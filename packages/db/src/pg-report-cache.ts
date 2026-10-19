import { assertValidScope, type CacheEntry, type CacheGetOptions, type CacheMeta, type CacheScope, type ReportCache } from "@serp/cache";
import type { SqlExecutor } from "./pg-repository.js";

/** Reports larger than this are served but not stored. */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

interface Row {
  result_payload: unknown;
  fetched_at: Date | string;
  expires_at: Date | string;
}

/**
 * Durable report cache in `report_cache` (server-only: RLS enabled, no browser grants). Rows are keyed by
 * (user, provider, connection, property, query hash) and the composite foreign keys tie the connection and the
 * property to the same user, so the database itself refuses a row that mixes tenants.
 * `propertyId` in the scope is the internal property row id (uuid); the connection id is the connection row id.
 */
export class PgReportCache implements ReportCache {
  constructor(private readonly db: SqlExecutor) {}

  async get<T>(scope: CacheScope, queryHash: string, options: CacheGetOptions = {}): Promise<CacheEntry<T> | null> {
    assertValidScope(scope, queryHash);
    const staleSeconds = options.allowStale ? (options.maxStaleSeconds ?? 365 * 86_400) : 0;
    const rows = await this.db.query<Row>(
      `select result_payload, fetched_at, expires_at
         from public.report_cache
        where user_id = $1 and provider = $2 and connection_id = $3 and property_id = $4 and canonical_query_hash = $5
          and expires_at > now() - make_interval(secs => $6)`,
      [scope.userId, scope.provider, scope.connectionId, scope.propertyId, queryHash, staleSeconds],
    );
    const row = rows[0];
    if (!row) return null;
    return { value: row.result_payload as T, fetchedAt: new Date(row.fetched_at).getTime(), expiresAt: new Date(row.expires_at).getTime() };
  }

  async set<T>(scope: CacheScope, queryHash: string, value: T, ttlSeconds: number, meta: CacheMeta = {}): Promise<void> {
    assertValidScope(scope, queryHash);
    const payload = JSON.stringify(value);
    if (payload.length > MAX_PAYLOAD_BYTES) return;
    await this.db.query(
      `insert into public.report_cache
         (user_id, provider, connection_id, property_id, canonical_query_hash, query_metadata, result_payload, fetched_at, expires_at, row_count)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now(), now() + make_interval(secs => $8), $9)
       on conflict (user_id, provider, connection_id, property_id, canonical_query_hash)
       do update set query_metadata = excluded.query_metadata, result_payload = excluded.result_payload,
                     fetched_at = now(), expires_at = excluded.expires_at, row_count = excluded.row_count`,
      [
        scope.userId,
        scope.provider,
        scope.connectionId,
        scope.propertyId,
        queryHash,
        JSON.stringify({ startDate: meta.startDate ?? null, endDate: meta.endDate ?? null }),
        payload,
        ttlSeconds,
        meta.rowCount ?? null,
      ],
    );
  }

  async invalidate(filter: { userId: string; connectionId?: string; propertyId?: string }): Promise<number> {
    const rows = await this.db.query(
      `delete from public.report_cache
        where user_id = $1 and ($2::uuid is null or connection_id = $2::uuid) and ($3::uuid is null or property_id = $3::uuid)
        returning id`,
      [filter.userId, filter.connectionId ?? null, filter.propertyId ?? null],
    );
    return rows.length;
  }

  /** Housekeeping for a scheduled job: removes rows that expired more than `olderThanSeconds` ago. */
  async purgeExpired(olderThanSeconds = 86_400): Promise<number> {
    const rows = await this.db.query(`delete from public.report_cache where expires_at < now() - make_interval(secs => $1) returning id`, [olderThanSeconds]);
    return rows.length;
  }
}
