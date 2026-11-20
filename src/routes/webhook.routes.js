const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { getStripeInstance } = require("../config/stripe");
const { toStripeAmount, fromStripeAmount } = require("../utils/helpers");
const { getRefundIdempotencyKey } = require("../utils/refundRecovery");

const router = express.Router();

// In-flight sessions set to prevent concurrent duplicate webhook execution
const inFlightSessions = new Set();

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
        "Stripe webhook configuration error: STRIPE_WEBHOOK_SECRET is not configured",
      );
      return res
        .status(500)
        .json({ error: "Webhook secret is not configured" });
    }

    if (!sig) {
     
      console.error(
        "Stripe webhook verification error: Missing stripe-signature header",
      );
      return res.status(400).json({ error: "Missing stripe-signature header" });
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
        webhookSecret,
      );
    } catch (err) {
      console.error(
        "Stripe webhook signature verification failed:",
        err.message,
      );
      return res.status(400).json({
        error: `Webhook signature verification failed: ${err.message}`,
      });
    }

    // Ensure database connection is ready
    const {
      paymentsCollection,
      ordersCollection,
      productsCollection,
      processedEventsCollection,
      disputesCollection,
    } = getCollections();
    if (!paymentsCollection || !ordersCollection) {
      console.error("Stripe webhook error: Database collections not ready");
      return res
        .status(503)
        .json({ error: "Service unavailable: Database not connected" });
    }

    const eventId = event.id;
    const sessionId = event.data?.object?.id;

    // Durable event tracking & atomic claim to prevent concurrent duplicate processing
    const now = new Date();
    const lockTimeoutMs = 120 * 1000; // 2 minutes lock timeout for crash recovery
    const claimExpiresAt = new Date(Date.now() + lockTimeoutMs);
    let eventClaimed = false;

    if (processedEventsCollection && eventId) {
      try {
        await processedEventsCollection.insertOne({
          eventId,
          eventType: event.type,
          sessionId: sessionId || null,
          status: "processing",
          startedAt: now,
          claimExpiresAt,
          updatedAt: now,
        });
        eventClaimed = true;
      } catch (insertErr) {
        if (insertErr.code === 11000) {
          // Document already exists in processed_events
        } else {
          throw insertErr;
        }
      }

      if (!eventClaimed) {
        const existingRecord = await processedEventsCollection.findOne({
          eventId,
        });
        if (existingRecord && existingRecord.status === "completed") {
          return res.status(200).json({
            received: true,
            message: "Event already processed",
          });
        }

        const isStale =
          existingRecord &&
          existingRecord.claimExpiresAt &&
          new Date(existingRecord.claimExpiresAt) <= now;
        const isFailed = existingRecord && existingRecord.status === "failed";

        if (isStale || isFailed) {
          const reclaimResult = await processedEventsCollection.updateOne(
            {
              eventId,
              $or: [
                { status: "failed" },
                { status: "processing", claimExpiresAt: { $lte: now } },
              ],
            },
            {
              $set: {
                status: "processing",
                startedAt: now,
                claimExpiresAt,
                reclaimedAt: now,
                updatedAt: now,
              },
              $unset: { lastError: "", failedAt: "" },
            },
          );
          if (reclaimResult.modifiedCount > 0) {
            eventClaimed = true;
          }
        }
      }

      if (!eventClaimed) {
        // Another worker is actively processing. Wait briefly for simultaneous completion.
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const checkEvt = await processedEventsCollection.findOne({ eventId });
          if (checkEvt && checkEvt.status === "completed") {
            return res.status(200).json({
              received: true,
              message: "Simultaneous processing completed",
            });
          }
        }
        res.setHeader("Retry-After", "5");
        return res.status(503).json({
          error: "Webhook event is currently processing. Please retry.",
        });
      }
    } else {
      // In-flight concurrency protection when processedEventsCollection is not present
      if (sessionId && inFlightSessions.has(sessionId)) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (!inFlightSessions.has(sessionId)) {
            const existingPayment = await paymentsCollection.findOne({
              $or: [{ session_id: sessionId }, { transactionId: sessionId }],
            });
            if (existingPayment) {
              return res.status(200).json({
                received: true,
                message: "Simultaneous processing completed",
              });
            }
            break;
          }
        }
        if (inFlightSessions.has(sessionId)) {
          res.setHeader("Retry-After", "5");
          return res.status(503).json({
            error: "Webhook event currently processing. Please retry.",
          });
        }
      }
    }

    if (sessionId) {
      inFlightSessions.add(sessionId);
    }

    async function markEventCompleted() {
      if (processedEventsCollection && eventId) {
        await processedEventsCollection.updateOne(
          { eventId },
          {
            $set: {
              status: "completed",
              completedAt: new Date(),
              updatedAt: new Date(),
            },
          },
        );
      }
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          // Only process paid checkout sessions
          if (session.payment_status !== "paid") {
            console.log(
              `Stripe webhook: Checkout session ${session.id} payment_status is '${session.payment_status}', skipping order creation`,
            );
            await markEventCompleted();
            return res
              .status(200)
              .json({ received: true, status: session.payment_status });
          }

          const currentSessionId = session.id;
          const paymentIntentId = session.payment_intent || null;
          const metadata = session.metadata || {};
          const productId = metadata.productId;

          // 1. Idempotency Check: check if already processed in payments or orders
          const existingPayment =
            (await paymentsCollection.findOne({
              session_id: currentSessionId,
            })) ||
            (paymentIntentId
              ? await paymentsCollection.findOne({
                  transactionId: paymentIntentId,
                })
              : null) ||
            (await paymentsCollection.findOne({
              transactionId: currentSessionId,
            }));

          const existingOrder =
            (await ordersCollection.findOne({ paymentId: currentSessionId })) ||
            (paymentIntentId
              ? await ordersCollection.findOne({ paymentId: paymentIntentId })
              : null);

          if (existingPayment && existingOrder) {
            const isResolvedCancelled =
              existingOrder.orderStatus === "cancelled" &&
              (existingOrder.refundStatus === "refunded" ||
                existingPayment.refundStatus === "refunded");

            if (
              existingOrder.orderStatus !== "cancelled" ||
              isResolvedCancelled
            ) {
              console.log(
                `Stripe webhook: Session ${currentSessionId} already processed (idempotent skip)`,
              );
              await markEventCompleted();
              return res
                .status(200)
                .json({ received: true, message: "Already processed" });
            }
          }

          // 2. Retrieve authoritative product & price from database
          let product = null;
          if (productsCollection && productId) {
            const productQuery = ObjectId.isValid(productId)
              ? { _id: new ObjectId(productId) }
              : { _id: productId };
            product = await productsCollection.findOne(productQuery);
          }

          // Authoritative price and currency calculation
          const sessionCurrency = (session.currency || "usd").toLowerCase();
          let authoritativePrice;
          if (product && product.price != null) {
            authoritativePrice = Number(product.price);
            const expectedAmountSubunits = toStripeAmount(
              authoritativePrice,
              sessionCurrency,
            );

            // Security check: Validate against client-manipulated amount in session
            if (
              session.amount_total != null &&
              session.amount_total < expectedAmountSubunits
            ) {
              console.error(
                "Stripe webhook security error: Price mismatch detected",
                {
                  sessionId: currentSessionId,
                  paidSubunits: session.amount_total,
                  expectedSubunits: expectedAmountSubunits,
                  productId,
                },
              );
              return res.status(400).json({
                error:
                  "Security validation error: Paid amount does not match authoritative price",
              });
            }
          } else if (metadata.price != null && !isNaN(Number(metadata.price))) {
            authoritativePrice = Number(metadata.price);
          } else if (session.amount_total != null) {
            authoritativePrice = fromStripeAmount(
              session.amount_total,
              sessionCurrency,
            );
          } else {
            authoritativePrice = 0;
          }

          const buyerEmail =
            metadata.userEmail ||
            session.customer_details?.email ||
            session.customer_email ||
            "unknown@example.com";

          const buyerName =
            metadata.buyerName || session.customer_details?.name || "Anonymous";

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

          // 2.5 Duplicate Purchase / Competing Webhook Guard:
          // Check if product was already purchased by another customer
          let isDoubleSale = false;
          if (productId && ordersCollection) {
            const existingProductOrder = await ordersCollection.findOne({
              productId: String(productId),
              paymentStatus: "paid",
              orderStatus: { $nin: ["cancelled", "rejected"] },
            });
            if (
              existingProductOrder &&
              existingProductOrder.paymentId !== currentSessionId &&
              (!paymentIntentId ||
                existingProductOrder.transactionId !== paymentIntentId)
            ) {
              isDoubleSale = true;
              console.warn(
                `Stripe webhook WARNING: Duplicate purchase attempt detected for product ${productId}. Session ${currentSessionId} paid for already sold item.`,
              );
            }
          }

          // Check if order was cancelled before webhook arrival
          const isOrderCancelled =
            existingOrder && existingOrder.orderStatus === "cancelled";

          // Duplicate Payment Reconciliation & Cancelled Order Automatic Refund Processing:
          let refundResult = null;
          let refundStatus =
            isDoubleSale || isOrderCancelled ? "pending_refund" : undefined;
          let refundError = null;

          if ((isDoubleSale || isOrderCancelled) && paymentIntentId) {
            try {
              const stripe = getStripeInstance();
              if (
                stripe &&
                stripe.refunds &&
                typeof stripe.refunds.create === "function"
              ) {
                const idempotencyKey =
                  isOrderCancelled && existingOrder
                    ? getRefundIdempotencyKey(existingOrder._id, "order_cancel")
                    : getRefundIdempotencyKey(currentSessionId, "duplicate");

                const reason = isDoubleSale
                  ? "duplicate"
                  : "requested_by_customer";

                const refund = await stripe.refunds.create(
                  {
                    payment_intent: paymentIntentId,
                    reason,
                  },
                  { idempotencyKey },
                );
                if (refund && refund.status === "succeeded") {
                  refundResult = refund;
                  refundStatus = "refunded";
                } else if (refund && refund.status === "pending") {
                  refundResult = refund;
                  refundStatus = "pending_refund";
                }
              }
            } catch (rErr) {
              refundError = rErr.message || String(rErr);
              console.error(
                `Stripe automatic refund attempt error (${isDoubleSale ? "duplicate" : "order_cancel"}):`,
                refundError,
              );
            }
          }

          // 3. Insert or update order
          let orderId = null;
          if (existingOrder) {
            orderId = existingOrder._id;
            if (isOrderCancelled) {
              await ordersCollection.updateOne(
                { _id: existingOrder._id },
                {
                  $set: {
                    paymentStatus: "paid",
                    refundStatus,
                    refundId: refundResult ? refundResult.id : undefined,
                    refundQueue: refundStatus !== "refunded",
                    refundError: refundError || undefined,
                    updatedAt: new Date(),
                  },
                },
              );
            } else if (existingOrder.paymentStatus !== "paid") {
              await ordersCollection.updateOne(
                { _id: existingOrder._id },
                { $set: { paymentStatus: "paid", updatedAt: new Date() } },
              );
            }
          } else {
            const orderDoc = {
              paymentId: currentSessionId,
              transactionId: paymentIntentId || currentSessionId,
              productId: productId || (product ? product._id.toString() : null),
              productTitle,
              price: authoritativePrice,
              currency: sessionCurrency,
              sellerName,
              sellerInfo,
              buyerName,
              buyerInfo: buyerEmail,
              paymentStatus: "paid",
              orderStatus: isDoubleSale ? "rejected" : "pending",
              rejectionReason: isDoubleSale
                ? "Product already sold to another customer. Automatic refund required."
                : undefined,
              refundStatus: isDoubleSale ? refundStatus : undefined,
              refundId: refundResult ? refundResult.id : undefined,
              refundError: refundError || undefined,
              refundQueue: isDoubleSale && refundStatus !== "refunded",
              createdAt: new Date(),
            };
            try {
              const orderResult = await ordersCollection.insertOne(orderDoc);
              orderId = orderResult.insertedId;
            } catch (insertErr) {
              if (insertErr.code === 11000) {
                console.log(
                  `Stripe webhook: Order for session ${currentSessionId} already exists (concurrent insert caught)`,
                );
                await markEventCompleted();
                return res
                  .status(200)
                  .json({ received: true, message: "Already processed" });
              }
              throw insertErr;
            }
          }

          // 4. Insert payment record if not existing
          if (!existingPayment) {
            const paymentDoc = {
              session_id: currentSessionId,
              transactionId: paymentIntentId || currentSessionId,
              orderId: existingOrder ? existingOrder._id : orderId,
              amount:
                session.amount_total != null
                  ? fromStripeAmount(session.amount_total, sessionCurrency)
                  : authoritativePrice,
              currency: sessionCurrency,
              paymentStatus: "paid",
              fulfillmentStatus: isDoubleSale
                ? "failed_duplicate_purchase"
                : isOrderCancelled
                  ? "cancelled_order_refunded"
                  : "fulfilled",
              refundStatus:
                isDoubleSale || isOrderCancelled ? refundStatus : undefined,
              refundId: refundResult ? refundResult.id : undefined,
              refundError: refundError || undefined,
              refundQueue:
                (isDoubleSale || isOrderCancelled) &&
                refundStatus !== "refunded",
              metadata: {
                ...metadata,
                userEmail: buyerEmail,
              },
              buyerEmail,
              userEmail: buyerEmail,
              date: new Date().toISOString(),
              createdAt: new Date(),
            };
            try {
              await paymentsCollection.insertOne(paymentDoc);
            } catch (insertErr) {
              if (insertErr.code === 11000) {
                console.log(
                  `Stripe webhook: Payment for session ${currentSessionId} already exists (concurrent insert caught)`,
                );
                await markEventCompleted();
                return res
                  .status(200)
                  .json({ received: true, message: "Already processed" });
              }
              throw insertErr;
            }
          }

          // 5. Update product status to sold in database (only if not already sold and not cancelled order)
          if (
            !isDoubleSale &&
            !isOrderCancelled &&
            productsCollection &&
            productId
          ) {
            const productQuery = ObjectId.isValid(productId)
              ? { _id: new ObjectId(productId) }
              : { _id: productId };
            await productsCollection.updateOne(productQuery, {
              $set: {
                status: "sold",
                soldTo: buyerEmail,
                soldPaymentId: currentSessionId,
                updatedAt: new Date(),
              },
              $unset: {
                reservedBy: "",
                reservedUntil: "",
                reservationSessionId: "",
                reservationSessionUrl: "",
              },
            });
          } else if (isOrderCancelled && productsCollection && productId) {
            // Clean up any remaining provisional reservation for this session so product remains available
            const productQuery = ObjectId.isValid(productId)
              ? { _id: new ObjectId(productId) }
              : { _id: productId };
            await productsCollection.updateOne(
              {
                ...productQuery,
                reservationSessionId: currentSessionId,
                status: "reserved",
              },
              {
                $set: { status: "available", updatedAt: new Date() },
                $unset: {
                  reservedBy: "",
                  reservedUntil: "",
                  reservationSessionId: "",
                  reservationSessionUrl: "",
                },
              },
            );
          }

          console.log(
            `Stripe webhook: Successfully processed checkout.session.completed for session ${currentSessionId}${isDoubleSale ? " (flagged duplicate sale)" : ""}${isOrderCancelled ? " (cancelled order refunded)" : ""}`,
          );
          await markEventCompleted();
          return res.status(200).json({
            received: true,
            doubleSale: isDoubleSale,
            cancelled: isOrderCancelled,
          });
        }

        case "checkout.session.expired": {
          const session = event.data.object;
          const productId = session.metadata?.productId;
          if (productId && productsCollection) {
            const productQuery = ObjectId.isValid(productId)
              ? { _id: new ObjectId(productId) }
              : { _id: productId };
            // Strictly release ONLY active reservations belonging to this exact session ID
            // and ensure a sold or transferred product is never released
            await productsCollection.updateOne(
              {
                ...productQuery,
                reservationSessionId: session.id,
                status: "reserved",
              },
              {
                $set: { status: "available", updatedAt: new Date() },
                $unset: {
                  reservedBy: "",
                  reservedUntil: "",
                  reservationSessionId: "",
                  reservationSessionUrl: "",
                },
              },
            );
          }
          await markEventCompleted();
          return res.status(200).json({ received: true, status: "expired" });
        }

        case "payment_intent.payment_failed": {
          const intent = event.data.object;
          if (paymentsCollection) {
            await paymentsCollection.updateOne(
              { transactionId: intent.id },
              {
                $set: {
                  paymentStatus: "failed",
                  failureReason:
                    intent.last_payment_error?.message || "Payment failed",
                  updatedAt: new Date(),
                },
              },
            );
          }
          await markEventCompleted();
          return res.status(200).json({ received: true, status: "failed" });
        }

        case "charge.refunded": {
          const charge = event.data.object;
          const paymentIntentId = charge.payment_intent;
          const refund = charge.refunds?.data?.[0];
          const refundId = refund?.id;
          const isSucceeded = refund ? refund.status === "succeeded" : charge.refunded === true;
          const finalRefundStatus = isSucceeded ? "refunded" : "pending_refund";

          if (ordersCollection && paymentIntentId) {
            const orderDoc = await ordersCollection.findOne({
              $or: [
                { transactionId: paymentIntentId },
                { paymentId: paymentIntentId },
              ],
            });

            if (orderDoc) {
              const orderUpdate = {
                refundStatus: finalRefundStatus,
                refundQueue: !isSucceeded,
                updatedAt: new Date(),
              };
              if (refundId) orderUpdate.refundId = refundId;
              if (isSucceeded) orderUpdate.refundSuccessAt = new Date();

              await ordersCollection.updateOne({ _id: orderDoc._id }, { $set: orderUpdate });

              if (disputesCollection) {
                await disputesCollection.updateOne(
                  {
                    $or: [
                      { orderId: String(orderDoc._id) },
                      ...(ObjectId.isValid(orderDoc._id) ? [{ orderObjectId: new ObjectId(orderDoc._id) }] : []),
                    ],
                  },
                  {
                    $set: {
                      refundStatus: finalRefundStatus,
                      ...(refundId ? { refundId } : {}),
                      updatedAt: new Date(),
                    },
                  }
                );
              }
            }
          }

          if (paymentsCollection && paymentIntentId) {
            await paymentsCollection.updateOne(
              {
                $or: [
                  { transactionId: paymentIntentId },
                  { session_id: paymentIntentId },
                ],
              },
              {
                $set: {
                  refundStatus: finalRefundStatus,
                  refundQueue: !isSucceeded,
                  ...(refundId ? { refundId } : {}),
                  updatedAt: new Date(),
                },
              }
            );
          }

          await markEventCompleted();
          return res.status(200).json({ received: true, refundStatus: finalRefundStatus });
        }

        default:
          console.log(`Stripe webhook: Unhandled event type ${event.type}`);
          await markEventCompleted();
          return res.status(200).json({ received: true, unhandled: true });
      }
    } catch (processError) {
      console.error(
        "Stripe webhook processing error:",
        processError.message || processError,
      );
      if (processedEventsCollection && eventId) {
        try {
          await processedEventsCollection.updateOne(
            { eventId },
            {
              $set: {
                status: "failed",
                failedAt: new Date(),
                lastError: processError.message || String(processError),
                updatedAt: new Date(),
              },
            },
          );
        } catch (dbErr) {
          console.error(
            "Failed to update processed_events failure status:",
            dbErr.message,
          );
        }
      }
      return res.status(500).json({ error: "Failed to process webhook event" });
    } finally {
      if (sessionId) {
        inFlightSessions.delete(sessionId);
      }
    }
  },
);

module.exports = router;
