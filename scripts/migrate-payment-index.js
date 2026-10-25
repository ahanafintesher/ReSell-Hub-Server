/**
 * Migration Script: Migrate Orders paymentId Index to Unique Sparse
 *
 * Description:
 * Replaces the obsolete non-unique index { key: { paymentId: 1 }, name: "paymentId_1" }
 * on the orders collection with a required unique, sparse index:
 * { key: { paymentId: 1 }, name: "paymentId_1", unique: true, sparse: true }
 *
 * Safety Invariants:
 * 1. Checks for non-null duplicate paymentId values BEFORE modifying any index.
 * 2. If duplicates are found, aborts immediately without modifying any index or data.
 * 3. Does not delete any documents.
 * 4. Verifies post-migration index options.
 * 5. Supports dry-run mode (--dry-run).
 */

const { MongoClient } = require("mongodb");
const { config } = require("../src/config/env");

/**
 * Checks for duplicate non-null paymentId values in the orders collection.
 * @param {import('mongodb').Collection} ordersCollection
 * @returns {Promise<Array<{ _id: string, count: number, docIds: any[] }>>}
 */
async function checkDuplicatePaymentIds(ordersCollection) {
  return await ordersCollection
    .aggregate([
      {
        $match: {
          paymentId: { $exists: true, $ne: null, $ne: "" },
        },
      },
      {
        $group: {
          _id: "$paymentId",
          count: { $sum: 1 },
          docIds: { $push: "$_id" },
        },
      },
      {
        $match: {
          count: { $gt: 1 },
        },
      },
    ])
    .toArray();
}

/**
 * Executes the paymentId index migration safely.
 *
 * @param {object} options
 * @param {import('mongodb').Db} [options.db] - Optional connected MongoDB database instance.
 * @param {import('mongodb').MongoClient} [options.client] - Optional MongoClient instance.
 * @param {boolean} [options.dryRun=false] - If true, performs validation only without DDL changes.
 * @returns {Promise<{ success: boolean, message: string, duplicateCount: number }>}
 */
async function migratePaymentIndex(options = {}) {
  const dryRun = Boolean(options.dryRun);
  let client = options.client || null;
  let shouldCloseClient = false;
  let db = options.db || null;

  if (!db) {
    const uri = config.MONGODB_URI;
    if (!uri) {
      throw new Error(
        "Cannot run migration: MONGODB_URI environment variable is not set."
      );
    }
    client = new MongoClient(uri);
    await client.connect();
    shouldCloseClient = true;
    db = client.db("resell_hub");
  }

  try {
    const ordersCollection = db.collection("orders");

    console.log("[MIGRATION] Checking orders collection for duplicate paymentId values...");
    const duplicates = await checkDuplicatePaymentIds(ordersCollection);

    if (duplicates.length > 0) {
      const errMsg = `[MIGRATION ABORTED] Found ${duplicates.length} duplicate paymentId group(s) in orders collection. Migration cannot proceed without manual resolution.\nDuplicates: ${JSON.stringify(duplicates, null, 2)}`;
      console.error(errMsg);
      return {
        success: false,
        message: errMsg,
        duplicateCount: duplicates.length,
        duplicates,
      };
    }

    console.log(
      "[MIGRATION] Duplicate check passed: 0 duplicate non-null paymentId values found."
    );

    // Inspect existing indexes
    const existingIndexes = await ordersCollection.indexes();
    const existingPaymentIndex = existingIndexes.find(
      (idx) =>
        idx.name === "paymentId_1" ||
        (idx.key && idx.key.paymentId === 1 && Object.keys(idx.key).length === 1)
    );

    if (existingPaymentIndex) {
      const isAlreadyUniqueSparse =
        existingPaymentIndex.unique === true &&
        existingPaymentIndex.sparse === true;

      if (isAlreadyUniqueSparse) {
        const msg =
          "[MIGRATION] Index 'paymentId_1' is already configured with { unique: true, sparse: true }. No changes needed.";
        console.log(msg);
        return { success: true, message: msg, duplicateCount: 0 };
      }

      console.log(
        `[MIGRATION] Existing index '${existingPaymentIndex.name}' found with non-matching options:`,
        JSON.stringify({
          unique: existingPaymentIndex.unique,
          sparse: existingPaymentIndex.sparse,
        })
      );

      if (dryRun) {
        const msg = `[DRY-RUN] Would drop existing index '${existingPaymentIndex.name}' and create unique sparse index 'paymentId_1'.`;
        console.log(msg);
        return { success: true, message: msg, duplicateCount: 0 };
      }

      console.log(
        `[MIGRATION] Dropping obsolete index '${existingPaymentIndex.name}'...`
      );
      await ordersCollection.dropIndex(existingPaymentIndex.name);
      console.log(
        `[MIGRATION] Successfully dropped obsolete index '${existingPaymentIndex.name}'.`
      );
    } else {
      console.log(
        "[MIGRATION] No existing index found for paymentId. Ready to create new index."
      );
      if (dryRun) {
        const msg =
          "[DRY-RUN] Would create unique sparse index 'paymentId_1' on orders collection.";
        console.log(msg);
        return { success: true, message: msg, duplicateCount: 0 };
      }
    }

    console.log(
      "[MIGRATION] Creating required unique sparse index: { paymentId: 1 }..."
    );
    const createdIndexName = await ordersCollection.createIndex(
      { paymentId: 1 },
      { unique: true, sparse: true, name: "paymentId_1" }
    );
    console.log(`[MIGRATION] Successfully created index: '${createdIndexName}'`);

    // Post-migration verification
    const updatedIndexes = await ordersCollection.indexes();
    const verifiedIndex = updatedIndexes.find(
      (idx) => idx.name === "paymentId_1"
    );

    if (
      !verifiedIndex ||
      verifiedIndex.unique !== true ||
      verifiedIndex.sparse !== true
    ) {
      throw new Error(
        "[MIGRATION ERROR] Verification failed: 'paymentId_1' does not have expected { unique: true, sparse: true } options after migration."
      );
    }

    console.log(
      "[MIGRATION] Post-migration verification successful: 'paymentId_1' unique sparse index is active and enforcing uniqueness."
    );

    return {
      success: true,
      message:
        "Index migration completed successfully. 'paymentId_1' is now unique and sparse.",
      duplicateCount: 0,
    };
  } finally {
    if (shouldCloseClient && client) {
      await client.close();
    }
  }
}

if (require.main === module) {
  const isDryRun = process.argv.includes("--dry-run");
  migratePaymentIndex({ dryRun: isDryRun })
    .then((result) => {
      if (!result.success) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("[MIGRATION FATAL ERROR]:", err.message || err);
      process.exit(1);
    });
}

module.exports = {
  migratePaymentIndex,
  checkDuplicatePaymentIds,
};
