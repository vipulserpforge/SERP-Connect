import { GoogleApiError, GoogleRestClient } from "@serp/provider-google";
import { z } from "zod";

export type Ga4ApiError = GoogleApiError;
export const Ga4ApiError = GoogleApiError;

/** GA4 property ids are numeric. Anything else must never reach a URL. */
export const GA4_PROPERTY_ID = /^\d{1,20}$/;

// ---- domain types --------------------------------------------------------------------

export interface Ga4PropertySummary {
  propertyId: string;
  displayName: string;
  /** e.g. PROPERTY_TYPE_ORDINARY, PROPERTY_TYPE_SUBPROPERTY, PROPERTY_TYPE_ROLLUP */
  propertyType: string;
}
export interface Ga4AccountSummary {
  accountId: string;
  displayName: string;
  properties: Ga4PropertySummary[];
}
export interface Ga4PropertyDetails {
  propertyId: string;
  displayName: string;
  timeZone: string | null;
  currencyCode: string | null;
}
export interface Ga4FieldMeta {
  apiName: string;
  uiName: string;
  category: string;
  deprecatedApiNames: string[];
  custom: boolean;
  /** Metrics only, e.g. TYPE_INTEGER, TYPE_FLOAT, TYPE_SECONDS, TYPE_CURRENCY. */
  type?: string;
}
export interface Ga4Metadata {
  dimensions: Ga4FieldMeta[];
  metrics: Ga4FieldMeta[];
}
export interface Ga4Compatibility {
  incompatibleDimensions: string[];
  incompatibleMetrics: string[];
}

export type Ga4Filter =
  | { filter: { fieldName: string; stringFilter: { matchType: string; value: string; caseSensitive: boolean } } }
  | { filter: { fieldName: string; numericFilter: { operation: string; value: { doubleValue: number } } } };
export interface Ga4FilterExpression {
  andGroup?: { expressions: Ga4Filter[] };
  filter?: Ga4Filter["filter"];
}

export interface Ga4RunReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  dimensionFilter?: Ga4FilterExpression;
  metricFilter?: Ga4FilterExpression;
  orderBys: Array<{ desc: boolean; metric?: { metricName: string }; dimension?: { dimensionName: string; orderType: "ALPHANUMERIC" } }>;
  limit: string;
  offset: string;
  returnPropertyQuota: true;
}

export interface Ga4QuotaStatus {
  consumed: number | null;
  remaining: number | null;
}
export interface Ga4RunReportResponse {
  dimensionHeaders: string[];
  metricHeaders: Array<{ name: string; type: string }>;
  rows: Array<{ dimensions: string[]; metrics: string[] }>;
  rowCount: number | null;
  timeZone: string | null;
  currencyCode: string | null;
  subjectToThresholding: boolean;
  dataLossFromOtherRow: boolean;
  sampling: Array<{ samplesReadCount: string; samplingSpaceSize: string }>;
  restrictedMetrics: string[];
  hasEmptyReason: boolean;
  quota: Record<string, Ga4QuotaStatus>;
}

/** Boundary to the Analytics Admin and Data APIs. Real and mock implementations are interchangeable. */
export interface Ga4ApiClient {
  readonly mock: boolean;
  listAccountSummaries(accessToken: string, signal?: AbortSignal): Promise<Ga4AccountSummary[]>;
  getProperty(accessToken: string, propertyId: string, signal?: AbortSignal): Promise<Ga4PropertyDetails>;
  getMetadata(accessToken: string, propertyId: string, signal?: AbortSignal): Promise<Ga4Metadata>;
  checkCompatibility(accessToken: string, propertyId: string, fields: { dimensions: string[]; metrics: string[] }, signal?: AbortSignal): Promise<Ga4Compatibility>;
  runReport(accessToken: string, propertyId: string, request: Ga4RunReportRequest, signal?: AbortSignal): Promise<Ga4RunReportResponse>;
}

// ---- response validation -------------------------------------------------------------

const str = z.string().max(2048);
const accountSummariesSchema = z.object({
  accountSummaries: z
    .array(
      z.object({
        account: str,
        displayName: str.optional(),
        propertySummaries: z.array(z.object({ property: str, displayName: str.optional(), propertyType: str.optional() })).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().max(2048).optional(),
});

const propertySchema = z.object({ name: str, displayName: str.optional(), timeZone: str.optional(), currencyCode: str.optional() });

const fieldSchema = z.object({
  apiName: str,
  uiName: str.optional(),
  category: str.optional(),
  deprecatedApiNames: z.array(str).optional(),
  customDefinition: z.boolean().optional(),
  type: str.optional(),
});
const metadataSchema = z.object({ dimensions: z.array(fieldSchema).optional(), metrics: z.array(fieldSchema).optional() });

const compatSchema = z.object({
  dimensionCompatibilities: z.array(z.object({ dimensionMetadata: z.object({ apiName: str }), compatibility: str.optional() })).optional(),
  metricCompatibilities: z.array(z.object({ metricMetadata: z.object({ apiName: str }), compatibility: str.optional() })).optional(),
});

const quotaEntry = z.object({ consumed: z.number().optional(), remaining: z.number().optional() }).passthrough();
const reportSchema = z.object({
  dimensionHeaders: z.array(z.object({ name: str })).optional(),
  metricHeaders: z.array(z.object({ name: str, type: str.optional() })).optional(),
  rows: z.array(z.object({ dimensionValues: z.array(z.object({ value: z.string().max(4096).optional() })).optional(), metricValues: z.array(z.object({ value: z.string().max(64).optional() })).optional() })).optional(),
  rowCount: z.number().int().nonnegative().optional(),
  metadata: z
    .object({
      timeZone: str.optional(),
      currencyCode: str.optional(),
      subjectToThresholding: z.boolean().optional(),
      dataLossFromOtherRow: z.boolean().optional(),
      samplingMetadatas: z.array(z.object({ samplesReadCount: z.string().optional(), samplingSpaceSize: z.string().optional() })).optional(),
      schemaRestrictionResponse: z.object({ activeMetricRestrictions: z.array(z.object({ metricName: str.optional() })).optional() }).optional(),
      emptyReason: z.string().optional(),
    })
    .passthrough()
    .optional(),
  propertyQuota: z.record(z.string(), quotaEntry).optional(),
});

const QUOTA_KEYS = ["tokensPerDay", "tokensPerHour", "concurrentRequests", "serverErrorsPerProjectPerHour", "potentiallyThresholdedRequestsPerHour", "tokensPerProjectPerHour"];
const bad = () => new GoogleApiError("bad_response", 200);

function propertyIdFromName(name: string): string | null {
  const m = /^properties\/(\d{1,20})$/.exec(name);
  return m ? m[1]! : null;
}

// ---- HTTP implementation -------------------------------------------------------------

export interface HttpGa4ClientOptions {
  adminBaseUrl?: string;
  dataBaseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const MAX_SUMMARY_PAGES = 10;

/** REST client for Analytics Admin v1beta (accountSummaries, properties.get) and Data v1beta. Server-side only. */
export class HttpGa4ApiClient implements Ga4ApiClient {
  readonly mock = false;
  private readonly admin: string;
  private readonly data: string;
  private readonly rest: GoogleRestClient;

  constructor(opts: HttpGa4ClientOptions = {}) {
    this.admin = opts.adminBaseUrl ?? "https://analyticsadmin.googleapis.com/v1beta";
    this.data = opts.dataBaseUrl ?? "https://analyticsdata.googleapis.com/v1beta";
    this.rest = new GoogleRestClient({
      // GA4 quotas are per hour/day: retrying a quota error within seconds only burns more of it.
      retryQuota: false,
      ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
      ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
      ...(opts.sleep && { sleep: opts.sleep }),
      ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }),
    });
  }

  private assertId(propertyId: string): void {
    if (!GA4_PROPERTY_ID.test(propertyId)) throw new GoogleApiError("invalid_request", null);
  }

  async listAccountSummaries(accessToken: string, signal?: AbortSignal): Promise<Ga4AccountSummary[]> {
    const out: Ga4AccountSummary[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_SUMMARY_PAGES; page++) {
      const qs = new URLSearchParams({ pageSize: "200", ...(pageToken && { pageToken }) });
      const parsed = accountSummariesSchema.safeParse(await this.rest.call("GET", `${this.admin}/accountSummaries?${qs}`, accessToken, undefined, signal));
      if (!parsed.success) throw bad();
      for (const a of parsed.data.accountSummaries ?? []) {
        out.push({
          accountId: a.account.replace(/^accounts\//, ""),
          displayName: a.displayName ?? "",
          properties: (a.propertySummaries ?? []).flatMap((p) => {
            const propertyId = propertyIdFromName(p.property);
            return propertyId ? [{ propertyId, displayName: p.displayName ?? propertyId, propertyType: p.propertyType ?? "PROPERTY_TYPE_UNSPECIFIED" }] : [];
          }),
        });
      }
      pageToken = parsed.data.nextPageToken || undefined;
      if (!pageToken) break;
    }
    return out;
  }

  async getProperty(accessToken: string, propertyId: string, signal?: AbortSignal): Promise<Ga4PropertyDetails> {
    this.assertId(propertyId);
    const parsed = propertySchema.safeParse(await this.rest.call("GET", `${this.admin}/properties/${propertyId}`, accessToken, undefined, signal));
    if (!parsed.success || propertyIdFromName(parsed.data.name) !== propertyId) throw bad();
    return { propertyId, displayName: parsed.data.displayName ?? propertyId, timeZone: parsed.data.timeZone ?? null, currencyCode: parsed.data.currencyCode ?? null };
  }

  async getMetadata(accessToken: string, propertyId: string, signal?: AbortSignal): Promise<Ga4Metadata> {
    this.assertId(propertyId);
    const parsed = metadataSchema.safeParse(await this.rest.call("GET", `${this.data}/properties/${propertyId}/metadata`, accessToken, undefined, signal));
    if (!parsed.success) throw bad();
    const map = (f: z.infer<typeof fieldSchema>): Ga4FieldMeta => ({
      apiName: f.apiName,
      uiName: f.uiName ?? f.apiName,
      category: f.category ?? "",
      deprecatedApiNames: f.deprecatedApiNames ?? [],
      custom: f.customDefinition ?? false,
      ...(f.type && { type: f.type }),
    });
    return { dimensions: (parsed.data.dimensions ?? []).map(map), metrics: (parsed.data.metrics ?? []).map(map) };
  }

  async checkCompatibility(accessToken: string, propertyId: string, fields: { dimensions: string[]; metrics: string[] }, signal?: AbortSignal): Promise<Ga4Compatibility> {
    this.assertId(propertyId);
    const body = { dimensions: fields.dimensions.map((name) => ({ name })), metrics: fields.metrics.map((name) => ({ name })) };
    const parsed = compatSchema.safeParse(await this.rest.call("POST", `${this.data}/properties/${propertyId}:checkCompatibility`, accessToken, body, signal));
    if (!parsed.success) throw bad();
    // The API reports a verdict for every field of the property, not just the requested ones. Fields that merely
    // clash with the request (but are not in it) must not fail the query, so only the requested names count.
    const askedDims = new Set(fields.dimensions);
    const askedMets = new Set(fields.metrics);
    return {
      incompatibleDimensions: (parsed.data.dimensionCompatibilities ?? []).filter((d) => d.compatibility === "INCOMPATIBLE" && askedDims.has(d.dimensionMetadata.apiName)).map((d) => d.dimensionMetadata.apiName),
      incompatibleMetrics: (parsed.data.metricCompatibilities ?? []).filter((m) => m.compatibility === "INCOMPATIBLE" && askedMets.has(m.metricMetadata.apiName)).map((m) => m.metricMetadata.apiName),
    };
  }

  async runReport(accessToken: string, propertyId: string, request: Ga4RunReportRequest, signal?: AbortSignal): Promise<Ga4RunReportResponse> {
    this.assertId(propertyId);
    const parsed = reportSchema.safeParse(await this.rest.call("POST", `${this.data}/properties/${propertyId}:runReport`, accessToken, request, signal));
    if (!parsed.success) throw bad();
    const d = parsed.data;
    const dimNames = request.dimensions.length;
    const metNames = request.metrics.length;
    const rows = (d.rows ?? []).map((r) => ({
      dimensions: (r.dimensionValues ?? []).map((v) => v.value ?? ""),
      metrics: (r.metricValues ?? []).map((v) => v.value ?? ""),
    }));
    // Every row must carry exactly the requested columns, otherwise values could be mislabeled.
    if (rows.some((r) => r.dimensions.length !== dimNames || r.metrics.length !== metNames)) throw bad();
    const quota: Record<string, Ga4QuotaStatus> = {};
    for (const key of QUOTA_KEYS) {
      const q = d.propertyQuota?.[key];
      if (q) quota[key] = { consumed: typeof q.consumed === "number" ? q.consumed : null, remaining: typeof q.remaining === "number" ? q.remaining : null };
    }
    return {
      dimensionHeaders: (d.dimensionHeaders ?? []).map((h) => h.name),
      metricHeaders: (d.metricHeaders ?? []).map((h) => ({ name: h.name, type: h.type ?? "TYPE_INTEGER" })),
      rows,
      rowCount: d.rowCount ?? null,
      timeZone: d.metadata?.timeZone ?? null,
      currencyCode: d.metadata?.currencyCode ?? null,
      subjectToThresholding: d.metadata?.subjectToThresholding ?? false,
      dataLossFromOtherRow: d.metadata?.dataLossFromOtherRow ?? false,
      sampling: (d.metadata?.samplingMetadatas ?? []).map((s) => ({ samplesReadCount: s.samplesReadCount ?? "", samplingSpaceSize: s.samplingSpaceSize ?? "" })),
      restrictedMetrics: (d.metadata?.schemaRestrictionResponse?.activeMetricRestrictions ?? []).flatMap((m) => (m.metricName ? [m.metricName] : [])),
      hasEmptyReason: Boolean(d.metadata?.emptyReason),
      quota,
    };
  }
}
