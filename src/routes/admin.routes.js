const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { verifyToken, requireRole } = require("../middleware/auth");
const { escapeRegex } = require("../utils/helpers");
const { getStripeInstance } = require("../config/stripe");
const { processPendingRefunds, getRefundIdempotencyKey } = require("../utils/refundRecovery");

const router = express.Router();

/**
 * Helper to count documents safely across both real MongoDB collections and mock collections
 */
async function countDocs(collection, filter = {}) {
  if (!collection) return 0;
  if (typeof collection.countDocuments === "function") {
    return await collection.countDocuments(filter);
  }
  const docs = await collection.find(filter).toArray();
  return docs.length;
}

// ──────────────────────────────────────────
// ADMIN API
// ──────────────────────────────────────────

// Get all users (Admin only)
router.get(
  "/api/admin/users",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { usersCollection } = getCollections();
      if (!usersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const users = await usersCollection
        .find({})
        .project({
          name: 1,
          email: 1,
          role: 1,
          status: 1,
          location: 1,
          image: 1,
          isVerified: 1,
          emailVerified: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(users);
    } catch (error) {
      console.error("Get admin users error:", error.message || error);
      res.status(500).send({
        success: false,
        message: "Failed to fetch users",
      });
    }
  }
);

// Get single user by ID (Admin only)
router.get(
  "/api/admin/users/:id",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { usersCollection } = getCollections();
      if (!usersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const userQuery = ObjectId.isValid(id)
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const user = await usersCollection.findOne(userQuery);

      if (!user) {
        return res.status(404).send({
          message: "User not found",
        });
      }

      res.send(user);
    } catch (error) {
      console.error("Get user error:", error.message || error);
      res.status(500).send({
        message: "Failed to fetch user",
      });
    }
  }
);

// Update user status (Admin only)
router.patch(
  "/api/admin/users/:id/status",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;

      const allowedStatuses = ["active", "blocked"];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).send({
          message: "Invalid status",
        });
      }

      const { usersCollection } = getCollections();
      if (!usersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const userQuery = ObjectId.isValid(id)
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const result = await usersCollection.updateOne(userQuery, {
        $set: {
          status,
          updatedAt: new Date(),
        },
      });

      if (result.matchedCount === 0) {
        return res.status(404).send({
          message: "User not found",
        });
      }

      res.send({
        success: true,
        message: `User ${status === "blocked" ? "blocked" : "unblocked"} successfully`,
        result,
      });
    } catch (error) {
      console.error("Update user status error:", error.message || error);
      res.status(500).send({
        message: "Failed to update user status",
      });
    }
  }
);

// Delete user (Admin only)
router.delete(
  "/api/admin/users/:id",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { usersCollection } = getCollections();
      if (!usersCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const userQuery = ObjectId.isValid(id)
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const result = await usersCollection.deleteOne(userQuery);

      if (result.deletedCount === 0) {
        return res.status(404).send({
          message: "User not found",
        });
      }

      res.send({
        success: true,
        message: "User deleted successfully",
        result,
      });
    } catch (error) {
      console.error("Delete user error:", error.message || error);
      res.status(500).send({
        message: "Failed to delete user",
      });
    }
  }
);

// ──────────────────────────────────────────
// B. ADMIN ALL-ORDERS MANAGEMENT
// ──────────────────────────────────────────

/**
 * GET /api/admin/orders
 * Returns all platform orders with search, status filtering, and pagination.
 */
router.get(
  "/api/admin/orders",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { ordersCollection } = getCollections();
      if (!ordersCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const query = {};

      // 1. Status filter
      const statusParam = req.query.status || req.query.orderStatus;
      if (statusParam && typeof statusParam === "string" && statusParam.trim()) {
        query.orderStatus = statusParam.trim();
      }

      // 2. Payment status filter
      if (req.query.paymentStatus && typeof req.query.paymentStatus === "string") {
        query.paymentStatus = req.query.paymentStatus.trim();
      }

      // 3. Search query across title, buyer, seller, transactionId
      const search = req.query.search || req.query.q;
      if (search && typeof search === "string" && search.trim()) {
        const escaped = escapeRegex(search.trim());
        query.$or = [
          { productTitle: { $regex: escaped, $options: "i" } },
          { buyerInfo: { $regex: escaped, $options: "i" } },
          { "buyerInfo.email": { $regex: escaped, $options: "i" } },
          { sellerInfo: { $regex: escaped, $options: "i" } },
          { "sellerInfo.email": { $regex: escaped, $options: "i" } },
          { transactionId: { $regex: escaped, $options: "i" } },
          { paymentId: { $regex: escaped, $options: "i" } },
        ];
      }

      const total = await countDocs(ordersCollection, query);

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const skip = (page - 1) * limit;

      let cursor = ordersCollection.find(query).sort({ createdAt: -1 });

      if (typeof cursor.skip === "function") {
        cursor = cursor.skip(skip);
      }
      if (typeof cursor.limit === "function") {
        cursor = cursor.limit(limit);
      }

      const orders = await cursor.toArray();

      res.status(200).json({
        orders,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      });
    } catch (error) {
      console.error("Admin orders error:", error.message || error);
      res.status(500).json({ message: "Failed to fetch orders" });
    }
  }
);

// ──────────────────────────────────────────
// H. ADMIN PRODUCT MODERATION
// ──────────────────────────────────────────

/**
 * PATCH /api/admin/products/:id/status
 * Moderates a product: approve, reject, available, sold, or pending.
 */
router.patch(
  "/api/admin/products/:id/status",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid product ID format" });
      }

      const { status } = req.body || {};
      const allowed = ["approved", "rejected", "pending", "available", "sold"];

      if (!status || !allowed.includes(status)) {
        return res.status(400).json({
          message: `Invalid status. Must be one of: [${allowed.join(", ")}]`,
        });
      }

      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const query = { _id: new ObjectId(id) };
      const existing = await productsCollection.findOne(query);

      if (!existing) {
        return res.status(404).json({ message: "Product not found" });
      }

      // Map "approved" to status: "available" while preserving moderationStatus
      const isApprovedOrAvailable = status === "approved" || status === "available";
      const updateDoc = {
        status: status === "approved" ? "available" : status,
        moderationStatus: status === "available" ? "approved" : status,
        isPubliclyVisible: isApprovedOrAvailable,
        moderatedBy: req.user.email,
        moderatedAt: new Date(),
        updatedAt: new Date(),
      };

      const updateOp = { $set: updateDoc };
      if (status === "rejected" || status === "pending") {
        updateOp.$unset = {
          reservedBy: "",
          reservedUntil: "",
          reservationSessionId: "",
        };
      }

      const result = await productsCollection.updateOne(query, updateOp);

      res.status(200).json({
        success: true,
        message: `Product successfully marked as ${status}`,
        result,
      });
    } catch (error) {
      console.error("Admin product moderation error:", error.message || error);
      res.status(500).json({ message: "Failed to update product status" });
    }
  }
);

// ──────────────────────────────────────────
// L. SELLER VERIFICATION
// ──────────────────────────────────────────

/**
 * PATCH /api/admin/users/:id/verify
 * Grants or revokes seller verification badge. Only applies to seller accounts.
 */
router.patch(
  "/api/admin/users/:id/verify",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { usersCollection } = getCollections();
      if (!usersCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const userQuery = ObjectId.isValid(id)
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const user = await usersCollection.findOne(userQuery);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (user.role !== "seller") {
        return res
          .status(400)
          .json({ message: "Only seller accounts can be verified" });
      }

      const body = req.body || {};
      const isVerified =
        body.isVerified !== undefined
          ? Boolean(body.isVerified)
          : body.verificationStatus === "verified" || body.status === "verified";

      await usersCollection.updateOne(userQuery, {
        $set: {
          isVerified,
          verifiedAt: isVerified ? new Date() : null,
          verifiedBy: isVerified ? req.user.email : null,
          updatedAt: new Date(),
        },
      });

      const updated = await usersCollection.findOne(userQuery);

      res.status(200).json({
        success: true,
        message: `Seller verification status updated to ${isVerified ? "verified" : "unverified"}`,
        user: {
          _id: updated._id,
          name: updated.name,
          email: updated.email,
          role: updated.role,
          isVerified: Boolean(updated.isVerified),
        },
      });
    } catch (error) {
      console.error("Seller verify error:", error.message || error);
      res.status(500).json({ message: "Failed to update seller verification" });
    }
  }
);

// ──────────────────────────────────────────
// M. PRODUCT REPORTING & MODERATION (Admin)
// ──────────────────────────────────────────

/**
 * GET /api/admin/reports
 * Returns list of reported products for review.
 */
router.get(
  "/api/admin/reports",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { reportsCollection } = getCollections();
      if (!reportsCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const query = {};
      if (req.query.status && typeof req.query.status === "string") {
        query.status = req.query.status.trim();
      }

      const total = await countDocs(reportsCollection, query);
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const skip = (page - 1) * limit;

      let cursor = reportsCollection.find(query).sort({ createdAt: -1 });
      if (typeof cursor.skip === "function") cursor = cursor.skip(skip);
      if (typeof cursor.limit === "function") cursor = cursor.limit(limit);

      const reports = await cursor.toArray();

      res.status(200).json({
        reports,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      });
    } catch (error) {
      console.error("Admin reports error:", error.message || error);
      res.status(500).json({ message: "Failed to fetch reports" });
    }
  }
);

/**
 * PATCH /api/admin/reports/:id
 * Resolves or dismisses a product report.
 */
router.patch(
  "/api/admin/reports/:id",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, actionNotes } = req.body || {};

      const allowed = ["resolved", "dismissed", "pending"];
      if (!status || !allowed.includes(status)) {
        return res.status(400).json({
          message: `Invalid status. Must be one of: [${allowed.join(", ")}]`,
        });
      }

      const { reportsCollection } = getCollections();
      if (!reportsCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const query = ObjectId.isValid(id)
        ? { _id: new ObjectId(id) }
        : { _id: id };

      const result = await reportsCollection.updateOne(query, {
        $set: {
          status,
          actionNotes: typeof actionNotes === "string" ? actionNotes.trim() : "",
          resolvedBy: req.user.email,
          resolvedAt: new Date(),
        },
      });

      if (result.matchedCount === 0) {
        return res.status(404).json({ message: "Report not found" });
      }

      res.status(200).json({
        success: true,
        message: `Report marked as ${status}`,
        result,
      });
    } catch (error) {
      console.error("Admin resolve report error:", error.message || error);
      res.status(500).json({ message: "Failed to update report status" });
    }
  }
);

// ──────────────────────────────────────────
// J. ADMIN PLATFORM ANALYTICS & STATS
// ──────────────────────────────────────────

// Admin Platform High-Level Statistics Cards
router.get(
  "/api/admin/stats",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { usersCollection, productsCollection, ordersCollection, paymentsCollection } =
        getCollections();

      const [totalUsers, totalProducts, totalOrders] = await Promise.all([
        countDocs(usersCollection),
        countDocs(productsCollection),
        countDocs(ordersCollection),
      ]);

      // Calculate total verified revenue from paid payments
      let totalRevenue = 0;
      if (paymentsCollection) {
        const payments = await paymentsCollection
          .find({ paymentStatus: "paid" })
          .toArray();
        totalRevenue = payments.reduce(
          (sum, p) => sum + (Number(p.amount) || 0),
          0
        );
      }

      res.status(200).json({
        totalUsers,
        totalProducts,
        totalOrders,
        totalRevenue,
      });
    } catch (error) {
      console.error("Admin stats error:", error.message || error);
      res.status(500).json({ message: "Failed to fetch platform statistics" });
    }
  }
);

// Comprehensive Admin Analytics
router.get(
  "/api/admin/analytics",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const {
        usersCollection,
        productsCollection,
        ordersCollection,
        paymentsCollection,
      } = getCollections();

      if (!usersCollection || !productsCollection || !ordersCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const [users, products, orders, payments] = await Promise.all([
        usersCollection.find({}).toArray(),
        productsCollection.find({}).toArray(),
        ordersCollection.find({}).toArray(),
        paymentsCollection
          ? paymentsCollection.find({ paymentStatus: "paid" }).toArray()
          : [],
      ]);

      // 1. Account Distribution
      const accountDistribution = {
        buyers: users.filter((u) => u.role === "buyer" || !u.role).length,
        sellers: users.filter((u) => u.role === "seller").length,
        admins: users.filter((u) => u.role === "admin").length,
        blocked: users.filter((u) => u.status === "blocked").length,
      };

      // 2. Product Inventory & Valuation
      let totalValuation = 0;
      const productInventory = {
        total: products.length,
        available: 0,
        sold: 0,
        pending: 0,
        rejected: 0,
        totalValuation: 0,
      };

      const categoryMap = {};

      products.forEach((p) => {
        const price = Number(p.price) || 0;
        totalValuation += price;

        const st = (p.status || "available").toLowerCase();
        if (st === "sold") productInventory.sold++;
        else if (st === "rejected") productInventory.rejected++;
        else if (st === "pending") productInventory.pending++;
        else productInventory.available++;

        const cat = p.category || "Uncategorized";
        if (!categoryMap[cat]) {
          categoryMap[cat] = { category: cat, totalProducts: 0, totalRevenue: 0 };
        }
        categoryMap[cat].totalProducts++;
      });
      productInventory.totalValuation = totalValuation;

      // 3. Order Fulfillment Distribution & Category Revenue
      const fulfillmentDistribution = {
        pending: 0,
        accepted: 0,
        processing: 0,
        shipped: 0,
        delivered: 0,
        cancelled: 0,
        rejected: 0,
      };

      let verifiedRevenue = 0;
      const monthlyOrdersMap = {};

      orders.forEach((o) => {
        const st = (o.orderStatus || "pending").toLowerCase();
        if (fulfillmentDistribution[st] !== undefined) {
          fulfillmentDistribution[st]++;
        }

        const isPaid = o.paymentStatus === "paid";
        const price = Number(o.price) || 0;
        if (isPaid && st !== "cancelled" && st !== "rejected") {
          verifiedRevenue += price;
        }

        // Monthly trends
        const d = o.createdAt ? new Date(o.createdAt) : new Date();
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!monthlyOrdersMap[monthKey]) {
          monthlyOrdersMap[monthKey] = { month: monthKey, orders: 0, revenue: 0 };
        }
        monthlyOrdersMap[monthKey].orders++;
        if (isPaid && st !== "cancelled") {
          monthlyOrdersMap[monthKey].revenue += price;
        }
      });

      // Prefer authoritative payments total if higher or present
      if (payments.length > 0) {
        const paymentRev = payments.reduce(
          (sum, p) => sum + (Number(p.amount) || 0),
          0
        );
        if (paymentRev > 0) verifiedRevenue = paymentRev;
      }

      // 4. Monthly User Growth Trend
      const userGrowthMap = {};
      users.forEach((u) => {
        const d = u.createdAt ? new Date(u.createdAt) : new Date();
        const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!userGrowthMap[monthKey]) {
          userGrowthMap[monthKey] = { month: monthKey, newUsers: 0 };
        }
        userGrowthMap[monthKey].newUsers++;
      });

      const userGrowth = Object.values(userGrowthMap).sort((a, b) =>
        a.month.localeCompare(b.month)
      );
      const monthlyTrends = Object.values(monthlyOrdersMap).sort((a, b) =>
        a.month.localeCompare(b.month)
      );

      const categoryPerformance = Object.values(categoryMap).sort(
        (a, b) => b.totalProducts - a.totalProducts
      );

      res.status(200).json({
        totalUsers: users.length,
        totalProducts: products.length,
        totalOrders: orders.length,
        verifiedRevenue,
        accountDistribution,
        productInventory,
        fulfillmentDistribution,
        userGrowth,
        monthlyTrends,
        categoryPerformance,
      });
    } catch (error) {
      console.error("Admin analytics error:", error.message || error);
      res.status(500).json({ message: "Failed to generate platform analytics" });
    }
  }
);

/**
 * POST /api/admin/refunds/process-queue
 * Administrative recovery endpoint to trigger processing of durable pending refund queue.
 */
router.post(
  "/api/admin/refunds/process-queue",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { maxBatch, maxRetries } = req.body || {};
      const result = await processPendingRefunds({ maxBatch, maxRetries });
      res.status(200).json({
        success: true,
        message: "Refund recovery queue processed",
        ...result,
      });
    } catch (error) {
      console.error("Admin refund queue processing error:", error.message || error);
      res.status(500).json({ message: "Failed to process refund recovery queue" });
    }
  }
);

// ──────────────────────────────────────────
// N. ADMIN DISPUTE MANAGEMENT & RESOLUTION
// ──────────────────────────────────────────

/**
 * GET /api/admin/disputes
 * Lists all customer disputes with status filtering, search, and pagination.
 */
router.get(
  "/api/admin/disputes",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { disputesCollection } = getCollections();
      if (!disputesCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const query = {};
      const statusParam = req.query.status && typeof req.query.status === "string" ? req.query.status.trim() : null;
      let statusFilterCondition = null;

      if (statusParam && statusParam !== "all") {
        if (statusParam === "resolved") {
          statusFilterCondition = {
            $or: [
              { status: "resolved" },
              { status: "resolved_buyer" },
              { status: "resolved_seller" },
            ],
          };
        } else if (statusParam === "resolved_buyer") {
          statusFilterCondition = {
            $or: [
              { status: "resolved_buyer" },
              { status: "resolved", resolution: "resolved_buyer" },
            ],
          };
        } else if (statusParam === "resolved_seller") {
          statusFilterCondition = {
            $or: [
              { status: "resolved_seller" },
              { status: "resolved", resolution: "resolved_seller" },
            ],
          };
        } else if (statusParam === "opened") {
          statusFilterCondition = { status: { $in: ["opened", "pending"] } };
        } else {
          statusFilterCondition = { status: statusParam };
        }
      }

      let searchCondition = null;
      if (req.query.search && typeof req.query.search === "string" && req.query.search.trim()) {
        const regex = new RegExp(escapeRegex(req.query.search.trim()), "i");
        searchCondition = {
          $or: [
            { productTitle: regex },
            { buyerEmail: regex },
            { sellerEmail: regex },
            { orderId: regex },
            { reason: regex },
          ],
        };
      }

      if (statusFilterCondition && searchCondition) {
        query.$and = [statusFilterCondition, searchCondition];
      } else if (statusFilterCondition) {
        Object.assign(query, statusFilterCondition);
      } else if (searchCondition) {
        Object.assign(query, searchCondition);
      }

      const total = await countDocs(disputesCollection, query);
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const skip = (page - 1) * limit;

      let cursor = disputesCollection.find(query).sort({ createdAt: -1 });
      if (typeof cursor.skip === "function") cursor = cursor.skip(skip);
      if (typeof cursor.limit === "function") cursor = cursor.limit(limit);

      const disputes = await cursor.toArray();

      res.status(200).json({
        disputes,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      });
    } catch (error) {
      console.error("Admin disputes fetch error:", error.message || error);
      res.status(500).json({ message: "Failed to fetch disputes" });
    }
  }
);

/**
 * PATCH /api/admin/disputes/:id/resolve
 * Resolves a customer dispute with an authoritative decision and notes.
 */
router.patch(
  "/api/admin/disputes/:id/resolve",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid dispute ID format" });
      }

      const { resolution, resolutionNotes, decisionNotes, decision } = req.body || {};
      const effectiveResolution = resolution || decision;
      const allowedResolutions = [
        "resolved_buyer",
        "resolved_seller",
        "dismissed",
        "resolved",
      ];

      if (!effectiveResolution || !allowedResolutions.includes(effectiveResolution)) {
        return res.status(400).json({
          message: `Invalid resolution. Must be one of: [${allowedResolutions.join(", ")}]`,
        });
      }

      const { disputesCollection, ordersCollection, paymentsCollection } = getCollections();
      if (!disputesCollection || !ordersCollection) {
        return res
          .status(503)
          .json({ message: "Service Unavailable: Database not connected" });
      }

      const dispute = await disputesCollection.findOne({ _id: new ObjectId(id) });
      if (!dispute) {
        return res.status(404).json({ message: "Dispute not found" });
      }

      const terminalStatuses = [
        "resolved",
        "resolved_buyer",
        "resolved_seller",
        "dismissed",
      ];
      if (terminalStatuses.includes(dispute.status) || dispute.status !== "opened") {
        return res
          .status(400)
          .json({ message: "Dispute has already been resolved" });
      }

      let nextStatus;
      if (effectiveResolution === "resolved_buyer") {
        nextStatus = "resolved_buyer";
      } else if (effectiveResolution === "resolved_seller") {
        nextStatus = "resolved_seller";
      } else if (effectiveResolution === "dismissed") {
        nextStatus = "dismissed";
      } else {
        nextStatus = "resolved";
      }

      const notes = typeof resolutionNotes === "string" ? resolutionNotes.trim() : (typeof decisionNotes === "string" ? decisionNotes.trim() : "");
      const now = new Date();

      // Look up related order
      let order = null;
      let orderQuery = null;
      if (dispute.orderId) {
        orderQuery = ObjectId.isValid(dispute.orderId)
          ? { _id: new ObjectId(dispute.orderId) }
          : { _id: dispute.orderId };
        order = await ordersCollection.findOne(orderQuery);
      }

      let finalRefundStatus = undefined;
      let refundId = undefined;
      let isRefundQueue = false;
      let refundSuccessAt = undefined;
      let refundError = undefined;

      // Handle financial resolution when adjudicated in favor of buyer
      if (effectiveResolution === "resolved_buyer") {
        if (order && order.paymentStatus === "paid") {
          // Never label as "refunded" unless confirmed by Stripe
          finalRefundStatus = "pending_refund";
          isRefundQueue = true;

          // Attempt immediate deterministic refund via Stripe if PaymentIntent is available
          let paymentIntentId =
            (order.transactionId && order.transactionId.startsWith("pi_") ? order.transactionId : null) ||
            (order.paymentId && order.paymentId.startsWith("pi_") ? order.paymentId : null);

          if (!paymentIntentId && paymentsCollection && order.paymentId) {
            const paymentDoc = await paymentsCollection.findOne({
              $or: [
                { session_id: order.paymentId },
                { transactionId: order.paymentId },
              ],
            });
            if (
              paymentDoc &&
              paymentDoc.transactionId &&
              paymentDoc.transactionId.startsWith("pi_")
            ) {
              paymentIntentId = paymentDoc.transactionId;
            }
          }

          if (paymentIntentId) {
            const stripe = getStripeInstance();
            const idempotencyKey = getRefundIdempotencyKey(
              order._id || id,
              "dispute_refund"
            );
            try {
              if (
                stripe &&
                stripe.refunds &&
                typeof stripe.refunds.create === "function"
              ) {
                const refund = await stripe.refunds.create(
                  {
                    payment_intent: paymentIntentId,
                    reason: "requested_by_customer",
                  },
                  { idempotencyKey }
                );

                if (
                  refund &&
                  (refund.status === "succeeded" || refund.status === "pending")
                ) {
                  // Only label as "refunded" when confirmed by Stripe with succeeded status
                  finalRefundStatus =
                    refund.status === "succeeded" ? "refunded" : "pending_refund";
                  refundId = refund.id;
                  isRefundQueue = finalRefundStatus !== "refunded";
                  if (finalRefundStatus === "refunded") {
                    refundSuccessAt = new Date();
                  }
                }
              }
            } catch (rErr) {
              console.error(
                "Immediate Stripe refund error on dispute resolution:",
                rErr.message || rErr
              );
              refundError = rErr.message || String(rErr);
              isRefundQueue = true;
            }
          }
        } else if (order) {
          finalRefundStatus = "not_applicable";
          isRefundQueue = false;
        }
      }

      // Update dispute record
      const disputeUpdate = {
        status: nextStatus,
        resolution: effectiveResolution,
        resolutionNotes: notes,
        resolvedBy: req.user.email,
        resolvedAt: now,
        updatedAt: now,
      };
      if (effectiveResolution === "resolved_buyer") {
        disputeUpdate.refundStatus = finalRefundStatus;
        if (refundId) disputeUpdate.refundId = refundId;
      }

      await disputesCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: disputeUpdate }
      );

      // Keep related order synchronized
      if (orderQuery) {
        const orderUpdate = {
          disputeStatus: nextStatus,
          disputeResolution: effectiveResolution,
          updatedAt: now,
        };
        if (effectiveResolution === "resolved_buyer") {
          orderUpdate.refundStatus = finalRefundStatus;
          orderUpdate.refundQueue = isRefundQueue;
          if (refundId) orderUpdate.refundId = refundId;
          if (refundSuccessAt) orderUpdate.refundSuccessAt = refundSuccessAt;
          if (refundError) orderUpdate.refundError = refundError;
        }

        await ordersCollection.updateOne(orderQuery, { $set: orderUpdate });

        // Update payment collection if present and refund was applied
        if (
          effectiveResolution === "resolved_buyer" &&
          paymentsCollection &&
          (refundId || finalRefundStatus === "refunded" || finalRefundStatus === "pending_refund")
        ) {
          const paymentUpdate = {
            refundStatus: finalRefundStatus,
            refundId: refundId || undefined,
            refundQueue: isRefundQueue,
            updatedAt: now,
          };
          if (finalRefundStatus === "refunded" && refundSuccessAt) {
            paymentUpdate.refundSuccessAt = refundSuccessAt;
          }
          await paymentsCollection.updateOne(
            { $or: [{ orderId: order._id }, { session_id: order.paymentId }] },
            { $set: paymentUpdate }
          );
        }
      }

      res.status(200).json({
        success: true,
        message: `Dispute marked as ${nextStatus}`,
        status: nextStatus,
        resolution: effectiveResolution,
        refundStatus: effectiveResolution === "resolved_buyer" ? finalRefundStatus : undefined,
        refundId: refundId || undefined,
      });
    } catch (error) {
      console.error("Admin resolve dispute error:", error.message || error);
      res.status(500).json({ message: "Failed to resolve dispute" });
    }
  }
);

module.exports = router;

