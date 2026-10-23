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
const { extractEmail } = require("../utils/helpers");

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
router.get(
  "/api/payments",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      const { paymentsCollection } = getCollections();
      if (!paymentsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const userEmail =
        req.user.role === "admin" && req.query.userEmail
          ? req.query.userEmail
          : req.user.email;

      const result = await paymentsCollection
        .find({
          "metadata.userEmail": userEmail,
        })
        .sort({ date: -1 })
        .toArray();

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

      const stripe = getStripeInstance();
      const origin =
        req.headers.origin ||
        config.ALLOWED_ORIGINS?.[0] ||
        config.JWT_ISSUER ||
        "http://localhost:3000";

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: product.title || "Marketplace Product",
                images:
                  Array.isArray(product.images) && product.images.length > 0
                    ? [product.images[0]]
                    : undefined,
              },
              unit_amount: Math.round(authoritativePrice * 100),
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
          userEmail: req.user.email,
          buyerName: req.user.name || "Buyer",
          sellerInfo: sellerEmail || String(product.sellerInfo || "unknown"),
          sellerName: product.sellerName || "Seller",
        },
      });

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
