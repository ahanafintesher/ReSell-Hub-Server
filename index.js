const express = require("express");
const { validateEnv, config } = require("./src/config/env");
const { corsMiddleware } = require("./src/middleware/cors");
const {
  client,
  setCollections,
  run,
  close,
  createIndexes,
} = require("./src/config/db");
const { setStripeInstance } = require("./src/config/stripe");
const {
  verifyToken,
  optionalVerifyToken,
  publicOptionalVerifyToken,
  requireRole,
  getUserRole,
  validateUserIdentity,
  setVerificationKey,
  BLOCKED_ACCOUNT_RESPONSE,
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
const publicRoutes = require("./src/routes/public.routes");
const categoriesRoutes = require("./src/routes/categories.routes");
const usersRoutes = require("./src/routes/users.routes");
const sellerRoutes = require("./src/routes/seller.routes");

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
app.use(publicRoutes);
app.use(categoriesRoutes);
app.use(usersRoutes);
app.use(sellerRoutes);
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
  run()
    .then(() => {
      const {
        startRefundRecoveryWorker,
      } = require("./src/utils/refundRecovery");
      startRefundRecoveryWorker();

      const server = app.listen(port, () => {
        console.log(`ReSell Hub Server listening on port ${port}`);
      });
      return server;
    })
    .catch((err) => {
      console.error(
        "Fatal startup error: Failed to connect to database or initialize indexes:",
        err.message || err,
      );
      process.exit(1);
    });
}

module.exports = {
  app,
  verifyToken,
  optionalVerifyToken,
  publicOptionalVerifyToken,
  requireRole,
  getUserRole,
  validateUserIdentity,
  setCollections,
  setVerificationKey,
  setStripeInstance,
  run,
  close,
  createIndexes,
  client,
  BLOCKED_ACCOUNT_RESPONSE,
};
