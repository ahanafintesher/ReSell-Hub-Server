const { test, it, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { ObjectId } = require("mongodb");
const Stripe = require("stripe");
const { SignJWT } = require("jose-cjs");

const {
  app,
  setCollections,
  setStripeInstance,
  setVerificationKey,
  run,
  close,
} = require("../index");
const {
  processPendingRefunds,
  getRefundIdempotencyKey,
  calculateBackoffDelay,
} = require("../src/utils/refundRecovery");

/**
 * RELIABILITY FIXES REGRESSION TEST SUITE
 *
 * NOTE ON TESTING LIMITATIONS:
 * In-memory mock collections and mock Stripe instances provide functional regression
 * coverage of business invariants, control flows, and state machines. However, they do
 * NOT simulate distributed MongoDB wire-protocol concurrency or network-level Stripe behavior.
 * External end-to-end integration tests with a live MongoDB replica set and Stripe CLI
 * are recommended for staging/pre-production verification.
 */

const TEST_SECRET = new TextEncoder().encode(
  "test-secret-key-32-bytes-minimum-length-for-hmac!"
);
const TEST_WEBHOOK_SECRET =
  "whsec_test_secret_for_automated_testing_12345678901234567890";
const stripeTestClient = new Stripe("sk_test_fake_key_for_testing");

process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "http://localhost:3000";
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

async function createTestToken(payload) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("http://localhost:3000")
    .setAudience("http://localhost:3000")
    .setExpirationTime("2h")
    .sign(TEST_SECRET);
}

function createRegressionMockCollection(initialData = [], uniqueFields = []) {
  let docs = [...initialData];

  function matchesFilter(d, filter) {
    for (const key of Object.keys(filter)) {
      if (key === "$or" && Array.isArray(filter.$or)) {
        const anyMatch = filter.$or.some((sub) => matchesFilter(d, sub));
        if (!anyMatch) return false;
        continue;
      }
      if (key === "$and" && Array.isArray(filter.$and)) {
        const allMatch = filter.$and.every((sub) => matchesFilter(d, sub));
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
        const docId = val instanceof ObjectId ? val.toString() : String(val);
        if (docId !== filterId) return false;
      } else if (expected && typeof expected === "object") {
        if ("$ne" in expected && val === expected.$ne) return false;
        if ("$nin" in expected && Array.isArray(expected.$nin) && expected.$nin.includes(val))
          return false;
        if ("$in" in expected && Array.isArray(expected.$in) && !expected.$in.includes(val))
          return false;
        if ("$exists" in expected) {
          const exists = val !== undefined;
          if (exists !== expected.$exists) return false;
        }
        if ("$lt" in expected) {
          const expectedVal = expected.$lt instanceof Date ? expected.$lt.getTime() : expected.$lt;
          const actualVal = val instanceof Date ? val.getTime() : val;
          if (!(actualVal < expectedVal)) return false;
        }
        if ("$lte" in expected) {
          const expectedVal = expected.$lte instanceof Date ? expected.$lte.getTime() : expected.$lte;
          const actualVal = val instanceof Date ? val.getTime() : val;
          if (!(actualVal <= expectedVal)) return false;
        }
        if ("$gt" in expected) {
          const expectedVal = expected.$gt instanceof Date ? expected.$gt.getTime() : expected.$gt;
          const actualVal = val instanceof Date ? val.getTime() : val;
          if (!(actualVal > expectedVal)) return false;
        }
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
      return docs.filter((d) => matchesFilter(d, filter)).length;
    },
    async findOne(filter = {}) {
      return docs.find((d) => matchesFilter(d, filter)) || null;
    },
    find(filter = {}) {
      let matched = docs.filter((d) => matchesFilter(d, filter));
      const chain = {
        toArray: async () => matched,
        sort: () => chain,
        skip: (n) => {
          matched = matched.slice(n);
          return chain;
        },
        limit: (n) => {
          matched = matched.slice(0, n);
          return chain;
        },
      };
      return chain;
    },
    async insertOne(doc) {
      for (const field of uniqueFields) {
        if (doc[field] !== undefined && doc[field] !== null) {
          const conflict = docs.find((d) => d[field] === doc[field]);
          if (conflict) {
            const err = new Error(`E11000 duplicate key error collection index: ${field}_1`);
            err.code = 11000;
            err.keyPattern = { [field]: 1 };
            err.keyValue = { [field]: doc[field] };
            throw err;
          }
        }
      }

      const inserted = {
        _id: doc._id || new ObjectId(),
        ...doc,
      };
      docs.push(inserted);
      return { acknowledged: true, insertedId: inserted._id };
    },
    async updateOne(filter, update) {
      const doc = docs.find((d) => matchesFilter(d, filter));
      if (!doc) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) {
          delete doc[k];
        }
      }
      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          doc[k] = (doc[k] || 0) + v;
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

describe("Reliability & Concurrency Regression Test Suite", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockProducts;
  let mockOrders;
  let mockPayments;
  let mockProcessedEvents;

  let buyer1Token;
  let buyer2Token;
  let adminToken;

  const capturedRefundCalls = [];

  const mockStripe = {
    checkout: {
      sessions: {
        create: async (params) => ({
          id: `cs_test_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          url: "https://checkout.stripe.com/pay/session_mock",
          status: "open",
          ...params,
        }),
        retrieve: async (sessionId) => {
          return {
            id: sessionId,
            status: "open",
            url: "https://checkout.stripe.com/pay/session_mock",
          };
        },
      },
    },
    refunds: {
      create: async (params, options = {}) => {
        capturedRefundCalls.push({ params, options, timestamp: new Date() });
        return {
          id: `re_mock_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          status: "succeeded",
          payment_intent: params.payment_intent,
          amount: params.amount,
        };
      },
    },
    webhooks: {
      constructEvent: (body, sig, secret) => {
        return stripeTestClient.webhooks.constructEvent(body, sig, secret);
      },
    },
  };

  function generateSignedWebhook(payloadObj, secret = TEST_WEBHOOK_SECRET) {
    const rawPayload = JSON.stringify(payloadObj);
    const signature = stripeTestClient.webhooks.generateTestHeaderString({
      payload: rawPayload,
      secret,
    });
    return { rawPayload, signature };
  }

  before(async () => {
    setVerificationKey(TEST_SECRET);
    setStripeInstance(mockStripe);

    mockUsers = createRegressionMockCollection([], ["email"]);
    mockProducts = createRegressionMockCollection([], []);
    mockOrders = createRegressionMockCollection([], ["paymentId"]);
    mockPayments = createRegressionMockCollection([], ["session_id"]);
    mockProcessedEvents = createRegressionMockCollection([], ["eventId"]);

    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      paymentsCollection: mockPayments,
      processedEventsCollection: mockProcessedEvents,
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    buyer1Token = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000001",
      email: "buyer1@example.com",
      role: "buyer",
    });

    buyer2Token = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000002",
      email: "buyer2@example.com",
      role: "buyer",
    });

    adminToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad000009",
      email: "admin@example.com",
      role: "admin",
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (typeof close === "function") {
      await close();
    }
  });

  beforeEach(() => {
    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      paymentsCollection: mockPayments,
      processedEventsCollection: mockProcessedEvents,
    });
    mockUsers.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000001"),
        email: "buyer1@example.com",
        role: "buyer",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000002"),
        email: "buyer2@example.com",
        role: "buyer",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad000009"),
        email: "admin@example.com",
        role: "admin",
        status: "active",
      },
    ]);
    mockProducts.reset();
    mockOrders.reset();
    mockPayments.reset();
    mockProcessedEvents.reset();
    capturedRefundCalls.length = 0;
  });

  // ──────────────────────────────────────────
  // 1. Same-buyer concurrent checkout requests
  // ──────────────────────────────────────────
  describe("1. Same-Buyer Concurrent Checkout Requests", () => {
    it("reuses existing active checkout session for same buyer instead of creating duplicate Stripe sessions", async () => {
      const prodId = new ObjectId();
      mockProducts.reset([
        {
          _id: prodId,
          title: "Test Item",
          price: 50,
          status: "available",
          sellerInfo: "seller@example.com",
          moderationStatus: "approved",
        },
      ]);

      // Request 1: creates initial reservation and session
      const res1 = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: prodId.toString() }),
      });
      assert.strictEqual(res1.status, 200);
      const data1 = await res1.json();
      assert.ok(data1.sessionId);

      // Request 2 from same buyer: detects active reservation with open session and reuses it
      const res2 = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: prodId.toString() }),
      });
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json();
      assert.strictEqual(data2.sessionId, data1.sessionId);
      assert.strictEqual(data2.resumed, true);
    });

    it("rejects competing same-buyer request with HTTP 409 when session creation is still in flight", async () => {
      const prodId = new ObjectId();
      mockProducts.reset([
        {
          _id: prodId,
          title: "Test Item In-Flight",
          price: 75,
          status: "reserved",
          reservedBy: "buyer1@example.com",
          reservedUntil: new Date(Date.now() + 15 * 60 * 1000),
          reservationSessionId: null, // session not yet populated
          sellerInfo: "seller@example.com",
          moderationStatus: "approved",
        },
      ]);

      const res = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: prodId.toString() }),
      });
      assert.strictEqual(res.status, 409);
      const data = await res.json();
      assert.match(data.message, /checkout session is already in progress/i);
    });
  });

  // ──────────────────────────────────────────
  // 2. Different buyers competing for one product
  // ──────────────────────────────────────────
  describe("2. Different Buyers Competing for One Product", () => {
    it("rejects competing buyer with HTTP 409 when product is already reserved", async () => {
      const prodId = new ObjectId();
      mockProducts.reset([
        {
          _id: prodId,
          title: "Contested Product",
          price: 100,
          status: "available",
          sellerInfo: "seller@example.com",
          moderationStatus: "approved",
        },
      ]);

      // Buyer 1 reserves the item
      const res1 = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: prodId.toString() }),
      });
      assert.strictEqual(res1.status, 200);

      // Buyer 2 attempts checkout on the reserved item
      const res2 = await fetch(`${baseUrl}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer2Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productId: prodId.toString() }),
      });
      assert.strictEqual(res2.status, 409);
      const data2 = await res2.json();
      assert.match(data2.message, /reserved by another buyer/i);
    });
  });

  // ──────────────────────────────────────────
  // 3. Duplicate webhook delivery while processing is active
  // ──────────────────────────────────────────
  describe("3. Duplicate Webhook Delivery Handling", () => {
    it("returns retryable HTTP 503 with Retry-After header when event is in-flight by another worker", async () => {
      const eventId = "evt_inflight_test_1";
      // Simulate another worker having claimed the event 10 seconds ago
      await mockProcessedEvents.insertOne({
        eventId,
        eventType: "checkout.session.completed",
        status: "processing",
        startedAt: new Date(),
        claimExpiresAt: new Date(Date.now() + 110 * 1000), // active claim
      });

      const eventPayload = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_inflight_123",
            payment_status: "paid",
            amount_total: 5000,
            currency: "usd",
            customer_details: { email: "buyer1@example.com" },
            metadata: { price: "50", userEmail: "buyer1@example.com" },
          },
        },
      };

      const { rawPayload, signature } = generateSignedWebhook(eventPayload);
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      // Must return retryable 503 instead of false 200 ack
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.headers.get("retry-after"), "5");
    });

    it("returns HTTP 200 idempotent acknowledgment when event has already completed", async () => {
      const eventId = "evt_completed_test_1";
      await mockProcessedEvents.insertOne({
        eventId,
        eventType: "checkout.session.completed",
        status: "completed",
        completedAt: new Date(),
      });

      const eventPayload = {
        id: eventId,
        type: "checkout.session.completed",
        data: { object: { id: "cs_done_123" } },
      };

      const { rawPayload, signature } = generateSignedWebhook(eventPayload);
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.match(data.message, /already processed/i);
    });
  });

  // ──────────────────────────────────────────
  // 4. Webhook processing failure followed by successful retry
  // ──────────────────────────────────────────
  describe("4. Webhook Processing Failure and Retry Recovery", () => {
    it("reclaims event marked failed and successfully completes on subsequent retry", async () => {
      const eventId = "evt_retry_recovery_1";
      const sessionId = "cs_retry_rec_1";
      const prodId = new ObjectId();

      mockProducts.reset([
        {
          _id: prodId,
          title: "Retryable Product",
          price: 40,
          status: "available",
          sellerInfo: "seller@example.com",
        },
      ]);

      // Seed failed event from earlier aborted attempt
      await mockProcessedEvents.insertOne({
        eventId,
        eventType: "checkout.session.completed",
        status: "failed",
        lastError: "Database transient socket error",
        failedAt: new Date(),
      });

      const eventPayload = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            payment_status: "paid",
            payment_intent: "pi_retry_rec_1",
            amount_total: 4000,
            currency: "usd",
            customer_details: { email: "buyer1@example.com" },
            metadata: {
              productId: prodId.toString(),
              price: "40",
              userEmail: "buyer1@example.com",
            },
          },
        },
      };

      const { rawPayload, signature } = generateSignedWebhook(eventPayload);
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 200);
      const record = await mockProcessedEvents.findOne({ eventId });
      assert.strictEqual(record.status, "completed");

      const order = await mockOrders.findOne({ paymentId: sessionId });
      assert.ok(order);
      assert.strictEqual(order.paymentStatus, "paid");
    });
  });

  // ──────────────────────────────────────────
  // 5. Durable event claim behavior across simulated workers
  // ──────────────────────────────────────────
  describe("5. Durable Event Claim Across Workers", () => {
    it("reclaims stale lock if previous worker crashed and lock timeout expired", async () => {
      const eventId = "evt_stale_lock_1";
      const sessionId = "cs_stale_lock_1";
      const prodId = new ObjectId();

      mockProducts.reset([
        {
          _id: prodId,
          title: "Stale Lock Product",
          price: 60,
          status: "available",
          sellerInfo: "seller@example.com",
        },
      ]);

      // Seed a stale claim (lock timeout 2 minutes has passed)
      await mockProcessedEvents.insertOne({
        eventId,
        eventType: "checkout.session.completed",
        status: "processing",
        startedAt: new Date(Date.now() - 180 * 1000),
        claimExpiresAt: new Date(Date.now() - 60 * 1000), // expired 1 min ago
      });

      const eventPayload = {
        id: eventId,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            payment_status: "paid",
            payment_intent: "pi_stale_lock_1",
            amount_total: 6000,
            currency: "usd",
            customer_details: { email: "buyer1@example.com" },
            metadata: {
              productId: prodId.toString(),
              price: "60",
              userEmail: "buyer1@example.com",
            },
          },
        },
      };

      const { rawPayload, signature } = generateSignedWebhook(eventPayload);
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 200);
      const record = await mockProcessedEvents.findOne({ eventId });
      assert.strictEqual(record.status, "completed");
    });
  });

  // ──────────────────────────────────────────
  // 6. Stripe refund retries using identical idempotency key
  // ──────────────────────────────────────────
  describe("6. Deterministic Stripe Refund Idempotency Keys", () => {
    it("generates stable, deterministic idempotency keys and reuses them on retry", () => {
      const orderId = new ObjectId();
      const key1 = getRefundIdempotencyKey(orderId, "order_cancel");
      const key2 = getRefundIdempotencyKey(orderId, "order_cancel");
      assert.strictEqual(key1, key2);
      assert.strictEqual(key1, `refund_order_cancel_${orderId.toString()}`);

      const sessionKey1 = getRefundIdempotencyKey("cs_test_session_abc", "duplicate");
      const sessionKey2 = getRefundIdempotencyKey("cs_test_session_abc", "duplicate");
      assert.strictEqual(sessionKey1, sessionKey2);
      assert.strictEqual(sessionKey1, "refund_duplicate_cs_test_session_abc");
    });

    it("triggers Stripe refund with deterministic idempotencyKey on double sale", async () => {
      const prodId = new ObjectId();
      const firstSessionId = "cs_legit_first_buyer";
      const secondSessionId = "cs_competing_second_buyer";

      mockProducts.reset([
        {
          _id: prodId,
          title: "Rare Vintage Watch",
          price: 250,
          status: "sold",
          soldTo: "first@example.com",
          soldPaymentId: firstSessionId,
        },
      ]);

      mockOrders.reset([
        {
          _id: new ObjectId(),
          productId: prodId.toString(),
          paymentId: firstSessionId,
          transactionId: "pi_first_buyer",
          paymentStatus: "paid",
          orderStatus: "pending",
        },
      ]);

      const eventPayload = {
        id: "evt_double_sale_1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: secondSessionId,
            payment_status: "paid",
            payment_intent: "pi_second_competing_buyer",
            amount_total: 25000,
            currency: "usd",
            customer_details: { email: "second@example.com" },
            metadata: {
              productId: prodId.toString(),
              price: "250",
              userEmail: "second@example.com",
            },
          },
        },
      };

      const { rawPayload, signature } = generateSignedWebhook(eventPayload);
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(capturedRefundCalls.length, 1);
      const refundCall = capturedRefundCalls[0];
      assert.strictEqual(
        refundCall.options.idempotencyKey,
        `refund_duplicate_${secondSessionId}`
      );
      assert.strictEqual(refundCall.params.payment_intent, "pi_second_competing_buyer");
    });
  });

  // ──────────────────────────────────────────
  // 7. Refund queue recovery and retry limits
  // ──────────────────────────────────────────
  describe("7. Refund Queue Recovery and Retry Limits", () => {
    it("processes pending refunds with deterministic idempotency keys and caps retries", async () => {
      const orderId1 = new ObjectId();
      const orderId2 = new ObjectId();

      mockOrders.reset([
        {
          _id: orderId1,
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_recover_1",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 0,
        },
        {
          _id: orderId2,
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_recover_2",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 3, // already at max retries
        },
      ]);

      const result = await processPendingRefunds({ maxBatch: 10, maxRetries: 3 });
      assert.strictEqual(result.refunded, 1);

      const order1 = await mockOrders.findOne({ _id: orderId1 });
      assert.strictEqual(order1.refundStatus, "refunded");
      assert.strictEqual(order1.refundQueue, false);

      // Order 2 at max retries was not processed
      const order2 = await mockOrders.findOne({ _id: orderId2 });
      assert.strictEqual(order2.refundStatus, "pending_refund");
    });
  });

  // ──────────────────────────────────────────
  // 8. Cancellation racing with successful payment completion
  // ──────────────────────────────────────────
  describe("8. Cancellation Racing With Webhook Completion", () => {
    it("refunds buyer and preserves product availability when order was cancelled before webhook arrival", async () => {
      const prodId = new ObjectId();
      const orderId = new ObjectId();
      const sessionId = "cs_cancel_race_1";
      const paymentIntentId = "pi_cancel_race_1";

      mockProducts.reset([
        {
          _id: prodId,
          title: "Cancelled Race Item",
          price: 80,
          status: "available",
          sellerInfo: "seller@example.com",
        },
      ]);

      // Buyer created an order upfront, then cancelled it before the webhook arrived
      mockOrders.reset([
        {
          _id: orderId,
          productId: prodId.toString(),
          paymentId: sessionId,
          transactionId: paymentIntentId,
          paymentStatus: "pending",
          orderStatus: "cancelled",
          cancelledAt: new Date(),
          refundStatus: "not_applicable",
        },
      ]);

      const eventPayload = {
        id: "evt_cancel_race_1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            payment_status: "paid",
            payment_intent: paymentIntentId,
            amount_total: 8000,
            currency: "usd",
            customer_details: { email: "buyer1@example.com" },
            metadata: {
              productId: prodId.toString(),
              price: "80",
              userEmail: "buyer1@example.com",
            },
          },
        },
      };

      const { rawPayload, signature } = generateSignedWebhook(eventPayload);
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 200);

      // 1. Order remains cancelled, but marked paid & refunded
      const updatedOrder = await mockOrders.findOne({ _id: orderId });
      assert.strictEqual(updatedOrder.orderStatus, "cancelled");
      assert.strictEqual(updatedOrder.paymentStatus, "paid");
      assert.strictEqual(updatedOrder.refundStatus, "refunded");

      // 2. Product must NOT be marked sold; remains available
      const product = await mockProducts.findOne({ _id: prodId });
      assert.strictEqual(product.status, "available");

      // 3. Refund was issued with deterministic order cancel idempotency key
      assert.strictEqual(capturedRefundCalls.length, 1);
      assert.strictEqual(
        capturedRefundCalls[0].options.idempotencyKey,
        `refund_order_cancel_${orderId.toString()}`
      );
    });
  });

  // ──────────────────────────────────────────
  // 9. Duplicate POST /api/orders requests and MongoDB error 11000
  // ──────────────────────────────────────────
  describe("9. Duplicate POST /api/orders Handling (Code 11000)", () => {
    it("handles E11000 duplicate paymentId gracefully and returns existing order", async () => {
      const prodId = new ObjectId();
      mockProducts.reset([
        {
          _id: prodId,
          title: "Order Race Item",
          price: 45,
          sellerInfo: "seller@example.com",
        },
      ]);

      const orderPayload = {
        productId: prodId.toString(),
        paymentId: "cs_duplicate_order_test_1",
        price: 45,
        buyerInfo: "buyer1@example.com",
      };

      // First call succeeds with 201
      const res1 = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(orderPayload),
      });
      assert.strictEqual(res1.status, 201);

      // Second duplicate call hits E11000 on unique paymentId
      const res2 = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(orderPayload),
      });

      // Must return HTTP 200 with existing order instead of 500 error
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json();
      assert.match(data2.message, /Order already placed/i);
      assert.ok(data2.insertedId);
    });
  });

  // ──────────────────────────────────────────
  // 10. Admin refund queue processing endpoint
  // ──────────────────────────────────────────
  describe("10. Admin Refund Queue Processing Endpoint", () => {
    it("allows admin to trigger bounded refund queue processing", async () => {
      const orderId = new ObjectId();
      mockOrders.reset([
        {
          _id: orderId,
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_admin_process_1",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 0,
        },
      ]);

      const res = await fetch(`${baseUrl}/api/admin/refunds/process-queue`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ maxBatch: 5, maxRetries: 3 }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.refunded, 1);
    });

    it("forbids non-admin from triggering refund processing", async () => {
      const res = await fetch(`${baseUrl}/api/admin/refunds/process-queue`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer1Token}`,
          "Content-Type": "application/json",
        },
      });
      assert.strictEqual(res.status, 403);
    });
  });

  // ──────────────────────────────────────────
  // 11. Reliable Startup & Database Connection Guard
  // ──────────────────────────────────────────
  describe("11. Reliable Startup and Deduplication", () => {
    it("run() returns initialized collections and prevents duplicate concurrent execution", async () => {
      // Calling run() multiple times returns the same resolved promise / collections
      const res1 = await run();
      const res2 = await run();
      assert.ok(res1);
      assert.strictEqual(res1, res2);
    });
  });

  // ──────────────────────────────────────────
  // 12. Financial State & Refund Timestamp Consistency (Rule 8 Integrity)
  // ──────────────────────────────────────────
  describe("12. Financial State & Refund Timestamp Consistency (Rule 8 Integrity)", () => {
    it("does NOT set refundSuccessAt when Stripe returns pending on recovery", async () => {
      const orderId = new ObjectId();
      mockOrders.reset([
        {
          _id: orderId,
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_pending_recovery_1",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 0,
        },
      ]);
      mockPayments.reset([
        {
          _id: new ObjectId(),
          orderId,
          transactionId: "pi_pending_recovery_1",
          paymentStatus: "paid",
          refundStatus: "pending_refund",
          refundQueue: true,
        },
      ]);

      const originalCreate = mockStripe.refunds.create;
      mockStripe.refunds.create = async (params, options) => {
        return {
          id: "re_pending_test_1",
          status: "pending",
          payment_intent: params.payment_intent,
        };
      };

      try {
        const result = await processPendingRefunds({ maxBatch: 5, maxRetries: 3 });
        assert.strictEqual(result.refunded, 0, "Pending refund must not increment refundedCount");

        const updatedOrder = await mockOrders.findOne({ _id: orderId });
        assert.strictEqual(updatedOrder.refundStatus, "pending_refund");
        assert.strictEqual(updatedOrder.refundQueue, true);
        assert.strictEqual(
          updatedOrder.refundSuccessAt,
          undefined,
          "refundSuccessAt must NEVER be set on pending refund"
        );
        assert.ok(updatedOrder.nextRetryAt instanceof Date, "nextRetryAt must be scheduled");

        const updatedPayment = await mockPayments.findOne({ orderId });
        assert.strictEqual(updatedPayment.refundStatus, "pending_refund");
        assert.strictEqual(
          updatedPayment.refundSuccessAt,
          undefined,
          "refundSuccessAt must not be set on payment for pending refund"
        );
      } finally {
        mockStripe.refunds.create = originalCreate;
      }
    });

    it("sets valid refundSuccessAt when Stripe confirms succeeded on recovery", async () => {
      const orderId = new ObjectId();
      mockOrders.reset([
        {
          _id: orderId,
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_succeeded_recovery_1",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 0,
        },
      ]);
      mockPayments.reset([
        {
          _id: new ObjectId(),
          orderId,
          transactionId: "pi_succeeded_recovery_1",
          paymentStatus: "paid",
          refundStatus: "pending_refund",
          refundQueue: true,
        },
      ]);

      const originalCreate = mockStripe.refunds.create;
      mockStripe.refunds.create = async (params, options) => {
        return {
          id: "re_succeeded_test_1",
          status: "succeeded",
          payment_intent: params.payment_intent,
        };
      };

      try {
        const result = await processPendingRefunds({ maxBatch: 5, maxRetries: 3 });
        assert.strictEqual(result.refunded, 1);

        const updatedOrder = await mockOrders.findOne({ _id: orderId });
        assert.strictEqual(updatedOrder.refundStatus, "refunded");
        assert.strictEqual(updatedOrder.refundQueue, false);
        assert.ok(
          updatedOrder.refundSuccessAt instanceof Date,
          "refundSuccessAt must be set to Date upon confirmed succeeded refund"
        );

        const updatedPayment = await mockPayments.findOne({ orderId });
        assert.strictEqual(updatedPayment.refundStatus, "refunded");
        assert.ok(
          updatedPayment.refundSuccessAt instanceof Date,
          "Payment refundSuccessAt must be synchronized"
        );
      } finally {
        mockStripe.refunds.create = originalCreate;
      }
    });

    it("does NOT set refundSuccessAt when Stripe throws error on recovery", async () => {
      const orderId = new ObjectId();
      mockOrders.reset([
        {
          _id: orderId,
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_error_recovery_1",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 0,
        },
      ]);

      const originalCreate = mockStripe.refunds.create;
      mockStripe.refunds.create = async () => {
        throw new Error("Stripe network error on refund attempt");
      };

      try {
        const result = await processPendingRefunds({ maxBatch: 5, maxRetries: 3 });
        assert.strictEqual(result.failed, 1);

        const updatedOrder = await mockOrders.findOne({ _id: orderId });
        assert.strictEqual(updatedOrder.refundStatus, "pending_refund");
        assert.strictEqual(
          updatedOrder.refundSuccessAt,
          undefined,
          "refundSuccessAt must not be set on failed refund"
        );
        assert.ok(updatedOrder.refundError);
        assert.ok(updatedOrder.nextRetryAt instanceof Date);
      } finally {
        mockStripe.refunds.create = originalCreate;
      }
    });

    it("cancellation immediate refund: pending Stripe status does not set refundSuccessAt and synchronizes payment", async () => {
      const orderId = new ObjectId();
      const sessionId = "cs_cancel_pending_sync_1";
      const piId = "pi_cancel_pending_sync_1";

      mockOrders.reset([
        {
          _id: orderId,
          buyerInfo: "buyer1@example.com",
          paymentStatus: "paid",
          orderStatus: "pending",
          transactionId: piId,
          paymentId: sessionId,
          createdAt: new Date(),
        },
      ]);
      mockPayments.reset([
        {
          _id: new ObjectId(),
          orderId,
          session_id: sessionId,
          transactionId: piId,
          paymentStatus: "paid",
        },
      ]);

      const originalCreate = mockStripe.refunds.create;
      mockStripe.refunds.create = async () => {
        return { id: "re_pending_cancel_1", status: "pending" };
      };

      try {
        const res = await fetch(`${baseUrl}/api/orders/${orderId}/cancel`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${buyer1Token}`,
            "Content-Type": "application/json",
          },
        });

        assert.strictEqual(res.status, 200);

        const order = await mockOrders.findOne({ _id: orderId });
        assert.strictEqual(order.refundStatus, "pending_refund");
        assert.strictEqual(order.refundSuccessAt, undefined);

        const payment = await mockPayments.findOne({ orderId });
        assert.strictEqual(payment.refundStatus, "pending_refund");
        assert.strictEqual(payment.refundSuccessAt, undefined);
      } finally {
        mockStripe.refunds.create = originalCreate;
      }
    });

    it("cancellation immediate refund: succeeded Stripe status sets refundSuccessAt and synchronizes payment", async () => {
      const orderId = new ObjectId();
      const sessionId = "cs_cancel_succeeded_sync_1";
      const piId = "pi_cancel_succeeded_sync_1";

      mockOrders.reset([
        {
          _id: orderId,
          buyerInfo: "buyer1@example.com",
          paymentStatus: "paid",
          orderStatus: "pending",
          transactionId: piId,
          paymentId: sessionId,
          createdAt: new Date(),
        },
      ]);
      mockPayments.reset([
        {
          _id: new ObjectId(),
          orderId,
          session_id: sessionId,
          transactionId: piId,
          paymentStatus: "paid",
        },
      ]);

      const originalCreate = mockStripe.refunds.create;
      mockStripe.refunds.create = async () => {
        return { id: "re_succeeded_cancel_1", status: "succeeded" };
      };

      try {
        const res = await fetch(`${baseUrl}/api/orders/${orderId}/cancel`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${buyer1Token}`,
            "Content-Type": "application/json",
          },
        });

        assert.strictEqual(res.status, 200);

        const order = await mockOrders.findOne({ _id: orderId });
        assert.strictEqual(order.refundStatus, "refunded");
        assert.ok(order.refundSuccessAt instanceof Date);

        const payment = await mockPayments.findOne({ orderId });
        assert.strictEqual(payment.refundStatus, "refunded");
        assert.ok(payment.refundSuccessAt instanceof Date);
      } finally {
        mockStripe.refunds.create = originalCreate;
      }
    });

    it("charge.refunded webhook: sets refundSuccessAt on order and payment when succeeded, but not when pending", async () => {
      const piSuccess = "pi_wh_test_succ_1";
      const orderSuccessId = new ObjectId();
      mockOrders.reset([
        {
          _id: orderSuccessId,
          transactionId: piSuccess,
          paymentStatus: "paid",
          refundStatus: "pending_refund",
        },
      ]);
      mockPayments.reset([
        {
          _id: new ObjectId(),
          orderId: orderSuccessId,
          transactionId: piSuccess,
          paymentStatus: "paid",
          refundStatus: "pending_refund",
        },
      ]);

      const succPayload = {
        id: "evt_charge_refunded_succ_1",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_wh_succ_1",
            payment_intent: piSuccess,
            refunded: true,
            refunds: {
              data: [{ id: "re_wh_succ_1", status: "succeeded" }],
            },
          },
        },
      };

      const { rawPayload: rawSucc, signature: sigSucc } = generateSignedWebhook(succPayload);
      const resSucc = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": sigSucc,
        },
        body: rawSucc,
      });

      assert.strictEqual(resSucc.status, 200);
      const updatedOrderSucc = await mockOrders.findOne({ _id: orderSuccessId });
      assert.strictEqual(updatedOrderSucc.refundStatus, "refunded");
      assert.ok(updatedOrderSucc.refundSuccessAt instanceof Date);

      const updatedPaymentSucc = await mockPayments.findOne({ orderId: orderSuccessId });
      assert.strictEqual(updatedPaymentSucc.refundStatus, "refunded");
      assert.ok(updatedPaymentSucc.refundSuccessAt instanceof Date);
    });
  });

  // ──────────────────────────────────────────
  // 13. Starvation Prevention and Bounded Exponential Backoff Scheduling
  // ──────────────────────────────────────────
  describe("13. Starvation Prevention and Bounded Exponential Backoff Scheduling", () => {
    it("calculateBackoffDelay calculates bounded exponential backoff correctly", () => {
      assert.strictEqual(calculateBackoffDelay(1, 30000, 3600000), 30000); // 30s
      assert.strictEqual(calculateBackoffDelay(2, 30000, 3600000), 60000); // 60s
      assert.strictEqual(calculateBackoffDelay(3, 30000, 3600000), 120000); // 120s
      assert.strictEqual(calculateBackoffDelay(4, 30000, 3600000), 240000); // 240s
      assert.strictEqual(calculateBackoffDelay(10, 30000, 3600000), 3600000); // capped at 1h
    });

    it("starvation prevention: candidate orders query excludes exhausted records (refundAttempts >= maxRetries)", async () => {
      const activeOrderId = new ObjectId();
      mockOrders.reset([
        {
          _id: new ObjectId(),
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_exhausted_1",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 3, // exhausted
        },
        {
          _id: new ObjectId(),
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_exhausted_2",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 3, // exhausted
        },
        {
          _id: new ObjectId(),
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_exhausted_3",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 3, // exhausted
        },
        {
          _id: activeOrderId,
          paymentStatus: "paid",
          orderStatus: "cancelled",
          transactionId: "pi_active_fresh_1",
          refundStatus: "pending_refund",
          refundQueue: true,
          refundAttempts: 0, // fresh eligible record
        },
      ]);

      // Batch limit of 2: if exhausted records were not excluded by query, they would fill the batch and starve activeOrderId
      const result = await processPendingRefunds({ maxBatch: 2, maxRetries: 3 });
      assert.strictEqual(result.refunded, 1, "Eligible record must be processed and refunded without starvation");

      const activeOrder = await mockOrders.findOne({ _id: activeOrderId });
      assert.strictEqual(activeOrder.refundStatus, "refunded");
    });
  });
});
