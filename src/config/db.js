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
}

/**
 * Creates safe performance indexes on collections.
 * Fails safely and silently if running in mock/test mode without index support.
 */
async function createIndexes() {
  try {
    if (collections.productsCollection && typeof collections.productsCollection.createIndex === "function") {
      await collections.productsCollection.createIndex({ sellerInfo: 1 });
      await collections.productsCollection.createIndex({ status: 1 });
      await collections.productsCollection.createIndex({ category: 1 });
      await collections.productsCollection.createIndex({ price: 1 });
      await collections.productsCollection.createIndex({ createdAt: -1 });
    }
    if (collections.ordersCollection && typeof collections.ordersCollection.createIndex === "function") {
      await collections.ordersCollection.createIndex({ buyerInfo: 1 });
      await collections.ordersCollection.createIndex({ sellerInfo: 1 });
      await collections.ordersCollection.createIndex({ paymentId: 1 }, { unique: true, sparse: true });
      await collections.ordersCollection.createIndex({ orderStatus: 1 });
    }
    if (collections.paymentsCollection && typeof collections.paymentsCollection.createIndex === "function") {
      await collections.paymentsCollection.createIndex({ session_id: 1 }, { unique: true, sparse: true });
      await collections.paymentsCollection.createIndex({ transactionId: 1 });
      await collections.paymentsCollection.createIndex({ "metadata.userEmail": 1 });
    }
    if (collections.wishlistCollection && typeof collections.wishlistCollection.createIndex === "function") {
      await collections.wishlistCollection.createIndex({ userInfo: 1 });
      await collections.wishlistCollection.createIndex({ "product._id": 1, userInfo: 1 });
    }
    if (collections.usersCollection && typeof collections.usersCollection.createIndex === "function") {
      await collections.usersCollection.createIndex({ email: 1 });
    }
    if (collections.reportsCollection && typeof collections.reportsCollection.createIndex === "function") {
      await collections.reportsCollection.createIndex({ productId: 1 });
      await collections.reportsCollection.createIndex({ reporterEmail: 1 });
      await collections.reportsCollection.createIndex({ status: 1 });
    }
    if (collections.processedEventsCollection && typeof collections.processedEventsCollection.createIndex === "function") {
      await collections.processedEventsCollection.createIndex({ eventId: 1 }, { unique: true });
    }
  } catch (indexErr) {
    // Indexes are safe optimizations; don't crash if database has restricted index privileges
    console.warn("Index initialization notice:", indexErr.message);
  }
}

async function run() {
  if (!client) {
    console.warn("MongoDB client not initialized (MONGODB_URI is empty)");
    return;
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

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );

    await createIndexes();
  } catch (error) {
    console.error("MongoDB connection or setup error:", error.message || error);
  }
}

module.exports = {
  client,
  collections,
  getCollections,
  setCollections,
  run,
};
