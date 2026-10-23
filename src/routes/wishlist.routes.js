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
// WISHLIST API
// ──────────────────────────────────────────

// Get wishlist items by user (Buyer / Admin)
router.get(
  "/api/wishlist",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      const { wishlistCollection } = getCollections();
      if (!wishlistCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const userInfo =
        req.user.role === "admin" && req.query.userInfo
          ? req.query.userInfo
          : req.user.email;

      const result = await wishlistCollection.find({ userInfo }).toArray();
      res.send(result);
    } catch (error) {
      console.error("Get wishlist error:", error.message || error);
      res.status(500).send({ message: "Failed to fetch wishlist" });
    }
  }
);

// Add a wishlist item (Buyer / Admin)
router.post(
  "/api/wishlist",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      if (!validateUserIdentity(req, res)) return;

      const { wishlistCollection } = getCollections();
      if (!wishlistCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const { product } = req.body || {};
      const userInfo = req.user.email;

      if (!product || typeof product !== "object" || !product._id) {
        return res.status(400).send({ message: "Product is required" });
      }

      const existingItem = await wishlistCollection.findOne({
        "product._id": product._id,
        userInfo,
      });

      if (existingItem) {
        return res.status(409).send({
          message: "Product already exists in wishlist",
        });
      }

      const result = await wishlistCollection.insertOne({
        product,
        userInfo,
        createdAt: new Date(),
      });

      res.status(201).send(result);
    } catch (error) {
      console.error("Add wishlist error:", error.message || error);
      res.status(500).send({ message: "Failed to add to wishlist" });
    }
  }
);

// Remove wishlist item (Buyer / Admin)
router.delete(
  "/api/wishlist/:id",
  verifyToken,
  requireRole("buyer", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res
          .status(400)
          .send({ message: "Invalid wishlist item ID format" });
      }

      const { wishlistCollection } = getCollections();
      if (!wishlistCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const existing = await wishlistCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!existing) {
        return res.status(404).send({ message: "Wishlist item not found" });
      }

      const existingUserEmail = extractEmail(existing.userInfo);
      if (
        req.user.role !== "admin" &&
        existingUserEmail !== req.user.email
      ) {
        return res.status(403).send({
          message: "Forbidden: You do not own this wishlist item",
        });
      }

      const result = await wishlistCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    } catch (error) {
      console.error("Delete wishlist error:", error.message || error);
      res.status(500).send({ message: "Failed to delete wishlist item" });
    }
  }
);

module.exports = router;
