const { test, it, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { SignJWT } = require("jose-cjs");
const { ObjectId } = require("mongodb");

const {
  app,
  setCollections,
  setVerificationKey,
  BLOCKED_ACCOUNT_RESPONSE,
} = require("../index");

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
        if ("$nin" in expected && expected.$nin.includes(val)) return false;
        if ("$in" in expected && !expected.$in.includes(val)) return false;
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
        project: (projection) => chain,
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
      };
      return chain;
    },
    async insertOne(doc) {
      const newDoc = {
        _id: doc._id || new ObjectId(),
        ...doc,
      };
      docs.push(newDoc);
      return { insertedId: newDoc._id, acknowledged: true };
    },
    async updateOne(filter, update) {
      const doc = await this.findOne(filter);
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) {
        Object.assign(doc, update.$set);
      }
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) {
          delete doc[key];
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(filter) {
      const idx = docs.findIndex((d) => matchesFilter(d, filter));
      if (idx !== -1) {
        docs.splice(idx, 1);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    },
  };
}

describe("Blocked User Access Protection Audit & Verification Suite", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockProducts;
  let mockOrders;
  let mockReviews;
  let mockWishlist;

  before(async () => {
    setVerificationKey(TEST_SECRET);

    mockUsers = createMockCollection();
    mockProducts = createMockCollection();
    mockOrders = createMockCollection();
    mockReviews = createMockCollection();
    mockWishlist = createMockCollection();

    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      reviewsCollection: mockReviews,
      wishlistCollection: mockWishlist,
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

  const activeBuyerId = "60c72b2f9b1d8b2bad000001";
  const activeSellerId = "60c72b2f9b1d8b2bad000002";
  const adminId = "60c72b2f9b1d8b2bad000003";
  const blockedBuyerId = "60c72b2f9b1d8b2bad000004";
  const blockedSellerId = "60c72b2f9b1d8b2bad000005";
  const dynamicUserId = "60c72b2f9b1d8b2bad000006";

  const approvedProductId = "60c72b2f9b1d8b2bad000010";
  const pendingProductId = "60c72b2f9b1d8b2bad000011";

  beforeEach(() => {
    mockUsers.reset([
      {
        _id: new ObjectId(activeBuyerId),
        email: "active.buyer@example.com",
        name: "Active Buyer",
        role: "buyer",
        status: "active",
      },
      {
        _id: new ObjectId(activeSellerId),
        email: "active.seller@example.com",
        name: "Active Seller",
        role: "seller",
        status: "active",
      },
      {
        _id: new ObjectId(adminId),
        email: "admin@example.com",
        name: "Administrator",
        role: "admin",
        status: "active",
      },
      {
        _id: new ObjectId(blockedBuyerId),
        email: "blocked.buyer@example.com",
        name: "Blocked Buyer",
        role: "buyer",
        status: "blocked",
      },
      {
        _id: new ObjectId(blockedSellerId),
        email: "blocked.seller@example.com",
        name: "Blocked Seller",
        role: "seller",
        status: "blocked",
      },
      {
        _id: new ObjectId(dynamicUserId),
        email: "dynamic.user@example.com",
        name: "Dynamic User",
        role: "seller",
        status: "active",
      },
    ]);

    mockProducts.reset([
      {
        _id: new ObjectId(approvedProductId),
        title: "Canon DSLR Camera",
        category: "Electronics",
        price: 450,
        sellerInfo: "active.seller@example.com",
        status: "available",
        moderationStatus: "approved",
      },
      {
        _id: new ObjectId(pendingProductId),
        title: "Pending Smartphone Listing",
        category: "Electronics",
        price: 300,
        sellerInfo: "active.seller@example.com",
        status: "pending",
        moderationStatus: "pending",
      },
    ]);

    mockOrders.reset([]);
    mockReviews.reset([]);
    mockWishlist.reset([]);
  });

  describe("1. Active user can access protected APIs", () => {
    it("active buyer can access GET /api/buyer/orders (200)", async () => {
      const token = await createTestToken({
        sub: activeBuyerId,
        email: "active.buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/buyer/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
    });

    it("active seller can access GET /api/my-products (200)", async () => {
      const token = await createTestToken({
        sub: activeSellerId,
        email: "active.seller@example.com",
      });

      const res = await fetch(`${baseUrl}/api/my-products`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.strictEqual(data.length, 2);
    });

    it("active user can access GET /api/users/profile (200)", async () => {
      const token = await createTestToken({
        sub: activeBuyerId,
        email: "active.buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/users/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.email, "active.buyer@example.com");
      assert.strictEqual(data.status, "active");
    });
  });

  describe("2. Blocked user receives HTTP 403 with exact error contract", () => {
    it("blocked user on verifyToken-only route (GET /api/users/profile) receives 403 ACCOUNT_BLOCKED", async () => {
      const token = await createTestToken({
        sub: blockedBuyerId,
        email: "blocked.buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/users/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });

    it("blocked user on requireRole route (GET /api/buyer/orders) receives 403 ACCOUNT_BLOCKED", async () => {
      const token = await createTestToken({
        sub: blockedBuyerId,
        email: "blocked.buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/buyer/orders`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });

    it("blocked seller on POST /api/products receives 403 ACCOUNT_BLOCKED", async () => {
      const token = await createTestToken({
        sub: blockedSellerId,
        email: "blocked.seller@example.com",
      });

      const res = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: "Forbidden Product",
          price: 100,
          category: "Electronics",
        }),
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });

    it("blocked user on POST /api/reviews receives 403 ACCOUNT_BLOCKED", async () => {
      const token = await createTestToken({
        sub: blockedBuyerId,
        email: "blocked.buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/reviews`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          rating: 5,
          comment: "Review attempt while blocked",
        }),
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });

    it("blocked buyer on GET /api/wishlist receives 403 ACCOUNT_BLOCKED", async () => {
      const token = await createTestToken({
        sub: blockedBuyerId,
        email: "blocked.buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/wishlist`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });
  });

  describe("3. Old JWT cannot bypass blocking", () => {
    it("old valid JWT immediately fails with 403 when user is blocked in MongoDB", async () => {
      // 1. Issue token while user is active
      const oldValidToken = await createTestToken({
        sub: dynamicUserId,
        email: "dynamic.user@example.com",
      });

      // 2. Verify token works while active
      const checkActiveRes = await fetch(`${baseUrl}/api/users/profile`, {
        headers: { Authorization: `Bearer ${oldValidToken}` },
      });
      assert.strictEqual(checkActiveRes.status, 200);

      // 3. Admin blocks user in MongoDB
      await mockUsers.updateOne(
        { email: "dynamic.user@example.com" },
        { $set: { status: "blocked" } }
      );

      // 4. Send request using the EXACT SAME previously issued JWT token
      const checkBlockedRes = await fetch(`${baseUrl}/api/users/profile`, {
        headers: { Authorization: `Bearer ${oldValidToken}` },
      });
      assert.strictEqual(checkBlockedRes.status, 403);
      const data = await checkBlockedRes.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });
  });

  describe("4. Blocked user cannot access Product Details API with an authenticated token", () => {
    it("GET /api/products/:id with blocked user token returns 403 ACCOUNT_BLOCKED (not anonymous fallback)", async () => {
      const blockedToken = await createTestToken({
        sub: blockedBuyerId,
        email: "blocked.buyer@example.com",
      });

      const res = await fetch(
        `${baseUrl}/api/products/${approvedProductId}`,
        {
          headers: { Authorization: `Bearer ${blockedToken}` },
        }
      );
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });

    it("GET /api/products with blocked user token returns 403 ACCOUNT_BLOCKED", async () => {
      const blockedToken = await createTestToken({
        sub: blockedBuyerId,
        email: "blocked.buyer@example.com",
      });

      const res = await fetch(`${baseUrl}/api/products`, {
        headers: { Authorization: `Bearer ${blockedToken}` },
      });
      assert.strictEqual(res.status, 403);
      const data = await res.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(
        data.message,
        "Your account has been blocked by an administrator."
      );
      assert.strictEqual(data.code, "ACCOUNT_BLOCKED");
    });
  });

  describe("5. Anonymous visitors can still browse public products", () => {
    it("anonymous visitor without Authorization header can view product details (200)", async () => {
      const res = await fetch(`${baseUrl}/api/products/${approvedProductId}`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.title, "Canon DSLR Camera");
      assert.strictEqual(data.status, "available");
    });

    it("anonymous visitor without Authorization header can browse public product list (200)", async () => {
      const res = await fetch(`${baseUrl}/api/products`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.strictEqual(data.length, 1);
      assert.strictEqual(data[0].title, "Canon DSLR Camera");
    });

    it("anonymous visitor cannot view pending product on GET /api/products/:id (404)", async () => {
      const res = await fetch(`${baseUrl}/api/products/${pendingProductId}`);
      assert.strictEqual(res.status, 404);
    });

    it("visitor with invalid/malformed token is safely handled as anonymous on GET /api/products/:id (200)", async () => {
      const res = await fetch(`${baseUrl}/api/products/${approvedProductId}`, {
        headers: { Authorization: "Bearer invalid.malformed.token" },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.title, "Canon DSLR Camera");
    });
  });

  describe("6. Unblocking restores permitted API access according to existing role", () => {
    it("unblocking a user restores API access and preserves existing role permissions", async () => {
      // 1. User starts blocked
      await mockUsers.updateOne(
        { email: "dynamic.user@example.com" },
        { $set: { status: "blocked", role: "seller" } }
      );

      const userToken = await createTestToken({
        sub: dynamicUserId,
        email: "dynamic.user@example.com",
      });

      // 2. Request fails while blocked
      const blockedRes = await fetch(`${baseUrl}/api/seller/analytics`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(blockedRes.status, 403);
      const blockedData = await blockedRes.json();
      assert.strictEqual(blockedData.code, "ACCOUNT_BLOCKED");

      // 3. Admin unblocks user via admin status endpoint
      const adminToken = await createTestToken({
        sub: adminId,
        email: "admin@example.com",
      });

      const unblockRes = await fetch(
        `${baseUrl}/api/admin/users/${dynamicUserId}/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "active" }),
        }
      );
      assert.strictEqual(unblockRes.status, 200);
      const unblockData = await unblockRes.json();
      assert.strictEqual(unblockData.success, true);
      assert.match(unblockData.message, /unblocked successfully/i);

      // 4. Request succeeds now that account is active
      const restoredRes = await fetch(`${baseUrl}/api/seller/analytics`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      assert.strictEqual(restoredRes.status, 200);
      const analyticsData = await restoredRes.json();
      assert.strictEqual(analyticsData.sellerEmail, "dynamic.user@example.com");

      // 5. Product details endpoint also allows access
      const productRes = await fetch(
        `${baseUrl}/api/products/${approvedProductId}`,
        {
          headers: { Authorization: `Bearer ${userToken}` },
        }
      );
      assert.strictEqual(productRes.status, 200);
    });
  });

  describe("7. Existing Admin block/unblock functionality still works", () => {
    it("Admin can block an active user via PATCH /api/admin/users/:id/status", async () => {
      const adminToken = await createTestToken({
        sub: adminId,
        email: "admin@example.com",
      });

      const res = await fetch(
        `${baseUrl}/api/admin/users/${activeBuyerId}/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "blocked" }),
        }
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.message, "User blocked successfully");

      const userInDb = await mockUsers.findOne({
        _id: new ObjectId(activeBuyerId),
      });
      assert.strictEqual(userInDb.status, "blocked");
      assert.strictEqual(userInDb.role, "buyer"); // role preserved
    });

    it("Admin can unblock a user via PATCH /api/admin/users/:id/status", async () => {
      const adminToken = await createTestToken({
        sub: adminId,
        email: "admin@example.com",
      });

      const res = await fetch(
        `${baseUrl}/api/admin/users/${blockedBuyerId}/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "active" }),
        }
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.message, "User unblocked successfully");

      const userInDb = await mockUsers.findOne({
        _id: new ObjectId(blockedBuyerId),
      });
      assert.strictEqual(userInDb.status, "active");
      assert.strictEqual(userInDb.role, "buyer"); // role preserved
    });

    it("rejects invalid status values with 400", async () => {
      const adminToken = await createTestToken({
        sub: adminId,
        email: "admin@example.com",
      });

      const res = await fetch(
        `${baseUrl}/api/admin/users/${activeBuyerId}/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "suspended" }), // invalid
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.message, "Invalid status");
    });

    it("non-admin user cannot call PATCH /api/admin/users/:id/status (403)", async () => {
      const buyerToken = await createTestToken({
        sub: activeBuyerId,
        email: "active.buyer@example.com",
      });

      const res = await fetch(
        `${baseUrl}/api/admin/users/${activeSellerId}/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${buyerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "blocked" }),
        }
      );
      assert.strictEqual(res.status, 403);
    });
  });
});
