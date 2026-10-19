import { GoogleApiError, GoogleRestClient, classifyGoogleError, type GoogleApiErrorKind } from "@serp/provider-google";
import { z } from "zod";

export { classifyGoogleError };

/** What Search Console can say about a site for the authorized account. */
export const SITE_PERMISSION_LEVELS = ["siteOwner", "siteFullUser", "siteRestrictedUser", "siteUnverifiedUser"] as const;
export type SitePermissionLevel = (typeof SITE_PERMISSION_LEVELS)[number];

export interface GscSite {
  siteUrl: string;
  permissionLevel: SitePermissionLevel | "unknown";
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: string[];
  searchType: string;
  dimensionFilterGroups?: Array<{
    groupType: "and";
    filters: Array<{ dimension: string; operator: string; expression: string }>;
  }>;
  rowLimit: number;
  startRow: number;
  dataState: "final" | "all";
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows: SearchAnalyticsRow[];
  responseAggregationType: string | null;
  firstIncompleteDate: string | null;
}

/** Failure classes and the error type are shared with every Google integration (see @serp/provider-google). */
export type GscApiErrorKind = GoogleApiErrorKind;
export const GscApiError = GoogleApiError;
export type GscApiError = GoogleApiError;

/** Boundary to the Search Console API. Real and mock implementations are interchangeable. */
export interface GscApiClient {
  readonly mock: boolean;
  listSites(accessToken: string, signal?: AbortSignal): Promise<GscSite[]>;
  querySearchAnalytics(accessToken: string, siteUrl: string, body: SearchAnalyticsRequest, signal?: AbortSignal): Promise<SearchAnalyticsResponse>;
}

// ---- response validation ---------------------------------------------------------

const sitesSchema = z.object({
  siteEntry: z
    .array(z.object({ siteUrl: z.string().min(1).max(2048), permissionLevel: z.string().optional() }))
    .optional(), // Google omits the field entirely when the account has no sites.
});

const finite = z.number().refine(Number.isFinite);
const analyticsSchema = z.object({
  rows: z
    .array(
      z.object({
        keys: z.array(z.string()).optional(),
        clicks: finite,
        impressions: finite,
        ctr: finite,
        position: finite,
      }),
    )
    .optional(), // Omitted when there is no data.
  responseAggregationType: z.string().optional(),
  metadata: z.object({ first_incomplete_date: z.string().optional() }).passthrough().optional(),
});

// ---- HTTP implementation ---------------------------------------------------------

export interface HttpGscClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/** Thin REST client for webmasters v3 (sites.list, searchAnalytics.query). Server-side only. */
export class HttpGscApiClient implements GscApiClient {
  readonly mock = false;
  private readonly baseUrl: string;
  private readonly rest: GoogleRestClient;

  constructor(opts: HttpGscClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://www.googleapis.com/webmasters/v3";
    this.rest = new GoogleRestClient({
      ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      ...(opts.sleep && { sleep: opts.sleep }),
      ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
    });
  }

  async listSites(accessToken: string, signal?: AbortSignal): Promise<GscSite[]> {
    const data = await this.rest.call("GET", `${this.baseUrl}/sites`, accessToken, undefined, signal);
    const parsed = sitesSchema.safeParse(data);
    if (!parsed.success) throw new GscApiError("bad_response", 200);
    return (parsed.data.siteEntry ?? []).map((s) => ({
      siteUrl: s.siteUrl,
      permissionLevel: (SITE_PERMISSION_LEVELS as readonly string[]).includes(s.permissionLevel ?? "")
        ? (s.permissionLevel as SitePermissionLevel)
        : "unknown",
    }));
  }

  async querySearchAnalytics(accessToken: string, siteUrl: string, body: SearchAnalyticsRequest, signal?: AbortSignal): Promise<SearchAnalyticsResponse> {
    const url = `${this.baseUrl}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const data = await this.rest.call("POST", url, accessToken, body, signal);
    const parsed = analyticsSchema.safeParse(data);
    if (!parsed.success) throw new GscApiError("bad_response", 200);
    const rows = (parsed.data.rows ?? []).map((r) => ({ ...r, keys: r.keys ?? [] }));
    // A row must carry one key per requested dimension, otherwise we could mislabel data.
    if (rows.some((r) => r.keys.length !== body.dimensions.length)) throw new GscApiError("bad_response", 200);
    return {
      rows,
      responseAggregationType: parsed.data.responseAggregationType ?? null,
      firstIncompleteDate: parsed.data.metadata?.first_incomplete_date ?? null,
    };
  }
}
