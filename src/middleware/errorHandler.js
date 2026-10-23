/**
 * Fallback 404 handler for unmatched routes.
 */
function notFoundHandler(req, res) {
  res.status(404).json({ message: "Route not found" });
}

/**
 * Centralized error handling middleware.
 * Guarantees no sensitive internals, DB schemas, or stack traces leak to clients.
 */
function errorHandler(err, req, res, next) {
  // If headers have already been sent, delegate to Express default
  if (res.headersSent) {
    return next(err);
  }

  console.error("Unhandled application error:", err.message || err);

  const statusCode = err.status || err.statusCode || 500;
  const safeMessage =
    statusCode === 500 && process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Internal server error";

  res.status(statusCode).json({
    message: safeMessage,
  });
}

module.exports = {
  notFoundHandler,
  errorHandler,
};
