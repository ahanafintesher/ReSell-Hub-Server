const { test, it, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { SignJWT } = require("jose-cjs");
const { ObjectId } = require("mongodb");
const Stripe = require("stripe");

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
const TEST_WEBHOOK_SECRET = "whsec_test_secret_for_automated_testing_12345678901234567890";
const stripeTestClient = new Stripe("sk_test_fake_key_for_testing");

process.env.JWT_ISSUER = TEST_ISSUER;
process.env.JWT_AUDIENCE = TEST_AUDIENCE;
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

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

function createMockCollection(initialData = []) {
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
        const filterId = expected?.toString ? expected.toString() : expected;
        const docId = d._id?.toString ? d._id.toString() : d._id;
        if (docId !== filterId) return false;
        continue;
      }

      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        if (expected.$in && Array.isArray(expected.$in)) {
          if (!expected.$in.includes(val)) return false;
          continue;
        }
        if (expected.$ne !== undefined) {
          if (val === expected.$ne) return false;
          continue;
        }
        if (expected instanceof RegExp) {
          if (!expected.test(String(val || ""))) return false;
          continue;
        }
      }

      if (val !== expected) return false;
    }
    return true;
  }

  return {
    _docs: docs,
    async findOne(filter = {}) {
      return docs.find((d) => matchesFilter(d, filter)) || null;
    },
    find(filter = {}) {
      let filtered = docs.filter((d) => matchesFilter(d, filter));
      let sortKey = null;
      let sortDir = 1;
      let skipCount = 0;
      let limitCount = Infinity;

      const cursor = {
        sort(sortObj) {
          const keys = Object.keys(sortObj || {});
          if (keys.length > 0) {
            sortKey = keys[0];
            sortDir = sortObj[sortKey];
          }
          return cursor;
        },
        skip(n) {
          skipCount = n;
          return cursor;
        },
        limit(n) {
          limitCount = n;
          return cursor;
        },
        project() {
          return cursor;
        },
        async toArray() {
          let res = [...filtered];
          if (sortKey) {
            res.sort((a, b) => {
              const va = a[sortKey];
              const vb = b[sortKey];
              if (va < vb) return -1 * sortDir;
              if (va > vb) return 1 * sortDir;
              return 0;
            });
          }
          return res.slice(skipCount, skipCount + limitCount);
        },
      };
      return cursor;
    },
    async countDocuments(filter = {}) {
      return docs.filter((d) => matchesFilter(d, filter)).length;
    },
    async insertOne(doc) {
      const inserted = {
        ...doc,
        _id: doc._id || new ObjectId(),
      };
      docs.push(inserted);
      return { insertedId: inserted._id, acknowledged: true };
    },
    async updateOne(filter, update) {
      const idx = docs.findIndex((d) => matchesFilter(d, filter));
      if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        docs[idx] = { ...docs[idx], ...update.$set };
      }
      if (update.$unset) {
        for (const k of Object.keys(update.$unset)) {
          delete docs[idx][k];
        }
      }
      if (update.$inc) {
        for (const k of Object.keys(update.$inc)) {
          docs[idx][k] = (docs[idx][k] || 0) + update.$inc[k];
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

describe("Dispute Workflow API Suite (Phase 5)", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockOrders;
  let mockDisputes;
  let buyerToken;
  let sellerToken;
  let adminToken;
  let buyer2Token;

  const buyerEmail = "dispute_buyer@example.com";
  const buyer2Email = "other_buyer@example.com";
  const sellerEmail = "dispute_seller@example.com";
  const adminEmail = "admin@example.com";

  const orderId = new ObjectId().toString();

  before(async () => {
    setVerificationKey(TEST_SECRET);

    buyerToken = await createTestToken({ sub: "buyer_1", email: buyerEmail, role: "buyer" });
    buyer2Token = await createTestToken({ sub: "buyer_2", email: buyer2Email, role: "buyer" });
    sellerToken = await createTestToken({ sub: "seller_1", email: sellerEmail, role: "seller" });
    adminToken = await createTestToken({ sub: "admin_1", email: adminEmail, role: "admin" });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    mockUsers = createMockCollection([
      { _id: new ObjectId(), email: buyerEmail, role: "buyer", status: "active" },
      { _id: new ObjectId(), email: buyer2Email, role: "buyer", status: "active" },
      { _id: new ObjectId(), email: sellerEmail, role: "seller", status: "active" },
      { _id: new ObjectId(), email: adminEmail, role: "admin", status: "active" },
    ]);

    mockOrders = createMockCollection([
      {
        _id: new ObjectId(orderId),
        buyerInfo: buyerEmail,
        buyerName: "Dispute Buyer",
        sellerInfo: sellerEmail,
        sellerName: "Dispute Seller",
        productTitle: "Test Vintage Watch",
        price: 3200,
        paymentStatus: "paid",
        orderStatus: "delivered",
        createdAt: new Date(),
      },
    ]);

    mockDisputes = createMockCollection([]);
    mockPayments = createMockCollection([]);
    const mockProcessedEvents = createMockCollection([]);

    setCollections({
      usersCollection: mockUsers,
      ordersCollection: mockOrders,
      disputesCollection: mockDisputes,
      paymentsCollection: mockPayments,
      processedEventsCollection: mockProcessedEvents,
    });
  });

  // ──────────────────────────────────────────
  // 1. POST /api/orders/:id/dispute (Buyer)
  // ──────────────────────────────────────────
  describe("1. Buyer: Create Dispute (POST /api/orders/:id/dispute)", () => {
    it("creates dispute for buyer's own order with valid reason and details", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: "Item not as described",
          details: "The watch has severe scratches not shown in listing photos.",
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.ok(data.disputeId);
      assert.strictEqual(data.dispute.status, "opened");
      assert.strictEqual(data.dispute.buyerEmail, buyerEmail);

      // Verify order updated
      const updatedOrder = await mockOrders.findOne({ _id: new ObjectId(orderId) });
      assert.strictEqual(updatedOrder.isDisputed, true);
      assert.strictEqual(updatedOrder.disputeStatus, "opened");
    });

    it("rejects dispute submission without authentication (401)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Item not as described" }),
      });
      assert.strictEqual(res.status, 401);
    });

    it("rejects dispute submission if user does not own order (403)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyer2Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Unauthorized attempt" }),
      });
      assert.strictEqual(res.status, 403);
    });

    it("rejects invalid order ID format (400)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/not-a-valid-id/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Item not as described" }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects dispute with missing or too short reason (400)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: " " }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects dispute on cancelled order (400)", async () => {
      await mockOrders.updateOne({ _id: new ObjectId(orderId) }, { $set: { orderStatus: "cancelled" } });
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Item not as described" }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects dispute on rejected order (400)", async () => {
      await mockOrders.updateOne({ _id: new ObjectId(orderId) }, { $set: { orderStatus: "rejected" } });
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Item not as described" }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, "Cannot dispute a rejected order");
    });

    it("rejects invalid dispute payload (non-string or empty reason) (400)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: 999 }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("prevents duplicate active disputes on same order (409)", async () => {
      // First dispute
      await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Item not as described" }),
      });

      // Second dispute attempt
      const res2 = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reason: "Item damaged in transit" }),
      });
      assert.strictEqual(res2.status, 409);
    });
  });

  // ──────────────────────────────────────────
  // 2. GET /api/admin/disputes (Admin)
  // ──────────────────────────────────────────
  describe("2. Admin: View Disputes (GET /api/admin/disputes)", () => {
    beforeEach(async () => {
      await mockDisputes.insertOne({
        orderId,
        buyerEmail,
        sellerEmail,
        productTitle: "Test Vintage Watch",
        reason: "Item not as described",
        status: "opened",
        createdAt: new Date(),
      });
    });

    it("returns paginated disputes list for admin (200)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.total, 1);
      assert.strictEqual(data.disputes.length, 1);
      assert.strictEqual(data.disputes[0].reason, "Item not as described");
    });

    it("rejects non-admin access (403)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it("supports status filtering", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes?status=resolved`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.total, 0);
    });

    it("supports status filtering across resolved_buyer, resolved_seller, and opened", async () => {
      await mockDisputes.insertOne({
        orderId: new ObjectId().toString(),
        buyerEmail,
        sellerEmail,
        productTitle: "Second Item",
        reason: "Item defective",
        status: "resolved_buyer",
        createdAt: new Date(),
      });
      await mockDisputes.insertOne({
        orderId: new ObjectId().toString(),
        buyerEmail,
        sellerEmail,
        productTitle: "Third Item",
        reason: "Shipping delay",
        status: "resolved_seller",
        createdAt: new Date(),
      });

      const resBuyer = await fetch(`${baseUrl}/api/admin/disputes?status=resolved_buyer`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const dataBuyer = await resBuyer.json();
      assert.strictEqual(dataBuyer.total, 1);
      assert.strictEqual(dataBuyer.disputes[0].status, "resolved_buyer");

      const resSeller = await fetch(`${baseUrl}/api/admin/disputes?status=resolved_seller`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const dataSeller = await resSeller.json();
      assert.strictEqual(dataSeller.total, 1);
      assert.strictEqual(dataSeller.disputes[0].status, "resolved_seller");

      const resAllResolved = await fetch(`${baseUrl}/api/admin/disputes?status=resolved`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const dataAllResolved = await resAllResolved.json();
      assert.strictEqual(dataAllResolved.total, 2);
    });

    it("supports search filtering across productTitle and buyerEmail", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes?search=Vintage`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.total, 1);
      assert.strictEqual(data.disputes[0].productTitle, "Test Vintage Watch");
    });
  });

  // ──────────────────────────────────────────
  // 3. PATCH /api/admin/disputes/:id/resolve (Admin)
  // ──────────────────────────────────────────
  describe("3. Admin: Resolve Dispute (PATCH /api/admin/disputes/:id/resolve)", () => {
    let disputeId;

    beforeEach(async () => {
      const insert = await mockDisputes.insertOne({
        orderId,
        buyerEmail,
        sellerEmail,
        productTitle: "Test Vintage Watch",
        reason: "Item not as described",
        status: "opened",
        createdAt: new Date(),
      });
      disputeId = insert.insertedId.toString();
    });

    it("resolves dispute successfully and updates order (200)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resolution: "resolved_buyer",
          resolutionNotes: "Seller agrees description was ambiguous. Buyer refunded.",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.status, "resolved_buyer");
      assert.strictEqual(data.resolution, "resolved_buyer");

      // Verify dispute doc in DB
      const updatedDispute = await mockDisputes.findOne({ _id: new ObjectId(disputeId) });
      assert.strictEqual(updatedDispute.status, "resolved_buyer");
      assert.strictEqual(updatedDispute.resolvedBy, adminEmail);

      // Verify order doc synchronized
      const updatedOrder = await mockOrders.findOne({ _id: new ObjectId(orderId) });
      assert.strictEqual(updatedOrder.disputeStatus, "resolved_buyer");
    });

    it("resolves dispute as resolved_seller and updates order (200)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resolution: "resolved_seller",
          resolutionNotes: "Item verified as described by seller.",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.status, "resolved_seller");
      assert.strictEqual(data.resolution, "resolved_seller");

      const updatedDispute = await mockDisputes.findOne({ _id: new ObjectId(disputeId) });
      assert.strictEqual(updatedDispute.status, "resolved_seller");
      const updatedOrder = await mockOrders.findOne({ _id: new ObjectId(orderId) });
      assert.strictEqual(updatedOrder.disputeStatus, "resolved_seller");
    });

    it("resolves dispute as dismissed and updates order (200)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resolution: "dismissed",
          resolutionNotes: "Dispute dismissed due to lack of evidence.",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, "dismissed");

      const updatedDispute = await mockDisputes.findOne({ _id: new ObjectId(disputeId) });
      assert.strictEqual(updatedDispute.status, "dismissed");
    });

    it("accepts resolution payload using decision and decisionNotes format (200)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          decision: "resolved_buyer",
          decisionNotes: "Adjudicated using decision key.",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, "resolved_buyer");
      assert.strictEqual(data.resolution, "resolved_buyer");
    });

    it("rejects non-admin resolution attempt (403)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${sellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resolution: "dismissed" }),
      });
      assert.strictEqual(res.status, 403);
    });

    it("rejects invalid resolution decision (400)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resolution: "invalid_choice" }),
      });
      assert.strictEqual(res.status, 400);
    });

    it("prevents resolving an already resolved dispute (400)", async () => {
      // First resolve
      await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resolution: "resolved" }),
      });

      // Second resolve attempt
      const res2 = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ resolution: "dismissed" }),
      });
      assert.strictEqual(res2.status, 400);
      const err = await res2.json();
      assert.strictEqual(err.message, "Dispute has already been resolved");
    });

    it("resolved_buyer triggers Stripe refund and marks order refunded when Stripe confirms success", async () => {
      let stripeRefundCalled = false;
      const fakeStripe = {
        refunds: {
          create: async (params, opts) => {
            stripeRefundCalled = true;
            assert.strictEqual(params.payment_intent, "pi_test_confirmed_123");
            return {
              id: "re_test_success_999",
              status: "succeeded",
            };
          },
        },
      };
      setStripeInstance(fakeStripe);

      // Add payment intent to order
      await mockOrders.updateOne(
        { _id: new ObjectId(orderId) },
        { $set: { transactionId: "pi_test_confirmed_123", paymentStatus: "paid" } }
      );

      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resolution: "resolved_buyer",
          resolutionNotes: "Confirmed damaged item. Stripe refund issued.",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.refundStatus, "refunded");
      assert.strictEqual(data.refundId, "re_test_success_999");
      assert.strictEqual(stripeRefundCalled, true);

      // Verify order doc
      const updatedOrder = await mockOrders.findOne({ _id: new ObjectId(orderId) });
      assert.strictEqual(updatedOrder.refundStatus, "refunded");
      assert.strictEqual(updatedOrder.refundId, "re_test_success_999");
      assert.ok(updatedOrder.refundSuccessAt);

      // Verify dispute doc
      const updatedDispute = await mockDisputes.findOne({ _id: new ObjectId(disputeId) });
      assert.strictEqual(updatedDispute.refundStatus, "refunded");
      assert.strictEqual(updatedDispute.refundId, "re_test_success_999");

      // Reset stripe instance
      setStripeInstance(null);
    });

    it("resolved_buyer does not label as refunded when Stripe fails or is pending", async () => {
      const fakeFailingStripe = {
        refunds: {
          create: async () => {
            throw new Error("Stripe network timeout");
          },
        },
      };
      setStripeInstance(fakeFailingStripe);

      await mockOrders.updateOne(
        { _id: new ObjectId(orderId) },
        { $set: { transactionId: "pi_test_timeout_456", paymentStatus: "paid" } }
      );

      const res = await fetch(`${baseUrl}/api/admin/disputes/${disputeId}/resolve`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resolution: "resolved_buyer",
          resolutionNotes: "Approving refund despite temporary Stripe failure.",
        }),
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.refundStatus, "pending_refund");

      // Verify order doc remains pending_refund and enqueued for retry
      const updatedOrder = await mockOrders.findOne({ _id: new ObjectId(orderId) });
      assert.strictEqual(updatedOrder.refundStatus, "pending_refund");
      assert.strictEqual(updatedOrder.refundQueue, true);
      assert.ok(updatedOrder.refundError);

      setStripeInstance(null);
    });
  });

  // ──────────────────────────────────────────
  // 4. GET /api/orders/:id/dispute (Buyer / Seller / Admin)
  // ──────────────────────────────────────────
  describe("4. Order Dispute Lookup (GET /api/orders/:id/dispute)", () => {
    beforeEach(async () => {
      await mockDisputes.insertOne({
        orderId,
        buyerEmail,
        sellerEmail,
        productTitle: "Test Vintage Watch",
        reason: "Item not as described",
        status: "opened",
        createdAt: new Date(),
      });
    });

    it("returns dispute document for order buyer (200)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data);
      assert.strictEqual(data.orderId, orderId);
      assert.strictEqual(data.buyerEmail, buyerEmail);
    });

    it("returns dispute document for order seller (200)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        headers: { Authorization: `Bearer ${sellerToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data);
      assert.strictEqual(data.orderId, orderId);
    });

    it("returns dispute document for admin (200)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data);
      assert.strictEqual(data.orderId, orderId);
    });

    it("rejects unauthorized third-party user (403)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/${orderId}/dispute`, {
        headers: { Authorization: `Bearer ${buyer2Token}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it("rejects invalid order ID format (400)", async () => {
      const res = await fetch(`${baseUrl}/api/orders/invalid-format/dispute`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 400);
    });

    it("returns 404 for non-existent order", async () => {
      const nonExistentId = new ObjectId().toString();
      const res = await fetch(`${baseUrl}/api/orders/${nonExistentId}/dispute`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 404);
    });
  });

  // ──────────────────────────────────────────
  // 5. Stripe Webhook & Durability for Disputes
  // ──────────────────────────────────────────
  describe("5. Stripe Webhook & Durability for Disputes", () => {
    it("charge.refunded webhook updates dispute and order refundStatus to refunded", async () => {
      const piId = "pi_dispute_webhook_test_123";
      await mockOrders.updateOne(
        { _id: new ObjectId(orderId) },
        {
          $set: {
            transactionId: piId,
            paymentStatus: "paid",
            refundStatus: "pending_refund",
            refundQueue: true,
            isDisputed: true,
          },
        }
      );
      const ins = await mockDisputes.insertOne({
        orderId,
        buyerEmail,
        status: "resolved_buyer",
        refundStatus: "pending_refund",
        createdAt: new Date(),
      });

      const payloadString = JSON.stringify({
        id: "evt_test_charge_refunded_1",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_test_charge_123",
            payment_intent: piId,
            refunded: true,
            refunds: {
              data: [
                {
                  id: "re_webhook_success_1",
                  status: "succeeded",
                },
              ],
            },
          },
        },
      });

      const signature = stripeTestClient.webhooks.generateTestHeaderString({
        payload: payloadString,
        secret: TEST_WEBHOOK_SECRET,
      });

      setStripeInstance(stripeTestClient);

      const res = await fetch(`${baseUrl}/api/stripe/webhook`, {
        method: "POST",
        headers: {
          "stripe-signature": signature,
          "content-type": "application/json",
        },
        body: payloadString,
      });

      assert.strictEqual(res.status, 200);
      const resBody = await res.json();
      assert.strictEqual(resBody.refundStatus, "refunded");

      const updatedOrder = await mockOrders.findOne({ _id: new ObjectId(orderId) });
      assert.strictEqual(updatedOrder.refundStatus, "refunded");
      assert.strictEqual(updatedOrder.refundQueue, false);

      const updatedDispute = await mockDisputes.findOne({ _id: ins.insertedId });
      assert.strictEqual(updatedDispute.refundStatus, "refunded");
      assert.strictEqual(updatedDispute.refundId, "re_webhook_success_1");

      setStripeInstance(null);
    });
  });
});
