const cors = require("cors");
const { config } = require("../config/env");

const isProduction = config.NODE_ENV === "production";

// Safe development origin allowlist
const devDefaultOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const originValidator = (origin, callback) => {
  // Allow server-to-server requests, mobile apps, curl, or automated test runners without origin header
  if (!origin) {
    return callback(null, true);
  }

  const allowedList = config.ALLOWED_ORIGINS || (!isProduction ? devDefaultOrigins : []);

  if (allowedList.includes(origin)) {
    return callback(null, true);
  }

  if (!isProduction) {
    // In local development, permit other localhost / local network ports
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(null, true);
  }

  // In production, reject unlisted origins
  return callback(new Error("CORS policy error: Origin not allowed"), false);
};

const corsMiddleware = cors({
  origin: originValidator,
  credentials: true,
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "stripe-signature",
    "X-Requested-With",
    "Accept",
  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});

module.exports = {
  corsMiddleware,
};
