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
} = require("../index");

// Test Configuration
const TEST_WEBHOOK_SECRET = "whsec_test_secret_for_automated_testing_12345678901234567890";
const TEST_STRIPE_KEY = "sk_test_fake_key_for_testing";
const stripeTestClient = new Stripe(TEST_STRIPE_KEY);
const TEST_JWT_SECRET = new TextEncoder().encode(
  "test-secret-key-32-bytes-minimum-length-for-hmac!"
);
process.env.JWT_ISSUER = "http://localhost:3000";
process.env.JWT_AUDIENCE = "http://localhost:3000";

async function createTestToken(payload) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("http://localhost:3000")
    .setAudience("http://localhost:3000")
    .setExpirationTime("2h")
    .sign(TEST_JWT_SECRET);
}

function createMockCollection(initialData = []) {
  let docs = [...initialData];

  return {
    _docs: docs,
    reset(data = []) {
      docs = [...data];
      this._docs = docs;
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
      const match = () =>
        docs.filter((d) => {
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

      const chain = {
        toArray: async () => match(),
        sort: () => chain,
        limit: (n) => ({ toArray: async () => match().slice(0, n) }),
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

describe("Stripe Webhook Integration Test Suite", () => {
  let server;
  let baseUrl;
  let mockProducts;
  let mockOrders;
  let mockPayments;
  const originalEnvSecret = process.env.STRIPE_WEBHOOK_SECRET;

  before(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    setStripeInstance(stripeTestClient);
    setVerificationKey(TEST_JWT_SECRET);

    mockProducts = createMockCollection();
    mockOrders = createMockCollection();
    mockPayments = createMockCollection();
    mockUsers = createMockCollection([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123451"),
        email: "buyer@example.com",
        role: "buyer",
        status: "active",
      },
    ]);

    setCollections({
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      paymentsCollection: mockPayments,
      usersCollection: mockUsers,
    });

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = originalEnvSecret;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    mockProducts.reset();
    mockOrders.reset();
    mockPayments.reset();
    process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  });

  // Helper to generate signed webhook payload
  function generateSignedWebhook(payloadObj, secret = TEST_WEBHOOK_SECRET) {
    const rawPayload = JSON.stringify(payloadObj);
    const signature = stripeTestClient.webhooks.generateTestHeaderString({
      payload: rawPayload,
      secret,
    });
    return { rawPayload, signature };
  }

  describe("1. Signature Verification and Header Validation", () => {
    it("rejects webhook request without stripe-signature header (400)", async () => {
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_test", type: "checkout.session.completed" }),
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, "Missing stripe-signature header");
    });

    it("rejects webhook request with invalid signature (400)", async () => {
      const { rawPayload } = generateSignedWebhook({
        id: "evt_test",
        type: "checkout.session.completed",
      });

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "t=1234567890,v1=invalid_signature_hash",
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Webhook signature verification failed/);
    });

    it("rejects webhook request signed with wrong secret (400)", async () => {
      const { rawPayload, signature } = generateSignedWebhook(
        { id: "evt_test", type: "checkout.session.completed" },
        "whsec_different_secret_key_12345678901234567890123456"
      );

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Webhook signature verification failed/);
    });

    it("rejects webhook request with empty body (400)", async () => {
      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "t=1234567890,v1=fakesig",
        },
        body: "",
      });

      assert.strictEqual(res.status, 400);
    });

    it("returns 500 when STRIPE_WEBHOOK_SECRET is not configured", async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;

      const { rawPayload, signature } = generateSignedWebhook({
        id: "evt_test",
        type: "checkout.session.completed",
      });

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.strictEqual(data.error, "Webhook secret is not configured");
    });
  });

  describe("2. checkout.session.completed Event Handling", () => {
    it("successfully processes valid checkout.session.completed, creates order and payment", async () => {
      const productId = "60c72b2f9b1d8b2bad123450";
      await mockProducts.insertOne({
        _id: new ObjectId(productId),
        title: "Vintage Leather Jacket",
        price: 150,
        sellerInfo: "seller@example.com",
        sellerName: "Vintage Store",
      });

      const eventPayload = {
        id: "evt_test_valid_checkout",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_session_123456",
            payment_intent: "pi_test_intent_789012",
            payment_status: "paid",
            amount_total: 15000, // $150.00 in cents
            currency: "usd",
            customer_details: {
              email: "buyer@example.com",
              name: "John Buyer",
            },
            metadata: {
              productId: productId,
              title: "Vintage Leather Jacket",
              price: 150,
              buyerName: "John Buyer",
              userEmail: "buyer@example.com",
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
      const data = await res.json();
      assert.strictEqual(data.received, true);

      // Verify order creation
      assert.strictEqual(mockOrders._docs.length, 1);
      const order = mockOrders._docs[0];
      assert.strictEqual(order.paymentId, "cs_test_session_123456");
      assert.strictEqual(order.transactionId, "pi_test_intent_789012");
      assert.strictEqual(order.productId, productId);
      assert.strictEqual(order.productTitle, "Vintage Leather Jacket");
      assert.strictEqual(order.price, 150);
      assert.strictEqual(order.sellerInfo, "seller@example.com");
      assert.strictEqual(order.sellerName, "Vintage Store");
      assert.strictEqual(order.buyerInfo, "buyer@example.com");
      assert.strictEqual(order.paymentStatus, "paid");
      assert.strictEqual(order.orderStatus, "pending");

      // Verify payment record creation
      assert.strictEqual(mockPayments._docs.length, 1);
      const payment = mockPayments._docs[0];
      assert.strictEqual(payment.session_id, "cs_test_session_123456");
      assert.strictEqual(payment.transactionId, "pi_test_intent_789012");
      assert.strictEqual(payment.amount, 150);
      assert.strictEqual(payment.currency, "usd");
      assert.strictEqual(payment.paymentStatus, "paid");
      assert.strictEqual(payment.metadata.userEmail, "buyer@example.com");
      assert.ok(payment.orderId);
      assert.ok(payment.date);
      assert.ok(payment.createdAt);
    });

    it("skips order creation if session payment_status is not 'paid'", async () => {
      const eventPayload = {
        id: "evt_test_unpaid",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_unpaid_123",
            payment_status: "unpaid",
            amount_total: 5000,
            currency: "usd",
            metadata: { productId: "some_prod" },
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
      const data = await res.json();
      assert.strictEqual(data.status, "unpaid");
      assert.strictEqual(mockOrders._docs.length, 0);
      assert.strictEqual(mockPayments._docs.length, 0);
    });

    it("handles unhandled event types gracefully with 200", async () => {
      const eventPayload = {
        id: "evt_test_other",
        type: "customer.created",
        data: { object: { id: "cus_123" } },
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
      assert.strictEqual(data.received, true);
      assert.strictEqual(data.unhandled, true);
    });
  });

  describe("3. Idempotency on Repeated Delivery", () => {
    it("does not create duplicate orders or payments when webhook is received multiple times", async () => {
      const productId = "60c72b2f9b1d8b2bad123450";
      await mockProducts.insertOne({
        _id: new ObjectId(productId),
        title: "Vintage Leather Jacket",
        price: 150,
        sellerInfo: "seller@example.com",
        sellerName: "Vintage Store",
      });

      const eventPayload = {
        id: "evt_test_idempotent",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_idempotent_session",
            payment_intent: "pi_test_idempotent_intent",
            payment_status: "paid",
            amount_total: 15000,
            currency: "usd",
            customer_details: { email: "buyer@example.com", name: "Buyer" },
            metadata: {
              productId: productId,
              title: "Vintage Leather Jacket",
              price: 150,
              userEmail: "buyer@example.com",
            },
          },
        },
      };

      const { rawPayload, signature } = generateSignedWebhook(eventPayload);

      // 1st delivery
      const res1 = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(mockOrders._docs.length, 1);
      assert.strictEqual(mockPayments._docs.length, 1);

      // 2nd delivery (identical webhook retry)
      const res2 = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });
      assert.strictEqual(res2.status, 200);
      const data2 = await res2.json();
      assert.strictEqual(data2.message, "Already processed");

      // Verify no duplicates
      assert.strictEqual(mockOrders._docs.length, 1);
      assert.strictEqual(mockPayments._docs.length, 1);
    });
  });

  describe("4. Security and Price Tampering Protection", () => {
    it("rejects checkout session when amount paid is less than database authoritative price (400)", async () => {
      const productId = "60c72b2f9b1d8b2bad123450";
      // Product price in database is $35,000 (3,500,000 cents)
      await mockProducts.insertOne({
        _id: new ObjectId(productId),
        title: "Dell Inspiron Laptop",
        price: 35000,
        sellerInfo: "seller@example.com",
        sellerName: "Tech Store",
      });

      // Attacker manipulated client to only charge $1 (100 cents)
      const eventPayload = {
        id: "evt_tampered_price",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_tampered_price",
            payment_intent: "pi_test_tampered",
            payment_status: "paid",
            amount_total: 100, // Only $1 paid!
            currency: "usd",
            customer_details: { email: "attacker@example.com" },
            metadata: {
              productId: productId,
              title: "Dell Inspiron Laptop",
              price: 1, // Tampered price in metadata
              userEmail: "attacker@example.com",
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

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Paid amount does not match authoritative price/);

      // Verify that no paid order or payment record was created
      assert.strictEqual(mockOrders._docs.length, 0);
      assert.strictEqual(mockPayments._docs.length, 0);
    });
  });

  describe("5. Database Readiness Guard", () => {
    it("returns 503 when database collections are not initialized", async () => {
      setCollections({
        paymentsCollection: null,
        ordersCollection: null,
      });

      const eventPayload = {
        id: "evt_test_db_down",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_db_down",
            payment_status: "paid",
            amount_total: 5000,
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

      assert.strictEqual(res.status, 503);
      const data = await res.json();
      assert.strictEqual(data.error, "Service unavailable: Database not connected");

      // Restore collections
      setCollections({
        productsCollection: mockProducts,
        ordersCollection: mockOrders,
        paymentsCollection: mockPayments,
      });
    });
  });

  describe("6. Express Pipeline & Raw Body Integrity", () => {
    it("preserves raw Buffer body before JSON parsing without mutation", async () => {
      const productId = "60c72b2f9b1d8b2bad123450";
      await mockProducts.insertOne({
        _id: new ObjectId(productId),
        title: "Test Item",
        price: 25,
      });

      const eventPayload = {
        id: "evt_test_raw_buf",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_raw_buf_session",
            payment_status: "paid",
            amount_total: 2500,
            currency: "usd",
            metadata: { productId, price: 25 },
          },
        },
      };

      // Space and property formatting that express.json() would alter if parsed first
      const rawPayload = JSON.stringify(eventPayload, null, 2);
      const signature = stripeTestClient.webhooks.generateTestHeaderString({
        payload: rawPayload,
        secret: TEST_WEBHOOK_SECRET,
      });

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "stripe-signature": signature,
        },
        body: rawPayload,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(mockOrders._docs.length, 1);
    });
  });

  describe("7. Client Endpoint Idempotency and Payment Status Guards", () => {
    it("POST /api/orders does not duplicate an order already fulfilled by webhook", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      // Existing order created by webhook
      await mockOrders.insertOne({
        paymentId: "cs_existing_webhook_123",
        productId: "prod_1",
        price: 50,
        paymentStatus: "paid",
        orderStatus: "pending",
        buyerInfo: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          paymentId: "cs_existing_webhook_123",
          productId: "prod_1",
          price: 50,
          paymentStatus: "paid",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.message, "Order already placed");
      assert.strictEqual(mockOrders._docs.length, 1);
    });

    it("POST /api/orders does not mark order as paid without verified payment record", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          paymentId: "cs_unverified_visit",
          productId: "prod_1",
          price: 50,
          paymentStatus: "paid", // Attacker sends paid without paying
        }),
      });

      assert.strictEqual(res.status, 201);
      const createdOrder = mockOrders._docs.find(
        (o) => o.paymentId === "cs_unverified_visit"
      );
      assert.ok(createdOrder);
      assert.strictEqual(createdOrder.paymentStatus, "pending");
    });

    it("POST /api/payments does not duplicate a payment already recorded by webhook", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      // Existing payment recorded by webhook
      await mockPayments.insertOne({
        session_id: "cs_existing_payment_456",
        amount: 75,
        paymentStatus: "paid",
        metadata: { userEmail: "buyer@example.com" },
      });

      const res = await fetch(`${baseUrl}/api/payments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: "cs_existing_payment_456",
          amount: 75,
          metadata: { userEmail: "buyer@example.com" },
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.message, "Payment already recorded");
      assert.strictEqual(mockPayments._docs.length, 1);
    });
  });
});

