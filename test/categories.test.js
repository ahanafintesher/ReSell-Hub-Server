const { test, it, describe, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { app } = require("../index");
const categoriesRoutes = require("../src/routes/categories.routes");
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

  before(async () => {
    await new Promise((resolve) => {
      server = http.createServer(app);
      server.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    originalCollections = { ...getCollections() };
  });

  afterEach(() => {
    setCollections(originalCollections);
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

  describe("2. Public Categories API Endpoint & Custom Sorting", () => {
    const EXPECTED_ORDER = [
      "Electronics",
      "Audio",
      "Wearables",
      "Accessories",
      "Fashion",
      "Furniture",
      "Vehicles",
      "Mobile Phones",
      "Others",
    ];

    it("GET /api/v1/categories returns 200 with all 9 active categories in exact predefined order", async () => {
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

      // Verify exact sequence
      const names = json.data.map((c) => c.name);
      assert.deepStrictEqual(names, EXPECTED_ORDER);

      // Verify Others is strictly last
      assert.strictEqual(names[names.length - 1], "Others");

      // Verify fields
      const first = json.data[0];
      assert.strictEqual(first.name, "Electronics");
      assert.strictEqual(first.isActive, true);
      assert.ok(first._id);
      assert.ok(first.description);
    });

    it("GET /api/categories and GET /categories aliases return identical exact predefined order", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const resApi = await fetch(`${baseUrl}/api/categories`);
      assert.strictEqual(resApi.status, 200);
      const jsonApi = await resApi.json();
      assert.deepStrictEqual(
        jsonApi.data.map((c) => c.name),
        EXPECTED_ORDER
      );

      const resRoot = await fetch(`${baseUrl}/categories`);
      assert.strictEqual(resRoot.status, 200);
      const jsonRoot = await resRoot.json();
      assert.deepStrictEqual(
        jsonRoot.data.map((c) => c.name),
        EXPECTED_ORDER
      );
    });

    it("does not depend on MongoDB natural document order or insertion order", async () => {
      // Intentionally insert categories in reversed order into the collection
      const reversedCategories = [...INITIAL_CATEGORIES].reverse();
      const mockCategories = createMockCollection(reversedCategories);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      const names = json.data.map((c) => c.name);
      assert.deepStrictEqual(
        names,
        EXPECTED_ORDER,
        "Categories must strictly match predefined order regardless of database insertion/natural order"
      );
    });

    it("excludes inactive categories while preserving relative predefined order", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);

      // Deactivate "Audio" and "Fashion"
      const audio = mockCategories._docs.find((c) => c.name === "Audio");
      audio.isActive = false;
      const fashion = mockCategories._docs.find((c) => c.name === "Fashion");
      fashion.isActive = false;

      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.data.length, 7);
      assert.ok(!json.data.some((c) => c.name === "Audio" || c.name === "Fashion"));

      const expectedFiltered = [
        "Electronics",
        "Wearables",
        "Accessories",
        "Furniture",
        "Vehicles",
        "Mobile Phones",
        "Others",
      ];
      assert.deepStrictEqual(
        json.data.map((c) => c.name),
        expectedFiltered
      );
    });

    it("handles unexpected or newly added categories safely with 'Others' strictly last", async () => {
      // 9 standard categories + 3 unknown categories
      const mockData = [
        ...INITIAL_CATEGORIES,
        {
          _id: "cat_gaming",
          name: "Gaming Consoles",
          description: "Consoles and game gear",
          isActive: true,
        },
        {
          _id: "cat_books",
          name: "Books",
          description: "Novels and reference books",
          isActive: true,
        },
        {
          _id: "cat_art",
          name: "Art & Collectibles",
          description: "Paintings and sculptures",
          isActive: true,
        },
      ];

      const mockCategories = createMockCollection(mockData);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      const names = json.data.map((c) => c.name);

      const expectedWithUnknown = [
        "Electronics",
        "Audio",
        "Wearables",
        "Accessories",
        "Fashion",
        "Furniture",
        "Vehicles",
        "Mobile Phones",
        "Art & Collectibles",
        "Books",
        "Gaming Consoles",
        "Others",
      ];

      assert.deepStrictEqual(
        names,
        expectedWithUnknown,
        "Known categories must be in order, followed by unknown categories (alphabetical), with 'Others' strictly last"
      );
      assert.strictEqual(names[names.length - 1], "Others");
    });

    it("keeps 'Others' at the very end even when only unknown categories and Others exist", async () => {
      const mockData = [
        { _id: "cat_others", name: "Others", description: "Other items", isActive: true },
        { _id: "cat_sports", name: "Sports", description: "Sporting goods", isActive: true },
        { _id: "cat_music", name: "Musical Instruments", description: "Guitars & Pianos", isActive: true },
      ];

      const mockCategories = createMockCollection(mockData);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      const names = json.data.map((c) => c.name);

      assert.deepStrictEqual(names, ["Musical Instruments", "Sports", "Others"]);
      assert.strictEqual(names[names.length - 1], "Others");
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

    describe("3. Unit Tests: Sorting Helper & Priority Map", () => {
      it("maps predefined category names to distinct integer priorities from 1 to 8", () => {
        const { getCategoryPriority, PREDEFINED_CATEGORY_ORDER } = categoriesRoutes;
        assert.ok(Array.isArray(PREDEFINED_CATEGORY_ORDER));
        assert.strictEqual(PREDEFINED_CATEGORY_ORDER.length, 8);

        PREDEFINED_CATEGORY_ORDER.forEach((name, index) => {
          assert.strictEqual(getCategoryPriority(name), index + 1);
        });
      });

      it("assigns Number.MAX_SAFE_INTEGER to 'Others' and 9999 to unknown categories", () => {
        const { getCategoryPriority } = categoriesRoutes;
        assert.strictEqual(getCategoryPriority("Others"), Number.MAX_SAFE_INTEGER);
        assert.strictEqual(getCategoryPriority("Unknown Cat"), 9999);
        assert.strictEqual(getCategoryPriority(null), 9999);
        assert.strictEqual(getCategoryPriority(undefined), 9999);
      });

      it("sortCategories handles empty arrays, missing fields, and non-array gracefully", () => {
        const { sortCategories } = categoriesRoutes;
        assert.deepStrictEqual(sortCategories([]), []);
        assert.deepStrictEqual(sortCategories(null), []);
        assert.deepStrictEqual(sortCategories(undefined), []);

        const messy = [
          { name: "Others" },
          { name: null },
          { name: "Electronics" },
        ];
        const sorted = sortCategories(messy);
        assert.strictEqual(sorted[0].name, "Electronics");
        assert.strictEqual(sorted[1].name, null);
        assert.strictEqual(sorted[2].name, "Others");
      });
    });
  });

  describe("4. Featured Categories API Endpoint (GET /api/v1/featured)", () => {
    const EXPECTED_FEATURED_ORDER = [
      "Electronics",
      "Audio",
      "Wearables",
      "Accessories",
      "Fashion",
      "Furniture",
      "Vehicles",
      "Mobile Phones",
    ];

    it("GET /api/v1/featured returns 200 with exactly 8 categories in exact custom order", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.message, "Featured categories fetched successfully");
      assert.ok(Array.isArray(json.data));
      assert.strictEqual(json.data.length, 8, "Must contain exactly 8 featured categories");

      const names = json.data.map((c) => c.name);
      assert.deepStrictEqual(names, EXPECTED_FEATURED_ORDER);

      // Verify fields
      for (const cat of json.data) {
        assert.strictEqual(cat.isActive, true);
        assert.ok(cat._id);
        assert.ok(typeof cat.description === "string");
        assert.ok(typeof cat.name === "string");
      }
    });

    it("excludes 'Others' from featured categories", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      const names = json.data.map((c) => c.name);
      assert.strictEqual(names.includes("Others"), false, "'Others' must be strictly excluded from /featured");
    });

    it("GET /api/featured and GET /featured aliases return identical 8 featured categories", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const resApi = await fetch(`${baseUrl}/api/featured`);
      assert.strictEqual(resApi.status, 200);
      const jsonApi = await resApi.json();
      assert.deepStrictEqual(
        jsonApi.data.map((c) => c.name),
        EXPECTED_FEATURED_ORDER
      );

      const resRoot = await fetch(`${baseUrl}/featured`);
      assert.strictEqual(resRoot.status, 200);
      const jsonRoot = await resRoot.json();
      assert.deepStrictEqual(
        jsonRoot.data.map((c) => c.name),
        EXPECTED_FEATURED_ORDER
      );
    });

    it("does not depend on MongoDB natural or insertion order", async () => {
      const reversedCategories = [...INITIAL_CATEGORIES].reverse();
      const mockCategories = createMockCollection(reversedCategories);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      const names = json.data.map((c) => c.name);
      assert.deepStrictEqual(names, EXPECTED_FEATURED_ORDER);
    });

    it("excludes inactive categories and preserves relative predefined order", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);

      // Deactivate Audio and Fashion
      const audio = mockCategories._docs.find((c) => c.name === "Audio");
      audio.isActive = false;
      const fashion = mockCategories._docs.find((c) => c.name === "Fashion");
      fashion.isActive = false;

      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.data.length, 6);
      assert.ok(!json.data.some((c) => c.name === "Audio" || c.name === "Fashion"));

      const expectedFiltered = [
        "Electronics",
        "Wearables",
        "Accessories",
        "Furniture",
        "Vehicles",
        "Mobile Phones",
      ];
      assert.deepStrictEqual(
        json.data.map((c) => c.name),
        expectedFiltered
      );
    });

    it("excludes unknown categories from featured response", async () => {
      const mockData = [
        ...INITIAL_CATEGORIES,
        {
          _id: "cat_gaming",
          name: "Gaming Consoles",
          description: "Consoles and games",
          isActive: true,
        },
        {
          _id: "cat_books",
          name: "Books",
          description: "Reading materials",
          isActive: true,
        },
      ];

      const mockCategories = createMockCollection(mockData);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.data.length, 8);
      const names = json.data.map((c) => c.name);
      assert.deepStrictEqual(names, EXPECTED_FEATURED_ORDER);
      assert.strictEqual(names.includes("Gaming Consoles"), false);
      assert.strictEqual(names.includes("Books"), false);
    });

    it("returns available matching categories without crashing if fewer than 8 exist", async () => {
      const partialData = [
        {
          _id: "cat_elec",
          name: "Electronics",
          description: "Electronics description",
          isActive: true,
        },
        {
          _id: "cat_audio",
          name: "Audio",
          description: "Audio description",
          isActive: true,
        },
        {
          _id: "cat_fash",
          name: "Fashion",
          description: "Fashion description",
          isActive: true,
        },
      ];

      const mockCategories = createMockCollection(partialData);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.length, 3);
      assert.deepStrictEqual(
        json.data.map((c) => c.name),
        ["Electronics", "Audio", "Fashion"]
      );
    });

    it("returns empty data array if no active featured categories exist", async () => {
      const mockCategories = createMockCollection([]);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.deepStrictEqual(json.data, []);
    });

    it("fetches dynamic data from MongoDB and preserves existing IDs and custom descriptions", async () => {
      const customDocs = [
        {
          _id: "custom_id_electronics_999",
          name: "Electronics",
          description: "Authoritative dynamic custom electronics text from DB",
          isActive: true,
        },
      ];

      const mockCategories = createMockCollection(customDocs);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.data.length, 1);
      assert.strictEqual(json.data[0]._id, "custom_id_electronics_999");
      assert.strictEqual(
        json.data[0].description,
        "Authoritative dynamic custom electronics text from DB"
      );
      assert.strictEqual(json.data[0].isActive, true);
    });

    it("does not expose unnecessary internal MongoDB fields", async () => {
      const mockCategories = createMockCollection([
        {
          _id: "cat_elec_id",
          name: "Electronics",
          description: "Laptops and tech gear",
          isActive: true,
          __v: 0,
          internalClusterId: "node-xyz-secret",
          mongoInternalState: { version: 1 },
        },
      ]);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.data.length, 1);
      const keys = Object.keys(json.data[0]);
      assert.deepStrictEqual(keys.sort(), ["_id", "description", "isActive", "name"].sort());
      assert.strictEqual(json.data[0].__v, undefined);
      assert.strictEqual(json.data[0].internalClusterId, undefined);
    });

    it("ensures existing /categories endpoint remains unchanged and continues to return all 9 categories", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const catRes = await fetch(`${baseUrl}/api/v1/categories`);
      assert.strictEqual(catRes.status, 200);
      const catJson = await catRes.json();
      assert.strictEqual(catJson.data.length, 9, "Standard categories API must return 9 categories");
      assert.strictEqual(catJson.data[8].name, "Others", "Standard categories API must include 'Others' at the end");

      const featRes = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(featRes.status, 200);
      const featJson = await featRes.json();
      assert.strictEqual(featJson.data.length, 8, "Featured API must return exactly 8 categories");
      assert.ok(!featJson.data.some((c) => c.name === "Others"));
    });

    it("does not require authentication or authorization tokens (public access)", async () => {
      const mockCategories = createMockCollection([]);
      await seedCategories(mockCategories);
      setCollections({ categoriesCollection: mockCategories });

      const res = await fetch(`${baseUrl}/api/v1/featured`, {
        headers: {},
      });
      assert.strictEqual(res.status, 200);
    });

    it("returns 503 Service Unavailable when database is not connected", async () => {
      setCollections({ categoriesCollection: null });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 503);

      const json = await res.json();
      assert.strictEqual(json.success, false);
      assert.match(json.message, /Database not connected/);
    });

    it("returns 500 Internal Server Error when database query fails", async () => {
      const brokenCollection = {
        find() {
          throw new Error("Simulated database query fault");
        },
      };
      setCollections({ categoriesCollection: brokenCollection });

      const res = await fetch(`${baseUrl}/api/v1/featured`);
      assert.strictEqual(res.status, 500);

      const json = await res.json();
      assert.strictEqual(json.success, false);
      assert.strictEqual(json.message, "Failed to fetch featured categories");
    });
  });

  describe("5. Unit Tests: Featured Categories Filter & Sorter", () => {
    it("getFeaturedCategories handles invalid inputs safely", () => {
      const { getFeaturedCategories } = categoriesRoutes;
      assert.deepStrictEqual(getFeaturedCategories(null), []);
      assert.deepStrictEqual(getFeaturedCategories(undefined), []);
      assert.deepStrictEqual(getFeaturedCategories([]), []);
      assert.deepStrictEqual(getFeaturedCategories("not-an-array"), []);
    });

    it("getFeaturedCategories filters inactive items and respects limit", () => {
      const { getFeaturedCategories } = categoriesRoutes;
      const input = [
        { name: "Electronics", isActive: true },
        { name: "Audio", isActive: false },
        { name: "Wearables", isActive: true },
        { name: "Accessories", isActive: true },
      ];

      const result = getFeaturedCategories(input, 2);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, "Electronics");
      assert.strictEqual(result[1].name, "Wearables");
    });

    it("getFeaturedCategories excludes 'Others' and unknown categories", () => {
      const { getFeaturedCategories } = categoriesRoutes;
      const input = [
        { name: "Others", isActive: true },
        { name: "Unknown Category", isActive: true },
        { name: "Mobile Phones", isActive: true },
        { name: "Electronics", isActive: true },
      ];

      const result = getFeaturedCategories(input, 8);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].name, "Electronics");
      assert.strictEqual(result[1].name, "Mobile Phones");
    });
  });
});
