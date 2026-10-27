import type { NormalizedReportResult } from "@serp/contracts";

/** Pulls older than this are deleted when a new one is saved. */
export const CLARITY_SNAPSHOT_RETENTION_DAYS = 90;

export interface ClaritySnapshot {
  id: string;
  projectKey: string;
  numOfDays: 1 | 2 | 3;
  dimensions: string[];
  /** When the data was pulled from Clarity (UTC ISO). */
  pulledAt: string;
  result: NormalizedReportResult;
}

export interface SaveClaritySnapshot {
  userId: string;
  connectionId: string;
  projectKey: string;
  numOfDays: 1 | 2 | 3;
  dimensions: readonly string[];
  result: NormalizedReportResult;
}

/** History of live Clarity pulls. Every read is scoped to the owning user. */
export interface ClaritySnapshotStore {
  save(input: SaveClaritySnapshot): Promise<void>;
  /** Newest first. `dimensions` (when given) keeps only pulls of that exact shape. */
  list(userId: string, projectKey: string, opts: { dimensions?: readonly string[]; limit: number }): Promise<ClaritySnapshot[]>;
}

export const dimensionsKey = (dimensions: readonly string[]): string => dimensions.join("|");

/** In-process store for mock mode and tests. */
export class MemoryClaritySnapshotStore implements ClaritySnapshotStore {
  private readonly items: Array<ClaritySnapshot & { userId: string }> = [];
  private seq = 0;

  async save(input: SaveClaritySnapshot): Promise<void> {
    this.items.push({ id: `snap-${++this.seq}`, userId: input.userId, projectKey: input.projectKey, numOfDays: input.numOfDays, dimensions: [...input.dimensions], pulledAt: input.result.fetchedAt, result: structuredClone(input.result) });
  }

  async list(userId: string, projectKey: string, opts: { dimensions?: readonly string[]; limit: number }): Promise<ClaritySnapshot[]> {
    const key = opts.dimensions ? dimensionsKey(opts.dimensions) : null;
    return this.items
      .filter((s) => s.userId === userId && s.projectKey === projectKey && (key === null || dimensionsKey(s.dimensions) === key))
      .sort((a, b) => b.pulledAt.localeCompare(a.pulledAt))
      .slice(0, opts.limit)
      .map(({ userId: _u, ...s }) => structuredClone(s));
  }
}
