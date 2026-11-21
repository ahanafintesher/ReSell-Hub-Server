const express = require("express");
const { getCollections } = require("../config/db");

const router = express.Router();

// ──────────────────────────────────────────
// CATEGORIES API
// ──────────────────────────────────────────

/**
 * GET /api/v1/categories, GET /api/categories, GET /categories
 * Public endpoint returning all active categories sorted alphabetically by name.
 * Excludes inactive categories and does not expose internal/unnecessary MongoDB fields.
 */
router.get(
  ["/api/v1/categories", "/api/categories", "/categories"],
  async (req, res) => {
    try {
      const { categoriesCollection } = getCollections();

      if (!categoriesCollection) {
        return res.status(503).json({
          success: false,
          message: "Service Unavailable: Database not connected",
        });
      }

      const categories = await categoriesCollection
        .find(
          { isActive: true },
          { projection: { _id: 1, name: 1, description: 1, isActive: 1 } }
        )
        .sort({ name: 1 })
        .toArray();

      const sanitizedCategories = categories.map((cat) => ({
        _id: cat._id,
        name: cat.name,
        description: cat.description,
        isActive: cat.isActive,
      }));

      res.status(200).json({
        success: true,
        message: "Categories fetched successfully",
        data: sanitizedCategories,
      });
    } catch (error) {
      console.error("Categories fetch error:", error.message || error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch categories",
      });
    }
  }
);

module.exports = router;
