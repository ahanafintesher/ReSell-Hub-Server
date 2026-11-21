const express = require("express");
const { getCollections } = require("../config/db");

const router = express.Router();

// ──────────────────────────────────────────
// CATEGORIES PRIORITY & SORTING CONFIGURATION
// ──────────────────────────────────────────

const PREDEFINED_CATEGORY_ORDER = [
  "Electronics",
  "Audio",
  "Wearables",
  "Accessories",
  "Fashion",
  "Furniture",
  "Vehicles",
  "Mobile Phones",
];

const CATEGORY_PRIORITY_MAP = new Map(
  PREDEFINED_CATEGORY_ORDER.map((name, index) => [name, index + 1])
);

/**
 * Resolves the numeric sorting priority for a category name.
 * - Predefined categories (Electronics through Mobile Phones): priorities 1 through 8
 * - Unknown / newly added categories: priority 9999 (appear after predefined categories)
 * - "Others": Number.MAX_SAFE_INTEGER (always guaranteed to appear at the very end)
 *
 * @param {string} name
 * @returns {number}
 */
function getCategoryPriority(name) {
  if (name === "Others") {
    return Number.MAX_SAFE_INTEGER;
  }
  if (CATEGORY_PRIORITY_MAP.has(name)) {
    return CATEGORY_PRIORITY_MAP.get(name);
  }
  return 9999;
}

/**
 * Sorts category objects according to business priority requirements:
 * 1. Known categories follow the exact predefined sequence:
 *    Electronics, Audio, Wearables, Accessories, Fashion, Furniture, Vehicles, Mobile Phones.
 * 2. Unexpected or newly added categories appear after the predefined categories (sorted alphabetically among themselves).
 * 3. "Others" always appears at the very end, even if unknown categories exist.
 *
 * @param {Array<object>} categories
 * @returns {Array<object>}
 */
function sortCategories(categories) {
  if (!Array.isArray(categories)) return [];

  return [...categories].sort((a, b) => {
    const priorityA = getCategoryPriority(a?.name);
    const priorityB = getCategoryPriority(b?.name);

    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }

    return (a?.name || "").localeCompare(b?.name || "");
  });
}

// ──────────────────────────────────────────
// CATEGORIES API
// ──────────────────────────────────────────

/**
 * GET /api/v1/categories, GET /api/categories, GET /categories
 * Public endpoint returning all active categories sorted by predefined business order.
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
        .toArray();

      const sanitizedCategories = categories.map((cat) => ({
        _id: cat._id,
        name: cat.name,
        description: cat.description,
        isActive: cat.isActive,
      }));

      const sortedCategories = sortCategories(sanitizedCategories);

      res.status(200).json({
        success: true,
        message: "Categories fetched successfully",
        data: sortedCategories,
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

// Attach helpers for direct unit testing without breaking router export
router.PREDEFINED_CATEGORY_ORDER = PREDEFINED_CATEGORY_ORDER;
router.CATEGORY_PRIORITY_MAP = CATEGORY_PRIORITY_MAP;
router.getCategoryPriority = getCategoryPriority;
router.sortCategories = sortCategories;

// ──────────────────────────────────────────
// FEATURED CATEGORIES API
// ──────────────────────────────────────────

/**
 * Filters and sorts categories for the featured categories endpoint:
 * 1. Only active categories (isActive: true).
 * 2. Predefined featured categories only (excludes "Others" and unknown categories).
 * 3. Exact custom priority order:
 *    Electronics (1), Audio (2), Wearables (3), Accessories (4),
 *    Fashion (5), Furniture (6), Vehicles (7), Mobile Phones (8).
 * 4. Maximum limit of 8 items.
 *
 * @param {Array<object>} categories
 * @param {number} [limit=8]
 * @returns {Array<object>}
 */
function getFeaturedCategories(categories, limit = 8) {
  if (!Array.isArray(categories)) return [];

  const eligible = categories.filter(
    (cat) => cat && cat.isActive === true && CATEGORY_PRIORITY_MAP.has(cat.name)
  );

  eligible.sort((a, b) => {
    return CATEGORY_PRIORITY_MAP.get(a.name) - CATEGORY_PRIORITY_MAP.get(b.name);
  });

  return eligible.slice(0, limit);
}

/**
 * GET /api/v1/featured, GET /api/featured, GET /featured
 * Public endpoint returning exactly 8 featured categories in custom business order.
 * Excludes inactive categories, "Others", and unknown categories.
 */
router.get(
  ["/api/v1/featured", "/api/featured", "/featured"],
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
          {
            isActive: true,
            name: { $in: PREDEFINED_CATEGORY_ORDER },
          },
          { projection: { _id: 1, name: 1, description: 1, isActive: 1 } }
        )
        .toArray();

      const sanitizedCategories = categories.map((cat) => ({
        _id: cat._id,
        name: cat.name,
        description: cat.description,
        isActive: cat.isActive,
      }));

      const featuredCategories = getFeaturedCategories(sanitizedCategories, 8);

      res.status(200).json({
        success: true,
        message: "Featured categories fetched successfully",
        data: featuredCategories,
      });
    } catch (error) {
      console.error("Featured categories fetch error:", error.message || error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch featured categories",
      });
    }
  }
);

router.getFeaturedCategories = getFeaturedCategories;

module.exports = router;
