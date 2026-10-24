const { test, it, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { ObjectId } = require("mongodb");
const { SignJWT } = require("jose-cjs");

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

// In-memory mock collection supporting standard MongoDB query operators
function createAdversarialMockCollection(initialData = []) {
  let docs = [...initialData];

  function matchesFilter(d, filter) {
    for (const key of Object.keys(filter)) {
      if (key === "$or" && Array.isArray(filter.$or)) {
        const anyMatch = filter.$or.some((subFilter) =>
          matchesFilter(d, subFilter)
        );
        if (!anyMatch) return false;
        continue;
      }

      if (key === "$and" && Array.isArray(filter.$and)) {
        const allMatch = filter.$and.every((subFilter) =>
          matchesFilter(d, subFilter)
        );
        if (!allMatch) return false;
        continue;
      }

      const val = key.includes(".")
        ? key.split(".").reduce((acc, part) => acc?.[part], d)
        : d[key];

      const expected = filter[key];

      if (key === "_id") {
        const filterId =
          expected instanceof ObjectId ? expected.toString() : String(expected);
        const docId =
          val instanceof ObjectId ? val.toString() : String(val);
        if (docId !== filterId) return false;
      } else if (expected && typeof expected === "object") {
        if ("$ne" in expected && val === expected.$ne) return false;
        if ("$nin" in expected && Array.isArray(expected.$nin) && expected.$nin.includes(val)) return false;
        if ("$in" in expected && Array.isArray(expected.$in) && !expected.$in.includes(val)) return false;
        if ("$regex" in expected) {
          const re = new RegExp(expected.$regex, expected.$options || "");
          if (!re.test(String(val || ""))) return false;
        }
        if ("$gte" in expected && Number(val) < expected.$gte) return false;
        if ("$lte" in expected && Number(val) > expected.$lte) return false;
      } else {
        if (val !== expected) return false;
      }
    }
    return true;
  }

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
      return docs.find((d) => matchesFilter(d, filter)) || null;
    },
    find(filter = {}) {
      let matched = docs.filter((d) => matchesFilter(d, filter));

      const chain = {
        toArray: async () => matched,
        sort: (sortObj) => {
          const entries = Object.entries(sortObj);
          if (entries.length > 0) {
            const [field, dir] = entries[0];
            matched = [...matched].sort((a, b) => {
              const valA = a[field];
              const valB = b[field];
              if (valA < valB) return dir === 1 ? -1 : 1;
              if (valA > valB) return dir === 1 ? 1 : -1;
              return 0;
            });
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
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) {
          delete doc[k];
        }
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter) {
      const idx = docs.findIndex((d) => matchesFilter(d, filter));
      if (idx === -1) return { acknowledged: true, deletedCount: 0 };
      docs.splice(idx, 1);
      return { acknowledged: true, deletedCount: 1 };
    },
  };
}

describe("Adversarial Production Readiness Regression Suite", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockProducts;
  let mockOrders;
  let mockPayments;
  let mockReviews;
  let mockWishlist;
  let mockReports;

  let buyer1Token;
  let buyer2Token;
  let sellerToken;
  let blockedSellerToken;
  let adminToken;

  const fakeStripeClient = {
    checkout: {
      sessions: {
        create: async (params) => ({
          id: `cs_test_session_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          url: "https://checkout.stripe.com/pay/session",
          ...params,
        }),
      },
    },
    refunds: {
      create: async (params) => ({
        id: `re_test_${Date.now()}`,
        status: "succeeded",
        ...params,
      }),
    },
    webhooks: {
      constructEvent: (body, sig, secret) => {
        return JSON.parse(body.toString());
      },
    },
  };

  before(async () => {
    setVerificationKey(TEST_SECRET);
    setStripeInstance(fakeStripeClient);

    mockUsers = createAdversarialMockCollection();
    mockProducts = createAdversarialMockCollection();
    mockOrders = createAdversarialMockCollection();
    mockPayments = createAdversarialMockCollection();
    mockReviews = createAdversarialMockCollection();
    mockWishlist = createAdversarialMockCollection();
    mockReports = createAdversarialMockCollection();

    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      paymentsCollection: mockPayments,
      reviewsCollection: mockReviews,
      wishlistCollection: mockWishlist,
      reportsCollection: mockReports,
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    buyer1Token = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000001",
      email: "buyer1@example.com",
      name: "Buyer One",
    });

    buyer2Token = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000002",
      email: "buyer2@example.com",
      name: "Buyer Two",
    });

    sellerToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000003",
      email: "seller@example.com",
      name: "Valid Seller",
    });

    blockedSellerToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000004",
      email: "blocked.seller@example.com",
      name: "Blocked Seller",
    });

    adminToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000005",
      email: "admin@example.com",
      name: "Admin User",
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    mockUsers.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000001"),
        email: "buyer1@example.com",
        name: "Buyer One",
        role: "buyer",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000002"),
        email: "buyer2@example.com",
        name: "Buyer Two",
        role: "buyer",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000003"),
        email: "seller@example.com",
        name: "Valid Seller",
        role: "seller",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000004"),
        email: "blocked.seller@example.com",
        name: "Blocked Seller",
        role: "seller",
        status: "blocked",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000005"),
        email: "admin@example.com",
        name: "Admin User",
        role: "admin",
        status: "active",
      },
    ]);

    mockProducts.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
        title: "Available Vintage Camera",
        category: "Photography",
        condition: "Used",
        price: 250,
        sellerInfo: {
          name: "Valid Seller",
          email: "seller@example.com",
          phone: "+8801700000000", // Private phone that must be sanitized
        },
        sellerName: "Valid Seller",
        status: "available",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad100002"),
        title: "Rejected Counterfeit Phone",
        category: "Electronics",
        condition: "Used",
        price: 300,
        sellerInfo: "seller@example.com",
        status: "rejected",
        moderationStatus: "rejected",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad100003"),
        title: "Pending Review Laptop",
        category: "Electronics",
        condition: "Used",
        price: 500,
        sellerInfo: "seller@example.com",
        status: "pending",
        moderationStatus: "pending",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad100004"),
        title: "Blocked Seller Item",
        category: "Electronics",
        condition: "Used",
        price: 400,
        sellerInfo: "blocked.seller@example.com",
        status: "available",
      },
    ]);

    mockOrders.reset([]);
    mockPayments.reset([]);
    mockReports.reset([]);
    mockReviews.reset([]);
    mockWishlist.reset([]);
  });

  // ──────────────────────────────────────────
  // 1. Concurrent Product Reservation & Competing Sessions
  // ──────────────────────────────────────────
  describe("1. Concurrent Checkout & Reservation Integrity", () => {
    it("Buyer 1 reserves product; Buyer 2 is rejected with 409 Conflict", async () => {
      // Buyer 1 initiates checkout
      const res1 = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100001" }),
      });
      assert.strictEqual(res1.status, 200);

      // Verify product is now reserved by Buyer 1
      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.status, "reserved");
      assert.strictEqual(prod.reservedBy, "buyer1@example.com");

      // Buyer 2 concurrently attempts checkout on the same item
      const res2 = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer2Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100001" }),
      });
      assert.strictEqual(res2.status, 409);
      const data2 = await res2.json();
      assert.match(data2.message, /reserved by another buyer/i);
    });

    it("concurrent checkout attempts: exactly one buyer wins reservation and one gets 409", async () => {
      // Reset product to available
      await mockProducts.updateOne(
        { _id: new ObjectId("60c72b2f9b1d8b2bad100001") },
        {
          $set: { status: "available" },
          $unset: { reservedBy: "", reservedUntil: "", reservationSessionId: "" },
        }
      );

      // Concurrently fire checkout session creation
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/create-checkout-session`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${buyer1Token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100001" }),
        }),
        fetch(`${baseUrl}/api/create-checkout-session`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${buyer2Token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100001" }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409]);

      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.status, "reserved");
      assert.ok(
        prod.reservedBy === "buyer1@example.com" ||
        prod.reservedBy === "buyer2@example.com"
      );
    });

    it("Buyer 1 can refresh or re-create checkout session on their own reserved product", async () => {
      // First session
      await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100001" }),
      });

      // Second session from same buyer succeeds
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100001" }),
      });
      assert.strictEqual(res.status, 200);
    });

    it("expired reservation allows another buyer to checkout", async () => {
      // Set expired reservation in database
      await mockProducts.updateOne(
        { _id: new ObjectId("60c72b2f9b1d8b2bad100001") },
        {
          $set: {
            status: "reserved",
            reservedBy: "buyer1@example.com",
            reservedUntil: new Date(Date.now() - 60000), // Expired 1 minute ago
          },
        }
      );

      // Buyer 2 should now be able to reserve
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer2Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100001" }),
      });
      assert.strictEqual(res.status, 200);

      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.reservedBy, "buyer2@example.com");
    });
  });

  // ──────────────────────────────────────────
  // 2. Moderated Products & Blocked Accounts
  // ──────────────────────────────────────────
  describe("2. Moderation & Account Status Protection", () => {
    it("rejects checkout on rejected product (400)", async () => {
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100002" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /not approved for purchase/i);
    });

    it("rejects checkout on pending moderation product (400)", async () => {
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100003" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /not approved for purchase/i);
    });

    it("rejects direct POST /api/orders on rejected product (400)", async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100002" }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects checkout when seller account is blocked (400)", async () => {
      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100004" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /seller account is blocked/i);
    });

    it("rejects direct POST /api/orders when buyer is the seller (400)", async () => {
      // Product owned by buyer1
      await mockProducts.insertOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100099"),
        title: "Buyer's Own Item",
        category: "Electronics",
        price: 150,
        sellerInfo: "buyer1@example.com",
        status: "available",
      });

      const res = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: "60c72b2f9b1d8b2bad100099" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /cannot purchase your own product/i);
    });
  });

  // ──────────────────────────────────────────
  // 3. Order Status Integrity & Transition Guard
  // ──────────────────────────────────────────
  describe("3. Order Status Integrity & Transitions", () => {
    it("forces client-supplied orderStatus to 'pending' on POST /api/orders", async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productId: "60c72b2f9b1d8b2bad100001",
          orderStatus: "delivered", // Malicious client attempt
        }),
      });
      assert.strictEqual(res.status, 201);

      const inserted = await mockOrders.findOne({
        buyerInfo: "buyer1@example.com",
      });
      assert.strictEqual(inserted.orderStatus, "pending");
    });

    it("prevents shipping an unpaid order (400)", async () => {
      await mockOrders.insertOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad300001"),
        productId: "60c72b2f9b1d8b2bad100001",
        sellerInfo: "seller@example.com",
        buyerInfo: "buyer1@example.com",
        paymentStatus: "pending",
        orderStatus: "pending",
      });

      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300001/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${sellerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "shipped" }),
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /unpaid order|payment is verified/i);
    });

    it("prevents updating status on an already delivered order (400)", async () => {
      await mockOrders.insertOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad300002"),
        productId: "60c72b2f9b1d8b2bad100001",
        sellerInfo: "seller@example.com",
        buyerInfo: "buyer1@example.com",
        paymentStatus: "paid",
        orderStatus: "delivered",
      });

      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300002/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${sellerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "processing" }),
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /already delivered order/i);
    });

    it("prevents cancelling an already shipped order (400)", async () => {
      await mockOrders.insertOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad300003"),
        productId: "60c72b2f9b1d8b2bad100001",
        sellerInfo: "seller@example.com",
        buyerInfo: "buyer1@example.com",
        paymentStatus: "paid",
        orderStatus: "shipped",
      });

      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300003/cancel`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${buyer1Token}` },
        }
      );
      assert.strictEqual(res.status, 400);
    });

    it("cancels pending paid order and records refundStatus: pending_refund", async () => {
      await mockOrders.insertOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad300004"),
        productId: "60c72b2f9b1d8b2bad100001",
        sellerInfo: "seller@example.com",
        buyerInfo: "buyer1@example.com",
        paymentStatus: "paid",
        orderStatus: "pending",
      });

      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300004/cancel`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${buyer1Token}` },
        }
      );
      assert.strictEqual(res.status, 200);

      const order = await mockOrders.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad300004"),
      });
      assert.strictEqual(order.orderStatus, "cancelled");
      assert.strictEqual(order.refundStatus, "pending_refund");

      // Product is restored to available
      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.status, "available");
    });

    it("DELETE /api/orders/:orderId hard cancellation restores product availability", async () => {
      await mockProducts.updateOne(
        { _id: new ObjectId("60c72b2f9b1d8b2bad100001") },
        { $set: { status: "sold", soldTo: "buyer1@example.com" } }
      );

      await mockOrders.insertOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad300005"),
        productId: "60c72b2f9b1d8b2bad100001",
        sellerInfo: "seller@example.com",
        buyerInfo: "buyer1@example.com",
        paymentStatus: "paid",
        orderStatus: "pending",
      });

      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300005`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${buyer1Token}` },
        }
      );
      assert.strictEqual(res.status, 200);

      // Product is restored to available
      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.status, "available");
      assert.strictEqual(prod.soldTo, undefined);
    });
  });

  // ──────────────────────────────────────────
  // 4. Stripe Webhook Double Sale & Event Lifecycle
  // ──────────────────────────────────────────
  describe("4. Stripe Webhook Double Sale Prevention & Idempotency", () => {
    it("handles concurrent/duplicate payment for already sold item without creating duplicate active order", async () => {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret";

      // Buyer 1's purchase completes first
      const session1Payload = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_session_first_buyer",
            payment_status: "paid",
            amount_total: 25000,
            currency: "usd",
            customer_email: "buyer1@example.com",
            metadata: {
              productId: "60c72b2f9b1d8b2bad100001",
              price: "250",
              userEmail: "buyer1@example.com",
            },
          },
        },
      };

      const res1 = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "stripe-signature": "valid_mock_sig",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(session1Payload),
      });
      assert.strictEqual(res1.status, 200);

      // Verify product is sold to buyer 1
      const prodAfterFirst = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prodAfterFirst.status, "sold");
      assert.strictEqual(prodAfterFirst.soldTo, "buyer1@example.com");

      // Buyer 2's competing session completes afterwards
      const session2Payload = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_session_second_buyer",
            payment_status: "paid",
            amount_total: 25000,
            currency: "usd",
            customer_email: "buyer2@example.com",
            metadata: {
              productId: "60c72b2f9b1d8b2bad100001",
              price: "250",
              userEmail: "buyer2@example.com",
            },
          },
        },
      };

      const res2 = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "stripe-signature": "valid_mock_sig",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(session2Payload),
      });
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json();
      assert.strictEqual(data2.doubleSale, true);

      // Verify second buyer's payment record was safely saved for refund audit
      const payment2 = await mockPayments.findOne({
        session_id: "cs_session_second_buyer",
      });
      assert.ok(payment2);
      assert.strictEqual(payment2.fulfillmentStatus, "failed_duplicate_purchase");
      assert.strictEqual(payment2.refundStatus, "pending_refund");
      assert.strictEqual(payment2.refundQueue, true);

      // Verify second order was created with status 'rejected' rather than 'pending'
      const order2 = await mockOrders.findOne({
        paymentId: "cs_session_second_buyer",
      });
      assert.ok(order2);
      assert.strictEqual(order2.orderStatus, "rejected");
      assert.strictEqual(order2.refundStatus, "pending_refund");

      // Product ownership was NOT overwritten
      const finalProd = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(finalProd.soldTo, "buyer1@example.com");
    });

    it("competing session with payment_intent triggers automatic Stripe refund and records refundStatus: refunded", async () => {
      // Prior active paid order exists for this product
      await mockOrders.insertOne({
        productId: "60c72b2f9b1d8b2bad100001",
        paymentId: "cs_session_first_buyer",
        transactionId: "pi_first_buyer",
        paymentStatus: "paid",
        orderStatus: "pending",
      });
      await mockProducts.updateOne(
        { _id: new ObjectId("60c72b2f9b1d8b2bad100001") },
        { $set: { status: "sold", soldTo: "buyer1@example.com" } }
      );

      // Competing session that includes payment_intent arrives
      const session3Payload = {
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_session_third_buyer",
            payment_status: "paid",
            payment_intent: "pi_third_buyer_auto_refund",
            amount_total: 25000,
            currency: "usd",
            customer_email: "buyer3@example.com",
            metadata: {
              productId: "60c72b2f9b1d8b2bad100001",
              price: "250",
              userEmail: "buyer3@example.com",
            },
          },
        },
      };

      const res3 = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "stripe-signature": "valid_mock_sig",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(session3Payload),
      });
      assert.strictEqual(res3.status, 200);
      const data3 = await res3.json();
      assert.strictEqual(data3.doubleSale, true);

      const payment3 = await mockPayments.findOne({
        session_id: "cs_session_third_buyer",
      });
      assert.ok(payment3);
      assert.strictEqual(payment3.fulfillmentStatus, "failed_duplicate_purchase");
      assert.strictEqual(payment3.refundStatus, "refunded");
      assert.ok(payment3.refundId);

      const order3 = await mockOrders.findOne({
        paymentId: "cs_session_third_buyer",
      });
      assert.ok(order3);
      assert.strictEqual(order3.orderStatus, "rejected");
      assert.strictEqual(order3.refundStatus, "refunded");
      assert.ok(order3.refundId);
    });

    it("releases reservation when checkout.session.expired arrives", async () => {
      // Set product as reserved
      await mockProducts.updateOne(
        { _id: new ObjectId("60c72b2f9b1d8b2bad100001") },
        {
          $set: {
            status: "reserved",
            reservationSessionId: "cs_session_to_expire",
            reservedBy: "buyer1@example.com",
          },
        }
      );

      const expirePayload = {
        type: "checkout.session.expired",
        data: {
          object: {
            id: "cs_session_to_expire",
            metadata: { productId: "60c72b2f9b1d8b2bad100001" },
          },
        },
      };

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "stripe-signature": "valid_mock_sig",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(expirePayload),
      });
      assert.strictEqual(res.status, 200);

      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.status, "available");
      assert.strictEqual(prod.reservationSessionId, undefined);
    });

    it("delayed checkout.session.expired does not reset an already sold product to available", async () => {
      // Set product as sold
      await mockProducts.updateOne(
        { _id: new ObjectId("60c72b2f9b1d8b2bad100001") },
        {
          $set: {
            status: "sold",
            soldTo: "buyer1@example.com",
            soldPaymentId: "cs_session_first_buyer",
          },
          $unset: { reservedBy: "", reservedUntil: "", reservationSessionId: "" },
        }
      );

      const delayedExpirePayload = {
        type: "checkout.session.expired",
        data: {
          object: {
            id: "cs_old_expired_session",
            metadata: { productId: "60c72b2f9b1d8b2bad100001" },
          },
        },
      };

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "stripe-signature": "valid_mock_sig",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(delayedExpirePayload),
      });
      assert.strictEqual(res.status, 200);

      // Product MUST still be sold
      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.status, "sold");
      assert.strictEqual(prod.soldTo, "buyer1@example.com");
    });

    it("delayed checkout.session.expired does not release a newer active reservation", async () => {
      // Product currently reserved under a newer session cs_newer_session
      await mockProducts.updateOne(
        { _id: new ObjectId("60c72b2f9b1d8b2bad100001") },
        {
          $set: {
            status: "reserved",
            reservationSessionId: "cs_newer_session",
            reservedBy: "buyer1@example.com",
            reservedUntil: new Date(Date.now() + 15 * 60 * 1000),
          },
        }
      );

      // Delayed webhook arrives for old session
      const delayedExpirePayload = {
        type: "checkout.session.expired",
        data: {
          object: {
            id: "cs_older_expired_session",
            metadata: { productId: "60c72b2f9b1d8b2bad100001" },
          },
        },
      };

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "stripe-signature": "valid_mock_sig",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(delayedExpirePayload),
      });
      assert.strictEqual(res.status, 200);

      // Product MUST still be reserved under cs_newer_session
      const prod = await mockProducts.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad100001"),
      });
      assert.strictEqual(prod.status, "reserved");
      assert.strictEqual(prod.reservationSessionId, "cs_newer_session");
      assert.strictEqual(prod.reservedBy, "buyer1@example.com");
    });
  });

  // ──────────────────────────────────────────
  // 5. Polymorphic Object/String Schema Queries & Privacy
  // ──────────────────────────────────────────
  describe("5. Polymorphic Schema Queries & Public Data Sanitization", () => {
    it("GET /api/seller/orders finds orders stored as objects", async () => {
      await mockOrders.insertOne({
        productId: "60c72b2f9b1d8b2bad100001",
        sellerInfo: { email: "seller@example.com", name: "Valid Seller" }, // object format
        buyerInfo: "buyer1@example.com",
        orderStatus: "pending",
        price: 250,
      });

      const res = await fetch(`${baseUrl}/api/seller/orders`, {
        headers: { Authorization: `Bearer ${sellerToken}` },
      });
      assert.strictEqual(res.status, 200);
      const orders = await res.json();
      assert.strictEqual(orders.length, 1);
    });

    it("GET /api/buyer/orders finds orders stored as objects", async () => {
      await mockOrders.insertOne({
        productId: "60c72b2f9b1d8b2bad100001",
        sellerInfo: "seller@example.com",
        buyerInfo: { email: "buyer1@example.com", name: "Buyer One" }, // object format
        orderStatus: "pending",
        price: 250,
      });

      const res = await fetch(`${baseUrl}/api/buyer/orders`, {
        headers: { Authorization: `Bearer ${buyer1Token}` },
      });
      assert.strictEqual(res.status, 200);
      const orders = await res.json();
      assert.strictEqual(orders.length, 1);
    });

    it("GET /api/products/:id sanitizes private phone numbers from sellerInfo", async () => {
      const res = await fetch(
        `${baseUrl}/api/products/60c72b2f9b1d8b2bad100001`
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      // sellerInfo should have name and email, but phone MUST NOT be exposed
      assert.strictEqual(data.sellerInfo.name, "Valid Seller");
      assert.strictEqual(data.sellerInfo.phone, undefined);
    });
  });
});
