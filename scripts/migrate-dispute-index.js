/**
 * Migration Script: Migrate Disputes orderId Index to Unique Sparse
 *
 * Description:
 * Replaces the obsolete non-unique index { key: { orderId: 1 }, name: "orderId_1" }
 * on the disputes collection with a required unique, sparse index:
 * { key: { orderId: 1 }, name: "orderId_1", unique: true, sparse: true }
 *
 * Safety Invariants:
 * 1. Checks for non-null duplicate orderId values BEFORE modifying any index.
 * 2. If duplicates are found, aborts immediately without modifying any index or data.
 * 3. Does not delete any documents.
 * 4. Verifies post-migration index options.
 * 5. Supports dry-run mode (--dry-run).
 */

const { MongoClient } = require("mongodb");
const { config } = require("../src/config/env");

/**
 * Checks for duplicate non-null orderId values in the disputes collection.
 * @param {import('mongodb').Collection} disputesCollection
 * @returns {Promise<Array<{ _id: string, count: number, docIds: any[] }>>}
 */
async function checkDuplicateDisputeOrderIds(disputesCollection) {
  return await disputesCollection
    .aggregate([
      {
        $match: {
          orderId: { $exists: true, $ne: null, $ne: "" },
        },
      },
      {
        $group: {
          _id: "$orderId",
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
 * Executes the dispute orderId index migration safely.
 *
 * @param {object} options
 * @param {import('mongodb').Db} [options.db] - Optional connected MongoDB database instance.
 * @param {import('mongodb').MongoClient} [options.client] - Optional MongoClient instance.
 * @param {boolean} [options.dryRun=false] - If true, performs validation only without DDL changes.
 * @returns {Promise<{ success: boolean, message: string, duplicateCount: number }>}
 */
async function migrateDisputeIndex(options = {}) {
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
    const disputesCollection = db.collection("disputes");

    console.log("[MIGRATION] Checking disputes collection for duplicate orderId values...");
    const duplicates = await checkDuplicateDisputeOrderIds(disputesCollection);

    if (duplicates.length > 0) {
      const errMsg = `[MIGRATION ABORTED] Found ${duplicates.length} duplicate orderId group(s) in disputes collection. Migration cannot proceed without manual resolution.\nDuplicates: ${JSON.stringify(duplicates, null, 2)}`;
      console.error(errMsg);
      return {
        success: false,
        message: errMsg,
        duplicateCount: duplicates.length,
        duplicates,
      };
    }

    console.log(
      "[MIGRATION] Duplicate check passed: 0 duplicate non-null orderId values found in disputes."
    );

    // Inspect existing indexes
    const existingIndexes = await disputesCollection.indexes();
    const existingOrderIndex = existingIndexes.find(
      (idx) =>
        idx.name === "orderId_1" ||
        (idx.key && idx.key.orderId === 1 && Object.keys(idx.key).length === 1)
    );

    if (existingOrderIndex) {
      const isAlreadyUniqueSparse =
        existingOrderIndex.unique === true &&
        existingOrderIndex.sparse === true;

      if (isAlreadyUniqueSparse) {
        const msg =
          "[MIGRATION] Index 'orderId_1' on disputes is already configured with { unique: true, sparse: true }. No changes needed.";
        console.log(msg);
        return { success: true, message: msg, duplicateCount: 0 };
      }

      console.log(
        `[MIGRATION] Existing index '${existingOrderIndex.name}' found with non-matching options:`,
        JSON.stringify({
          unique: existingOrderIndex.unique,
          sparse: existingOrderIndex.sparse,
        })
      );

      if (dryRun) {
        const msg = `[DRY-RUN] Would drop existing index '${existingOrderIndex.name}' and create unique sparse index 'orderId_1' on disputes collection.`;
        console.log(msg);
        return { success: true, message: msg, duplicateCount: 0 };
      }

      console.log(
        `[MIGRATION] Dropping obsolete index '${existingOrderIndex.name}'...`
      );
      await disputesCollection.dropIndex(existingOrderIndex.name);
      console.log(
        `[MIGRATION] Successfully dropped obsolete index '${existingOrderIndex.name}'.`
      );
    } else {
      console.log(
        "[MIGRATION] No existing index found for orderId in disputes. Ready to create new index."
      );
      if (dryRun) {
        const msg =
          "[DRY-RUN] Would create unique sparse index 'orderId_1' on disputes collection.";
        console.log(msg);
        return { success: true, message: msg, duplicateCount: 0 };
      }
    }

    console.log(
      "[MIGRATION] Creating required unique sparse index: { orderId: 1 } on disputes..."
    );
    const createdIndexName = await disputesCollection.createIndex(
      { orderId: 1 },
      { unique: true, sparse: true, name: "orderId_1" }
    );
    console.log(`[MIGRATION] Successfully created index: '${createdIndexName}'`);

    // Post-migration verification
    const updatedIndexes = await disputesCollection.indexes();
    const verifiedIndex = updatedIndexes.find(
      (idx) => idx.name === "orderId_1"
    );

    if (
      !verifiedIndex ||
      verifiedIndex.unique !== true ||
      verifiedIndex.sparse !== true
    ) {
      throw new Error(
        "[MIGRATION ERROR] Verification failed: 'orderId_1' does not have expected { unique: true, sparse: true } options after migration."
      );
    }

    console.log(
      "[MIGRATION] Post-migration verification successful: 'orderId_1' unique sparse index is active and enforcing uniqueness on disputes."
    );

    return {
      success: true,
      message:
        "Dispute index migration completed successfully. 'orderId_1' is now unique and sparse.",
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
  migrateDisputeIndex({ dryRun: isDryRun })
    .then((result) => {
      if (!result.success) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("[FATAL MIGRATION ERROR]:", err.message || err);
      process.exit(1);
    });
}

module.exports = {
  migrateDisputeIndex,
  checkDuplicateDisputeOrderIds,
};
