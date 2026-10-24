const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { getStripeInstance } = require("../config/stripe");
const { config } = require("../config/env");
const {
  verifyToken,
  requireRole,
  validateUserIdentity,
} = require("../middleware/auth");
const { extractEmail, escapeRegex, toStripeAmount } = require("../utils/helpers");

const router = express.Router();

// ──────────────────────────────────────────
// PAYMENTS API
// ──────────────────────────────────────────

// Record payment (Buyer / Admin)
router.post(
  "/api/payments",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      if (!validateUserIdentity(req, res)) return;

      const payment = req.body;
      if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
        return res.status(400).send({ message: "Payment data is required" });
      }

      const { paymentsCollection } = getCollections();
      if (!paymentsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      if (req.user.role !== "admin") {
        payment.metadata = {
          ...(payment.metadata || {}),
          userEmail: req.user.email,
        };
      }

      // Idempotency: avoid duplicate payment record if already created via webhook
      if (payment.session_id) {
        const existingPayment = await paymentsCollection.findOne({
          session_id: payment.session_id,
        });
        if (existingPayment) {
          return res.status(200).send({
            message: "Payment already recorded",
            insertedId: existingPayment._id,
          });
        }
      }

      payment.createdAt = new Date();

      const result = await paymentsCollection.insertOne(payment);
      res.status(201).send(result);
    } catch (error) {
      console.error("Post payment error:", error.message || error);
      res.status(500).send({ message: "Failed to record payment" });
    }
  }
);

// Get payment history (Buyer / Admin)
// Non-admin users are strictly restricted to their own payment records.
// Admin users can monitor platform-wide transactions or filter by userEmail.
router.get(
  "/api/payments",
  verifyToken,
  requireRole("buyer", "seller", "admin"),
  async (req, res) => {
    try {
      const { paymentsCollection } = getCollections();
      if (!paymentsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const query = {};
      const isAdmin = req.user.role === "admin";

      let userMatch = null;
      if (isAdmin) {
        // Admin can optionally filter by userEmail or view all platform payments
        if (req.query.userEmail && typeof req.query.userEmail === "string") {
          userMatch = {
            $or: [
              { "metadata.userEmail": req.query.userEmail.trim() },
              { userEmail: req.query.userEmail.trim() },
              { buyerEmail: req.query.userEmail.trim() },
            ],
          };
        }
      } else {
        // Non-admin users are strictly bound to their authenticated principal email
        userMatch = {
          $or: [
            { "metadata.userEmail": req.user.email },
            { userEmail: req.user.email },
            { buyerEmail: req.user.email },
            { "metadata.buyerEmail": req.user.email },
          ],
        };
      }

      // Filter by payment status if supplied
      const statusParam = req.query.status || req.query.paymentStatus;
      if (statusParam && typeof statusParam === "string") {
        query.paymentStatus = statusParam.trim();
      }

      // Search by transactionId or session_id
      const search = req.query.search || req.query.q;
      let searchMatch = null;
      if (search && typeof search === "string" && search.trim()) {
        const escaped = escapeRegex(search.trim());
        searchMatch = {
          $or: [
            { transactionId: { $regex: escaped, $options: "i" } },
            { session_id: { $regex: escaped, $options: "i" } },
            { "metadata.userEmail": { $regex: escaped, $options: "i" } },
            { userEmail: { $regex: escaped, $options: "i" } },
          ],
        };
      }

      if (userMatch && searchMatch) {
        query.$and = [userMatch, searchMatch];
      } else if (userMatch) {
        Object.assign(query, userMatch);
      } else if (searchMatch) {
        Object.assign(query, searchMatch);
      }

      let cursor = paymentsCollection.find(query).sort({ date: -1, createdAt: -1 });

      // Pagination support
      const isPaginated = Boolean(req.query.page || req.query.limit);
      if (isPaginated) {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const skip = (page - 1) * limit;

        const allMatching = await paymentsCollection.find(query).toArray();
        const total = allMatching.length;
        const totalRevenue = allMatching.reduce(
          (sum, p) => sum + (p.paymentStatus === "paid" ? Number(p.amount) || 0 : 0),
          0
        );

        if (typeof cursor.skip === "function") cursor = cursor.skip(skip);
        if (typeof cursor.limit === "function") cursor = cursor.limit(limit);

        const payments = await cursor.toArray();
        return res.status(200).json({
          payments,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit) || 1,
          totalRevenue,
        });
      }

      const result = await cursor.toArray();
      res.set("X-Total-Count", String(result.length));
      res.send(result);
    } catch (error) {
      console.error("Get payments error:", error.message || error);
      res.status(500).send({ message: "Failed to fetch payments" });
    }
  }
);

// Create Stripe Checkout Session (Buyer / Admin)
// Authoritative price derived from database, never trusted from client
router.post(
  "/api/create-checkout-session",
  verifyToken,
  requireRole("buyer", "seller", "admin"),
  async (req, res) => {
    try {
      if (!validateUserIdentity(req, res)) return;

      const { productId } = req.body || {};
      if (!productId) {
        return res.status(400).json({ message: "productId is required" });
      }

      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const productQuery = ObjectId.isValid(productId)
        ? { _id: new ObjectId(productId) }
        : { _id: productId };
      const product = await productsCollection.findOne(productQuery);

      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }

      if (product.status === "sold") {
        return res.status(400).json({ message: "Product is already sold" });
      }

      // Moderation status check: pending and rejected products cannot be checked out
      if (
        product.status === "pending" ||
        product.status === "rejected" ||
        product.moderationStatus === "pending" ||
        product.moderationStatus === "rejected"
      ) {
        return res
          .status(400)
          .json({ message: "Product is not approved for purchase" });
      }

      const authoritativePrice = Number(product.price);
      if (isNaN(authoritativePrice) || authoritativePrice <= 0) {
        return res
          .status(400)
          .json({ message: "Product does not have a valid price" });
      }

      // Check seller cannot buy their own product
      const sellerEmail = extractEmail(product.sellerInfo);
      if (sellerEmail && sellerEmail === req.user.email) {
        return res
          .status(400)
          .json({ message: "You cannot purchase your own product" });
      }

      // Check seller account is not blocked
      const { usersCollection } = getCollections();
      if (usersCollection && sellerEmail) {
        const seller = await usersCollection.findOne({ email: sellerEmail });
        if (seller && seller.status === "blocked") {
          return res.status(400).json({
            message: "Seller account is blocked; product is unavailable",
          });
        }
      }

      // Atomic conditional reservation in MongoDB BEFORE Stripe session creation.
      // Guarantees that two concurrent buyers cannot both claim or overwrite a reservation for the same product.
      const now = new Date();
      const reservationExpiry = new Date(Date.now() + 30 * 60 * 1000);

      const reserveFilter = {
        ...productQuery,
        status: { $nin: ["sold", "pending", "rejected"] },
        $or: [
          { status: "available" },
          { reservedUntil: { $lte: now } },
          { reservedBy: req.user.email },
        ],
      };

      const reserveResult = await productsCollection.updateOne(reserveFilter, {
        $set: {
          status: "reserved",
          reservedBy: req.user.email,
          reservedUntil: reservationExpiry,
          updatedAt: now,
        },
      });

      if (!reserveResult || reserveResult.matchedCount === 0) {
        return res.status(409).json({
          message:
            "This product is currently reserved by another buyer in checkout. Please try again shortly.",
        });
      }

      const stripe = getStripeInstance();
      const origin =
        req.headers.origin ||
        config.ALLOWED_ORIGINS?.[0] ||
        config.JWT_ISSUER ||
        "http://localhost:3000";

      const currency = (config.CURRENCY || "usd").toLowerCase();
      const unitAmount = toStripeAmount(authoritativePrice, currency);

      let session;
      try {
        session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency,
                product_data: {
                  name: product.title || "Marketplace Product",
                  images:
                    Array.isArray(product.images) && product.images.length > 0
                      ? [product.images[0]]
                      : undefined,
                },
                unit_amount: unitAmount,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          customer_email: req.user.email,
          success_url: `${origin}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/products/${productId}`,
          metadata: {
            productId: String(product._id),
            title: product.title || "Product",
            price: String(authoritativePrice),
            currency,
            userEmail: req.user.email,
            buyerName: req.user.name || "Buyer",
            sellerInfo: sellerEmail || String(product.sellerInfo || "unknown"),
            sellerName: product.sellerName || "Seller",
          },
        });
      } catch (stripeErr) {
        // Rollback provisional reservation if Stripe checkout session creation fails
        await productsCollection.updateOne(
          {
            ...productQuery,
            reservedBy: req.user.email,
            status: "reserved",
          },
          {
            $set: { status: "available", updatedAt: new Date() },
            $unset: { reservedBy: "", reservedUntil: "", reservationSessionId: "" },
          }
        );
        throw stripeErr;
      }

      // Record the Stripe checkout session ID on the active reservation
      await productsCollection.updateOne(
        {
          ...productQuery,
          reservedBy: req.user.email,
          status: "reserved",
        },
        {
          $set: {
            reservationSessionId: session.id,
            updatedAt: new Date(),
          },
        }
      );

      res.status(200).json({
        sessionId: session.id,
        url: session.url,
      });
    } catch (error) {
      console.error(
        "Create checkout session error:",
        error.message || error
      );
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  }
);

module.exports = router;
