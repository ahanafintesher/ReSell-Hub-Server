const { test, it, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { SignJWT } = require("jose-cjs");
const { ObjectId } = require("mongodb");

const {
  app,
  setCollections,
  setVerificationKey,
  setStripeInstance,
} = require("../index");

// Test Configuration
const TEST_SECRET = new TextEncoder().encode(
  "test-secret-key-32-bytes-minimum-length-for-hmac!"
);
const TEST_ISSUER = "http://localhost:3000";
const TEST_AUDIENCE = "http://localhost:3000";

process.env.JWT_ISSUER = TEST_ISSUER;
process.env.JWT_AUDIENCE = TEST_AUDIENCE;

async function createTestToken(payload, options = {}) {
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE);

  if (options.expiresIn !== undefined) {
    jwt.setExpirationTime(options.expiresIn);
  } else {
    jwt.setExpirationTime("2h");
  }

  return await jwt.sign(options.secret || TEST_SECRET);
}

// Enhanced in-memory mock collection supporting sorting, skipping, regex, and counts
function createEnhancedMockCollection(initialData = []) {
  let docs = [...initialData];

  return {
    _docs: docs,
    reset(data = []) {
      docs = [...data];
      this._docs = docs;
    },
    async countDocuments(filter = {}) {
      const match = await this.find(filter).toArray();
      return match.length;
    },
    async findOne(filter = {}) {
      return (
        docs.find((d) => {
          for (const key of Object.keys(filter)) {
            if (key === "_id") {
              const filterId =
                filter._id instanceof ObjectId
                  ? filter._id.toString()
                  : String(filter._id);
              const docId =
                d._id instanceof ObjectId ? d._id.toString() : String(d._id);
              if (docId !== filterId) return false;
            } else if (key.includes(".")) {
              const parts = key.split(".");
              let val = d;
              for (const p of parts) val = val?.[p];
              if (val !== filter[key]) return false;
            } else {
              if (d[key] !== filter[key]) return false;
            }
          }
          return true;
        }) || null
      );
    },
    find(filter = {}) {
      let matched = docs.filter((d) => {
        for (const key of Object.keys(filter)) {
          if (key === "_id") {
            const filterId =
              filter._id instanceof ObjectId
                ? filter._id.toString()
                : String(filter._id);
            const docId =
              d._id instanceof ObjectId ? d._id.toString() : String(d._id);
            if (docId !== filterId) return false;
          } else if (
            filter[key] &&
            typeof filter[key] === "object" &&
            "$regex" in filter[key]
          ) {
            const re = new RegExp(
              filter[key].$regex,
              filter[key].$options || ""
            );
            if (!re.test(d[key] || "")) return false;
          } else if (
            filter[key] &&
            typeof filter[key] === "object"
          ) {
            const expected = filter[key];
            if ("$ne" in expected && d[key] === expected.$ne) return false;
            if (
              "$nin" in expected &&
              Array.isArray(expected.$nin) &&
              expected.$nin.includes(d[key])
            ) {
              return false;
            }
            if (
              "$in" in expected &&
              Array.isArray(expected.$in) &&
              !expected.$in.includes(d[key])
            ) {
              return false;
            }
            if ("$gte" in expected && Number(d[key]) < expected.$gte) return false;
            if ("$lte" in expected && Number(d[key]) > expected.$lte) return false;
          } else if (key.includes(".")) {
            const parts = key.split(".");
            let val = d;
            for (const p of parts) val = val?.[p];
            if (val !== filter[key]) return false;
          } else {
            if (d[key] !== filter[key]) return false;
          }
        }
        return true;
      });

      const chain = {
        toArray: async () => matched,
        sort: (sortObj) => {
          const entries = Object.entries(sortObj);
          if (entries.length > 0) {
            const [field, dir] = entries[0];
            matched = [...matched].sort((a, b) =>
              dir === 1 ? a[field] - b[field] : b[field] - a[field]
            );
          }
          return chain;
        },
        skip: (n) => {
          matched = matched.slice(n);
          return chain;
        },
        limit: (n) => {
          matched = matched.slice(0, n);
          return chain;
        },
        project: () => chain,
      };
      return chain;
    },
    async insertOne(doc) {
      const inserted = {
        _id: doc._id || new ObjectId(),
        ...doc,
      };
      docs.push(inserted);
      return { acknowledged: true, insertedId: inserted._id };
    },
    async updateOne(filter, update) {
      const doc = await this.findOne(filter);
      if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter) {
      const idx = docs.findIndex((d) => {
        for (const key of Object.keys(filter)) {
          if (key === "_id") {
            const filterId =
              filter._id instanceof ObjectId
                ? filter._id.toString()
                : String(filter._id);
            const docId =
              d._id instanceof ObjectId ? d._id.toString() : String(d._id);
            if (docId !== filterId) return false;
          } else if (d[key] !== filter[key]) return false;
        }
        return true;
      });
      if (idx === -1) return { acknowledged: true, deletedCount: 0 };
      docs.splice(idx, 1);
      return { acknowledged: true, deletedCount: 1 };
    },
  };
}

describe("Reliability, Input Validation, and Edge Cases Audit Suite", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockProducts;
  let mockOrders;
  let mockWishlist;
  let mockReviews;
  let mockPayments;

  const fakeStripeClient = {
    checkout: {
      sessions: {
        create: async (params) => ({
          id: "cs_mock_audit_session_123",
          url: "https://checkout.stripe.com/pay/cs_mock_audit_session_123",
          ...params,
        }),
      },
    },
  };

  before(async () => {
    setVerificationKey(TEST_SECRET);
    setStripeInstance(fakeStripeClient);

    mockUsers = createEnhancedMockCollection();
    mockProducts = createEnhancedMockCollection();
    mockOrders = createEnhancedMockCollection();
    mockWishlist = createEnhancedMockCollection();
    mockReviews = createEnhancedMockCollection();
    mockPayments = createEnhancedMockCollection();

    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      wishlistCollection: mockWishlist,
      reviewsCollection: mockReviews,
      paymentsCollection: mockPayments,
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    mockUsers.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123451"),
        email: "buyer@example.com",
        name: "Test Buyer",
        role: "buyer",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123452"),
        email: "seller@example.com",
        name: "Test Seller",
        role: "seller",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123453"),
        email: "admin@example.com",
        name: "Test Admin",
        role: "admin",
        status: "active",
      },
    ]);

    mockProducts.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200001"),
        title: "Apple MacBook Pro M1",
        category: "Electronics",
        condition: "Like New",
        price: 950,
        sellerInfo: "seller@example.com",
        status: "available",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200002"),
        title: "Sony WH-1000XM4 Headphones",
        category: "Electronics",
        condition: "Used",
        price: 200,
        sellerInfo: "seller@example.com",
        status: "available",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200003"),
        title: "Sold Camera Item",
        category: "Photography",
        condition: "Used",
        price: 500,
        sellerInfo: "seller@example.com",
        status: "sold",
      },
    ]);

    mockOrders.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad300001"),
        buyerInfo: "buyer@example.com",
        sellerInfo: { email: "seller@example.com" }, // object sellerInfo format
        orderStatus: "pending",
        price: 950,
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad300002"),
        buyerInfo: { email: "buyer@example.com" }, // object buyerInfo format
        sellerInfo: "seller@example.com",
        orderStatus: "shipped", // cannot be cancelled
        price: 200,
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad300003"),
        buyerInfo: "buyer@example.com",
        sellerInfo: "seller@example.com",
        orderStatus: "cancelled",
        price: 300,
      },
    ]);

    mockWishlist.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad400001"),
        userInfo: "buyer@example.com",
        product: { _id: "60c72b2f9b1d8b2bad200001", title: "Apple MacBook Pro M1" },
      },
    ]);

    mockReviews.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad500001"),
        review: {
          productId: "60c72b2f9b1d8b2bad200001",
          rating: 5,
          comment: "Excellent condition!",
        },
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad500002"),
        review: {
          productId: "60c72b2f9b1d8b2bad200001",
          rating: 4,
          comment: "Very good battery life.",
        },
      },
    ]);

    mockPayments.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad600001"),
        session_id: "cs_existing_1",
        amount: 950,
        paymentStatus: "paid",
        metadata: { userEmail: "buyer@example.com" },
      },
    ]);
  });

  // ──────────────────────────────────────────
  // 1. Invalid MongoDB ObjectId Validation
  // ──────────────────────────────────────────
  describe("1. MongoDB ObjectId Validation", () => {
    it("rejects malformed ObjectId on GET /api/products/:id with 400", async () => {
      const res = await fetch(`${baseUrl}/api/products/not-a-valid-object-id`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /Invalid product ID format/i);
    });

    it("rejects malformed ObjectId on PATCH /api/products/:id with 400", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(`${baseUrl}/api/products/invalid-id`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${sellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ price: 100 }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects malformed ObjectId on DELETE /api/products/:id with 400", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(`${baseUrl}/api/products/invalid-id`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${sellerToken}` },
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects malformed ObjectId on PATCH /api/orders/:orderId/status with 400", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(`${baseUrl}/api/orders/bad-id/status`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${sellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "accepted" }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects malformed ObjectId on DELETE /api/orders/:orderId with 400", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/orders/bad-id`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects malformed ObjectId on DELETE /api/wishlist/:id with 400", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/wishlist/bad-id`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 400);
    });
  });

  // ──────────────────────────────────────────
  // 2. Product Input Validation & Reliability
  // ──────────────────────────────────────────
  describe("2. Product Input Validation & Availability", () => {
    it("rejects product creation when title is empty whitespace (400)", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "   ", price: 100 }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /title is required/i);
    });

    it("rejects product creation when price is negative (400)", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Valid Title", price: -50 }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /price must be a non-negative number/i);
    });

    it("returns 404 for non-existent product ID on GET /api/products/:id", async () => {
      const res = await fetch(
        `${baseUrl}/api/products/60c72b2f9b1d8b2bad999999`
      );
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.match(data.message, /Product not found/i);
    });

    it("filters products by search title keyword", async () => {
      const res = await fetch(`${baseUrl}/api/products?search=MacBook`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.length, 1);
      assert.strictEqual(data[0].title, "Apple MacBook Pro M1");
    });

    it("filters products by category", async () => {
      const res = await fetch(`${baseUrl}/api/products?category=Electronics`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.length, 2);
    });

    it("sorts products by price low to high", async () => {
      const res = await fetch(`${baseUrl}/api/products?sort=price-low-to-high`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data[0].price, 200);
      assert.strictEqual(data[1].price, 500);
      assert.strictEqual(data[2].price, 950);
    });
  });

  // ──────────────────────────────────────────
  // 3. Stripe Checkout Session Creation
  // ──────────────────────────────────────────
  describe("3. Authoritative Stripe Checkout Session Creation", () => {
    it("rejects checkout session creation without authentication (401)", async () => {
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad200001" }),
      });
      assert.strictEqual(res.status, 401);
    });

    it("rejects checkout session creation when productId is missing (400)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /productId is required/i);
    });

    it("rejects checkout session creation for non-existent product (404)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad999999" }),
      });
      assert.strictEqual(res.status, 404);
    });

    it("rejects checkout session creation for already sold product (400)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad200003" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /already sold/i);
    });

    it("rejects checkout session creation when seller tries to purchase their own product (400)", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad200001" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /cannot purchase your own product/i);
    });

    it("successfully creates checkout session with authoritative price from database (200)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad200001" }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.sessionId);
      assert.ok(data.url);
    });
  });

  // ──────────────────────────────────────────
  // 4. Order Lifecycle & Status Transitions
  // ──────────────────────────────────────────
  describe("4. Order Lifecycle & Status Transitions", () => {
    it("rejects invalid status value on order status update (400)", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300001/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${sellerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "bogus-status" }),
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /Invalid status/i);
    });

    it("allows seller to update status when sellerInfo is structured as an object", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300001/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${sellerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "accepted" }),
        }
      );
      assert.strictEqual(res.status, 200);
    });

    it("prevents status update on a cancelled order (400)", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300003/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${sellerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "accepted" }),
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /Cannot update status of a cancelled order/i);
    });

    it("prevents buyer from cancelling an order that is already shipped (400)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300002`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${buyerToken}` },
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /Order cannot be cancelled when status is "shipped"/i);
    });
  });

  // ──────────────────────────────────────────
  // 5. Reviews & Ratings Calculation
  // ──────────────────────────────────────────
  describe("5. Reviews & Rating Calculations", () => {
    it("rejects review creation with rating out of bounds (400)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/reviews`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rating: 10, comment: "Invalid rating" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /rating must be a number between 1 and 5/i);
    });

    it("calculates average rating accurately via /api/reviews/average-rating", async () => {
      const res = await fetch(
        `${baseUrl}/api/reviews/average-rating?productId=60c72b2f9b1d8b2bad200001`
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.averageRating, 4.5);
    });

    it("supports legacy spelling /api/reviews/avarage-rating", async () => {
      const res = await fetch(
        `${baseUrl}/api/reviews/avarage-rating?productId=60c72b2f9b1d8b2bad200001`
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.avarageRating, 4.5);
    });
  });

  // ──────────────────────────────────────────
  // 6. Admin Statistics & Platform Metrics
  // ──────────────────────────────────────────
  describe("6. Admin Platform Statistics API", () => {
    it("prevents non-admin user from accessing platform stats (403)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it("returns platform metrics to authenticated admin (200)", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(`${baseUrl}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.totalUsers, 3);
      assert.strictEqual(data.totalProducts, 3);
      assert.strictEqual(data.totalOrders, 3);
      assert.strictEqual(data.totalRevenue, 950);
    });
  });

  // ──────────────────────────────────────────
  // 7. Centralized Safe 404 & Error Handling
  // ──────────────────────────────────────────
  describe("7. Safe Error Handling", () => {
    it("returns sanitized JSON 404 on undefined routes without leaking internals", async () => {
      const res = await fetch(`${baseUrl}/api/non-existent-endpoint`);
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.message, "Route not found");
    });
  });
});
