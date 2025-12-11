import { config } from "../config";
import { log } from "../log";
import { AsyncObjectStorage } from "./AsyncObjectStorage";
import { CachedItem, CacheItem } from "./CacheItem";
import { CacheProvider } from "./CacheProvider";
import { CacheStats } from "./CacheStats";

const SHORT_EXPIRATION_MS = 1 * 24 * 60 * 60 * 1000;
const LONG_EXPIRATION_MS = 90 * 24 * 60 * 60 * 1000;

export class Cache implements CacheProvider {
  protected enforcingQuota = false;

  constructor(private readonly storage: AsyncObjectStorage) {}

  async find<T>(id: string): Promise<CacheItem<T> | null> {
    const result: CacheItem<T> | null = await this.storage.getItem(
      this.getKey(id),
    );

    if (!result) {
      return null;
    }

    if (new Date() >= new Date(result.expirationDateUtc)) {
      this.storage.removeItem(this.getKey(id));
      return null;
    }

    const copy = structuredClone(result);
    copy.lastAccessedDateUtc = new Date().toISOString();
    await this.storage.setItem(this.getKey(id), copy);
    return structuredClone(copy);
  }

  async store<T>(id: string, data: T): Promise<void> {
    let expirationDateUtc: string;

    if (data == null) {
      expirationDateUtc = this.getExpirationDateUtc(SHORT_EXPIRATION_MS);
    } else {
      expirationDateUtc = this.getExpirationDateUtc(LONG_EXPIRATION_MS);
    }

    const cacheItem: CacheItem<T> = {
      data,
      expirationDateUtc,
      lastAccessedDateUtc: new Date().toISOString(),
    };

    try {
      await this.storage.setItem(this.getKey(id), cacheItem);
    } catch (error) {
      console.warn(log.namespace, error);
      console.warn(
        log.namespace,
        `An error occurred while storing: ${id}.`,
        "Enforcing quota and trying one more time.",
      );
      await this.enforceQuota();
      await this.storage.setItem(this.getKey(id), cacheItem);
    }
  }

  async enforceQuota() {
    if (this.enforcingQuota) {
      return;
    }

    try {
      this.enforcingQuota = true;

      const cacheStats = new CacheStats(this.storage);
      let usage = await cacheStats.getNamespaceUsageInBytes();

      if (usage <= config.cacheQuotaMaxBytes) {
        return;
      }

      await this.prune();
      usage = await cacheStats.getNamespaceUsageInBytes();
      const bytesToRecover = usage - config.cacheQuotaTargetBytes;

      if (bytesToRecover <= 0) {
        return;
      }

      const cachedItems = await this.getCachedItems();
      this.sortCachedItems(cachedItems);

      let bytesRecovered = 0;
      for (const cachedItem of cachedItems) {
        if (bytesRecovered >= bytesToRecover) {
          break;
        }

        await this.storage.removeItem(cachedItem.key);
        console.debug(log.namespace, `Evicted: ${cachedItem.key} from cache.`);
        bytesRecovered += CacheStats.getCachedItemSizeInBytes(cachedItem);
      }
    } finally {
      this.enforcingQuota = false;
    }
  }

  async prune(): Promise<void> {
    const toBePruned: string[] = [];
    const cachedItems = await this.getCachedItems();
    for (const cachedItem of cachedItems) {
      if (new Date() >= new Date(cachedItem.expirationDateUtc)) {
        toBePruned.push(cachedItem.key);
      }
    }

    const promises = toBePruned.map(async (key) => {
      await this.storage.removeItem(key);
      console.debug(log.namespace, `Pruned: ${key} from cache.`);
    });

    await Promise.allSettled(promises);
  }

  async clear(): Promise<void> {
    const cachedItems = await this.getCachedItems();
    for (const cachedItem of cachedItems) {
      await this.storage.removeItem(cachedItem.key);
      console.debug(log.namespace, `Cleared: ${cachedItem.key} from cache.`);
    }
  }

  private getExpirationDateUtc(offsetInMs: number): string {
    return new Date(Date.now() + offsetInMs).toISOString();
  }

  private getKey(id: string): string {
    return `${config.namespace}${id}`;
  }

  private async getCachedItems() {
    const namespaceKeys = (await this.storage.keys()).filter((key) =>
      key.startsWith(config.namespace),
    );

    const cachedItems: CachedItem<unknown>[] = [];
    for (const key of namespaceKeys) {
      const cachedItem = await this.storage.getItem<CacheItem<unknown>>(key);
      if (cachedItem) {
        cachedItems.push({ ...cachedItem, key });
      }
    }

    return cachedItems;
  }

  private sortCachedItems(cachedItems: CachedItem<unknown>[]) {
    cachedItems.sort((a, b) => {
      return (
        new Date(a.lastAccessedDateUtc).getTime() -
        new Date(b.lastAccessedDateUtc).getTime()
      );
    });
  }
}
