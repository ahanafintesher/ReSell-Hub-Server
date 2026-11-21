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

describe("Section 5: Critical Product Moderation Security Audit Suite", () => {
  let server;
  let baseUrl;
  let mockUsers;
  let mockProducts;

  before(async () => {
    setVerificationKey(TEST_SECRET);

    mockUsers = createMockCollection();
    mockProducts = createMockCollection();

    setCollections({
      usersCollection: mockUsers,
      productsCollection: mockProducts,
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
        email: "seller1@example.com",
        name: "Seller One",
        role: "seller",
        status: "active",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad123454"),
        email: "seller2@example.com",
        name: "Seller Two",
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
        title: "Approved Camera",
        category: "Electronics",
        price: 500,
        sellerInfo: "seller1@example.com",
        status: "available",
        moderationStatus: "approved",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200002"),
        title: "Pending Moderation Laptop",
        category: "Electronics",
        price: 1200,
        sellerInfo: "seller1@example.com",
        status: "pending",
        moderationStatus: "pending",
      },
      {
        _id: new ObjectId("60c72b2f9b1d8b2bad200003"),
        title: "Rejected Counterfeit Watch",
        category: "Wearables",
        price: 300,
        sellerInfo: "seller1@example.com",
        status: "rejected",
        moderationStatus: "rejected",
      },
    ]);
  });

  it("Rule 1, 2, 3: Seller created product is always forced to pending moderation regardless of client payload", async () => {
    const sellerToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad123452",
      email: "seller1@example.com",
    });

    const res = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sellerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Exploit Available Product",
        price: 999,
        category: "Electronics",
        status: "available", // Attempted bypass!
        moderationStatus: "approved", // Attempted bypass!
        isPubliclyVisible: true, // Attempted bypass!
      }),
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    const created = await mockProducts.findOne({ _id: data.insertedId });
    assert.strictEqual(created.status, "pending");
    assert.strictEqual(created.moderationStatus, "pending");
    assert.strictEqual(created.isPubliclyVisible, false);
  });

  it("Rule 4: Seller cannot update pending product into available/approved listing", async () => {
    const sellerToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad123452",
      email: "seller1@example.com",
    });

    const res = await fetch(`${baseUrl}/api/products/60c72b2f9b1d8b2bad200002`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${sellerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "available", // Attempted bypass!
        moderationStatus: "approved", // Attempted bypass!
      }),
    });

    assert.strictEqual(res.status, 200);
    const doc = await mockProducts.findOne({
      _id: new ObjectId("60c72b2f9b1d8b2bad200002"),
    });
    assert.strictEqual(doc.status, "pending");
    assert.strictEqual(doc.moderationStatus, "pending");
  });

  it("Rule 5 & 9: Only Admin can approve listings via /api/admin/products/:id/status", async () => {
    const adminToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad123453",
      email: "admin@example.com",
    });

    const res = await fetch(
      `${baseUrl}/api/admin/products/60c72b2f9b1d8b2bad200002/status`,
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
    const doc = await mockProducts.findOne({
      _id: new ObjectId("60c72b2f9b1d8b2bad200002"),
    });
    assert.strictEqual(doc.status, "available");
    assert.strictEqual(doc.moderationStatus, "approved");
    assert.strictEqual(doc.moderatedBy, "admin@example.com");
  });

  it("Rule 5: Buyer cannot moderate product listings (403 Forbidden)", async () => {
    const buyerToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad123451",
      email: "buyer@example.com",
    });

    const res = await fetch(
      `${baseUrl}/api/admin/products/60c72b2f9b1d8b2bad200002/status`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${buyerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "approved" }),
      }
    );

    assert.strictEqual(res.status, 403);
  });

  it("Rule 5: Unauthenticated user cannot moderate product listings (401 Unauthorized)", async () => {
    const res = await fetch(
      `${baseUrl}/api/admin/products/60c72b2f9b1d8b2bad200002/status`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      }
    );

    assert.strictEqual(res.status, 401);
  });

  it("Rule 6, 7, 10: Public GET /api/products excludes pending and rejected products", async () => {
    const res = await fetch(`${baseUrl}/api/products`);
    assert.strictEqual(res.status, 200);
    const list = await res.json();
    assert.ok(Array.isArray(list));
    // Only the approved camera should be returned
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].title, "Approved Camera");
  });

  it("Rule 7, 10: Non-admin cannot query pending products via ?status=pending", async () => {
    const res = await fetch(`${baseUrl}/api/products?status=pending`);
    assert.strictEqual(res.status, 200);
    const list = await res.json();
    assert.strictEqual(list.length, 0);
  });

  it("Rule 6, 7, 10: Public GET /api/products/:id returns 404 for pending product to unauthenticated users", async () => {
    const res = await fetch(
      `${baseUrl}/api/products/60c72b2f9b1d8b2bad200002`
    );
    assert.strictEqual(res.status, 404);
  });

  it("Rule 6, 7, 10: Public GET /api/products/:id returns 404 for rejected product to unauthenticated users", async () => {
    const res = await fetch(
      `${baseUrl}/api/products/60c72b2f9b1d8b2bad200003`
    );
    assert.strictEqual(res.status, 404);
  });

  it("Rule 6, 7: Owner seller can view their own pending product via GET /api/products/:id", async () => {
    const sellerToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad123452",
      email: "seller1@example.com",
    });

    const res = await fetch(
      `${baseUrl}/api/products/60c72b2f9b1d8b2bad200002`,
      {
        headers: { Authorization: `Bearer ${sellerToken}` },
      }
    );
    assert.strictEqual(res.status, 200);
    const doc = await res.json();
    assert.strictEqual(doc.title, "Pending Moderation Laptop");
  });

  it("Rule 8: Seller cannot edit another seller's product (403 Forbidden)", async () => {
    const seller2Token = await createTestToken({
      sub: "60c72b2f9b1d8b2bad123454",
      email: "seller2@example.com",
    });

    const res = await fetch(
      `${baseUrl}/api/products/60c72b2f9b1d8b2bad200001`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${seller2Token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: "Attacker Edited Title" }),
      }
    );

    assert.strictEqual(res.status, 403);
  });

  it("Admin can view pending products and query ?status=pending", async () => {
    const adminToken = await createTestToken({
      sub: "60c72b2f9b1d8b2bad123453",
      email: "admin@example.com",
    });

    const res = await fetch(`${baseUrl}/api/products?status=pending`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(res.status, 200);
    const list = await res.json();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].title, "Pending Moderation Laptop");
  });
});
