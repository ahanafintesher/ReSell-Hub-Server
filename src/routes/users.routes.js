const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const { verifyToken, validateUserIdentity } = require("../middleware/auth");

const router = express.Router();

/**
 * GET /api/users/profile
 * Returns authenticated user's profile details safely.
 */
router.get("/api/users/profile", verifyToken, async (req, res) => {
  try {
    if (!validateUserIdentity(req, res)) return;

    const { usersCollection } = getCollections();
    if (!usersCollection) {
      return res
        .status(503)
        .json({ message: "Service Unavailable: Database not connected" });
    }

    const email = req.user.email;
    const user = await usersCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({
      _id: user._id,
      name: user.name || "",
      email: user.email,
      role: user.role || "buyer",
      image: user.image || user.photo || "",
      phone: user.phone || "",
      location: user.location || "",
      status: user.status || "active",
      isVerified: Boolean(user.isVerified),
      createdAt: user.createdAt,
    });
  } catch (error) {
    console.error("Get profile error:", error.message || error);
    res.status(500).json({ message: "Failed to fetch user profile" });
  }
});

/**
 * PATCH /api/users/profile
 * Allows an authenticated user to update ONLY permitted fields:
 * - name
 * - image (or photo)
 * - phone
 * - location
 * Strictly preserves immutable fields (email, role, status, _id, createdAt).
 */
router.patch("/api/users/profile", verifyToken, async (req, res) => {
  try {
    if (!validateUserIdentity(req, res)) return;

    const { usersCollection } = getCollections();
    if (!usersCollection) {
      return res
        .status(503)
        .json({ message: "Service Unavailable: Database not connected" });
    }

    const updates = {};
    const body = req.body || {};

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return res.status(400).json({ message: "Invalid request payload" });
    }

    // 1. Name validation
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return res.status(400).json({ message: "Name cannot be empty" });
      }
      updates.name = body.name.trim();
    }

    // 2. Image / Photo URL validation
    if (body.image !== undefined || body.photo !== undefined) {
      const img = body.image || body.photo;
      if (typeof img === "string") {
        updates.image = img.trim();
        updates.photo = img.trim();
      }
    }

    // 3. Phone validation
    if (body.phone !== undefined) {
      if (typeof body.phone === "string") {
        updates.phone = body.phone.trim();
      }
    }

    // 4. Location validation
    if (body.location !== undefined) {
      if (typeof body.location === "string") {
        updates.location = body.location.trim();
      }
    }

    if (Object.keys(updates).length === 0) {
      return res
        .status(400)
        .json({ message: "No valid profile fields provided for update" });
    }

    updates.updatedAt = new Date();

    // Strictly derive identity from verified auth context
    const email = req.user.email;
    const query = { email };

    const result = await usersCollection.updateOne(query, { $set: updates });

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const updatedUser = await usersCollection.findOne(query);

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: {
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
        image: updatedUser.image || updatedUser.photo || "",
        phone: updatedUser.phone || "",
        location: updatedUser.location || "",
        status: updatedUser.status,
        isVerified: Boolean(updatedUser.isVerified),
        updatedAt: updatedUser.updatedAt,
      },
    });
  } catch (error) {
    console.error("Update profile error:", error.message || error);
    res.status(500).json({ message: "Failed to update user profile" });
  }
});

module.exports = router;
