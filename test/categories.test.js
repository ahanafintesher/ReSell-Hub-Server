const { test, it, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { app } = require("../index");
const {
  setCollections,
  getCollections,
  createIndexes,
  seedCategories,
  INITIAL_CATEGORIES,
} = require("../src/config/db");

// In-memory mock collection supporting queries, operators, projection, and sorting
function createMockCollection(initialData = []) {
  let docs = initialData.map((d) => ({ ...d }));

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

      if (expected && typeof expected === "object") {
        if ("$ne" in expected && val === expected.$ne) return false;
        if ("$nin" in expected && expected.$nin.includes(val)) return false;
        if ("$in" in expected && !expected.$in.includes(val)) return false;
      } else {
        if (val !== expected) return false;
      }
    }
    return true;
  }

  return {
    _docs: docs,
    _indexes: [],
    async countDocuments(filter = {}) {
      return docs.filter((d) => matchesFilter(d, filter)).length;
    },
    async createIndex(keys, options = {}) {
      const idx = { key: keys, ...options, name: options.name || "idx" };
      this._indexes.push(idx);
      return idx.name;
    },
    async indexes() {
      return this._indexes;
    },
    async bulkWrite(operations) {
      for (const op of operations) {
        if (op.updateOne) {
          const { filter, update, upsert } = op.updateOne;
          const matchIndex = docs.findIndex((d) => matchesFilter(d, filter));
          if (matchIndex >= 0) {
            // Apply $set if any
            if (update.$set) {
              Object.assign(docs[matchIndex], update.$set);
            }
            // Do not apply $setOnInsert on existing documents
          } else if (upsert) {
            const newDoc = { _id: "mock_id_" + Math.random().toString(36).substring(2, 9) };
            if (update.$setOnInsert) {
              Object.assign(newDoc, update.$setOnInsert);
            }
            if (update.$set) {
              Object.assign(newDoc, update.$set);
            }
            docs.push(newDoc);
          }
        }
      }
      return { ok: 1 };
    },
    find(filter = {}, projectionOptions = {}) {
      let matched = docs.filter((d) => matchesFilter(d, filter));

      const chain = {
        sort(sortObj) {
          if (sortObj && sortObj.name) {
            matched.sort((a, b) =>
              sortObj.name === 1
                ? (a.name || "").localeCompare(b.name || "")
                : (b.name || "").localeCompare(a.name || "")
            );
          }
          return chain;
        },
        async toArray() {
          return matched.map((d) => ({ ...d }));
        },
      };
      return chain;
    },
  };
}

describe("Categories Collection & Public API Test Suite", () => {
  let originalCollections;
  let server;
  let baseUrl;

  beforeEach(async () => {
    originalCollections = { ...getCollections() };

    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    setCollections(originalCollections);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe("1. Category Seeding and Idempotency", () => {
    it("seeds all 9 categories into an empty collection", async () => {
      const mockCategories = createMockCollection([]);
      setCollections({ categoriesCollection: mockCategories });

      await seedCategories(mockCategories);

      const count = await mockCategories.countDocuments();
      assert.strictEqual(count, 9);

      const docs = await mockCategories.find({}).sort({ name: 1 }).toArray();
      assert.strictEqual(docs.length, 9);
      assert.strictEqual(docs[0].name, "Accessories");
      assert.strictEqual(docs[8].name, "Wearables");

      // Verify all active
      for (const cat of docs) {
        assert.strictEqual(cat.isActive, true);
        assert.ok(typeof cat.description === "string" && cat.description.length > 0);
      }
    });

    it("does not create duplicate documents when re-run multiple times (idempotency)", async () => {
      const mockCategories = createMockCollection([]);
      setCollections({ categoriesCollection: mockCategories });

      // Run seeding twice
      await seedCategories(mockCategories);
      await seedCategories(mockCategories);
      await seedCategories(mockCategories);

      const count = await mockCategories.countDocuments();
      assert.strictEqual(count, 9, "Collection must strictly retain exactly 9 documents");
    });

    it("preserves existing customized descriptions and inactive status without overwriting", async () => {
      // Pre-populate with custom description and deactivated status
      const existing = [
        {
          _id: "custom_electronics",
          name: "Electronics",
          description: "Custom user-modified electronic equipment description",
          isActive: false, // manually disabled by admin
        },
      ];
      const mockCategories = createMockCollection(existing);
      setCollections({ categoriesCollection: mockCategories });

      await seedCategories(mockCategories);

      const count = await mockCategories.countDocuments();
      assert.strictEqual(count, 9);

      const electronics = mockCategories._docs.find((c) => c.name === "Electronics");
      assert.strictEqual(
        electronics.description,
        "Custom user-modified electronic equipment description",
        "Existing description must be preserved"
      );
      assert.strictEqual(
        electronics.isActive,
        false,
        "Existing inactive status must not be overridden"
      );
    });

    it("creates unique index on name field during createIndexes", async () => {
      const mockCategories = createMockCollection([]);
      setCollections({
        categoriesCollection: mockCategories,
        productsCollection: null,
        ordersCollection: null,
        paymentsCollection: null,
        wishlistCollection: null,
        usersCollection: null,
        reportsCollection: null,
        processedEventsCollection: null,
        disputesCollection: null,
      });

      await createIndexes();

      const indexes = await mockCategories.indexes();
      const nameIndex = indexes.find(
        (idx) => idx.name === "name_1" || (idx.key && idx.key.name === 1)
      );
      assert.ok(nameIndex, "name_1 index must be created");
      assert.strictEqual(nameIndex.unique, true, "name index must be unique");
    });
  });

  describe("2. Public Categories API Endpoint", () => {
    it("GET /api/v1/categories returns 200 with all 9 active categories sorted alphabetically", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.message, "Categories fetched successfully");
      assert.ok(Array.isArray(json.data));
      assert.strictEqual(json.data.length, 9);

      // Verify alphabetical order
      const names = json.data.map((c) => c.name);
      const sortedNames = [...names].sort();
      assert.deepStrictEqual(names, sortedNames);

      // Verify fields
      const first = json.data[0];
      assert.strictEqual(first.name, "Accessories");
      assert.strictEqual(first.isActive, true);
      assert.ok(first._id);
      assert.ok(first.description);
    });

    it("GET /api/categories and GET /categories also resolve successfully (route aliases)", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const resApi = await fetch(`${baseUrl}/api/categories`);
      assert.strictEqual(resApi.status, 200);
      const jsonApi = await resApi.json();
      assert.strictEqual(jsonApi.data.length, 9);

      const resRoot = await fetch(`${baseUrl}/categories`);
      assert.strictEqual(resRoot.status, 200);
      const jsonRoot = await resRoot.json();
      assert.strictEqual(jsonRoot.data.length, 9);
    });

    it("excludes inactive categories from response", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);

      // Deactivate one category
      const target = mockCategories._docs.find((c) => c.name === "Audio");
      target.isActive = false;

      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.data.length, 8);
      assert.ok(!json.data.some((c) => c.name === "Audio"));
    });

    it("does not require authentication or authorization tokens (public access)", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      // Request without any headers
      const res = await fetch(`${baseUrl}/api/v1/categories`, {
        headers: {},
      });
      assert.strictEqual(res.status, 200);
    });

    it("returns 503 Service Unavailable when database is not connected", async () => {
      setCollections({ categoriesCollection: null });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 503);

      const json = await res.json();
      assert.strictEqual(json.success, false);
      assert.match(json.message, /Database not connected/);
    });

    it("does not expose unnecessary internal MongoDB fields", async () => {
      const mockCategories = createMockCollection([
        {
          _id: "cat_1",
          name: "Electronics",
          description: "Laptops and tech gear",
          isActive: true,
          __v: 0,
          internalClusterId: "node-xyz-secret",
          mongoInternalState: { version: 1 },
        },
      ]);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.data.length, 1);
      const keys = Object.keys(json.data[0]);
      assert.deepStrictEqual(keys.sort(), ["_id", "description", "isActive", "name"].sort());
      assert.strictEqual(json.data[0].__v, undefined);
      assert.strictEqual(json.data[0].internalClusterId, undefined);
    });
  });
});
