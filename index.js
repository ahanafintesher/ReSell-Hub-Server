const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;

// Middleware
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// Better Auth JWT & JWKS Configuration
const JWKS_URL =
  process.env.JWKS_URL || "http://localhost:3000/api/auth/jwks";
const JWT_ISSUER = (
  process.env.JWT_ISSUER ||
  process.env.BETTER_AUTH_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");
const JWT_AUDIENCE = (
  process.env.JWT_AUDIENCE ||
  process.env.BETTER_AUTH_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

// MongoDB Client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database;
let productsCollection;
let reviewsCollection;
let wishlistCollection;
let paymentsCollection;
let ordersCollection;
let usersCollection;

// Auth Middleware: Verify Signature, Expiration, Issuer, and Audience
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res
      .status(401)
      .json({ message: "Unauthorized: Missing Authorization header" });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return res
      .status(401)
      .json({ message: "Unauthorized: Invalid Authorization header format" });
  }

  const token = parts[1];
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    req.user = {
      ...payload,
      id: payload.sub,
      role: payload.role || null, // Never assume 'buyer' if missing
    };

    next();
  } catch (error) {
    console.error("JWT Verification failed:", error.message);
    return res
      .status(403)
      .json({ message: "Forbidden: Invalid, expired, or untrusted token" });
  }
};

// Server-controlled role verification helper
const getUserRole = async (user) => {
  if (user.role) return user.role;
  if (usersCollection && user.email) {
    const dbUser = await usersCollection.findOne({ email: user.email });
    if (dbUser && dbUser.role) {
      return dbUser.role;
    }
  }
  return null;
};

// Role Enforcement Middleware: Validates permissions against server-controlled source
const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    if (!req.user) {
      return res
        .status(401)
        .json({ message: "Unauthorized: User not authenticated" });
    }

    let role = req.user.role;
    if (!role) {
      role = await getUserRole(req.user);
      req.user.role = role;
    }

    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({
        message: `Forbidden: Requires one of [${allowedRoles.join(", ")}] permissions`,
      });
    }

    // Check if user is blocked in database
    if (usersCollection && req.user.email) {
      const dbUser = await usersCollection.findOne({ email: req.user.email });
      if (dbUser && dbUser.status === "blocked") {
        return res
          .status(403)
          .json({ message: "Forbidden: Account is blocked" });
      }
    }

    next();
  };
};

app.get("/", (req, res) => {
  res.send("Hello World!");
});

async function run() {
  try {
    await client.connect();

    database = client.db("resell_hub");
    productsCollection = database.collection("products");
    reviewsCollection = database.collection("reviews");
    wishlistCollection = database.collection("wishlist");
    paymentsCollection = database.collection("payments");
    ordersCollection = database.collection("orders");
    usersCollection = database.collection("user");

    // ──────────────────────────────────────────
    // PRODUCTS API
    // ──────────────────────────────────────────

    // Post a product (Seller / Admin)
    app.post(
      "/api/products",
      verifyToken,
      requireRole("seller", "admin"),
      async (req, res) => {
        try {
          const product = req.body;
          if (req.user.role !== "admin" || !product.sellerInfo) {
            product.sellerInfo = req.user.email;
          }
          product.createdAt = new Date();

          const result = await productsCollection.insertOne(product);
          res.status(201).send(result);
        } catch (error) {
          console.error("Create product error:", error);
          res.status(500).send({ message: "Failed to create product" });
        }
      }
    );

    // Get my products (Seller / Admin)
    app.get(
      "/api/my-products",
      verifyToken,
      requireRole("seller", "admin"),
      async (req, res) => {
        try {
          const sellerInfo =
            req.user.role === "admin" && req.query.sellerInfo
              ? req.query.sellerInfo
              : req.user.email;

          const result = await productsCollection
            .find({ sellerInfo })
            .toArray();
          res.send(result);
        } catch (error) {
          console.error("Get my products error:", error);
          res.status(500).send({ message: "Failed to fetch products" });
        }
      }
    );

    // Get all products (Public)
    app.get("/api/products", async (req, res) => {
      try {
        const result = await productsCollection.find({}).toArray();
        res.send(result);
      } catch (error) {
        console.error("Get products error:", error);
        res.status(500).send({ message: "Failed to fetch products" });
      }
    });

    // Get featured products (Public)
    app.get("/api/featured", async (req, res) => {
      try {
        const result = await productsCollection.find({}).limit(6).toArray();
        res.send(result);
      } catch (error) {
        console.error("Get featured products error:", error);
        res.status(500).send({ message: "Failed to fetch featured products" });
      }
    });

    // Get a single product (Public)
    app.get("/api/products/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid product ID format" });
        }

        const query = { _id: new ObjectId(id) };
        const result = await productsCollection.findOne(query);
        if (!result) {
          return res.status(404).send({ message: "Product not found" });
        }
        res.send(result);
      } catch (error) {
        console.error("Get single product error:", error);
        res.status(500).send({ message: "Failed to fetch product" });
      }
    });

    // Edit a product (Owner Seller / Admin)
    app.patch(
      "/api/products/:id",
      verifyToken,
      requireRole("seller", "admin"),
      async (req, res) => {
        try {
          const { id } = req.params;
          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid product ID format" });
          }

          const updatedProduct = { ...req.body };
          delete updatedProduct._id;

          const existing = await productsCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!existing) {
            return res.status(404).send({ message: "Product not found" });
          }

          // Ownership verification
          if (
            req.user.role !== "admin" &&
            existing.sellerInfo !== req.user.email
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
          console.error("Edit product error:", error);
          res.status(500).send({ message: "Failed to update product" });
        }
      }
    );

    // Delete a product (Owner Seller / Admin)
    app.delete(
      "/api/products/:id",
      verifyToken,
      requireRole("seller", "admin"),
      async (req, res) => {
        try {
          const { id } = req.params;
          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid product ID format" });
          }

          const existing = await productsCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!existing) {
            return res.status(404).send({ message: "Product not found" });
          }

          // Ownership verification
          if (
            req.user.role !== "admin" &&
            existing.sellerInfo !== req.user.email
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
          console.error("Delete product error:", error);
          res.status(500).send({ message: "Failed to delete product" });
        }
      }
    );

    // ──────────────────────────────────────────
    // REVIEWS API
    // ──────────────────────────────────────────

    // Post review (Authenticated)
    app.post("/api/reviews", verifyToken, async (req, res) => {
      try {
        const review = req.body;
        if (req.user.role !== "admin") {
          review.userEmail = req.user.email;
          if (review.review && typeof review.review === "object") {
            review.review.userEmail = req.user.email;
          }
        }
        review.createdAt = new Date();

        const result = await reviewsCollection.insertOne(review);
        res.status(201).send(result);
      } catch (error) {
        console.error("Post review error:", error);
        res.status(500).send({ message: "Failed to post review" });
      }
    });

    // Get reviews by productId (Public)
    app.get("/api/reviews", async (req, res) => {
      try {
        const productId = req.query.productId;
        const query = productId ? { "review.productId": productId } : {};
        const result = await reviewsCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error("Get reviews error:", error);
        res.status(500).send({ message: "Failed to fetch reviews" });
      }
    });

    // Get average rating of a product (Public)
    app.get("/api/reviews/avarage-rating", async (req, res) => {
      try {
        const productId = req.query.productId;
        if (!productId) {
          return res
            .status(400)
            .send({ message: "productId query parameter is required" });
        }

        const result = await reviewsCollection
          .aggregate([
            {
              $match: {
                "review.productId": productId,
              },
            },
            {
              $group: {
                _id: "$review.productId",
                avarageRating: { $avg: "$review.rating" },
              },
            },
          ])
          .toArray();

        if (result.length === 0) {
          return res.send({ avarageRating: 0 });
        }
        res.send({
          avarageRating: Number(result[0].avarageRating.toFixed(1)),
        });
      } catch (error) {
        console.error("Average rating error:", error);
        res.status(500).send({ message: "Failed to calculate average rating" });
      }
    });

    // ──────────────────────────────────────────
    // ORDERS API
    // ──────────────────────────────────────────

    // Post an order (Buyer / Admin)
    app.post(
      "/api/orders",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
          const orderData = req.body;
          if (req.user.role !== "admin" || !orderData.buyerInfo) {
            orderData.buyerInfo = req.user.email;
          }

          const result = await ordersCollection.insertOne({
            ...orderData,
            orderStatus: orderData.orderStatus || "pending",
            createdAt: new Date(),
          });
          res.status(201).send(result);
        } catch (error) {
          console.error("Post order error:", error);
          res.status(500).send({ message: "Failed to place order" });
        }
      }
    );

    // Get orders by sellerInfo (Seller / Admin)
    app.get(
      "/api/seller/orders",
      verifyToken,
      requireRole("seller", "admin"),
      async (req, res) => {
        try {
          const sellerInfo =
            req.user.role === "admin" && req.query.sellerInfo
              ? req.query.sellerInfo
              : req.user.email;

          const result = await ordersCollection.find({ sellerInfo }).toArray();
          res.send(result);
        } catch (error) {
          console.error("Get seller orders error:", error);
          res.status(500).send({ message: "Failed to fetch orders" });
        }
      }
    );

    // Get orders by buyerInfo (Buyer / Admin)
    app.get(
      "/api/buyer/orders",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
          const buyerInfo =
            req.user.role === "admin" && req.query.buyerInfo
              ? req.query.buyerInfo
              : req.user.email;

          const result = await ordersCollection.find({ buyerInfo }).toArray();
          res.send(result);
        } catch (error) {
          console.error("Get buyer orders error:", error);
          res.status(500).send({ message: "Failed to fetch orders" });
        }
      }
    );

    // Update order status (Seller / Admin)
    app.patch(
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

          // Only the seller of the product or admin can update status
          if (
            req.user.role !== "admin" &&
            order.sellerInfo !== req.user.email
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
          console.error("Update order status error:", error);
          res.status(500).send({ message: "Failed to update order status" });
        }
      }
    );

    // Cancel order (Buyer / Admin)
    app.delete(
      "/api/orders/:orderId",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
          const { orderId } = req.params;
          if (!ObjectId.isValid(orderId)) {
            return res.status(400).send({ message: "Invalid order ID format" });
          }

          const order = await ordersCollection.findOne({
            _id: new ObjectId(orderId),
          });

          if (!order) {
            return res.status(404).send({
              message: "Order not found",
            });
          }

          // Ownership check
          if (
            req.user.role !== "admin" &&
            order.buyerInfo !== req.user.email
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

          const result = await ordersCollection.deleteOne({
            _id: new ObjectId(orderId),
          });

          res.send({
            success: true,
            message: "Order cancelled successfully",
            result,
          });
        } catch (error) {
          console.error("Cancel order error:", error);
          res.status(500).send({
            success: false,
            message: "Failed to cancel order",
          });
        }
      }
    );

    // ──────────────────────────────────────────
    // WISHLIST API
    // ──────────────────────────────────────────

    // Get wishlist items by user (Buyer / Admin)
    app.get(
      "/api/wishlist",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
          const userInfo =
            req.user.role === "admin" && req.query.userInfo
              ? req.query.userInfo
              : req.user.email;

          const result = await wishlistCollection.find({ userInfo }).toArray();
          res.send(result);
        } catch (error) {
          console.error("Get wishlist error:", error);
          res.status(500).send({ message: "Failed to fetch wishlist" });
        }
      }
    );

    // Add a wishlist item (Buyer / Admin)
    app.post(
      "/api/wishlist",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
          const { product } = req.body;
          const userInfo = req.user.email;

          if (!product || !product._id) {
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
          console.error("Add wishlist error:", error);
          res.status(500).send({ message: "Failed to add to wishlist" });
        }
      }
    );

    // Remove wishlist item (Buyer / Admin)
    app.delete(
      "/api/wishlist/:id",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
          const { id } = req.params;
          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid wishlist item ID format" });
          }

          const existing = await wishlistCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!existing) {
            return res.status(404).send({ message: "Wishlist item not found" });
          }

          if (
            req.user.role !== "admin" &&
            existing.userInfo !== req.user.email
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
          console.error("Delete wishlist error:", error);
          res.status(500).send({ message: "Failed to delete wishlist item" });
        }
      }
    );

    // ──────────────────────────────────────────
    // PAYMENTS HISTORY API
    // ──────────────────────────────────────────

    app.post(
      "/api/payments",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
          const payment = req.body;
          if (req.user.role !== "admin") {
            payment.metadata = {
              ...(payment.metadata || {}),
              userEmail: req.user.email,
            };
          }
          payment.createdAt = new Date();

          const result = await paymentsCollection.insertOne(payment);
          res.status(201).send(result);
        } catch (error) {
          console.error("Post payment error:", error);
          res.status(500).send({ message: "Failed to record payment" });
        }
      }
    );

    app.get(
      "/api/payments",
      verifyToken,
      requireRole("buyer", "admin"),
      async (req, res) => {
        try {
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
          console.error("Get payments error:", error);
          res.status(500).send({ message: "Failed to fetch payments" });
        }
      }
    );

    // ──────────────────────────────────────────
    // ADMIN API
    // ──────────────────────────────────────────

    // Get all users (Admin only)
    app.get(
      "/api/admin/users",
      verifyToken,
      requireRole("admin"),
      async (req, res) => {
        try {
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
          console.error("Get admin users error:", error);
          res.status(500).send({
            success: false,
            message: "Failed to fetch users",
          });
        }
      }
    );

    // Get single user by ID (Admin only)
    app.get(
      "/api/admin/users/:id",
      verifyToken,
      requireRole("admin"),
      async (req, res) => {
        try {
          const { id } = req.params;
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
          console.error("Get user error:", error);
          res.status(500).send({
            message: "Failed to fetch user",
          });
        }
      }
    );

    // Update user status (Admin only)
    app.patch(
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
          console.error("Update user status error:", error);
          res.status(500).send({
            message: "Failed to update user status",
          });
        }
      }
    );

    // Delete user (Admin only)
    app.delete(
      "/api/admin/users/:id",
      verifyToken,
      requireRole("admin"),
      async (req, res) => {
        try {
          const { id } = req.params;
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
          console.error("Delete user error:", error);
          res.status(500).send({
            message: "Failed to delete user",
          });
        }
      }
    );

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (error) {
    console.error("MongoDB connection or setup error:", error);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
