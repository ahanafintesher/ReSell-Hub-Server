const { test, it, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { createIndexes, setCollections, getCollections } = require("../src/config/db");
const {
  migratePaymentIndex,
  checkDuplicatePaymentIds,
} = require("../scripts/migrate-payment-index");

describe("MongoDB Index Initialization & Failure Handling Test Suite", () => {
  let originalCollections;

  beforeEach(() => {
    originalCollections = { ...getCollections() };
  });

  afterEach(() => {
    setCollections(originalCollections);
  });

  describe("1. Required Unique Constraint Enforcement on Startup", () => {
    it("fails fast with fatal error when orders.paymentId index creation conflicts and unique constraint is missing", async () => {
      let createdIndexName = null;
      const mockOrders = {
        async createIndex(keys, options) {
          if (keys.paymentId) {
            const conflictErr = new Error(
              "An existing index has the same name as the requested index. When index names are not specified, they are auto generated and can cause conflicts. Requested index: { unique: true, key: { paymentId: 1 }, name: \"paymentId_1\", sparse: true }, existing index: { key: { paymentId: 1 }, name: \"paymentId_1\" }"
            );
            conflictErr.code = 85;
            throw conflictErr;
          }
          createdIndexName = options?.name || "mock_idx";
          return createdIndexName;
        },
        async indexes() {
          // Returns existing non-unique index
          return [
            { name: "_id_", key: { _id: 1 } },
            { name: "paymentId_1", key: { paymentId: 1 } }, // missing unique: true
          ];
        },
      };

      setCollections({
        productsCollection: null,
        ordersCollection: mockOrders,
        paymentsCollection: null,
        wishlistCollection: null,
        usersCollection: null,
        reportsCollection: null,
        processedEventsCollection: null,
      });

      await assert.rejects(
        async () => {
          await createIndexes();
        },
        (err) => {
          assert.match(
            err.message,
            /\[FATAL DB STARTUP\] Required unique constraint on 'orders\.paymentId' is missing or conflicting/
          );
          assert.match(err.message, /migrate:payment-index/);
          return true;
        }
      );
    });

    it("succeeds when orders.paymentId is already unique and sparse", async () => {
      let createIndexCalledWith = null;
      const mockOrders = {
        async createIndex(keys, options) {
          createIndexCalledWith = { keys, options };
          return "paymentId_1";
        },
        async indexes() {
          return [
            { name: "_id_", key: { _id: 1 } },
            {
              name: "paymentId_1",
              key: { paymentId: 1 },
              unique: true,
              sparse: true,
            },
          ];
        },
      };

      setCollections({
        productsCollection: null,
        ordersCollection: mockOrders,
        paymentsCollection: null,
        wishlistCollection: null,
        usersCollection: null,
        reportsCollection: null,
        processedEventsCollection: null,
      });

      await createIndexes();
      assert.deepStrictEqual(createIndexCalledWith.keys, { paymentId: 1 });
      assert.strictEqual(createIndexCalledWith.options.unique, true);
      assert.strictEqual(createIndexCalledWith.options.sparse, true);
    });
  });

  describe("2. Optional Performance Index Fault Tolerance", () => {
    it("logs a notice but does not abort startup when an optional product index creation fails", async () => {
      const mockProducts = {
        async createIndex(keys) {
          if (keys.price) {
            throw new Error("Privilege restricted for price index");
          }
          return "ok";
        },
      };

      const mockOrders = {
        async createIndex() {
          return "paymentId_1";
        },
        async indexes() {
          return [
            {
              name: "paymentId_1",
              key: { paymentId: 1 },
              unique: true,
              sparse: true,
            },
          ];
        },
      };

      setCollections({
        productsCollection: mockProducts,
        ordersCollection: mockOrders,
        paymentsCollection: null,
        wishlistCollection: null,
        usersCollection: null,
        reportsCollection: null,
        processedEventsCollection: null,
      });

      // Should not throw despite products.price index failing
      await createIndexes();
    });
  });

  describe("3. Safe Explicit Migration Script Functionality", () => {
    it("aborts migration without changes when duplicate non-null paymentId values exist", async () => {
      let droppedIndex = null;
      let createdIndex = null;

      const mockDb = {
        collection(name) {
          assert.strictEqual(name, "orders");
          return {
            aggregate(pipeline) {
              return {
                toArray: async () => [
                  {
                    _id: "cs_duplicate_test_123",
                    count: 2,
                    docIds: ["doc1", "doc2"],
                  },
                ],
              };
            },
            async indexes() {
              return [{ name: "paymentId_1", key: { paymentId: 1 } }];
            },
            async dropIndex(name) {
              droppedIndex = name;
            },
            async createIndex(key, opts) {
              createdIndex = { key, opts };
              return "paymentId_1";
            },
          };
        },
      };

      const result = await migratePaymentIndex({ db: mockDb });
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.duplicateCount, 1);
      assert.strictEqual(droppedIndex, null, "Should NOT drop any index if duplicates exist");
      assert.strictEqual(createdIndex, null, "Should NOT create any index if duplicates exist");
    });

    it("respects --dry-run mode without modifying indexes or dropping data", async () => {
      let droppedIndex = null;
      let createdIndex = null;

      const mockDb = {
        collection() {
          return {
            aggregate() {
              return { toArray: async () => [] };
            },
            async indexes() {
              return [{ name: "paymentId_1", key: { paymentId: 1 } }];
            },
            async dropIndex(name) {
              droppedIndex = name;
            },
            async createIndex(key, opts) {
              createdIndex = { key, opts };
              return "paymentId_1";
            },
          };
        },
      };

      const result = await migratePaymentIndex({ db: mockDb, dryRun: true });
      assert.strictEqual(result.success, true);
      assert.strictEqual(droppedIndex, null, "Dry run must not drop index");
      assert.strictEqual(createdIndex, null, "Dry run must not create index");
    });

    it("safely migrates non-unique index to unique sparse index when no duplicates exist", async () => {
      let droppedIndex = null;
      let createdIndex = null;
      let indexState = [{ name: "paymentId_1", key: { paymentId: 1 } }];

      const mockDb = {
        collection() {
          return {
            aggregate() {
              return { toArray: async () => [] };
            },
            async indexes() {
              return indexState;
            },
            async dropIndex(name) {
              droppedIndex = name;
              indexState = indexState.filter((i) => i.name !== name);
            },
            async createIndex(key, opts) {
              createdIndex = { key, opts };
              indexState.push({ name: opts.name, key, ...opts });
              return opts.name;
            },
          };
        },
      };

      const result = await migratePaymentIndex({ db: mockDb });
      assert.strictEqual(result.success, true);
      assert.strictEqual(droppedIndex, "paymentId_1");
      assert.deepStrictEqual(createdIndex.key, { paymentId: 1 });
      assert.strictEqual(createdIndex.opts.unique, true);
      assert.strictEqual(createdIndex.opts.sparse, true);
    });

    it("is idempotent when index is already unique and sparse", async () => {
      let droppedIndex = null;
      let createdIndex = null;

      const mockDb = {
        collection() {
          return {
            aggregate() {
              return { toArray: async () => [] };
            },
            async indexes() {
              return [
                {
                  name: "paymentId_1",
                  key: { paymentId: 1 },
                  unique: true,
                  sparse: true,
                },
              ];
            },
            async dropIndex(name) {
              droppedIndex = name;
            },
            async createIndex(key, opts) {
              createdIndex = { key, opts };
              return opts.name;
            },
          };
        },
      };

      const result = await migratePaymentIndex({ db: mockDb });
      assert.strictEqual(result.success, true);
      assert.match(result.message, /already configured/);
      assert.strictEqual(droppedIndex, null);
      assert.strictEqual(createdIndex, null);
    });
  });
});
