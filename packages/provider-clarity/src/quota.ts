import { CLARITY_DAILY_REQUEST_LIMIT } from "./constants.js";

export type ReservationOutcome = "succeeded" | "failed" | "provider_limited";

export interface QuotaWindow {
  /** ISO timestamp of 00:00 UTC. The provider documents "per day" but not its exact reset, so UTC midnight is our assumption. */
  start: string;
  end: string;
  basis: "utc_calendar_day (assumed)";
}

export interface QuotaStatus {
  /** Requests this application reserved in the window. Not an authoritative provider counter. */
  appTrackedUsed: number;
  /** This application's own ceiling (below the provider's limit, to leave headroom). */
  localBudget: number;
  localRemaining: number;
  providerDailyLimit: number;
  window: QuotaWindow;
  lastSuccessAt: string | null;
  /** True when Clarity answered 429 in this window: no more requests are made until the next window. */
  providerLimitReported: boolean;
  counts: { reserved: number; succeeded: number; failed: number; providerLimited: number };
}

export type ReserveResult =
  | { allowed: true; reservationId: string; appTrackedUsed: number; localBudget: number }
  | { allowed: false; appTrackedUsed: number; localBudget: number };

/**
 * Durable, concurrency-safe request budget for one Clarity project (keyed by a token fingerprint, never the token).
 * `reserve` must be atomic across processes. A reservation is never refunded: whether the provider counts a failed
 * call is not documented, so every attempted call is treated as spent.
 */
export interface ClarityQuotaStore {
  reserve(input: { projectKey: string; userId: string; connectionId: string | null; now?: Date }): Promise<ReserveResult>;
  complete(reservationId: string, outcome: ReservationOutcome, httpStatus: number | null, now?: Date): Promise<void>;
  status(projectKey: string, now?: Date): Promise<QuotaStatus>;
}

export function quotaWindow(now: Date): QuotaWindow {
  const day = now.toISOString().slice(0, 10);
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString(), basis: "utc_calendar_day (assumed)" };
}

interface Entry {
  id: string;
  projectKey: string;
  day: string;
  status: "reserved" | ReservationOutcome;
  completedAt: string | null;
}

/** In-process store for tests and mock mode. Single-threaded JS makes `reserve` atomic within one process only. */
export class MemoryClarityQuotaStore implements ClarityQuotaStore {
  private readonly counts = new Map<string, number>();
  private readonly entries: Entry[] = [];
  private seq = 0;

  constructor(private readonly localBudget: number = Math.min(8, CLARITY_DAILY_REQUEST_LIMIT)) {}

  async reserve(input: { projectKey: string; userId: string; connectionId: string | null; now?: Date }): Promise<ReserveResult> {
    const day = (input.now ?? new Date()).toISOString().slice(0, 10);
    const key = `${input.projectKey}:${day}`;
    const used = this.counts.get(key) ?? 0;
    if (used >= this.localBudget) return { allowed: false, appTrackedUsed: used, localBudget: this.localBudget };
    this.counts.set(key, used + 1);
    const id = `mem-${++this.seq}`;
    this.entries.push({ id, projectKey: input.projectKey, day, status: "reserved", completedAt: null });
    return { allowed: true, reservationId: id, appTrackedUsed: used + 1, localBudget: this.localBudget };
  }

  async complete(reservationId: string, outcome: ReservationOutcome, _httpStatus: number | null, now: Date = new Date()): Promise<void> {
    const e = this.entries.find((x) => x.id === reservationId);
    if (!e) return;
    e.status = outcome;
    e.completedAt = now.toISOString();
    if (outcome === "provider_limited") this.counts.set(`${e.projectKey}:${e.day}`, Math.max(this.counts.get(`${e.projectKey}:${e.day}`) ?? 0, this.localBudget));
  }

  async status(projectKey: string, now: Date = new Date()): Promise<QuotaStatus> {
    const day = now.toISOString().slice(0, 10);
    const used = this.counts.get(`${projectKey}:${day}`) ?? 0;
    const mine = this.entries.filter((e) => e.projectKey === projectKey && e.day === day);
    const count = (s: Entry["status"]) => mine.filter((e) => e.status === s).length;
    const lastSuccess = this.entries
      .filter((e) => e.projectKey === projectKey && e.status === "succeeded" && e.completedAt)
      .map((e) => e.completedAt!)
      .sort()
      .at(-1);
    return {
      appTrackedUsed: used,
      localBudget: this.localBudget,
      localRemaining: Math.max(0, this.localBudget - used),
      providerDailyLimit: CLARITY_DAILY_REQUEST_LIMIT,
      window: quotaWindow(now),
      lastSuccessAt: lastSuccess ?? null,
      providerLimitReported: count("provider_limited") > 0,
      counts: { reserved: count("reserved"), succeeded: count("succeeded"), failed: count("failed"), providerLimited: count("provider_limited") },
    };
  }
}
