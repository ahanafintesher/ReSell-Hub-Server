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

// In-memory mock collection supporting queries, operators, pagination, and projection
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

describe("ReSell Hub Complete Requirements Feature Suite", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockProducts;
  let mockOrders;
  let mockWishlist;
  let mockReviews;
  let mockPayments;
  let mockReports;

  before(async () => {
    setVerificationKey(TEST_SECRET);

    mockUsers = createMockCollection();
    mockProducts = createMockCollection();
    mockOrders = createMockCollection();
    mockWishlist = createMockCollection();
    mockReviews = createMockCollection();
    mockPayments = createMockCollection();
    mockReports = createMockCollection();

    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
      ordersCollection: mockOrders,
      wishlistCollection: mockWishlist,
      reviewsCollection: mockReviews,
      paymentsCollection: mockPayments,
      reportsCollection: mockReports,
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
        name: "Active Buyer",
        role: "buyer",
        status: "active",
        phone: "+8801700000001",
        location: "Dhaka",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123452"),
        email: "seller@example.com",
        name: "Pro Tech Seller",
        role: "seller",
        status: "active",
        isVerified: true,
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123453"),
        email: "admin@example.com",
        name: "Super Admin",
        role: "admin",
        status: "active",
      },
    ]);

    mockProducts.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200001"),
        title: "Dell XPS 13 Ultrabook",
        category: "Electronics",
        price: 85000,
        sellerInfo: "seller@example.com",
        sellerName: "Pro Tech Seller",
        status: "available",
        createdAt: new Date("2026-01-10"),
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200002"),
        title: "iPhone 13 128GB",
        category: "Mobile Phones",
        price: 55000,
        sellerInfo: "seller@example.com",
        sellerName: "Pro Tech Seller",
        status: "available",
        createdAt: new Date("2026-01-15"),
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200003"),
        title: "Mechanical Keyboard",
        category: "Accessories",
        price: 4500,
        sellerInfo: "seller@example.com",
        sellerName: "Pro Tech Seller",
        status: "sold",
        createdAt: new Date("2026-01-20"),
      },
    ]);

    mockOrders.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad300001"),
        productId: "60c72b2f9b1d8b2bad200001",
        productTitle: "Dell XPS 13 Ultrabook",
        buyerInfo: "buyer@example.com",
        buyerName: "Active Buyer",
        sellerInfo: "seller@example.com",
        price: 85000,
        orderStatus: "processing",
        paymentStatus: "paid",
        createdAt: new Date("2026-02-01"),
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad300002"),
        productId: "60c72b2f9b1d8b2bad200002",
        productTitle: "iPhone 13 128GB",
        buyerInfo: "buyer@example.com",
        buyerName: "Active Buyer",
        sellerInfo: "seller@example.com",
        price: 55000,
        orderStatus: "shipped",
        paymentStatus: "paid",
        createdAt: new Date("2026-02-05"),
      },
    ]);

    mockPayments.reset([
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad600001"),
        session_id: "cs_mock_p1",
        transactionId: "pi_mock_p1",
        amount: 85000,
        currency: "bdt",
        paymentStatus: "paid",
        metadata: { userEmail: "buyer@example.com" },
        createdAt: new Date("2026-02-01"),
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad600002"),
        session_id: "cs_mock_p2",
        transactionId: "pi_mock_p2",
        amount: 55000,
        currency: "bdt",
        paymentStatus: "paid",
        metadata: { userEmail: "buyer@example.com" },
        createdAt: new Date("2026-02-05"),
      },
    ]);

    mockReports.reset();
  });

  // ──────────────────────────────────────────
  // A. Public Marketplace Statistics
  // ──────────────────────────────────────────
  describe("A. Public Marketplace Statistics", () => {
    it("returns genuine platform statistics without authentication", async () => {
      const res = await fetch(`${baseUrl}/api/public/stats`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(typeof data.totalProducts, "number");
      assert.strictEqual(typeof data.totalSellers, "number");
      assert.strictEqual(typeof data.totalBuyers, "number");
      assert.strictEqual(typeof data.completedOrders, "number");

      assert.strictEqual(data.totalProducts, 3);
      assert.strictEqual(data.totalSellers, 1);
      assert.strictEqual(data.totalBuyers, 1);
      assert.strictEqual(data.completedOrders, 2);
    });
  });

  // ──────────────────────────────────────────
  // B. Admin All-Orders Management
  // ──────────────────────────────────────────
  describe("B. Admin All-Orders Management", () => {
    it("rejects non-admin access to /api/admin/orders (403)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/admin/orders`, {
        headers: { Authorization: `Bearer ${buyerToken}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it("allows admin to view all orders with pagination metadata", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(`${baseUrl}/api/admin/orders?page=1&limit=1`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.total, 2);
      assert.strictEqual(data.page, 1);
      assert.strictEqual(data.limit, 1);
      assert.strictEqual(data.totalPages, 2);
      assert.strictEqual(data.orders.length, 1);
    });

    it("filters admin orders by status", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(`${baseUrl}/api/admin/orders?status=shipped`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.total, 1);
      assert.strictEqual(data.orders[0].orderStatus, "shipped");
    });
  });

  // ──────────────────────────────────────────
  // C. Admin Global Payment Monitoring
  // ──────────────────────────────────────────
  describe("C. Admin Global Payment Monitoring", () => {
    it("restricts buyer to their own payments only", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      // Attacker buyer attempts to probe seller's payments
      const res = await fetch(
        `${baseUrl}/api/payments?userEmail=seller@example.com`,
        {
          headers: { Authorization: `Bearer ${buyerToken}` },
        }
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      // Should ignore query param and only return buyer's payments
      assert.ok(Array.isArray(data));
      for (const p of data) {
        assert.strictEqual(p.metadata.userEmail, "buyer@example.com");
      }
    });

    it("allows admin to monitor all platform payments when no filter is provided", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(`${baseUrl}/api/payments`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.length, 2);
    });

    it("supports paginated payment response with total revenue for admin", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(`${baseUrl}/api/payments?page=1&limit=10`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.total, 2);
      assert.strictEqual(data.totalRevenue, 140000);
    });
  });

  // ──────────────────────────────────────────
  // E. User Profile Management
  // ──────────────────────────────────────────
  describe("E. User Profile Management", () => {
    it("allows authenticated user to update permitted profile fields", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/users/profile`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Updated Buyer Name",
          location: "Chittagong",
          phone: "+8801999999999",
          role: "admin", // Attacker attempts role escalation
        }),
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.user.name, "Updated Buyer Name");
      assert.strictEqual(data.user.location, "Chittagong");
      assert.strictEqual(data.user.phone, "+8801999999999");
      assert.strictEqual(data.user.role, "buyer"); // Role must remain unchanged!
    });

    it("rejects empty name in profile update (400)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(`${baseUrl}/api/users/profile`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "   " }),
      });
      assert.strictEqual(res.status, 400);
    });
  });

  // ──────────────────────────────────────────
  // F. Product Listing Pagination
  // ──────────────────────────────────────────
  describe("F. Product Listing Pagination", () => {
    it("returns paginated object with metadata when page/limit are provided", async () => {
      const res = await fetch(`${baseUrl}/api/products?page=1&limit=2`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.page, 1);
      assert.strictEqual(data.limit, 2);
      assert.strictEqual(data.total, 3);
      assert.strictEqual(data.totalPages, 2);
      assert.strictEqual(data.products.length, 2);
    });

    it("returns backward-compatible flat array when pagination params are absent", async () => {
      const res = await fetch(`${baseUrl}/api/products`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.strictEqual(data.length, 3);
    });
  });

  // ──────────────────────────────────────────
  // G. Soft Order Cancellation & Order Details
  // ──────────────────────────────────────────
  describe("G. Soft Order Cancellation & Details", () => {
    it("allows buyer to view their own order details", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300001`,
        {
          headers: { Authorization: `Bearer ${buyerToken}` },
        }
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.productTitle, "Dell XPS 13 Ultrabook");
    });

    it("prevents third-party user from viewing another user's order (403)", async () => {
      const otherToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123454",
        email: "other@example.com",
      });
      mockUsers.insertOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad123454"),
        email: "other@example.com",
        role: "buyer",
        status: "active",
      });

      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300001`,
        {
          headers: { Authorization: `Bearer ${otherToken}` },
        }
      );
      assert.strictEqual(res.status, 403);
    });

    it("performs soft cancellation on eligible pending/processing orders", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300001/cancel`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${buyerToken}` },
        }
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.order.orderStatus, "cancelled");

      // Verify record is preserved, not deleted!
      const inDb = await mockOrders.findOne({
        _id: new ObjectId("60c72b2f9b1d8b2bad300001"),
      });
      assert.ok(inDb);
      assert.strictEqual(inDb.orderStatus, "cancelled");
    });

    it("rejects soft cancellation for shipped order (400)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/orders/60c72b2f9b1d8b2bad300002/cancel`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${buyerToken}` },
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /only pending, accepted, or processing/i);
    });
  });

  // ──────────────────────────────────────────
  // H. Admin Product Moderation
  // ──────────────────────────────────────────
  describe("H. Admin Product Moderation", () => {
    it("allows admin to approve or reject products", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/admin/products/60c72b2f9b1d8b2bad200001/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "approved" }),
        }
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
    });

    it("rejects non-admin product moderation attempt (403)", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/admin/products/60c72b2f9b1d8b2bad200001/status`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${sellerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ status: "approved" }),
        }
      );
      assert.strictEqual(res.status, 403);
    });
  });

  // ──────────────────────────────────────────
  // I. Seller Analytics
  // ──────────────────────────────────────────
  describe("I. Seller Analytics", () => {
    it("returns genuine seller metrics, monthly sales, and inventory", async () => {
      const sellerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123452",
        email: "seller@example.com",
      });
      const res = await fetch(`${baseUrl}/api/seller/analytics`, {
        headers: { Authorization: `Bearer ${sellerToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.sellerEmail, "seller@example.com");
      assert.strictEqual(typeof data.totalSales, "number");
      assert.strictEqual(typeof data.totalRevenue, "number");
      assert.ok(Array.isArray(data.monthlySales));
      assert.ok(Array.isArray(data.topProducts));
      assert.strictEqual(data.inventory.total, 3);
    });
  });

  // ──────────────────────────────────────────
  // J. Admin Platform Analytics
  // ──────────────────────────────────────────
  describe("J. Admin Platform Analytics", () => {
    it("returns rich platform metrics for admin dashboard", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(`${baseUrl}/api/admin/analytics`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.totalUsers, 3);
      assert.strictEqual(data.totalProducts, 3);
      assert.strictEqual(data.totalOrders, 2);
      assert.ok(data.accountDistribution);
      assert.ok(data.productInventory);
      assert.ok(data.fulfillmentDistribution);
    });
  });

  // ──────────────────────────────────────────
  // K. Public Seller Profile and Top-Rated
  // ──────────────────────────────────────────
  describe("K. Public Seller Profiles", () => {
    it("returns top-rated sellers publicly", async () => {
      const res = await fetch(`${baseUrl}/api/sellers/top-rated`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data));
      assert.strictEqual(data.length, 1);
      assert.strictEqual(data[0].sellerEmail, "seller@example.com");
    });

    it("returns individual public seller profile and listings", async () => {
      const res = await fetch(`${baseUrl}/api/sellers/seller@example.com`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.name, "Pro Tech Seller");
      assert.strictEqual(data.isVerified, true);
      assert.ok(Array.isArray(data.listings));
    });
  });

  // ──────────────────────────────────────────
  // L. Seller Verification
  // ──────────────────────────────────────────
  describe("L. Seller Verification", () => {
    it("allows admin to verify seller accounts", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/admin/users/60c72b2f9b1d8b2bad123452/verify`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isVerified: true }),
        }
      );
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.user.isVerified, true);
    });

    it("rejects verification on non-seller accounts (400)", async () => {
      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/admin/users/60c72b2f9b1d8b2bad123451/verify`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ isVerified: true }),
        }
      );
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.match(data.message, /only seller accounts/i);
    });
  });

  // ──────────────────────────────────────────
  // M. Product Reporting and Moderation
  // ──────────────────────────────────────────
  describe("M. Product Reporting and Moderation", () => {
    it("allows authenticated buyer to report a product with a reason", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });
      const res = await fetch(
        `${baseUrl}/api/products/60c72b2f9b1d8b2bad200001/report`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${buyerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reason: "Counterfeit item",
            description: "Serial number does not match authentic Apple model.",
          }),
        }
      );
      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.ok(data.reportId);
    });

    it("prevents duplicate report spam for the same product by the same user (409)", async () => {
      const buyerToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123451",
        email: "buyer@example.com",
      });

      // 1st report
      await fetch(
        `${baseUrl}/api/products/60c72b2f9b1d8b2bad200001/report`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${buyerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reason: "First complaint" }),
        }
      );

      // 2nd report attempt (duplicate)
      const res = await fetch(
        `${baseUrl}/api/products/60c72b2f9b1d8b2bad200001/report`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${buyerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ reason: "Duplicate complaint" }),
        }
      );
      assert.strictEqual(res.status, 409);
    });

    it("allows admin to view reported products list", async () => {
      // Seed a report
      await mockReports.insertOne({
        productId: "60c72b2f9b1d8b2bad200001",
        productTitle: "Dell XPS 13 Ultrabook",
        reporterEmail: "buyer@example.com",
        reason: "Counterfeit item",
        status: "pending",
        createdAt: new Date(),
      });

      const adminToken = await createTestToken({
        sub: "60c72b2f9b1d8b2bad123453",
        email: "admin@example.com",
      });
      const res = await fetch(`${baseUrl}/api/admin/reports`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.total, 1);
      assert.strictEqual(data.reports[0].reason, "Counterfeit item");
    });
  });
});
