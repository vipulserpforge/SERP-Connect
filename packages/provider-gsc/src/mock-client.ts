import {
  GscApiError,
  type GscApiClient,
  type GscSite,
  type SearchAnalyticsRequest,
  type SearchAnalyticsResponse,
  type SearchAnalyticsRow,
} from "./api-client.js";

const PAGES = ["/", "/blog/", "/blog/seo-basics", "/blog/link-building", "/products/", "/products/widget", "/pricing", "/about", "/contact", "/docs/getting-started", ...Array.from({ length: 20 }, (_, i) => `/blog/post-${i + 1}`)];
const QUERIES = ["seo tools", "keyword research", "backlink checker", "what is seo", "site audit", "rank tracker", "example brand", "widget price", "seo basics", "link building tips", "contact example", "technical seo"];
const COUNTRIES = ["usa", "gbr", "ind", "can"];
const DEVICES = ["DESKTOP", "MOBILE", "TABLET"];
const DAY = 86_400_000;
const MAX_DAYS = 600;

export const DEFAULT_MOCK_SITES: GscSite[] = [
  { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
  { siteUrl: "https://www.example.com/", permissionLevel: "siteFullUser" },
  { siteUrl: "https://restricted.example.com/", permissionLevel: "siteRestrictedUser" },
  { siteUrl: "https://not-verified.example.net/", permissionLevel: "siteUnverifiedUser" },
];

/** Small deterministic hash so the same query always yields the same synthetic numbers. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export interface MockGscClientOptions {
  sites?: GscSite[];
  /** "Today" for freshness rules (UTC calendar day). */
  now?: () => Date;
}

/**
 * Fixture-backed stand-in for the Search Console API. It applies the same rules the real API does
 * (site access, dimensions, filters, ordering, row limit, data state), so the adapter's normalization,
 * warnings and error handling are exercised without Google credentials. The numbers are synthetic.
 */
export class MockGscApiClient implements GscApiClient {
  readonly mock = true;
  sites: GscSite[];
  readonly calls: Array<{ op: "listSites" | "query"; siteUrl?: string; accessToken: string; body?: SearchAnalyticsRequest }> = [];
  /** Errors thrown by the next calls, in order. Lets tests simulate outages, quota and permission loss. */
  failures: GscApiError[] = [];
  /** Returned instead of the generated rows when set (e.g. to simulate a malformed or truncated reply). */
  override: Partial<SearchAnalyticsResponse> | null = null;
  private readonly now: () => Date;

  constructor(opts: MockGscClientOptions = {}) {
    this.sites = opts.sites ?? DEFAULT_MOCK_SITES;
    this.now = opts.now ?? (() => new Date());
  }

  private maybeFail(): void {
    const next = this.failures.shift();
    if (next) throw next;
  }

  async listSites(accessToken: string): Promise<GscSite[]> {
    this.calls.push({ op: "listSites", accessToken });
    this.maybeFail();
    return this.sites.map((s) => ({ ...s }));
  }

  async querySearchAnalytics(accessToken: string, siteUrl: string, body: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse> {
    this.calls.push({ op: "query", siteUrl, accessToken, body });
    this.maybeFail();

    const site = this.sites.find((s) => s.siteUrl === siteUrl);
    if (!site || site.permissionLevel === "siteUnverifiedUser") throw new GscApiError("no_resource_access", 403);
    if (body.rowLimit < 1 || body.rowLimit > 25_000 || body.startDate > body.endDate) throw new GscApiError("invalid_request", 400);
    if ((body.searchType === "discover" || body.searchType === "googleNews") && body.dimensions.includes("query")) {
      throw new GscApiError("invalid_request", 400);
    }

    const today = this.now().toISOString().slice(0, 10);
    const dates = enumerateDates(body.startDate, body.endDate);
    if (dates.length > MAX_DAYS) throw new GscApiError("invalid_request", 400);
    const finalCutoff = shiftDay(today, -2); // newest finalized day
    const usable = body.dataState === "final" ? dates.filter((d) => d <= finalCutoff) : dates;

    const filters = body.dimensionFilterGroups?.flatMap((g) => g.filters) ?? [];
    const scale = body.searchType === "web" ? 1 : 0.4;
    const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; posWeighted: number }>();

    for (const page of PAGES) {
      for (const query of QUERIES) {
        for (const country of COUNTRIES) {
          for (const device of DEVICES) {
            const values: Record<string, string> = { page: `${origin(siteUrl)}${page}`, query, country, device, searchAppearance: "" };
            if (!filters.every((f) => matches(values[f.dimension] ?? "", f.operator, f.expression))) continue;
            for (const date of usable) {
              const seed = hash(`${siteUrl}|${values.page}|${query}|${country}|${device}|${date}|${body.searchType}`);
              if (seed < 0.7) continue; // sparse, like real data
              const impressions = Math.max(1, Math.round(seed * 80 * scale * (1 + hash(`${query}|${siteUrl}`) * 6)));
              const clicks = Math.round(impressions * hash(`ctr|${values.page}|${query}|${date}`) * 0.25);
              const position = 1 + hash(`pos|${values.page}|${query}`) * 30;
              const v = { ...values, date, searchAppearance: "AMP_BLUE_LINK" };
              const keys = body.dimensions.map((d) => v[d as keyof typeof v] ?? "");
              const id = keys.join("\u0000");
              const g = groups.get(id) ?? { keys, clicks: 0, impressions: 0, posWeighted: 0 };
              g.clicks += clicks;
              g.impressions += impressions;
              g.posWeighted += position * impressions;
              groups.set(id, g);
            }
          }
        }
      }
    }

    let rows: SearchAnalyticsRow[] = [...groups.values()].map((g) => ({
      keys: g.keys,
      clicks: g.clicks,
      impressions: g.impressions,
      ctr: g.impressions ? g.clicks / g.impressions : 0,
      position: g.impressions ? g.posWeighted / g.impressions : 0,
    }));
    const dateIdx = body.dimensions.indexOf("date");
    rows.sort((a, b) => (dateIdx >= 0 ? a.keys[dateIdx]!.localeCompare(b.keys[dateIdx]!) : 0) || b.clicks - a.clicks || a.keys.join().localeCompare(b.keys.join()));
    rows = rows.slice(body.startRow, body.startRow + body.rowLimit);

    const incomplete = body.dataState === "all" && body.endDate >= shiftDay(today, -1);
    return {
      rows,
      responseAggregationType: body.dimensions.includes("page") || filters.some((f) => f.dimension === "page") ? "byPage" : "byProperty",
      firstIncompleteDate: incomplete ? shiftDay(today, -1) : null,
      ...this.override,
    };
  }
}

function origin(siteUrl: string): string {
  return siteUrl.startsWith("sc-domain:") ? `https://www.${siteUrl.slice("sc-domain:".length)}` : siteUrl.replace(/\/$/, "");
}

function matches(value: string, op: string, expr: string): boolean {
  switch (op) {
    case "equals":
      return value.toLowerCase() === expr.toLowerCase();
    case "notEquals":
      return value.toLowerCase() !== expr.toLowerCase();
    case "contains":
      return value.toLowerCase().includes(expr.toLowerCase());
    case "notContains":
      return !value.toLowerCase().includes(expr.toLowerCase());
    case "includingRegex":
      return new RegExp(expr).test(value);
    case "excludingRegex":
      return !new RegExp(expr).test(value);
    default:
      return true;
  }
}

function shiftDay(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function enumerateDates(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`) && out.length <= MAX_DAYS + 1; t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
