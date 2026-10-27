import { CLARITY_SNAPSHOT_RETENTION_DAYS, dimensionsKey, type ClaritySnapshot, type ClaritySnapshotStore, type SaveClaritySnapshot } from "@serp/provider-clarity";
import type { NormalizedReportResult } from "@serp/contracts";
import type { SqlExecutor } from "./pg-repository.js";

/** Durable Clarity pull history (public.clarity_snapshots). Server-only table; every query is scoped by user. */
export class PgClaritySnapshotStore implements ClaritySnapshotStore {
  constructor(private readonly db: SqlExecutor) {}

  async save(input: SaveClaritySnapshot): Promise<void> {
    await this.db.query(
      `insert into public.clarity_snapshots (user_id, connection_id, project_key, num_of_days, dimensions, dimensions_key, pulled_at, row_count, payload)
       values ($1::uuid, $2::uuid, $3, $4, $5::text[], $6, $7::timestamptz, $8, $9::jsonb)`,
      [input.userId, input.connectionId, input.projectKey, input.numOfDays, [...input.dimensions], dimensionsKey(input.dimensions), input.result.fetchedAt, input.result.rowCountReturned, JSON.stringify(input.result)],
    );
    await this.db.query("delete from public.clarity_snapshots where user_id = $1::uuid and project_key = $2 and pulled_at < now() - make_interval(days => $3)", [
      input.userId,
      input.projectKey,
      CLARITY_SNAPSHOT_RETENTION_DAYS,
    ]);
  }

  async list(userId: string, projectKey: string, opts: { dimensions?: readonly string[]; limit: number }): Promise<ClaritySnapshot[]> {
    const rows = await this.db.query<{ id: string; num_of_days: number; dimensions: string[]; pulled_at: string | Date; payload: NormalizedReportResult | string }>(
      `select id, num_of_days, dimensions, pulled_at, payload from public.clarity_snapshots
       where user_id = $1::uuid and project_key = $2 and ($3::text is null or dimensions_key = $3)
       order by pulled_at desc limit $4`,
      [userId, projectKey, opts.dimensions ? dimensionsKey(opts.dimensions) : null, opts.limit],
    );
    return rows.map((r) => ({
      id: r.id,
      projectKey,
      numOfDays: r.num_of_days as 1 | 2 | 3,
      dimensions: r.dimensions,
      pulledAt: new Date(r.pulled_at).toISOString(),
      result: typeof r.payload === "string" ? (JSON.parse(r.payload) as NormalizedReportResult) : r.payload,
    }));
  }
}
