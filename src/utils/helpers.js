const { ObjectId } = require("mongodb");

/**
 * Safely extracts an email address whether the input is a string or an object with an email property.
 * @param {string|object} info
 * @returns {string|null}
 */
const extractEmail = (info) => {
  if (!info) return null;
  if (typeof info === "string") return info.trim();
  if (typeof info === "object" && typeof info.email === "string") {
    return info.email.trim();
  }
  return null;
};

/**
 * Validates whether a value is a valid MongoDB 24-character hexadecimal ObjectId string.
 * @param {any} id
 * @returns {boolean}
 */
const isValidObjectId = (id) => {
  if (!id) return false;
  return ObjectId.isValid(id) && String(new ObjectId(id)) === String(id);
};

/**
 * Safely converts an ID to an ObjectId if valid, otherwise returns the original ID string.
 * @param {string} id
 * @returns {ObjectId|string}
 */
const toObjectIdQuery = (id) => {
  return ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
};

/**
 * Escapes regex special characters to prevent ReDoS or query injection when searching by name/category.
 * Truncates search query to maxLength to prevent memory and ReDoS exhaustion.
 * @param {string} str
 * @param {number} maxLength
 * @returns {string}
 */
const escapeRegex = (str, maxLength = 100) => {
  if (typeof str !== "string") return "";
  const trimmed = str.trim().slice(0, maxLength);
  return trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

/**
 * Sanitizes sellerInfo for public presentation, ensuring phone numbers, passwords,
 * and internal authentication keys are never leaked to unauthenticated scrapers.
 * @param {string|object} sellerInfo
 * @returns {string|object}
 */
const sanitizeSellerPublicInfo = (sellerInfo) => {
  if (!sellerInfo) return null;
  if (typeof sellerInfo === "string") {
    return sellerInfo;
  }
  if (typeof sellerInfo === "object") {
    return {
      name: sellerInfo.name || "Seller",
      email: sellerInfo.email || undefined,
    };
  }
  return String(sellerInfo);
};

/**
 * Set of currencies that do not use fractional subdivisions (cents) in Stripe.
 * All other currencies supported by Stripe use 2 decimal places (cents).
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"
]);

/**
 * Converts a standard currency amount (e.g., $10.50 or 500 JPY) into the integer subunit
 * amount required by Stripe API (e.g., 1050 cents or 500 yen).
 * @param {number|string} amount
 * @param {string} currency
 * @returns {number}
 */
const toStripeAmount = (amount, currency = "usd") => {
  const cur = (currency || "usd").toLowerCase();
  const num = Number(amount) || 0;
  return ZERO_DECIMAL_CURRENCIES.has(cur) ? Math.round(num) : Math.round(num * 100);
};

/**
 * Converts Stripe integer subunits (e.g. 1050 cents) into standard currency units (10.50).
 * @param {number|string} amountSubunits
 * @param {string} currency
 * @returns {number}
 */
const fromStripeAmount = (amountSubunits, currency = "usd") => {
  const cur = (currency || "usd").toLowerCase();
  const num = Number(amountSubunits) || 0;
  return ZERO_DECIMAL_CURRENCIES.has(cur) ? num : num / 100;
};

module.exports = {
  extractEmail,
  isValidObjectId,
  toObjectIdQuery,
  escapeRegex,
  sanitizeSellerPublicInfo,
  ZERO_DECIMAL_CURRENCIES,
  toStripeAmount,
  fromStripeAmount,
};
