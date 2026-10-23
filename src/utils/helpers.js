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
 * @param {string} str
 * @returns {string}
 */
const escapeRegex = (str) => {
  if (typeof str !== "string") return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

module.exports = {
  extractEmail,
  isValidObjectId,
  toObjectIdQuery,
  escapeRegex,
};
