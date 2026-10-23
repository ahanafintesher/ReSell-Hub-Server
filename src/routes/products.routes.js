const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const {
  verifyToken,
  requireRole,
  validateUserIdentity,
} = require("../middleware/auth");
const { extractEmail, escapeRegex } = require("../utils/helpers");

const router = express.Router();

// ──────────────────────────────────────────
// PRODUCTS API
// ──────────────────────────────────────────

// Post a product (Seller / Admin)
router.post(
  "/api/products",
  verifyToken,
  requireRole("seller", "admin"),
  async (req, res) => {
    try {
      if (!validateUserIdentity(req, res)) return;

      const product = req.body;
      if (!product || typeof product !== "object" || Array.isArray(product)) {
        return res.status(400).send({ message: "Product data is required" });
      }

      if (
        !product.title ||
        typeof product.title !== "string" ||
        !product.title.trim()
      ) {
        return res
          .status(400)
          .send({ message: "Product title is required and cannot be empty" });
      }

      if (product.price !== undefined) {
        const numPrice = Number(product.price);
        if (isNaN(numPrice) || numPrice < 0) {
          return res
            .status(400)
            .send({ message: "Product price must be a non-negative number" });
        }
        product.price = numPrice;
      }

      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      if (req.user.role !== "admin" || !product.sellerInfo) {
        product.sellerInfo = req.user.email;
      }
      product.sellerName =
        product.sellerName || req.user.name || req.user.email;
      product.status = product.status || "available";
      product.createdAt = new Date();

      const result = await productsCollection.insertOne(product);
      res.status(201).send(result);
    } catch (error) {
      console.error("Create product error:", error.message || error);
      res.status(500).send({ message: "Failed to create product" });
    }
  }
);

// Get my products (Seller / Admin)
router.get(
  "/api/my-products",
  verifyToken,
  requireRole("seller", "admin"),
  async (req, res) => {
    try {
      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const sellerInfo =
        req.user.role === "admin" && req.query.sellerInfo
          ? req.query.sellerInfo
          : req.user.email;

      const result = await productsCollection
        .find({ sellerInfo })
        .toArray();
      res.send(result);
    } catch (error) {
      console.error("Get my products error:", error.message || error);
      res.status(500).send({ message: "Failed to fetch products" });
    }
  }
);

// Get all products (Public with Search, Filter, Sort, Pagination)
router.get("/api/products", async (req, res) => {
  try {
    const { productsCollection } = getCollections();
    if (!productsCollection) {
      return res
        .status(503)
        .send({ message: "Service Unavailable: Database not connected" });
    }

    const query = {};

    // 1. Search by name/title
    const search = req.query.search || req.query.name || req.query.title;
    if (search && typeof search === "string" && search.trim()) {
      query.title = { $regex: escapeRegex(search.trim()), $options: "i" };
    }

    // 2. Filter by category
    if (req.query.category && typeof req.query.category === "string") {
      query.category = {
        $regex: `^${escapeRegex(req.query.category.trim())}$`,
        $options: "i",
      };
    }

    // 3. Filter by condition
    if (req.query.condition && typeof req.query.condition === "string") {
      query.condition = req.query.condition.trim();
    }

    // 4. Filter by status (optional)
    if (req.query.status && typeof req.query.status === "string") {
      query.status = req.query.status.trim();
    }

    // 5. Filter by price range
    if (req.query.minPrice || req.query.maxPrice) {
      query.price = {};
      if (req.query.minPrice && !isNaN(Number(req.query.minPrice))) {
        query.price.$gte = Number(req.query.minPrice);
      }
      if (req.query.maxPrice && !isNaN(Number(req.query.maxPrice))) {
        query.price.$lte = Number(req.query.maxPrice);
      }
    }

    let cursor = productsCollection.find(query);

    // 6. Sorting
    const sortParam = req.query.sort;
    if (sortParam) {
      if (sortParam === "price-low-to-high" || sortParam === "asc" || sortParam === "price_asc") {
        cursor = cursor.sort({ price: 1 });
      } else if (sortParam === "price-high-to-low" || sortParam === "desc" || sortParam === "price_desc") {
        cursor = cursor.sort({ price: -1 });
      } else if (sortParam === "newest" || sortParam === "latest") {
        cursor = cursor.sort({ createdAt: -1 });
      }
    }

    // 7. Pagination
    if (req.query.page || req.query.limit) {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
      const skip = (page - 1) * limit;

      if (typeof cursor.skip === "function") {
        cursor = cursor.skip(skip);
      }
      if (typeof cursor.limit === "function") {
        cursor = cursor.limit(limit);
      }
    }

    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error("Get products error:", error.message || error);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});

// Get featured products (Public)
router.get("/api/featured", async (req, res) => {
  try {
    const { productsCollection } = getCollections();
    if (!productsCollection) {
      return res
        .status(503)
        .send({ message: "Service Unavailable: Database not connected" });
    }

    const result = await productsCollection.find({}).limit(6).toArray();
    res.send(result);
  } catch (error) {
    console.error("Get featured products error:", error.message || error);
    res.status(500).send({ message: "Failed to fetch featured products" });
  }
});

// Get a single product (Public)
router.get("/api/products/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid product ID format" });
    }

    const { productsCollection } = getCollections();
    if (!productsCollection) {
      return res
        .status(503)
        .send({ message: "Service Unavailable: Database not connected" });
    }

    const query = { _id: new ObjectId(id) };
    const result = await productsCollection.findOne(query);
    if (!result) {
      return res.status(404).send({ message: "Product not found" });
    }
    res.send(result);
  } catch (error) {
    console.error("Get single product error:", error.message || error);
    res.status(500).send({ message: "Failed to fetch product" });
  }
});

// Edit a product (Owner Seller / Admin)
router.patch(
  "/api/products/:id",
  verifyToken,
  requireRole("seller", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid product ID format" });
      }

      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const updatedProduct = { ...req.body };
      delete updatedProduct._id;

      if (updatedProduct.price !== undefined) {
        const numPrice = Number(updatedProduct.price);
        if (isNaN(numPrice) || numPrice < 0) {
          return res
            .status(400)
            .send({ message: "Product price must be a non-negative number" });
        }
        updatedProduct.price = numPrice;
      }

      const existing = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!existing) {
        return res.status(404).send({ message: "Product not found" });
      }

      // Ownership verification
      const existingSellerEmail = extractEmail(existing.sellerInfo);
      if (
        req.user.role !== "admin" &&
        existingSellerEmail !== req.user.email
      ) {
        return res
          .status(403)
          .send({ message: "Forbidden: You do not own this product" });
      }

      if (req.user.role !== "admin") {
        updatedProduct.sellerInfo = req.user.email;
      }
      updatedProduct.updatedAt = new Date();

      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedProduct }
      );

      res.send(result);
    } catch (error) {
      console.error("Edit product error:", error.message || error);
      res.status(500).send({ message: "Failed to update product" });
    }
  }
);

// Delete a product (Owner Seller / Admin)
router.delete(
  "/api/products/:id",
  verifyToken,
  requireRole("seller", "admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).send({ message: "Invalid product ID format" });
      }

      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const existing = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      if (!existing) {
        return res.status(404).send({ message: "Product not found" });
      }

      // Ownership verification
      const existingSellerEmail = extractEmail(existing.sellerInfo);
      if (
        req.user.role !== "admin" &&
        existingSellerEmail !== req.user.email
      ) {
        return res
          .status(403)
          .send({ message: "Forbidden: You do not own this product" });
      }

      const result = await productsCollection.deleteOne({
        _id: new ObjectId(id),
      });

      res.send({
        success: true,
        message: "Product deleted successfully",
        result,
      });
    } catch (error) {
      console.error("Delete product error:", error.message || error);
      res.status(500).send({ message: "Failed to delete product" });
    }
  }
);

module.exports = router;
