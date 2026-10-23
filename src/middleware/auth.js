const { createRemoteJWKSet, jwtVerify } = require("jose-cjs");
const { ObjectId } = require("mongodb");
const { config } = require("../config/env");
const { getCollections } = require("../config/db");

const JWKS = createRemoteJWKSet(new URL(config.JWKS_URL));

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
      (config.JWT_SECRET
        ? new TextEncoder().encode(config.JWT_SECRET)
        : JWKS);

    const { payload } = await jwtVerify(token, key, {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
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
    const { usersCollection } = getCollections();

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
        name: dbUser.name || payload.name || "User",
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
  const { usersCollection } = getCollections();
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

    const { usersCollection } = getCollections();

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
    const authoritativeRole =
      dbUser && dbUser.role ? dbUser.role : req.user.role || "buyer";
    req.user.role = authoritativeRole;

    if (!allowedRoles.includes(authoritativeRole)) {
      return res.status(403).json({
        message: `Forbidden: Requires one of [${allowedRoles.join(", ")}] permissions`,
      });
    }

    next();
  };
};

module.exports = {
  verifyToken,
  requireRole,
  getUserRole,
  validateUserIdentity,
  setVerificationKey,
};
