const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { getStripeInstance } = require("../config/stripe");

const router = express.Router();

/**
 * STRIPE WEBHOOK API (Raw Body Handler)
 * Registered before express.json() to preserve unmodified raw body Buffer
 */
router.post(
  "/api/stripe/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error(
        "Stripe webhook configuration error: STRIPE_WEBHOOK_SECRET is not configured"
      );
      return res
        .status(500)
        .json({ error: "Webhook secret is not configured" });
    }

    if (!sig) {
      console.error(
        "Stripe webhook verification error: Missing stripe-signature header"
      );
      return res
        .status(400)
        .json({ error: "Missing stripe-signature header" });
    }

    if (!req.body || (Buffer.isBuffer(req.body) && req.body.length === 0)) {
      console.error("Stripe webhook error: Empty request payload");
      return res.status(400).json({ error: "Empty request payload" });
    }

    let event;
    const stripeInstance = getStripeInstance();
    try {
      event = stripeInstance.webhooks.constructEvent(
        req.body,
        sig,
        webhookSecret
      );
    } catch (err) {
      console.error(
        "Stripe webhook signature verification failed:",
        err.message
      );
      return res.status(400).json({
        error: `Webhook signature verification failed: ${err.message}`,
      });
    }

    // Ensure database connection is ready
    const { paymentsCollection, ordersCollection, productsCollection } =
      getCollections();
    if (!paymentsCollection || !ordersCollection) {
      console.error("Stripe webhook error: Database collections not ready");
      return res
        .status(503)
        .json({ error: "Service unavailable: Database not connected" });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          // Only process paid checkout sessions
          if (session.payment_status !== "paid") {
            console.log(
              `Stripe webhook: Checkout session ${session.id} payment_status is '${session.payment_status}', skipping order creation`
            );
            return res
              .status(200)
              .json({ received: true, status: session.payment_status });
          }

          const sessionId = session.id;
          const paymentIntentId = session.payment_intent || null;
          const metadata = session.metadata || {};
          const productId = metadata.productId;

          // 1. Idempotency Check: check if already processed in payments or orders
          const existingPayment =
            (await paymentsCollection.findOne({ session_id: sessionId })) ||
            (paymentIntentId
              ? await paymentsCollection.findOne({
                  transactionId: paymentIntentId,
                })
              : null) ||
            (await paymentsCollection.findOne({ transactionId: sessionId }));

          const existingOrder =
            (await ordersCollection.findOne({ paymentId: sessionId })) ||
            (paymentIntentId
              ? await ordersCollection.findOne({ paymentId: paymentIntentId })
              : null);

          if (existingPayment && existingOrder) {
            console.log(
              `Stripe webhook: Session ${sessionId} already processed (idempotent skip)`
            );
            return res
              .status(200)
              .json({ received: true, message: "Already processed" });
          }

          // 2. Retrieve authoritative product & price from database
          let product = null;
          if (productsCollection && productId) {
            const productQuery = ObjectId.isValid(productId)
              ? { _id: new ObjectId(productId) }
              : { _id: productId };
            product = await productsCollection.findOne(productQuery);
          }

          // Authoritative price check
          let authoritativePrice;
          if (product && product.price != null) {
            authoritativePrice = Number(product.price);
            const expectedAmountCents = Math.round(authoritativePrice * 100);

            // Security check: Validate against client-manipulated amount in session
            if (
              session.amount_total != null &&
              session.amount_total < expectedAmountCents
            ) {
              console.error(
                "Stripe webhook security error: Price mismatch detected",
                {
                  sessionId,
                  paidCents: session.amount_total,
                  expectedCents: expectedAmountCents,
                  productId,
                }
              );
              return res.status(400).json({
                error:
                  "Security validation error: Paid amount does not match authoritative price",
              });
            }
          } else if (metadata.price != null && !isNaN(Number(metadata.price))) {
            authoritativePrice = Number(metadata.price);
          } else if (session.amount_total != null) {
            authoritativePrice = session.amount_total / 100;
          } else {
            authoritativePrice = 0;
          }

          const buyerEmail =
            metadata.userEmail ||
            session.customer_details?.email ||
            session.customer_email ||
            "unknown@example.com";

          const buyerName =
            metadata.buyerName ||
            session.customer_details?.name ||
            "Anonymous";

          const sellerInfo = product
            ? typeof product.sellerInfo === "object"
              ? product.sellerInfo?.email || product.sellerInfo
              : product.sellerInfo || "not found"
            : metadata.sellerInfo || "not found";

          const sellerName =
            product?.sellerName ||
            (typeof product?.sellerInfo === "object"
              ? product?.sellerInfo?.name
              : metadata.sellerName || "N/A");

          const productTitle =
            product?.title || metadata.title || "Untitled Product";

          // 3. Insert or update order
          let orderId = null;
          if (existingOrder) {
            orderId = existingOrder._id;
            if (existingOrder.paymentStatus !== "paid") {
              await ordersCollection.updateOne(
                { _id: existingOrder._id },
                { $set: { paymentStatus: "paid", updatedAt: new Date() } }
              );
            }
          } else {
            const orderDoc = {
              paymentId: sessionId,
              transactionId: paymentIntentId || sessionId,
              productId: productId || (product ? product._id.toString() : null),
              productTitle,
              price: authoritativePrice,
              sellerName,
              sellerInfo,
              buyerName,
              buyerInfo: buyerEmail,
              paymentStatus: "paid",
              orderStatus: "pending",
              createdAt: new Date(),
            };
            const orderResult = await ordersCollection.insertOne(orderDoc);
            orderId = orderResult.insertedId;
          }

          // 4. Insert payment record if not existing
          if (!existingPayment) {
            const paymentDoc = {
              session_id: sessionId,
              transactionId: paymentIntentId || sessionId,
              orderId,
              amount:
                session.amount_total != null
                  ? session.amount_total / 100
                  : authoritativePrice,
              currency: session.currency || "usd",
              paymentStatus: "paid",
              metadata: {
                ...metadata,
                userEmail: buyerEmail,
              },
              date: new Date().toISOString(),
              createdAt: new Date(),
            };
            await paymentsCollection.insertOne(paymentDoc);
          }

          // 5. Update product status to sold in database
          if (productsCollection && productId) {
            const productQuery = ObjectId.isValid(productId)
              ? { _id: new ObjectId(productId) }
              : { _id: productId };
            await productsCollection.updateOne(productQuery, {
              $set: { status: "sold", updatedAt: new Date() },
            });
          }

          console.log(
            `Stripe webhook: Successfully processed checkout.session.completed for session ${sessionId}`
          );
          return res.status(200).json({ received: true });
        }

        default:
          console.log(`Stripe webhook: Unhandled event type ${event.type}`);
          return res.status(200).json({ received: true, unhandled: true });
      }
    } catch (processError) {
      console.error(
        "Stripe webhook processing error:",
        processError.message || processError
      );
      return res.status(500).json({ error: "Failed to process webhook event" });
    }
  }
);

module.exports = router;
