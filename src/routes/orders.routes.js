const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const {
  verifyToken,
  requireRole,
  validateUserIdentity,
} = require("../middleware/auth");
const { extractEmail } = require("../utils/helpers");

const router = express.Router();

// ──────────────────────────────────────────
// ORDERS API
// ──────────────────────────────────────────

// Post an order (Buyer / Admin)
router.post(
  "/api/orders",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      if (!validateUserIdentity(req, res)) return;

      const orderData = req.body;
      if (!orderData || typeof orderData !== "object" || Array.isArray(orderData)) {
        return res.status(400).send({ message: "Order data is required" });
      }

      const { ordersCollection, paymentsCollection, productsCollection } =
        getCollections();

      if (!ordersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      if (req.user.role !== "admin" || !orderData.buyerInfo) {
        orderData.buyerInfo = req.user.email;
      }
      orderData.buyerName = orderData.buyerName || req.user.name || "Buyer";

      // Idempotency: avoid duplicate order if already created via webhook
      if (orderData.paymentId) {
        const existingOrder = await ordersCollection.findOne({
          paymentId: orderData.paymentId,
        });
        if (existingOrder) {
          return res.status(200).send({
            message: "Order already placed",
            insertedId: existingOrder._id,
          });
        }
      }

      // Authoritative product and price lookup from database
      if (orderData.productId && productsCollection) {
        const productQuery = ObjectId.isValid(orderData.productId)
          ? { _id: new ObjectId(orderData.productId) }
          : { _id: orderData.productId };
        const product = await productsCollection.findOne(productQuery);
        if (product) {
          if (product.status === "sold") {
            return res.status(400).send({ message: "Product is already sold" });
          }
          if (
            product.status === "pending" ||
            product.status === "rejected" ||
            product.moderationStatus === "pending" ||
            product.moderationStatus === "rejected"
          ) {
            return res
              .status(400)
              .send({ message: "Product is not approved for ordering" });
          }
          const sellerEmail = extractEmail(product.sellerInfo);
          if (sellerEmail && sellerEmail === req.user.email) {
            return res
              .status(400)
              .send({ message: "You cannot purchase your own product" });
          }
          if (product.price != null) {
            orderData.price = Number(product.price);
          }
          if (product.title) {
            orderData.productTitle = product.title;
          }
          if (product.sellerInfo) {
            orderData.sellerInfo = sellerEmail || product.sellerInfo;
          }
          if (product.sellerName) {
            orderData.sellerName = product.sellerName;
          }
        }
      }

      // Never trust client-supplied paymentStatus without verified payment record
      if (req.user.role !== "admin" && orderData.paymentStatus === "paid") {
        const verifiedPayment =
          orderData.paymentId && paymentsCollection
            ? (await paymentsCollection.findOne({
                session_id: orderData.paymentId,
              })) ||
              (await paymentsCollection.findOne({
                transactionId: orderData.paymentId,
              }))
            : null;
        if (!verifiedPayment || verifiedPayment.paymentStatus !== "paid") {
          orderData.paymentStatus = "pending";
        }
      }

      // Non-admins cannot forge initial order status to shipped, delivered, or accepted
      const initialOrderStatus =
        req.user.role === "admin" && orderData.orderStatus
          ? orderData.orderStatus
          : "pending";

      const result = await ordersCollection.insertOne({
        ...orderData,
        orderStatus: initialOrderStatus,
        createdAt: new Date(),
      });
      res.status(201).send(result);
    } catch (error) {
      console.error("Post order error:", error.message || error);
      res.status(500).send({ message: "Failed to place order" });
    }
  }
);

// Get orders by sellerInfo (Seller / Admin) - supports both string and object schemas
router.get(
  "/api/seller/orders",
  verifyToken,
  requireRole("seller", "admin"),
  async (req, res) => {
    try {
      const { ordersCollection } = getCollections();
      if (!ordersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const sellerEmail =
        req.user.role === "admin" && req.query.sellerInfo
          ? req.query.sellerInfo.trim()
          : req.user.email;

      const result = await ordersCollection
        .find({
          $or: [{ sellerInfo: sellerEmail }, { "sellerInfo.email": sellerEmail }],
        })
        .toArray();
      res.send(result);
    } catch (error) {
      console.error("Get seller orders error:", error.message || error);
      res.status(500).send({ message: "Failed to fetch orders" });
    }
  }
);

// Get orders by buyerInfo (Buyer / Admin) - supports both string and object schemas
router.get(
  "/api/buyer/orders",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      const { ordersCollection } = getCollections();
      if (!ordersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const buyerEmail =
        req.user.role === "admin" && req.query.buyerInfo
          ? req.query.buyerInfo.trim()
          : req.user.email;

      const result = await ordersCollection
        .find({
          $or: [{ buyerInfo: buyerEmail }, { "buyerInfo.email": buyerEmail }],
        })
        .toArray();
      res.send(result);
    } catch (error) {
      console.error("Get buyer orders error:", error.message || error);
      res.status(500).send({ message: "Failed to fetch orders" });
    }
  }
);

// Update order status (Seller / Admin)
router.patch(
  "/api/orders/:orderId/status",
  verifyToken,
  requireRole("seller", "admin"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      if (!ObjectId.isValid(orderId)) {
        return res.status(400).send({ message: "Invalid order ID format" });
      }

      const { status } = req.body;
      const allowedStatuses = [
        "accepted",
        "rejected",
        "processing",
        "shipped",
        "delivered",
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const { ordersCollection } = getCollections();
      if (!ordersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });
      if (!order) {
        return res.status(404).send({ message: "Order not found" });
      }

      if (order.orderStatus === "cancelled") {
        return res
          .status(400)
          .send({ message: "Cannot update status of a cancelled order" });
      }

      if (order.orderStatus === "delivered") {
        return res
          .status(400)
          .send({ message: "Cannot update status of an already delivered order" });
      }

      if (order.orderStatus === "rejected") {
        return res
          .status(400)
          .send({ message: "Cannot update status of a rejected order" });
      }

      // Integrity guard: An unpaid order cannot be marked shipped or delivered
      if (
        (status === "shipped" || status === "delivered") &&
        order.paymentStatus !== "paid"
      ) {
        return res.status(400).send({
          message:
            "Cannot mark order as shipped or delivered before payment is verified",
        });
      }

      // Only the seller of the product or admin can update status
      const existingSellerEmail = extractEmail(order.sellerInfo);
      if (
        req.user.role !== "admin" &&
        existingSellerEmail !== req.user.email
      ) {
        return res.status(403).send({
          message:
            "Forbidden: You can only update orders for your products",
        });
      }

      const result = await ordersCollection.updateOne(
        { _id: new ObjectId(orderId) },
        { $set: { orderStatus: status, updatedAt: new Date() } }
      );

      res.send(result);
    } catch (error) {
      console.error("Update order status error:", error.message || error);
      res.status(500).send({ message: "Failed to update order status" });
    }
  }
);

// Cancel order (Buyer / Admin)
router.delete(
  "/api/orders/:orderId",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      if (!ObjectId.isValid(orderId)) {
        return res.status(400).send({ message: "Invalid order ID format" });
      }

      const { ordersCollection } = getCollections();
      if (!ordersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });

      if (!order) {
        return res.status(404).send({
          message: "Order not found",
        });
      }

      // Ownership check: only buyer or admin can cancel
      const existingBuyerEmail = extractEmail(order.buyerInfo);
      if (
        req.user.role !== "admin" &&
        existingBuyerEmail !== req.user.email
      ) {
        return res.status(403).send({
          message: "Forbidden: You can only cancel your own orders",
        });
      }

      const cancellableStatuses = [
        "pending",
        "accepted",
        "processing",
        "rejected",
      ];

      if (!cancellableStatuses.includes(order.orderStatus)) {
        return res.status(400).send({
          message: `Order cannot be cancelled when status is "${order.orderStatus}"`,
        });
      }

      const { productsCollection } = getCollections();
      const result = await ordersCollection.deleteOne({
        _id: new ObjectId(orderId),
      });

      // Restore product availability if no other active paid order holds the product
      if (order.productId && productsCollection) {
        const otherActiveOrder = await ordersCollection.findOne({
          productId: String(order.productId),
          _id: { $ne: new ObjectId(orderId) },
          paymentStatus: "paid",
          orderStatus: { $nin: ["cancelled", "rejected"] },
        });

        if (!otherActiveOrder) {
          const prodQuery = ObjectId.isValid(order.productId)
            ? { _id: new ObjectId(order.productId) }
            : { _id: order.productId };
          await productsCollection.updateOne(prodQuery, {
            $set: { status: "available", updatedAt: new Date() },
            $unset: {
              soldTo: "",
              soldPaymentId: "",
              reservedBy: "",
              reservedUntil: "",
              reservationSessionId: "",
            },
          });
        }
      }

      res.send({
        success: true,
        message: "Order cancelled successfully",
        result,
      });
    } catch (error) {
      console.error("Cancel order error:", error.message || error);
      res.status(500).send({
        success: false,
        message: "Failed to cancel order",
      });
    }
  }
);

// ──────────────────────────────────────────
// G. SOFT ORDER CANCELLATION & ORDER DETAILS
// ──────────────────────────────────────────

/**
 * GET /api/orders/:orderId
 * Fetches single order details. Only accessible by the buyer who placed it,
 * the seller of the product, or an administrator.
 */
router.get(
  "/api/orders/:orderId",
  verifyToken,
  async (req, res) => {
    try {
      const { orderId } = req.params;
      if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ message: "Invalid order ID format" });
      }

      const { ordersCollection } = getCollections();
      if (!ordersCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });

      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }

      // Authorization check
      const buyerEmail = extractEmail(order.buyerInfo);
      const sellerEmail = extractEmail(order.sellerInfo);

      if (
        req.user.role !== "admin" &&
        buyerEmail !== req.user.email &&
        sellerEmail !== req.user.email
      ) {
        return res.status(403).json({
          message: "Forbidden: You do not have permission to view this order",
        });
      }

      res.status(200).json(order);
    } catch (error) {
      console.error("Get order details error:", error.message || error);
      res.status(500).json({ message: "Failed to fetch order details" });
    }
  }
);

/**
 * PATCH /api/orders/:orderId/cancel
 * Soft order cancellation that preserves historical records.
 * Permitted only before shipment (pending, accepted, processing).
 */
router.patch(
  "/api/orders/:orderId/cancel",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ message: "Invalid order ID format" });
      }

      const { ordersCollection, productsCollection } = getCollections();
      if (!ordersCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const order = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });

      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }

      // Ownership check: only buyer or admin can cancel
      const buyerEmail = extractEmail(order.buyerInfo);
      if (req.user.role !== "admin" && buyerEmail !== req.user.email) {
        return res.status(403).json({
          message: "Forbidden: You can only cancel your own orders",
        });
      }

      const cancellableStatuses = ["pending", "accepted", "processing"];
      if (!cancellableStatuses.includes(order.orderStatus)) {
        return res.status(400).json({
          message: `Order cannot be cancelled when status is "${order.orderStatus}" (only pending, accepted, or processing orders can be cancelled)`,
        });
      }

      // Perform conditional atomic soft cancellation - prevents race conditions
      const cancelResult = await ordersCollection.updateOne(
        {
          _id: new ObjectId(orderId),
          orderStatus: { $in: cancellableStatuses },
        },
        {
          $set: {
            orderStatus: "cancelled",
            cancelledAt: new Date(),
            cancelledBy: req.user.email,
            refundStatus:
              order.paymentStatus === "paid" ? "pending_refund" : "not_applicable",
            updatedAt: new Date(),
          },
        }
      );

      if (cancelResult.matchedCount === 0) {
        return res.status(400).json({
          message:
            "Order cannot be cancelled. It may have already been shipped, delivered, or cancelled.",
        });
      }

      // Restore product availability only if no other active paid order holds the product
      if (order.productId && productsCollection) {
        const otherActiveOrder = await ordersCollection.findOne({
          productId: String(order.productId),
          _id: { $ne: new ObjectId(orderId) },
          paymentStatus: "paid",
          orderStatus: { $nin: ["cancelled", "rejected"] },
        });

        if (!otherActiveOrder) {
          const prodQuery = ObjectId.isValid(order.productId)
            ? { _id: new ObjectId(order.productId) }
            : { _id: order.productId };
          await productsCollection.updateOne(prodQuery, {
            $set: { status: "available", updatedAt: new Date() },
            $unset: {
              soldTo: "",
              soldPaymentId: "",
              reservedBy: "",
              reservedUntil: "",
              reservationSessionId: "",
            },
          });
        }
      }

      const updatedOrder = await ordersCollection.findOne({
        _id: new ObjectId(orderId),
      });

      res.status(200).json({
        success: true,
        message: "Order cancelled successfully",
        order: updatedOrder,
      });
    } catch (error) {
      console.error("Soft cancel order error:", error.message || error);
      res.status(500).json({ message: "Failed to cancel order" });
    }
  }
);

module.exports = router;
