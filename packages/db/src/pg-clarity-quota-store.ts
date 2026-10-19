import {
  CLARITY_DAILY_REQUEST_LIMIT,
  quotaWindow,
  type ClarityQuotaStore,
  type QuotaStatus,
  type ReservationOutcome,
  type ReserveResult,
} from "@serp/provider-clarity";
import type { SqlExecutor } from "./pg-repository.js";

const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Durable Clarity request budget in Postgres. `reserve` is one statement (private.reserve_provider_request), so two
 * instances can never reserve past the limit. The project key is a keyed fingerprint of the token, never the token.
 * Server-only tables: there are no grants for browser roles.
 */
export class PgClarityQuotaStore implements ClarityQuotaStore {
  constructor(
    private readonly db: SqlExecutor,
    private readonly localBudget: number = Math.min(8, CLARITY_DAILY_REQUEST_LIMIT),
  ) {}

  async reserve(input: { projectKey: string; userId: string; connectionId: string | null; now?: Date }): Promise<ReserveResult> {
    const day = dayOf(input.now ?? new Date());
    const rows = await this.db.query<{ reservation_id: string; used: number }>(
      "select reservation_id, used from private.reserve_provider_request('clarity', $1, $2::date, $3, $4::uuid, $5::uuid)",
      [input.projectKey, day, this.localBudget, input.userId, input.connectionId],
    );
    const row = rows[0];
    if (row) return { allowed: true, reservationId: row.reservation_id, appTrackedUsed: row.used, localBudget: this.localBudget };
    const used = await this.db.query<{ request_count: number }>(
      "select request_count from public.provider_request_budgets where provider = 'clarity' and project_key = $1 and period_start = $2::date",
      [input.projectKey, day],
    );
    return { allowed: false, appTrackedUsed: used[0]?.request_count ?? this.localBudget, localBudget: this.localBudget };
  }

  async complete(reservationId: string, outcome: ReservationOutcome, httpStatus: number | null, now: Date = new Date()): Promise<void> {
    const rows = await this.db.query<{ project_key: string; period_start: string | Date }>(
      `update public.provider_request_reservations
          set status = $2, http_status = $3, completed_at = $4
        where id = $1::uuid
        returning project_key, period_start`,
      [reservationId, outcome, httpStatus, now.toISOString()],
    );
    const row = rows[0];
    if (row && outcome === "provider_limited") {
      const day = typeof row.period_start === "string" ? row.period_start.slice(0, 10) : dayOf(row.period_start);
      await this.db.query("select private.exhaust_provider_budget('clarity', $1, $2::date, $3)", [row.project_key, day, this.localBudget]);
    }
  }

  async status(projectKey: string, now: Date = new Date()): Promise<QuotaStatus> {
    const day = dayOf(now);
    const [budget, counts, last] = await Promise.all([
      this.db.query<{ request_count: number }>(
        "select request_count from public.provider_request_budgets where provider = 'clarity' and project_key = $1 and period_start = $2::date",
        [projectKey, day],
      ),
      this.db.query<{ status: string; n: string | number }>(
        `select status, count(*) as n from public.provider_request_reservations
          where provider = 'clarity' and project_key = $1 and period_start = $2::date group by status`,
        [projectKey, day],
      ),
      this.db.query<{ at: Date | string | null }>(
        `select max(completed_at) as at from public.provider_request_reservations
          where provider = 'clarity' and project_key = $1 and status = 'succeeded'`,
        [projectKey],
      ),
    ]);
    const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
    const used = budget[0]?.request_count ?? 0;
    const at = last[0]?.at;
    return {
      appTrackedUsed: used,
      localBudget: this.localBudget,
      localRemaining: Math.max(0, this.localBudget - used),
      providerDailyLimit: CLARITY_DAILY_REQUEST_LIMIT,
      window: quotaWindow(now),
      lastSuccessAt: at ? new Date(at).toISOString() : null,
      providerLimitReported: n("provider_limited") > 0,
      counts: { reserved: n("reserved"), succeeded: n("succeeded"), failed: n("failed"), providerLimited: n("provider_limited") },
    };
  }
}
