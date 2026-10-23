const express = require("express");
const { validateEnv, config } = require("./src/config/env");
const { corsMiddleware } = require("./src/middleware/cors");
const { client, setCollections, run } = require("./src/config/db");
const { setStripeInstance } = require("./src/config/stripe");
const {
  verifyToken,
  requireRole,
  getUserRole,
  validateUserIdentity,
  setVerificationKey,
} = require("./src/middleware/auth");
const {
  notFoundHandler,
  errorHandler,
} = require("./src/middleware/errorHandler");

// Import route modules
const webhookRoutes = require("./src/routes/webhook.routes");
const productsRoutes = require("./src/routes/products.routes");
const ordersRoutes = require("./src/routes/orders.routes");
const paymentsRoutes = require("./src/routes/payments.routes");
const reviewsRoutes = require("./src/routes/reviews.routes");
const wishlistRoutes = require("./src/routes/wishlist.routes");
const adminRoutes = require("./src/routes/admin.routes");

// Validate environment variables on startup without exposing secret values
validateEnv();

const app = express();
const port = config.PORT;

// Global CORS Middleware with strict production allowlist
app.use(corsMiddleware);

// ──────────────────────────────────────────
// STRIPE WEBHOOK API (Raw Body Handler)
// MUST be registered BEFORE express.json() to preserve unmodified raw body Buffer
// ──────────────────────────────────────────
app.use(webhookRoutes);

// Standard JSON parser for all subsequent endpoints
app.use(express.json());

// Root test endpoint
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// Mount domain routes
app.use(productsRoutes);
app.use(ordersRoutes);
app.use(paymentsRoutes);
app.use(reviewsRoutes);
app.use(wishlistRoutes);
app.use(adminRoutes);

// 404 Handler for undefined routes
app.use(notFoundHandler);

// Centralized safe error handling middleware
app.use(errorHandler);

if (require.main === module) {
  run().catch(console.dir);
  app.listen(port, () => {
    console.log(`ReSell Hub Server listening on port ${port}`);
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
