require("dotenv").config();

/**
 * Validates required and recommended environment variables.
 * Never prints or leaks secret values.
 */
function validateEnv() {
  const isProduction = process.env.NODE_ENV === "production";
  const missingRequired = [];
  const missingRecommended = [];

  // Required in all operational environments
  if (!process.env.MONGODB_URI) {
    missingRequired.push("MONGODB_URI");
  }

  // Recommended / Required for full production operations
  if (!process.env.STRIPE_SECRET_KEY) {
    missingRecommended.push("STRIPE_SECRET_KEY");
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    missingRecommended.push("STRIPE_WEBHOOK_SECRET");
  }
  if (!process.env.ALLOWED_ORIGINS && isProduction) {
    missingRecommended.push("ALLOWED_ORIGINS");
  }

  if (missingRequired.length > 0) {
    const errorMsg = `[CONFIG FATAL] Missing required environment variables: ${missingRequired.join(", ")}`;
    if (isProduction) {
      throw new Error(errorMsg);
    } else if (process.env.NODE_ENV !== "test") {
      console.warn(errorMsg);
    }
  }

  if (missingRecommended.length > 0 && isProduction) {
    console.warn(
      `[CONFIG NOTICE] Production recommended environment variables not set: ${missingRecommended.join(", ")}`
    );
  }
}

const config = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: process.env.PORT || 5000,
  MONGODB_URI: process.env.MONGODB_URI,
  JWKS_URL: process.env.JWKS_URL || "http://localhost:3000/api/auth/jwks",
  JWT_ISSUER: (
    process.env.JWT_ISSUER ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, ""),
  JWT_AUDIENCE: (
    process.env.JWT_AUDIENCE ||
    process.env.BETTER_AUTH_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, ""),
  JWT_SECRET: process.env.JWT_SECRET || null,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : null,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "",
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || "",
  CURRENCY: (process.env.STRIPE_CURRENCY || process.env.CURRENCY || "usd").toLowerCase(),
};

module.exports = {
  config,
  validateEnv,
};
