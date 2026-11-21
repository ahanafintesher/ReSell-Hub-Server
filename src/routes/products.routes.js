const express = require("express");
const { ObjectId } = require("mongodb");
const { getCollections } = require("../config/db");
const {
  verifyToken,
  optionalVerifyToken,
  requireRole,
  validateUserIdentity,
} = require("../middleware/auth");
const {
  extractEmail,
  escapeRegex,
  sanitizeSellerPublicInfo,
} = require("../utils/helpers");

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

      // Section 5 Enforcement: Seller product submissions MUST always initialize as pending moderation.
      // Backend rejects client trust for status, moderationStatus, or visibility fields.
      if (req.user.role !== "admin") {
        product.status = "pending";
        product.moderationStatus = "pending";
        product.isPubliclyVisible = false;
      } else {
        product.status = product.status || "available";
        product.moderationStatus = product.moderationStatus || "approved";
        product.isPubliclyVisible =
          product.isPubliclyVisible !== undefined
            ? Boolean(product.isPubliclyVisible)
            : true;
      }

      product.createdAt = new Date();

      const result = await productsCollection.insertOne(product);
      res.status(201).send(result);
    } catch (error) {
      console.error("Create product error:", error.message || error);
      res.status(500).send({ message: "Failed to create product" });
    }
  },
);

// Get my products (Seller / Admin) - supports both string and object sellerInfo schemas
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

      const sellerEmail =
        req.user.role === "admin" && req.query.sellerInfo
          ? req.query.sellerInfo.trim()
          : req.user.email;

      const result = await productsCollection
        .find({
          $or: [
            { sellerInfo: sellerEmail },
            { "sellerInfo.email": sellerEmail },
          ],
        })
        .toArray();
      res.send(result);
    } catch (error) {
      console.error("Get my products error:", error.message || error);
      res.status(500).send({ message: "Failed to fetch products" });
    }
  },
);

// Get all products (Public with Search, Filter, Sort, Pagination; Admin can view all moderation statuses)
router.get("/api/products", optionalVerifyToken, async (req, res) => {
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

    // 4. Filter by status: enforce moderation visibility
    const isAdmin = Boolean(req.user && req.user.role === "admin");
    if (isAdmin) {
      if (
        req.query.status &&
        typeof req.query.status === "string" &&
        req.query.status.trim() !== "all"
      ) {
        query.status = req.query.status.trim();
      }
    } else {
      // Non-admin public visitors and buyers: strictly exclude pending & rejected products
      if (req.query.status && typeof req.query.status === "string") {
        const requestedStatus = req.query.status.trim();
        if (requestedStatus === "pending" || requestedStatus === "rejected") {
          // Never leak pending or rejected products to public / non-admin callers
          query.status = "__moderation_restricted__";
        } else if (
          requestedStatus === "sold" ||
          requestedStatus === "available"
        ) {
          query.status = requestedStatus;
          query.moderationStatus = { $nin: ["pending", "rejected"] };
        } else if (requestedStatus === "all") {
          query.status = { $nin: ["pending", "rejected"] };
          query.moderationStatus = { $nin: ["pending", "rejected"] };
        } else {
          query.status = requestedStatus;
          query.moderationStatus = { $nin: ["pending", "rejected"] };
        }
      } else {
        // Default public view: exclude pending and rejected listings
        query.status = { $nin: ["pending", "rejected"] };
        query.moderationStatus = { $nin: ["pending", "rejected"] };
      }
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
      if (
        sortParam === "price-low-to-high" ||
        sortParam === "asc" ||
        sortParam === "price_asc"
      ) {
        cursor = cursor.sort({ price: 1 });
      } else if (
        sortParam === "price-high-to-low" ||
        sortParam === "desc" ||
        sortParam === "price_desc"
      ) {
        cursor = cursor.sort({ price: -1 });
      } else if (sortParam === "newest" || sortParam === "latest") {
        cursor = cursor.sort({ createdAt: -1 });
      }
    }

    // 7. Bounded Pagination
    const isPaginated = Boolean(req.query.page || req.query.limit);

    if (isPaginated) {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(
        100,
        Math.max(1, parseInt(req.query.limit, 10) || 10),
      );
      const skip = (page - 1) * limit;

      const total =
        typeof productsCollection.countDocuments === "function"
          ? await productsCollection.countDocuments(query)
          : (await productsCollection.find(query).toArray()).length;

      if (typeof cursor.skip === "function") {
        cursor = cursor.skip(skip);
      }
      if (typeof cursor.limit === "function") {
        cursor = cursor.limit(limit);
      }

      const products = await cursor.toArray();
      const sanitizedProducts = products.map((p) => ({
        ...p,
        sellerInfo: sanitizeSellerPublicInfo(p.sellerInfo),
      }));

      return res.status(200).json({
        products: sanitizedProducts,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
      });
    }

    const rawList = await cursor.toArray();
    const result = rawList.map((p) => ({
      ...p,
      sellerInfo: sanitizeSellerPublicInfo(p.sellerInfo),
    }));
    res.set("X-Total-Count", String(result.length));
    res.send(result);
  } catch (error) {
    console.error("Get products error:", error.message || error);
    res.status(500).send({ message: "Failed to fetch products" });
  }
});

// Report a product (Authenticated)
router.post("/api/products/:id/report", verifyToken, async (req, res) => {
  try {
    if (!validateUserIdentity(req, res)) return;

    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid product ID format" });
    }

    const { reason, description } = req.body || {};
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({ message: "Report reason is required" });
    }

    const { productsCollection, reportsCollection } = getCollections();
    if (!productsCollection) {
      return res
        .status(503)
        .json({ message: "Service Unavailable: Database not connected" });
    }

    const product = await productsCollection.findOne({ _id: new ObjectId(id) });
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    if (reportsCollection) {
      // Prevent duplicate report spam from the same user for the same product
      const existingReport = await reportsCollection.findOne({
        productId: id,
        reporterEmail: req.user.email,
        status: "pending",
      });
      if (existingReport) {
        return res.status(409).json({
          message:
            "You have already submitted a pending report for this product",
        });
      }

      const reportDoc = {
        productId: id,
        productTitle: product.title || "Untitled Product",
        sellerInfo: extractEmail(product.sellerInfo) || product.sellerInfo,
        reporterEmail: req.user.email,
        reason: reason.trim(),
        description: typeof description === "string" ? description.trim() : "",
        status: "pending",
        createdAt: new Date(),
      };

      const result = await reportsCollection.insertOne(reportDoc);
      return res.status(201).json({
        success: true,
        message: "Product reported successfully",
        reportId: result.insertedId,
      });
    }

    res.status(200).json({
      success: true,
      message: "Report received",
    });
  } catch (error) {
    console.error("Report product error:", error.message || error);
    res.status(500).json({ message: "Failed to report product" });
  }
});

// Get featured products (Public)
router.get(
  ["/api/products/featured", "/api/featured-products", "/api/featured"],
  async (req, res) => {
    try {
      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res
          .status(503)
          .send({ message: "Service Unavailable: Database not connected" });
      }

      const raw = await productsCollection
        .find({
          status: "available",
          moderationStatus: { $nin: ["pending", "rejected"] },
        })
        .limit(6)
        .toArray();

      const result = raw.map((p) => ({
        ...p,
        sellerInfo: sanitizeSellerPublicInfo(p.sellerInfo),
      }));

      res.send(result);
    } catch (error) {
      console.error("Get featured products error:", error.message || error);
      res.status(500).send({ message: "Failed to fetch featured products" });
    }
  },
);

// Get a single product (Public for approved/available/sold listings; Owner Seller & Admin only for pending/rejected)
router.get("/api/products/:id", optionalVerifyToken, async (req, res) => {
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

    // Section 5 Security Guard: Pending and rejected products must remain strictly hidden from unauthenticated callers and unauthorized buyers
    const isPendingOrRejected =
      result.status === "pending" ||
      result.status === "rejected" ||
      result.moderationStatus === "pending" ||
      result.moderationStatus === "rejected";

    if (isPendingOrRejected) {
      const sellerEmail = extractEmail(result.sellerInfo);
      const isOwner =
        req.user && req.user.email && sellerEmail === req.user.email;
      const isAdmin = req.user && req.user.role === "admin";
      if (!isOwner && !isAdmin) {
        return res.status(404).send({ message: "Product not found" });
      }
    }

    const sanitized = {
      ...result,
      sellerInfo: sanitizeSellerPublicInfo(result.sellerInfo),
    };
    res.send(sanitized);
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
      if (req.user.role !== "admin" && existingSellerEmail !== req.user.email) {
        return res
          .status(403)
          .send({ message: "Forbidden: You do not own this product" });
      }

      // Section 5 Rules 4 & 8: Strip seller-manipulated moderation fields
      if (req.user.role !== "admin") {
        delete updatedProduct.status;
        delete updatedProduct.moderationStatus;
        delete updatedProduct.moderatedBy;
        delete updatedProduct.moderatedAt;
        delete updatedProduct.isPubliclyVisible;
        updatedProduct.sellerInfo = req.user.email;
      }
      updatedProduct.updatedAt = new Date();

      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedProduct },
      );

      res.send(result);
    } catch (error) {
      console.error("Edit product error:", error.message || error);
      res.status(500).send({ message: "Failed to update product" });
    }
  },
);

// ──────────────────────────────────────────
// Product Moderation Alias (Admin only)
// ──────────────────────────────────────────
router.patch(
  "/api/products/:id/moderate",
  verifyToken,
  requireRole("admin"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status, rejectionReason } = req.body || {};
      const { productsCollection } = getCollections();
      if (!productsCollection) {
        return res.status(503).json({ message: "Database not connected" });
      }
      const query = ObjectId.isValid(id)
        ? { _id: new ObjectId(id) }
        : { _id: id };
      const isApprovedOrAvailable =
        status === "approved" || status === "available";
      const updateDoc = {
        status: status === "approved" ? "available" : status,
        moderationStatus: status === "available" ? "approved" : status,
        isPubliclyVisible: isApprovedOrAvailable,
        moderatedBy: req.user.email,
        moderatedAt: new Date(),
        updatedAt: new Date(),
      };
      if (rejectionReason) updateDoc.rejectionReason = rejectionReason;
      const result = await productsCollection.updateOne(query, {
        $set: updateDoc,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  },
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
      if (req.user.role !== "admin" && existingSellerEmail !== req.user.email) {
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
  },
);

module.exports = router;
