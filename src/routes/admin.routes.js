const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { verifyToken, requireRole } = require("../middleware/auth");

const router = express.Router();

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

// Admin Platform Analytics and Statistics (Admin only)
router.get(
  "/api/admin/stats",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { usersCollection, productsCollection, ordersCollection, paymentsCollection } =
        getCollections();

      const countHelper = async (col) => {
        if (!col) return 0;
        if (typeof col.countDocuments === "function") {
          return await col.countDocuments({});
        }
        const docs = await col.find({}).toArray();
        return docs.length;
      };

      const [totalUsers, totalProducts, totalOrders] = await Promise.all([
        countHelper(usersCollection),
        countHelper(productsCollection),
        countHelper(ordersCollection),
      ]);

      // Calculate total revenue from paid payments
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

// Alias /api/admin/analytics
router.get("/api/admin/analytics", verifyToken, requireRole("admin"), (req, res) => {
  res.redirect("/api/admin/stats");
});

module.exports = router;
