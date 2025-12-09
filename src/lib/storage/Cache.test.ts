import { config } from "../config";
import { Cache } from "./Cache";
import {
  CacheTestManager,
  MockAsyncObjectStorage,
  TestCacheItem,
} from "./Cache.test-data";
import { CacheStats } from "./CacheStats";

describe(Cache.name, () => {
  let cache: Cache;
  let storage: MockAsyncObjectStorage;
  let t: CacheTestManager;

  const getKey = (id: string) => `${config.namespace}${id}`;

  beforeEach(() => {
    config.appId = "test-app";
    storage = new MockAsyncObjectStorage();
    cache = new Cache(storage);
    t = new CacheTestManager(storage, config);
  });

  describe(Cache.prototype.find.name, () => {
    it("stores and retrieves a complex object", async () => {
      const id = "complex-object-id";
      const data = {
        a: 1,
        b: "hello",
        c: {
          d: true,
          e: [1, 2, 3],
        },
      };
      await cache.store(id, data);
      const result = await cache.find(id);
      expect(result?.data).toEqual(data);
    });

    it("returns null if item is not in cache", async () => {
      const result = await cache.find("non-existent-id");
      expect(result).toBeNull();
    });

    it("returns null if item is expired", async () => {
      const id = "expired-id";
      await t.givenExpiredItem(id, "");

      const result = await cache.find(id);
      expect(result).toBeNull();
    });

    it("removes the item if it is expired", async () => {
      const id = "expired-id";
      await t.givenExpiredItem(id, "");

      expect(await storage.getItem(getKey(id))).not.toBeNull();

      const result = await cache.find(id);
      expect(result).toBeNull();
      expect(await storage.getItem(getKey(id))).toBeNull();
    });

    it("returns the item if it is not expired", async () => {
      const id = "valid-id";
      await t.givenValidItem(id, "some-data");

      const result = await cache.find(id);
      expect(result?.data).toEqual("some-data");
    });

    it("updates the last accessed date", async () => {
      const id = "valid-id";
      const lastAccessedDate = new Date(Date.now() - 50000);

      await t.givenValidItem(id, "", lastAccessedDate);
      const result = await cache.find(id);
      const updatedItem = await storage.getItem<TestCacheItem>(getKey(id));

      expect(
        new Date(updatedItem?.lastAccessedDateUtc ?? "").getTime(),
      ).toBeGreaterThan(lastAccessedDate.getTime());

      expect(result).toEqual(updatedItem);
    });

    it("returns a copy", async () => {
      const id = "valid-id";
      await t.givenValidItem(id, "original");

      const result1 = await cache.find(id);
      result1!.data = "updated";

      const result2 = await cache.find(id);
      expect(result2?.data).toEqual("original");
      expect(result2).not.toBe(result1);
    });
  });

  describe(Cache.prototype.store.name, () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    });

    it("stores item with long expiration for non-null data", async () => {
      const id = "some-id";
      const data = { value: "some-data" };
      await cache.store(id, data);

      const storedItem = await storage.getItem<TestCacheItem>(getKey(id));

      expect(storedItem).toBeDefined();
      expect(storedItem?.data).toEqual(data);
      expect(storedItem?.expirationDateUtc).toEqual(
        // 90 days
        new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    it("stores item with short expiration for null data", async () => {
      const id = "some-id-null";
      const data = null;
      await cache.store(id, data);

      const storedItem = await storage.getItem<TestCacheItem>(getKey(id));

      expect(storedItem).toBeDefined();
      expect(storedItem?.data).toBeNull();
      expect(storedItem?.expirationDateUtc).toEqual(
        // 1 day
        new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(),
      );
    });

    it("sets an initial last accessed date", async () => {
      const id = "some-id";
      const data = { value: "some-data" };
      await cache.store(id, data);

      const storedItem = await storage.getItem<TestCacheItem>(getKey(id));

      expect(storedItem).toBeDefined();
      expect(storedItem?.lastAccessedDateUtc).toEqual(new Date().toISOString());
    });

    it("enforces quota and retries when error is thrown", async () => {
      jest.spyOn(console, "warn").mockImplementation();
      const setItem = jest.spyOn(storage, "setItem");
      setItem.mockRejectedValueOnce(new DOMException("", "QuotaExceededError"));

      const enforceQuotaSpy = jest.spyOn(cache, "enforceQuota");

      const id = "some-id";
      const data = { value: "some-data" };
      await cache.store(id, data);

      expect(enforceQuotaSpy).toHaveBeenCalledTimes(1);
      expect(cache.find(id)).toBeDefined();
    });

    it("bubbles up the error after enforcing quota and retry fails", async () => {
      jest.spyOn(console, "warn").mockImplementation();
      const setItem = jest.spyOn(storage, "setItem");
      setItem.mockRejectedValue(new DOMException("", "QuotaExceededError"));

      const id = "some-id";
      const data = { value: "some-data" };
      await expect(cache.store(id, data)).rejects.toThrow(DOMException);
    });
  });

  describe(Cache.prototype.prune.name, () => {
    it("removes all expired items and keeps valid ones", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      const validId1 = "valid-id-1";
      const validId2 = "valid-id-2";

      await t.givenExpiredItem("expired-id-1", "expired-data-1");
      await t.givenExpiredItem("expired-id-2", "expired-data-2");
      const validItem1 = await t.givenValidItem(validId1, "valid-data-1");
      const validItem2 = await t.givenValidItem(validId2, "valid-data-2");

      await cache.prune();

      expect(await storage.keys()).toEqual([
        getKey(validId1),
        getKey(validId2),
      ]);

      expect(await storage.getItem(getKey(validId1))).toEqual(validItem1);
      expect(await storage.getItem(getKey(validId2))).toEqual(validItem2);
    });

    it("does nothing if there are no expired items", async () => {
      const validId1 = "valid-id-1";
      const validId2 = "valid-id-2";

      const validItem1 = await t.givenValidItem(validId1, "valid-data-1");
      const validItem2 = await t.givenValidItem(validId2, "valid-data-2");

      await cache.prune();

      expect(await storage.keys()).toEqual([
        getKey(validId1),
        getKey(validId2),
      ]);

      expect(await storage.getItem(getKey(validId1))).toEqual(validItem1);
      expect(await storage.getItem(getKey(validId2))).toEqual(validItem2);
    });

    it("removes all items if all are expired", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      await t.givenExpiredItem("expired-id-1", "expired-data-1");
      await t.givenExpiredItem("expired-id-2", "expired-data-2");

      await cache.prune();

      expect(await storage.keys()).toEqual([]);
    });

    it("does nothing if cache is empty", async () => {
      await cache.prune();
      expect(await storage.keys()).toEqual([]);
    });

    it("does not remove items that are not valid CacheItem objects", async () => {
      const malformedId = "malformed-id";
      const malformedItem = { some: "data" }; // Not a CacheItem

      await storage.setItem(malformedId, malformedItem);

      await cache.prune();

      expect(await storage.keys()).toEqual([malformedId]);
      expect(await storage.getItem(malformedId)).toEqual(malformedItem);
    });
  });

  describe(Cache.prototype.clear.name, () => {
    it("removes all cached items", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      await t.givenValidItem("valid-id-1", "valid-data-1");
      await t.givenExpiredItem("expired-id-1", "expired-data-1");
      await t.givenValidItem("valid-id-2", "valid-data-2");
      await t.givenExpiredItem("expired-id-2", "expired-data-2");
      await t.givenValidItem("valid-id-3", "valid-data-3");

      await cache.clear();

      expect(await storage.keys()).toEqual([]);
    });
  });

  describe("isolation", () => {
    it("finds and stores by namespace", async () => {
      const id = "some-id";
      const data1 = { value: "some-data-1" };
      const data2 = { value: "some-data-2" };

      config.appId = "app1";
      await cache.store(id, data1);

      config.appId = "app2";
      await cache.store(id, data2);

      config.appId = "app1";
      const result1 = await cache.find(id);
      expect(result1?.data).toEqual(data1);

      config.appId = "app2";
      const result2 = await cache.find(id);
      expect(result2?.data).toEqual(data2);
    });

    it("prunes by namespace", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      config.appId = "app1";
      const exItemApp1 = await t.givenExpiredItem("expired-app1", "");

      config.appId = "app2";
      await t.givenExpiredItem("expired-app2", "");
      const validItemApp2 = await t.givenValidItem("valid-app2", "");

      // appId = "app2"
      await cache.prune();

      expect(await storage.getItem("app1:expired-app1")).toEqual(exItemApp1);
      expect(await storage.getItem("app2:expired-app2")).toBeNull();
      expect(await storage.getItem("app2:valid-app2")).toEqual(validItemApp2);

      config.appId = "app1";
      await cache.prune();

      expect(await storage.getItem("app1:expired-app1")).toBeNull();
      expect(await storage.getItem("app2:valid-app2")).toEqual(validItemApp2);
    });
  });

  describe(Cache.prototype.enforceQuota.name, () => {
    const id1 = "valid-recent-1";
    const id2 = "valid-old-2";
    const id3 = "valid-recent-3";
    const id4 = "expired-recent-4";
    const id5 = "expired-old-5";
    const id6 = "valid-recent-6";
    const id7 = "valid-old-7";
    const id8 = "valid-recent-8";
    const additionalItemId = "additional-item";

    let validRecent1: TestCacheItem;
    let validOld2: TestCacheItem;
    let validRecent3: TestCacheItem;
    let _expiredRecent4: TestCacheItem;
    let _expiredOld5: TestCacheItem;
    let validRecent6: TestCacheItem;
    let validOld7: TestCacheItem;
    let validRecent8: TestCacheItem;
    let _additionalItem: TestCacheItem;

    beforeEach(async () => {
      config.cacheQuotaMaxBytes = 5000;
      config.cacheQuotaTargetBytes = 3000;

      validRecent1 = await t.givenValidItem(
        id1,
        "data-1",
        new Date(Date.now()),
      );

      validOld2 = await t.givenValidItem(
        id2,
        "data-2",
        new Date(Date.now() - 100000),
      );

      validRecent3 = await t.givenValidItem(
        id3,
        "data-3",
        new Date(Date.now() - 50000),
      );

      _expiredRecent4 = await t.givenExpiredItem(
        id4,
        "data-4",
        new Date(Date.now()),
      );

      _expiredOld5 = await t.givenExpiredItem(
        id5,
        "data-5",
        new Date(Date.now() - 80000),
      );

      validRecent6 = await t.givenValidItem(
        id6,
        "data-6",
        new Date(Date.now() - 2000),
      );

      validOld7 = await t.givenValidItem(
        id7,
        "data-7",
        new Date(Date.now() - 75000),
      );

      validRecent8 = await t.givenValidItem(
        id8,
        "data-8",
        new Date(Date.now()),
      );

      _additionalItem = await t.givenValidItem(
        additionalItemId,
        "additional-data",
        new Date(Date.now()),
      );
    });

    it("prunes to recover storage space", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      // sum(id1, id8) = 1083 bytes
      config.cacheQuotaMaxBytes = 1083;

      // (1083 + "additional-item") - (id4 + id5) = 956 bytes
      config.cacheQuotaTargetBytes = 956;

      await cache.enforceQuota();

      expect(await storage.keys()).toHaveLength(7);

      expect((await cache.find(additionalItemId))?.data).toEqual(
        "additional-data",
      );

      expect((await cache.find(id1))?.data).toEqual(validRecent1.data);
      expect((await cache.find(id2))?.data).toEqual(validOld2.data);
      expect((await cache.find(id3))?.data).toEqual(validRecent3.data);
      expect((await cache.find(id6))?.data).toEqual(validRecent6.data);
      expect((await cache.find(id7))?.data).toEqual(validOld7.data);
      expect((await cache.find(id8))?.data).toEqual(validRecent8.data);

      expect(await storage.getItem(getKey(id4))).toBeNull(); // expired
      expect(await storage.getItem(getKey(id5))).toBeNull(); // expired

      const cacheStats = new CacheStats(storage);
      expect(await cacheStats.getNamespaceUsageInBytes()).toBeLessThanOrEqual(
        config.cacheQuotaTargetBytes,
      );
    });
    it("prunes then removes least accessed items", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      // sum(id1, id8) = 1083 bytes
      config.cacheQuotaMaxBytes = 1083;

      // (1083 + "additional-item") - (id2 + id4 + id5 + id7) = 690 bytes
      config.cacheQuotaTargetBytes = 690;

      await cache.enforceQuota();

      expect(await storage.keys()).toHaveLength(5);

      expect((await cache.find(additionalItemId))?.data).toEqual(
        "additional-data",
      );

      expect((await cache.find(id1))?.data).toEqual(validRecent1.data);
      expect((await cache.find(id3))?.data).toEqual(validRecent3.data);
      expect((await cache.find(id6))?.data).toEqual(validRecent6.data);
      expect((await cache.find(id8))?.data).toEqual(validRecent8.data);

      expect(await storage.getItem(getKey(id2))).toBeNull(); // old
      expect(await storage.getItem(getKey(id4))).toBeNull(); // expired
      expect(await storage.getItem(getKey(id5))).toBeNull(); // expired
      expect(await storage.getItem(getKey(id7))).toBeNull(); // old

      const cacheStats = new CacheStats(storage);
      expect(await cacheStats.getNamespaceUsageInBytes()).toBeLessThanOrEqual(
        config.cacheQuotaTargetBytes,
      );
    });
    it("does nothing if quota is not reached", async () => {
      // sum(id1, id8) + "additional-item" = 1229 bytes
      config.cacheQuotaMaxBytes = 1229;

      // can be anything...
      config.cacheQuotaTargetBytes = 600;

      await cache.enforceQuota();

      expect(await storage.keys()).toHaveLength(9);

      expect((await cache.find(additionalItemId))?.data).toEqual(
        "additional-data",
      );

      expect(await storage.getItem(getKey(id1))).toBeDefined();
      expect(await storage.getItem(getKey(id2))).toBeDefined();
      expect(await storage.getItem(getKey(id3))).toBeDefined();
      expect(await storage.getItem(getKey(id4))).toBeDefined();
      expect(await storage.getItem(getKey(id5))).toBeDefined();
      expect(await storage.getItem(getKey(id6))).toBeDefined();
      expect(await storage.getItem(getKey(id7))).toBeDefined();
      expect(await storage.getItem(getKey(id8))).toBeDefined();
    });

    it("does nothing if its already running", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      class TestCache extends Cache {
        setEnforcingQuotaFlag(value: boolean) {
          this.enforcingQuota = value;
        }
      }

      const testCache = new TestCache(storage);
      testCache.setEnforcingQuotaFlag(true);

      config.cacheQuotaMaxBytes = 1083;
      config.cacheQuotaTargetBytes = 690;

      expect(await storage.keys()).toHaveLength(9);
      await testCache.enforceQuota();
      expect(await storage.keys()).toHaveLength(9);
      await cache.enforceQuota();
      expect(await storage.keys()).toHaveLength(5);
    });

    it("toggles an enforcing quota flag", async () => {
      jest.spyOn(console, "debug").mockImplementation();

      class TestCache extends Cache {
        getEnforcingQuotaFlag() {
          return this.enforcingQuota;
        }

        prune(): Promise<void> {
          expect(this.getEnforcingQuotaFlag()).toBeTruthy();
          return super.prune();
        }
      }

      config.cacheQuotaMaxBytes = 1083;
      config.cacheQuotaTargetBytes = 690;

      const testCache = new TestCache(storage);
      expect(testCache.getEnforcingQuotaFlag()).toBeFalsy();
      await testCache.enforceQuota();
      expect(testCache.getEnforcingQuotaFlag()).toBeFalsy();
    });
  });
});
