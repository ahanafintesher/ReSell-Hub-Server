const { MongoClient, ServerApiVersion } = require("mongodb");
const { config } = require("./env");

const uri = config.MONGODB_URI;

// MongoDB Client
const client = uri
  ? new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    })
  : null;

// Live shared collection references
const collections = {
  database: null,
  productsCollection: null,
  reviewsCollection: null,
  wishlistCollection: null,
  paymentsCollection: null,
  ordersCollection: null,
  usersCollection: null,
  reportsCollection: null,
  processedEventsCollection: null,
  disputesCollection: null,
};

function getCollections() {
  return collections;
}

function setCollections(newCollections) {
  if (!newCollections || typeof newCollections !== "object") return;
  if ("database" in newCollections) collections.database = newCollections.database;
  if ("productsCollection" in newCollections)
    collections.productsCollection = newCollections.productsCollection;
  if ("reviewsCollection" in newCollections)
    collections.reviewsCollection = newCollections.reviewsCollection;
  if ("wishlistCollection" in newCollections)
    collections.wishlistCollection = newCollections.wishlistCollection;
  if ("paymentsCollection" in newCollections)
    collections.paymentsCollection = newCollections.paymentsCollection;
  if ("ordersCollection" in newCollections)
    collections.ordersCollection = newCollections.ordersCollection;
  if ("usersCollection" in newCollections)
    collections.usersCollection = newCollections.usersCollection;
  if ("reportsCollection" in newCollections)
    collections.reportsCollection = newCollections.reportsCollection;
  if ("processedEventsCollection" in newCollections)
    collections.processedEventsCollection = newCollections.processedEventsCollection;
  if ("disputesCollection" in newCollections)
    collections.disputesCollection = newCollections.disputesCollection;
}

/**
 * Safely creates an optional performance index without failing startup if database privileges are restricted.
 */
async function safeCreateIndex(collection, key, options) {
  if (!collection || typeof collection.createIndex !== "function") return;
  try {
    await collection.createIndex(key, options);
  } catch (err) {
    console.warn(
      `[INDEX NOTICE] Optional performance index on ${JSON.stringify(key)}:`,
      err.message
    );
  }
}

/**
 * Creates indexes on collections.
 * - Performance indexes are created safely without blocking startup on restricted permissions.
 * - Required unique constraints are strictly verified and enforced: if missing or conflicting,
 *   startup throws a fatal error rather than silently proceeding with compromised data integrity.
 * - In accordance with production safeguards, startup NEVER drops or modifies indexes automatically.
 */
async function createIndexes() {
  if (collections.productsCollection && typeof collections.productsCollection.createIndex === "function") {
    await safeCreateIndex(collections.productsCollection, { sellerInfo: 1 });
    await safeCreateIndex(collections.productsCollection, { status: 1 });
    await safeCreateIndex(collections.productsCollection, { category: 1 });
    await safeCreateIndex(collections.productsCollection, { price: 1 });
    await safeCreateIndex(collections.productsCollection, { createdAt: -1 });
  }

  if (collections.ordersCollection && typeof collections.ordersCollection.createIndex === "function") {
    await safeCreateIndex(collections.ordersCollection, { buyerInfo: 1 });
    await safeCreateIndex(collections.ordersCollection, { sellerInfo: 1 });
    await safeCreateIndex(collections.ordersCollection, { orderStatus: 1 });

    // Required unique constraint on paymentId: ensures no duplicate orders on concurrent checkouts/webhooks
    try {
      await collections.ordersCollection.createIndex(
        { paymentId: 1 },
        { unique: true, sparse: true, name: "paymentId_1" }
      );
    } catch (err) {
      // Check if unique constraint is already enforced
      let isUniqueEnforced = false;
      if (typeof collections.ordersCollection.indexes === "function") {
        try {
          const idxs = await collections.ordersCollection.indexes();
          const existing = idxs.find(
            (idx) =>
              idx.name === "paymentId_1" ||
              (idx.key && idx.key.paymentId === 1 && Object.keys(idx.key).length === 1)
          );
          if (existing && existing.unique === true) {
            isUniqueEnforced = true;
          }
        } catch (_) {}
      }

      if (!isUniqueEnforced) {
        throw new Error(
          `[FATAL DB STARTUP] Required unique constraint on 'orders.paymentId' is missing or conflicting with existing index options: ${err.message}. The server cannot safely guarantee duplicate order prevention without this unique constraint. Startup halted. Run 'npm run migrate:payment-index' to safely migrate the index without data loss.`
        );
      }
    }
  }

  if (collections.paymentsCollection && typeof collections.paymentsCollection.createIndex === "function") {
    await safeCreateIndex(collections.paymentsCollection, { session_id: 1 });
    await safeCreateIndex(collections.paymentsCollection, { transactionId: 1 });
    await safeCreateIndex(collections.paymentsCollection, { "metadata.userEmail": 1 });
  }

  if (collections.wishlistCollection && typeof collections.wishlistCollection.createIndex === "function") {
    await safeCreateIndex(collections.wishlistCollection, { userInfo: 1 });
    await safeCreateIndex(collections.wishlistCollection, { "product._id": 1, userInfo: 1 });
  }

  if (collections.usersCollection && typeof collections.usersCollection.createIndex === "function") {
    await safeCreateIndex(collections.usersCollection, { email: 1 });
  }

  if (collections.reportsCollection && typeof collections.reportsCollection.createIndex === "function") {
    await safeCreateIndex(collections.reportsCollection, { productId: 1 });
    await safeCreateIndex(collections.reportsCollection, { reporterEmail: 1 });
    await safeCreateIndex(collections.reportsCollection, { status: 1 });
  }

  if (collections.disputesCollection && typeof collections.disputesCollection.createIndex === "function") {
    try {
      await collections.disputesCollection.createIndex(
        { orderId: 1 },
        { unique: true, sparse: true, name: "orderId_1" }
      );
    } catch (err) {
      let isUniqueEnforced = false;
      if (typeof collections.disputesCollection.indexes === "function") {
        try {
          const idxs = await collections.disputesCollection.indexes();
          const existing = idxs.find(
            (idx) =>
              idx.name === "orderId_1" ||
              (idx.key && idx.key.orderId === 1 && Object.keys(idx.key).length === 1)
          );
          if (existing && existing.unique === true) {
            isUniqueEnforced = true;
          }
        } catch (_) {}
      }

      if (!isUniqueEnforced) {
        console.warn(
          `[INDEX NOTICE] Unique constraint on 'disputes.orderId' not yet active: ${err.message}. Atomic order-level locking guarantees concurrency protection. Run 'npm run migrate:dispute-index' to safely migrate the index without data loss.`
        );
      }
    }
    await safeCreateIndex(collections.disputesCollection, { buyerEmail: 1 });
    await safeCreateIndex(collections.disputesCollection, { status: 1 });
    await safeCreateIndex(collections.disputesCollection, { createdAt: -1 });
  }

  if (collections.processedEventsCollection && typeof collections.processedEventsCollection.createIndex === "function") {
    try {
      await collections.processedEventsCollection.createIndex(
        { eventId: 1 },
        { unique: true, name: "eventId_1" }
      );
    } catch (err) {
      let isUniqueEnforced = false;
      if (typeof collections.processedEventsCollection.indexes === "function") {
        try {
          const idxs = await collections.processedEventsCollection.indexes();
          const existing = idxs.find(
            (idx) =>
              idx.name === "eventId_1" ||
              (idx.key && idx.key.eventId === 1 && Object.keys(idx.key).length === 1)
          );
          if (existing && existing.unique === true) {
            isUniqueEnforced = true;
          }
        } catch (_) {}
      }

      if (!isUniqueEnforced) {
        throw new Error(
          `[FATAL DB STARTUP] Required unique constraint on 'processed_events.eventId' failed: ${err.message}. Duplicate webhook protection cannot be guaranteed.`
        );
      }
    }
  }
}

let isInitialized = false;
let initPromise = null;

async function run() {
  if (isInitialized) {
    return collections;
  }
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!client) {
      console.warn("MongoDB client not initialized (MONGODB_URI is empty)");
      isInitialized = true;
      return collections;
    }
    try {
      await client.connect();

      collections.database = client.db("resell_hub");
      collections.productsCollection = collections.database.collection("products");
      collections.reviewsCollection = collections.database.collection("reviews");
      collections.wishlistCollection = collections.database.collection("wishlist");
      collections.paymentsCollection = collections.database.collection("payments");
      collections.ordersCollection = collections.database.collection("orders");
      collections.usersCollection = collections.database.collection("user");
      collections.reportsCollection = collections.database.collection("reports");
      collections.processedEventsCollection = collections.database.collection("processed_events");
      collections.disputesCollection = collections.database.collection("disputes");

      await client.db("admin").command({ ping: 1 });
      console.log(
        "Pinged your deployment. You successfully connected to MongoDB!"
      );

      await createIndexes();
      isInitialized = true;
      return collections;
    } catch (error) {
      console.error("MongoDB connection or setup error:", error.message || error);
      initPromise = null;
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Closes the MongoDB client connection and resets initialization state.
 * Useful for graceful shutdowns and test suite teardown.
 */
async function close() {
  if (client) {
    try {
      await client.close();
    } catch (closeErr) {
      console.warn("Error closing MongoDB client:", closeErr.message);
    }
  }
  isInitialized = false;
  initPromise = null;
}

module.exports = {
  client,
  collections,
  getCollections,
  setCollections,
  createIndexes,
  run,
  close,
};
