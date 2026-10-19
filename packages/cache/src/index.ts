/**
 * Report cache. Every entry is addressed by an explicit scope (user, provider, connection, property) plus a hash of
 * the canonical request (which covers dates, dimensions, metrics, filters, ordering, paging and time zone).
 * There is deliberately no way to read by hash alone, so one customer's request can never resolve to another's entry.
 */

export interface CacheScope {
  userId: string;
  provider: string;
  connectionId: string;
  /** The internal property id (a row id), not the provider-native one. */
  propertyId: string;
}

export interface CacheMeta {
  startDate?: string;
  endDate?: string;
  rowCount?: number;
}

export interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
  expiresAt: number;
}

export interface CacheGetOptions {
  /** Also return an expired entry, if it expired no more than `maxStaleSeconds` ago. */
  allowStale?: boolean;
  maxStaleSeconds?: number;
}

export interface ReportCache {
  get<T>(scope: CacheScope, queryHash: string, options?: CacheGetOptions): Promise<CacheEntry<T> | null>;
  set<T>(scope: CacheScope, queryHash: string, value: T, ttlSeconds: number, meta?: CacheMeta): Promise<void>;
  /** Drops entries for a user, optionally narrowed to a connection or property (e.g. on disconnect). */
  invalidate(filter: { userId: string; connectionId?: string; propertyId?: string }): Promise<number>;
}

const SAFE_PART = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_HASH = /^[a-f0-9]{16,128}$/;

/** Rejects anything that could make two different scopes collapse into one key (separators, empty parts). */
export function assertValidScope(scope: CacheScope, queryHash: string): void {
  for (const [name, part] of Object.entries(scope)) {
    if (!SAFE_PART.test(part)) throw new Error(`Invalid cache scope part: ${name}`);
  }
  if (!SAFE_HASH.test(queryHash)) throw new Error("Invalid cache query hash");
}

export const cacheKey = (scope: CacheScope, queryHash: string): string =>
  [scope.userId, scope.provider, scope.connectionId, scope.propertyId, queryHash].join(":");

interface Stored {
  scope: CacheScope;
  queryHash: string;
  value: unknown;
  fetchedAt: number;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  maxEntries?: number;
  /** One tenant filling its quota evicts its own oldest entries, never another tenant's. */
  maxEntriesPerUser?: number;
  now?: () => number;
}

/** In-process cache for development and tests. `PgReportCache` (in @serp/db) is the durable, shared implementation. */
export class MemoryReportCache implements ReportCache {
  private readonly store = new Map<string, Stored>();
  private readonly maxEntries: number;
  private readonly maxPerUser: number;
  private readonly now: () => number;

  constructor(options: MemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 2000;
    this.maxPerUser = options.maxEntriesPerUser ?? 300;
    this.now = options.now ?? Date.now;
  }

  async get<T>(scope: CacheScope, queryHash: string, options: CacheGetOptions = {}): Promise<CacheEntry<T> | null> {
    assertValidScope(scope, queryHash);
    const entry = this.store.get(cacheKey(scope, queryHash));
    if (!entry) return null;
    // Defense in depth: the stored scope must equal the requested one, whatever the key says.
    if (entry.scope.userId !== scope.userId || entry.scope.provider !== scope.provider || entry.scope.connectionId !== scope.connectionId || entry.scope.propertyId !== scope.propertyId || entry.queryHash !== queryHash) {
      return null;
    }
    const now = this.now();
    if (entry.expiresAt <= now) {
      const staleOk = options.allowStale && now - entry.expiresAt <= (options.maxStaleSeconds ?? Infinity) * 1000;
      if (!staleOk) return null;
    }
    return { value: entry.value as T, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt };
  }

  async set<T>(scope: CacheScope, queryHash: string, value: T, ttlSeconds: number, _meta?: CacheMeta): Promise<void> {
    assertValidScope(scope, queryHash);
    const key = cacheKey(scope, queryHash);
    this.store.delete(key); // re-insert so it counts as newest
    this.evictFor(scope.userId);
    const fetchedAt = this.now();
    this.store.set(key, { scope, queryHash, value, fetchedAt, expiresAt: fetchedAt + ttlSeconds * 1000 });
  }

  private evictFor(userId: string): void {
    let mine = 0;
    let oldestMine: string | undefined;
    for (const [k, v] of this.store) {
      if (v.scope.userId === userId) {
        mine++;
        oldestMine ??= k;
      }
    }
    if (mine >= this.maxPerUser && oldestMine) this.store.delete(oldestMine);
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  async invalidate(filter: { userId: string; connectionId?: string; propertyId?: string }): Promise<number> {
    let removed = 0;
    for (const [k, v] of this.store) {
      if (v.scope.userId !== filter.userId) continue;
      if (filter.connectionId && v.scope.connectionId !== filter.connectionId) continue;
      if (filter.propertyId && v.scope.propertyId !== filter.propertyId) continue;
      this.store.delete(k);
      removed++;
    }
    return removed;
  }

  get size(): number {
    return this.store.size;
  }
}
