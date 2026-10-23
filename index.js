const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;
const uri = process.env.MONGODB_URI;

// Stripe instance initialized with secret key from environment
let stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const setStripeInstance = (instance) => {
  stripeInstance = instance;
};

// Database and collection references (declared before route closures)
let database;
let productsCollection;
let reviewsCollection;
let wishlistCollection;
let paymentsCollection;
let ordersCollection;
let usersCollection;

// Middleware
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "stripe-signature"],
  })
);

// ──────────────────────────────────────────
// STRIPE WEBHOOK API (Raw Body Handler)
// MUST be registered BEFORE express.json() to preserve unmodified raw body Buffer
// ──────────────────────────────────────────
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error(
        "Stripe webhook configuration error: STRIPE_WEBHOOK_SECRET is not configured"
      );
      return res
        .status(500)
        .json({ error: "Webhook secret is not configured" });
    }

    if (!sig) {
      console.error(
        "Stripe webhook verification error: Missing stripe-signature header"
      );
      return res
        .status(400)
        .json({ error: "Missing stripe-signature header" });
    }

    if (!req.body || (Buffer.isBuffer(req.body) && req.body.length === 0)) {
      console.error("Stripe webhook error: Empty request payload");
      return res.status(400).json({ error: "Empty request payload" });
    }

    let event;
    try {
      event = stripeInstance.webhooks.constructEvent(
        req.body,
        sig,
        webhookSecret
      );
    } catch (err) {
      console.error(
        "Stripe webhook signature verification failed:",
        err.message
      );
      return res.status(400).json({
        error: `Webhook signature verification failed: ${err.message}`,
      });
    }

    // Ensure database connection is ready
    if (!paymentsCollection || !ordersCollection) {
      console.error("Stripe webhook error: Database collections not ready");
      return res
        .status(503)
        .json({ error: "Service unavailable: Database not connected" });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          // Only process paid checkout sessions
          if (session.payment_status !== "paid") {
            console.log(
              `Stripe webhook: Checkout session ${session.id} payment_status is '${session.payment_status}', skipping order creation`
            );
            return res
              .status(200)
              .json({ received: true, status: session.payment_status });
          }

          const sessionId = session.id;
          const paymentIntentId = session.payment_intent || null;
          const metadata = session.metadata || {};
          const productId = metadata.productId;

          // 1. Idempotency Check: check if already processed in payments or orders
          const existingPayment =
            (await paymentsCollection.findOne({ session_id: sessionId })) ||
            (paymentIntentId
              ? await paymentsCollection.findOne({ transactionId: paymentIntentId })
              : null) ||
            (await paymentsCollection.findOne({ transactionId: sessionId }));

          const existingOrder =
            (await ordersCollection.findOne({ paymentId: sessionId })) ||
            (paymentIntentId
              ? await ordersCollection.findOne({ paymentId: paymentIntentId })
              : null);

          if (existingPayment && existingOrder) {
            console.log(
              `Stripe webhook: Session ${sessionId} already processed (idempotent skip)`
            );
            return res
              .status(200)
              .json({ received: true, message: "Already processed" });
          }

          // 2. Retrieve authoritative product & price from database
          let product = null;
          if (productsCollection && productId) {
            const productQuery = ObjectId.isValid(productId)
              ? { _id: new ObjectId(productId) }
              : { _id: productId };
            product = await productsCollection.findOne(productQuery);
          }

          // Authoritative price check
          let authoritativePrice;
          if (product && product.price != null) {
            authoritativePrice = Number(product.price);
            const expectedAmountCents = Math.round(authoritativePrice * 100);

            // Security check: Validate against client-manipulated amount in session
            if (
              session.amount_total != null &&
              session.amount_total < expectedAmountCents
            ) {
              console.error(
                "Stripe webhook security error: Price mismatch detected",
                {
                  sessionId,
                  paidCents: session.amount_total,
                  expectedCents: expectedAmountCents,
                  productId,
                }
              );
              return res.status(400).json({
                error:
                  "Security validation error: Paid amount does not match authoritative price",
              });
            }
          } else if (metadata.price != null && !isNaN(Number(metadata.price))) {
            authoritativePrice = Number(metadata.price);
          } else if (session.amount_total != null) {
            authoritativePrice = session.amount_total / 100;
          } else {
            authoritativePrice = 0;
          }

          const buyerEmail =
            metadata.userEmail ||
            session.customer_details?.email ||
            session.customer_email ||
            "unknown@example.com";

          const buyerName =
            metadata.buyerName ||
            session.customer_details?.name ||
            "Anonymous";

          const sellerInfo = product
            ? typeof product.sellerInfo === "object"
              ? product.sellerInfo?.email || product.sellerInfo
              : product.sellerInfo || "not found"
            : metadata.sellerInfo || "not found";

          const sellerName =
            product?.sellerName ||
            (typeof product?.sellerInfo === "object"
              ? product?.sellerInfo?.name
              : metadata.sellerName || "N/A");

          const productTitle =
            product?.title || metadata.title || "Untitled Product";

          // 3. Insert or update order
          let orderId = null;
          if (existingOrder) {
            orderId = existingOrder._id;
            if (existingOrder.paymentStatus !== "paid") {
              await ordersCollection.updateOne(
                { _id: existingOrder._id },
                { $set: { paymentStatus: "paid", updatedAt: new Date() } }
              );
            }
          } else {
            const orderDoc = {
              paymentId: sessionId,
              transactionId: paymentIntentId || sessionId,
              productId: productId || (product ? product._id.toString() : null),
              productTitle,
              price: authoritativePrice,
              sellerName,
              sellerInfo,
              buyerName,
              buyerInfo: buyerEmail,
              paymentStatus: "paid",
              orderStatus: "pending",
              createdAt: new Date(),
            };
            const orderResult = await ordersCollection.insertOne(orderDoc);
            orderId = orderResult.insertedId;
          }

          // 4. Insert payment record if not existing
          if (!existingPayment) {
            const paymentDoc = {
              session_id: sessionId,
              transactionId: paymentIntentId || sessionId,
              orderId,
              amount:
                session.amount_total != null
                  ? session.amount_total / 100
                  : authoritativePrice,
              currency: session.currency || "usd",
              paymentStatus: "paid",
              metadata: {
                ...metadata,
                userEmail: buyerEmail,
              },
              date: new Date().toISOString(),
              createdAt: new Date(),
            };
            await paymentsCollection.insertOne(paymentDoc);
          }

          console.log(
            `Stripe webhook: Successfully processed checkout.session.completed for session ${sessionId}`
          );
          return res.status(200).json({ received: true });
        }

        default:
          console.log(
            `Stripe webhook: Unhandled event type ${event.type}`
          );
          return res.status(200).json({ received: true, unhandled: true });
      }
    } catch (processError) {
      console.error(
        "Stripe webhook processing error:",
        processError.message
      );
      return res.status(500).json({ error: "Failed to process webhook event" });
    }
  }
);

// Standard JSON parser for all subsequent endpoints
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

let customKeySet = null;
const setVerificationKey = (key) => {
  customKeySet = key;
};

// Validate user identity: ensures authenticated user has an active identity and required email
const validateUserIdentity = (req, res) => {
  if (
    !req.user ||
    !req.user.email ||
    typeof req.user.email !== "string" ||
    !req.user.email.trim()
  ) {
    res.status(401).json({
      message: "Unauthorized: Valid user identity and email are required",
    });
    return false;
  }
  return true;
};

// Auth Middleware: Verify Signature, Expiration, Issuer, Audience, and Sync Database Record
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
    const key =
      customKeySet ||
      (process.env.JWT_SECRET
        ? new TextEncoder().encode(process.env.JWT_SECRET)
        : JWKS);

    const { payload } = await jwtVerify(token, key, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    // 1. Identity claim validation
    if (
      !payload.sub ||
      !payload.email ||
      typeof payload.email !== "string" ||
      !payload.email.trim()
    ) {
      return res
        .status(401)
        .json({ message: "Unauthorized: Invalid or missing identity in token" });
    }

    const email = payload.email.trim();

    // 2. Authoritative User Sync from MongoDB
    if (usersCollection) {
      let dbUser = await usersCollection.findOne({ email });
      if (!dbUser && payload.sub) {
        const idQuery = ObjectId.isValid(payload.sub)
          ? { _id: new ObjectId(payload.sub) }
          : { _id: payload.sub };
        dbUser = await usersCollection.findOne(idQuery);
      }

      // Reject deleted or missing user record
      if (!dbUser) {
        return res
          .status(401)
          .json({ message: "Unauthorized: User record not found" });
      }

      // Reject blocked accounts on every authenticated route
      if (dbUser.status === "blocked") {
        return res
          .status(403)
          .json({ message: "Forbidden: Account is blocked" });
      }

      // Authoritative role from MongoDB - never trust JWT payload role alone
      const authoritativeRole = dbUser.role || "buyer";

      req.user = {
        ...payload,
        id: dbUser._id ? dbUser._id.toString() : payload.sub,
        email: dbUser.email || email,
        role: authoritativeRole,
        status: dbUser.status || "active",
        dbUser, // Cached to avoid duplicate database queries in requireRole
      };
    } else {
      return res
        .status(503)
        .json({ message: "Service Unavailable: Database connection not ready" });
    }

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
  if (!user || !user.email) return null;
  if (usersCollection) {
    const dbUser = await usersCollection.findOne({ email: user.email.trim() });
    if (dbUser && dbUser.role) {
      return dbUser.role;
    }
    if (dbUser) {
      return "buyer";
    }
  }
  return null;
};

// Role Enforcement Middleware: Validates permissions against server-controlled source
const requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    if (!req.user || !req.user.email) {
      return res
        .status(401)
        .json({ message: "Unauthorized: User not authenticated" });
    }

    // Reuse cached dbUser from verifyToken if available to avoid duplicate DB queries
    let dbUser = req.user.dbUser;
    if (!dbUser && usersCollection) {
      const email = req.user.email.trim();
      dbUser = await usersCollection.findOne({ email });
      if (!dbUser && req.user.id) {
        const idQuery = ObjectId.isValid(req.user.id)
          ? { _id: new ObjectId(req.user.id) }
          : { _id: req.user.id };
        dbUser = await usersCollection.findOne(idQuery);
      }
    }

    // Reject deleted or missing user record
    if (!dbUser && usersCollection) {
      return res
        .status(401)
        .json({ message: "Unauthorized: User record not found" });
    }

    // Reject blocked accounts
    if (dbUser && dbUser.status === "blocked") {
      return res
        .status(403)
        .json({ message: "Forbidden: Account is blocked" });
    }

    // Authoritative role from database
    const authoritativeRole = (dbUser && dbUser.role) ? dbUser.role : (req.user.role || "buyer");
    req.user.role = authoritativeRole;

    if (!allowedRoles.includes(authoritativeRole)) {
      return res.status(403).json({
        message: `Forbidden: Requires one of [${allowedRoles.join(", ")}] permissions`,
      });
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

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } catch (error) {
    console.error("MongoDB connection or setup error:", error);
  }
}

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
          if (!validateUserIdentity(req, res)) return;

          const product = req.body;
          if (!product || typeof product !== "object" || Array.isArray(product)) {
            return res.status(400).send({ message: "Product data is required" });
          }

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
        if (!validateUserIdentity(req, res)) return;

        const review = req.body;
        if (!review || typeof review !== "object" || Array.isArray(review)) {
          return res.status(400).send({ message: "Review data is required" });
        }

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
          if (!validateUserIdentity(req, res)) return;

          const orderData = req.body;
          if (!orderData || typeof orderData !== "object" || Array.isArray(orderData)) {
            return res.status(400).send({ message: "Order data is required" });
          }

          if (req.user.role !== "admin" || !orderData.buyerInfo) {
            orderData.buyerInfo = req.user.email;
          }

          // Idempotency: avoid duplicate order if already created via webhook
          if (orderData.paymentId && ordersCollection) {
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

          // Never trust client-supplied paymentStatus without verified payment record
          if (req.user.role !== "admin" && orderData.paymentStatus === "paid") {
            const verifiedPayment = orderData.paymentId && paymentsCollection
              ? ((await paymentsCollection.findOne({ session_id: orderData.paymentId })) ||
                 (await paymentsCollection.findOne({ transactionId: orderData.paymentId })))
              : null;
            if (!verifiedPayment) {
              orderData.paymentStatus = "pending";
            }
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
          if (!validateUserIdentity(req, res)) return;

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
          if (!validateUserIdentity(req, res)) return;

          const payment = req.body;
          if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
            return res.status(400).send({ message: "Payment data is required" });
          }

          if (req.user.role !== "admin") {
            payment.metadata = {
              ...(payment.metadata || {}),
              userEmail: req.user.email,
            };
          }

          // Idempotency: avoid duplicate payment record if already created via webhook
          if (payment.session_id && paymentsCollection) {
            const existingPayment = await paymentsCollection.findOne({
              session_id: payment.session_id,
            });
            if (existingPayment) {
              return res.status(200).send({
                message: "Payment already recorded",
                insertedId: existingPayment._id,
              });
            }
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

function setCollections(collections) {
  if ("database" in collections) database = collections.database;
  if ("productsCollection" in collections) productsCollection = collections.productsCollection;
  if ("reviewsCollection" in collections) reviewsCollection = collections.reviewsCollection;
  if ("wishlistCollection" in collections) wishlistCollection = collections.wishlistCollection;
  if ("paymentsCollection" in collections) paymentsCollection = collections.paymentsCollection;
  if ("ordersCollection" in collections) ordersCollection = collections.ordersCollection;
  if ("usersCollection" in collections) usersCollection = collections.usersCollection;
}

if (require.main === module) {
  run().catch(console.dir);
  app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
  });
}

module.exports = {
  app,
  verifyToken,
  requireRole,
  getUserRole,
  validateUserIdentity,
  setCollections,
  setVerificationKey,
  setStripeInstance,
  run,
  client,
};
