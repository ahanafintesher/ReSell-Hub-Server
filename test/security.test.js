const { test, it, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { SignJWT } = require("jose-cjs");
const { ObjectId } = require("mongodb");

const {
  app,
  setCollections,
  setVerificationKey,
} = require("../index");

// Test Configuration
const TEST_SECRET = new TextEncoder().encode(
  "test-secret-key-32-bytes-minimum-length-for-hmac!"
);
const TEST_ISSUER = "http://localhost:3000";
const TEST_AUDIENCE = "http://localhost:3000";

process.env.JWT_ISSUER = TEST_ISSUER;
process.env.JWT_AUDIENCE = TEST_AUDIENCE;

// Helper to create valid signed JWT tokens for tests
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

// In-Memory Mock Collection implementation
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

describe("Security Hardening Regression Test Suite (Phase 2A)", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockProducts;
  let mockOrders;
  let mockWishlist;
  let mockReviews;
  let mockPayments;

  before(async () => {
    // Set custom verification key for jose-cjs
    setVerificationKey(TEST_SECRET);

    // Initialize mock collections
    mockUsers = createMockCollection();
    mockProducts = createMockCollection();
    mockOrders = createMockCollection();
    mockWishlist = createMockCollection();
    mockReviews = createMockCollection();
    mockPayments = createMockCollection();

    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      wishlistCollection: mockWishlist,
      reviewsCollection: mockReviews,
      paymentsCollection: mockPayments,
    });

    // Start ephemeral server
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
    // Reset seed data
    mockUsers.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123451"),
        email: "buyer@example.com",
        name: "Active Buyer",
        role: "buyer",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123452"),
        email: "seller@example.com",
        name: "Active Seller",
        role: "seller",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123453"),
        email: "admin@example.com",
        name: "Active Admin",
        role: "admin",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123454"),
        email: "blocked@example.com",
        name: "Blocked User",
        role: "buyer",
        status: "blocked",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123455"),
        email: "demoted-admin@example.com",
        name: "Demoted Admin",
        role: "buyer", // Demoted in MongoDB to buyer!
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123456"),
        email: "demoted-seller@example.com",
        name: "Demoted Seller",
        role: "buyer", // Demoted in MongoDB to buyer!
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123457"),
        email: "seller2@example.com",
        name: "Seller Two",
        role: "seller",
        status: "active",
      },
    ]);

    mockProducts.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200001"),
        title: "Seller 1 Product",
        sellerInfo: "seller@example.com",
        price: 100,
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200002"),
        title: "Seller 2 Product",
        sellerInfo: "seller2@example.com",
        price: 200,
      },
    ]);

    mockOrders.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad300001"),
        buyerInfo: "buyer@example.com",
        sellerInfo: "seller@example.com",
        orderStatus: "pending",
        price: 100,
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad300002"),
        buyerInfo: "otherbuyer@example.com",
        sellerInfo: "seller2@example.com",
        orderStatus: "pending",
        price: 200,
      },
    ]);

    mockWishlist.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad400001"),
        userInfo: "buyer@example.com",
        product: { _id: "prod1", title: "Wishlist Item 1" },
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad400002"),
        userInfo: "other@example.com",
        product: { _id: "prod2", title: "Wishlist Item 2" },
      },
    ]);
  });

  // ──────────────────────────────────────────
  // 1. Missing Authentication Tests
  // ──────────────────────────────────────────
  describe("1. Missing Authentication", () => {
    it("rejects request without Authorization header on seller route (401)", async () => {
      const res = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Product" }),
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.message, /Missing Authorization header/i);
    });

    it("rejects request without Authorization header on admin route (401)", async () => {
      const res = await fetch(`${baseUrl}/api/admin/users`);
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.message, /Missing Authorization header/i);
    });

    it("rejects request without Authorization header on reviews creation (401)", async () => {
      const res = await fetch(`${baseUrl}/api/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "Great" }),
      });
      assert.strictEqual(res.status, 401);
    });
  });

  // ──────────────────────────────────────────
  // 2. Invalid Token Tests
  // ──────────────────────────────────────────
  describe("2. Invalid Tokens", () => {
    it("rejects malformed Authorization header without Bearer prefix (401)", async () => {
      const res = await fetch(`${baseUrl}/api/my-products`, {
        headers: { Authorization: "Basic 12345" },
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.message, /Invalid Authorization header format/i);
    });

    it("rejects token signed with wrong secret (403)", async () => {
      const badSecret = new TextEncoder().encode("wrong-secret-key-that-does-not-match-at-all!");
      const badToken = await createTestToken(
        { sub: "123", email: "seller@example.com", role: "seller" },
        { secret: badSecret }
      );

      const res = await fetch(`${baseUrl}/api/my-products`, {
        headers: { Authorization: `Bearer ${badToken}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /Invalid, expired, or untrusted token/i);
    });

    it("rejects expired token (403)", async () => {
      const expiredToken = await createTestToken(
        { sub: "123", email: "seller@example.com", role: "seller" },
        { expiresIn: "0s" }
      );

      // wait 10ms to ensure expiration
      await new Promise((r) => setTimeout(r, 15));

      const res = await fetch(`${baseUrl}/api/my-products`, {
        headers: { Authorization: `Bearer ${expiredToken}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it("rejects token with missing email identity (401)", async () => {
      const noEmailToken = await createTestToken({ sub: "123" });
      const res = await fetch(`${baseUrl}/api/buyer/orders`, {
        headers: { Authorization: `Bearer ${noEmailToken}` },
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.message, /Invalid or missing identity in token/i);
    });

    it("rejects token with missing sub identity (401)", async () => {
      const noSubToken = await createTestToken({ email: "seller@example.com" });
      const res = await fetch(`${baseUrl}/api/my-products`, {
        headers: { Authorization: `Bearer ${noSubToken}` },
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.message, /Invalid or missing identity in token/i);
    });
  });

  // ──────────────────────────────────────────
  // 3. Deleted Users Tests
  // ──────────────────────────────────────────
  describe("3. Deleted Users", () => {
    it("rejects token when user does not exist in MongoDB user collection (401)", async () => {
      const token = await createTestToken({
        sub: "nonexistent-id",
        email: "ghost@example.com",
        role: "buyer",
      });

      const res = await fetch(`${baseUrl}/api/buyer/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.message, /User record not found/i);
    });

    it("rejects deleted user on review creation (401)", async () => {
      const token = await createTestToken({
        sub: "deleted-user-id",
        email: "deleted@example.com",
      });

      const res = await fetch(`${baseUrl}/api/reviews`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ comment: "Should fail" }),
      });
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.match(data.message, /User record not found/i);
    });
  });

  // ──────────────────────────────────────────
  // 4. Blocked Accounts Tests
  // ──────────────────────────────────────────
  describe("4. Blocked Accounts", () => {
    it("rejects blocked user on privileged route with requireRole (403)", async () => {
      const token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123454",
        email: "blocked@example.com",
        role: "buyer",
      });

      const res = await fetch(`${baseUrl}/api/buyer/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /Account is blocked/i);
    });

    it("rejects blocked user on route using verifyToken alone (POST /api/reviews) (403)", async () => {
      const token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123454",
        email: "blocked@example.com",
      });

      const res = await fetch(`${baseUrl}/api/reviews`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ comment: "Spam from blocked user" }),
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /Account is blocked/i);
    });
  });

  // ──────────────────────────────────────────
  // 5. Admin Demotion Tests (Role Escalation Guard)
  // ──────────────────────────────────────────
  describe("5. Admin Demotion (Role Escalation Guard)", () => {
    it("rejects user holding admin JWT token when database role was changed to buyer (403)", async () => {
      // User holds token that claims role='admin'
      const demotedAdminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123455",
        email: "demoted-admin@example.com",
        role: "admin", // <--- Outdated JWT role!
      });

      const res = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${demotedAdminToken}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /Requires one of \[admin\] permissions/i);
    });
  });

  // ──────────────────────────────────────────
  // 6. Seller Demotion Tests
  // ──────────────────────────────────────────
  describe("6. Seller Demotion", () => {
    it("rejects user holding seller JWT token when database role was changed to buyer (403)", async () => {
      // User holds token that claims role='seller'
      const demotedSellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123456",
        email: "demoted-seller@example.com",
        role: "seller", // <--- Outdated JWT role!
      });

      const res = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${demotedSellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Unauthorized listing" }),
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /Requires one of \[seller, admin\] permissions/i);
    });
  });

  // ──────────────────────────────────────────
  // 7. Buyer / Seller / Admin Authorization Matrix
  // ──────────────────────────────────────────
  describe("7. Buyer / Seller / Admin Authorization Matrix", () => {
    it("allows active buyer to access buyer orders and wishlist", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const ordersRes = await fetch(`${baseUrl}/api/buyer/orders`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(ordersRes.status, 200);

      const wishlistRes = await fetch(`${baseUrl}/api/wishlist`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(wishlistRes.status, 200);
    });

    it("prevents buyer from accessing seller products API (403)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Buyer Product" }),
      });
      assert.strictEqual(res.status, 403);
    });

    it("prevents buyer from accessing admin users API (403)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it("allows active seller to create products and view seller orders", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });

      const createRes = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sellerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Valid Product", price: 50 }),
      });
      assert.strictEqual(createRes.status, 201);

      const ordersRes = await fetch(`${baseUrl}/api/seller/orders`, {
        headers: { Authorization: `Bearer ${sellerToken}` },
      });
      assert.strictEqual(ordersRes.status, 200);
    });

    it("prevents seller from accessing admin users API (403)", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });

      const res = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${sellerToken}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it("allows active admin full access across admin and products endpoints", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });

      const adminUsersRes = await fetch(`${baseUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(adminUsersRes.status, 200);

      const productsRes = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Admin Product", sellerInfo: "admin@example.com" }),
      });
      assert.strictEqual(productsRes.status, 201);
    });
  });

  // ──────────────────────────────────────────
  // 8. Ownership Checks
  // ──────────────────────────────────────────
  describe("8. Ownership Checks", () => {
    it("prevents Seller 1 from editing Seller 2's product (403)", async () => {
      const seller1Token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });

      const res = await fetch(`${baseUrl}/api/products/60c72b2f9b1d8b2bad200002`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${seller1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Hacked Title" }),
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /You do not own this product/i);
    });

    it("prevents Seller 1 from deleting Seller 2's product (403)", async () => {
      const seller1Token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });

      const res = await fetch(`${baseUrl}/api/products/60c72b2f9b1d8b2bad200002`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${seller1Token}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /You do not own this product/i);
    });

    it("allows Seller 1 to edit their own product (200)", async () => {
      const seller1Token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });

      const res = await fetch(`${baseUrl}/api/products/60c72b2f9b1d8b2bad200001`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${seller1Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Updated Title" }),
      });
      assert.strictEqual(res.status, 200);
    });

    it("prevents Buyer 1 from cancelling Buyer 2's order (403)", async () => {
      const buyer1Token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/orders/60c72b2f9b1d8b2bad300002`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${buyer1Token}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /You can only cancel your own orders/i);
    });

    it("allows Buyer 1 to cancel their own pending order (200)", async () => {
      const buyer1Token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/orders/60c72b2f9b1d8b2bad300001`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${buyer1Token}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
    });

    it("prevents User 1 from deleting User 2's wishlist item (403)", async () => {
      const user1Token = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/wishlist/60c72b2f9b1d8b2bad400002`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${user1Token}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.match(data.message, /You do not own this wishlist item/i);
    });
  });

  // ──────────────────────────────────────────
  // 9. Identity Validation on Creation
  // ──────────────────────────────────────────
  describe("9. Identity Validation on Creation", () => {
    it("rejects product creation when body is not an object or empty (400)", async () => {
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
        body: JSON.stringify(["invalid", "array", "body"]),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects order creation when body is not an object or empty (400)", async () => {
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
        body: JSON.stringify(["invalid-array"]),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects review creation when body is not an object or empty (400)", async () => {
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
        body: JSON.stringify(["invalid-array"]),
      });
      assert.strictEqual(res.status, 400);
    });

    it("rejects payment record creation when body is not an object or empty (400)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/payments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(["invalid-array"]),
      });
      assert.strictEqual(res.status, 400);
    });

    it("validates and binds authenticated email to created wishlist entry", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/wishlist`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          product: { _id: "new-prod-id", title: "New Item" },
          userInfo: "spoofed@attacker.com", // Attempt to spoof userInfo
        }),
      });
      assert.strictEqual(res.status, 201);

      // Verify the item in database is bound to the authenticated user's email
      const saved = await mockWishlist.findOne({ "product._id": "new-prod-id" });
      assert.strictEqual(saved.userInfo, "buyer@example.com");
    });
  });
});
