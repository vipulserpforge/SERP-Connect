import {
  Ga4ApiError,
  type Ga4AccountSummary,
  type Ga4ApiClient,
  type Ga4Compatibility,
  type Ga4FieldMeta,
  type Ga4Filter,
  type Ga4FilterExpression,
  type Ga4Metadata,
  type Ga4PropertyDetails,
  type Ga4RealtimeRequest,
  type Ga4RunReportRequest,
  type Ga4RunReportResponse,
} from "./api-client.js";

type Scope = "event" | "session" | "user" | "item";
const DAY = 86_400_000;
const MAX_DAYS = 400;
const FACTS = 700;

const PAGES = ["/", "/blog/", "/blog/seo-basics", "/blog/link-building", "/products/", "/products/widget", "/pricing", "/about", "/contact", "/docs/getting-started", ...Array.from({ length: 30 }, (_, i) => `/blog/post-${i + 1}`)];
const VALUES: Record<string, string[]> = {
  country: ["United States", "United Kingdom", "India", "Canada", "Germany", "Australia"],
  city: ["New York", "London", "Mumbai", "Toronto", "Berlin", "Sydney", "Austin", "Delhi"],
  deviceCategory: ["desktop", "mobile", "tablet"],
  browser: ["Chrome", "Safari", "Firefox", "Edge"],
  operatingSystem: ["Windows", "macOS", "iOS", "Android", "Linux"],
  sessionDefaultChannelGroup: ["Organic Search", "Direct", "Referral", "Paid Search", "Organic Social", "Email"],
  sessionSource: ["google", "(direct)", "bing", "facebook", "newsletter"],
  sessionMedium: ["organic", "(none)", "referral", "cpc", "email"],
  pagePath: PAGES,
  pageTitle: PAGES.map((p) => (p === "/" ? "Home" : `Page ${p}`)),
  landingPage: PAGES.slice(0, 12),
  hostName: ["www.example.com"],
  eventName: ["page_view", "session_start", "scroll", "click", "first_visit", "user_engagement", "purchase", "sign_up"],
  newVsReturning: ["new", "returning"],
  language: ["en-us", "en-gb", "hi-in", "de-de"],
  itemName: ["Widget", "Gadget", "Gizmo", "Doohickey", "Thingamajig"],
  itemCategory: ["Tools", "Toys", "Home"],
  itemBrand: ["Acme", "Globex", "Initech"],
  itemId: ["SKU-1", "SKU-2", "SKU-3", "SKU-4", "SKU-5"],
  itemPromotionName: ["Summer sale", "Black Friday", "Newsletter 10%"],
  sessionSourceMedium: ["google / organic", "(direct) / (none)", "bing / organic", "facebook / referral", "newsletter / email", "google / cpc"],
  sessionCampaignName: ["(organic)", "(direct)", "summer_sale", "brand_search", "(not set)"],
  firstUserDefaultChannelGroup: ["Organic Search", "Direct", "Referral", "Paid Search", "Organic Social", "Email"],
  userAgeBracket: ["18-24", "25-34", "35-44", "45-54", "55-64", "unknown"],
  userGender: ["female", "male", "unknown"],
  "customEvent:signup_plan": ["free", "pro", "enterprise"],
};

const dim = (apiName: string, uiName: string, category: string, scope: Scope, custom = false) => ({ apiName, uiName, category, scope, custom });
const DIMENSIONS = [
  dim("date", "Date", "Time", "event"),
  dim("country", "Country", "Geography", "user"),
  dim("city", "City", "Geography", "user"),
  dim("deviceCategory", "Device category", "Platform / Device", "session"),
  dim("browser", "Browser", "Platform / Device", "session"),
  dim("operatingSystem", "Operating system", "Platform / Device", "session"),
  dim("sessionDefaultChannelGroup", "Session default channel group", "Traffic source", "session"),
  dim("sessionSource", "Session source", "Traffic source", "session"),
  dim("sessionMedium", "Session medium", "Traffic source", "session"),
  dim("pagePath", "Page path + query string", "Page / Screen", "event"),
  dim("pageTitle", "Page title", "Page / Screen", "event"),
  dim("landingPage", "Landing page", "Page / Screen", "session"),
  dim("hostName", "Hostname", "Page / Screen", "event"),
  dim("eventName", "Event name", "Event", "event"),
  dim("newVsReturning", "New / returning", "User", "user"),
  dim("language", "Language", "Demographics", "user"),
  dim("itemName", "Item name", "Ecommerce", "item"),
  dim("itemCategory", "Item category", "Ecommerce", "item"),
  dim("itemBrand", "Item brand", "Ecommerce", "item"),
  dim("itemId", "Item ID", "Ecommerce", "item"),
  dim("itemPromotionName", "Item promotion name", "Ecommerce", "item"),
  dim("sessionSourceMedium", "Session source / medium", "Traffic source", "session"),
  dim("sessionCampaignName", "Session campaign", "Traffic source", "session"),
  dim("firstUserDefaultChannelGroup", "First user default channel group", "Traffic source", "user"),
  dim("userAgeBracket", "Age", "Demographics", "user"),
  dim("userGender", "Gender", "Demographics", "user"),
];
const CUSTOM_DIM = dim("customEvent:signup_plan", "Signup plan (custom)", "Custom", "event", true);

const met = (apiName: string, uiName: string, category: string, type: string, scope: Scope | "any") => ({ apiName, uiName, category, type, scope });
const METRICS = [
  met("activeUsers", "Active users", "User", "TYPE_INTEGER", "any"),
  met("totalUsers", "Total users", "User", "TYPE_INTEGER", "any"),
  met("newUsers", "New users", "User", "TYPE_INTEGER", "any"),
  met("sessions", "Sessions", "Session", "TYPE_INTEGER", "session"),
  met("engagedSessions", "Engaged sessions", "Session", "TYPE_INTEGER", "session"),
  met("engagementRate", "Engagement rate", "Session", "TYPE_FLOAT", "session"),
  met("bounceRate", "Bounce rate", "Session", "TYPE_FLOAT", "session"),
  met("sessionsPerUser", "Sessions per user", "Session", "TYPE_FLOAT", "session"),
  met("averageSessionDuration", "Average session duration", "Session", "TYPE_SECONDS", "session"),
  met("screenPageViews", "Views", "Page / Screen", "TYPE_INTEGER", "any"),
  met("screenPageViewsPerSession", "Views per session", "Page / Screen", "TYPE_FLOAT", "session"),
  met("eventCount", "Event count", "Event", "TYPE_INTEGER", "any"),
  met("eventCountPerUser", "Events per user", "Event", "TYPE_FLOAT", "any"),
  met("keyEvents", "Key events", "Event", "TYPE_INTEGER", "any"),
  met("conversions", "Conversions", "Event", "TYPE_INTEGER", "any"),
  met("userEngagementDuration", "User engagement", "User", "TYPE_SECONDS", "any"),
  met("transactions", "Transactions", "Ecommerce", "TYPE_INTEGER", "any"),
  met("totalRevenue", "Total revenue", "Revenue", "TYPE_CURRENCY", "any"),
  met("purchaseRevenue", "Purchase revenue", "Revenue", "TYPE_CURRENCY", "any"),
  met("itemsViewed", "Items viewed", "Ecommerce", "TYPE_INTEGER", "item"),
  met("itemRevenue", "Item revenue", "Ecommerce", "TYPE_CURRENCY", "item"),
  met("ecommercePurchases", "Ecommerce purchases", "Ecommerce", "TYPE_INTEGER", "any"),
  met("addToCarts", "Add to carts", "Ecommerce", "TYPE_INTEGER", "any"),
  met("checkouts", "Checkouts", "Ecommerce", "TYPE_INTEGER", "any"),
  met("itemsAddedToCart", "Items added to cart", "Ecommerce", "TYPE_INTEGER", "item"),
  met("itemsPurchased", "Items purchased", "Ecommerce", "TYPE_INTEGER", "item"),
  met("itemsViewedInPromotion", "Items viewed in promotion", "Ecommerce", "TYPE_INTEGER", "item"),
  met("itemsClickedInPromotion", "Items clicked in promotion", "Ecommerce", "TYPE_INTEGER", "item"),
  met("averagePurchaseRevenue", "Average purchase revenue", "Revenue", "TYPE_CURRENCY", "any"),
  met("averageRevenuePerUser", "ARPU", "Revenue", "TYPE_CURRENCY", "any"),
  met("dauPerMau", "DAU / MAU", "User", "TYPE_FLOAT", "any"),
  met("dauPerWau", "DAU / WAU", "User", "TYPE_FLOAT", "any"),
  met("wauPerMau", "WAU / MAU", "User", "TYPE_FLOAT", "any"),
  met("active1DayUsers", "1-day active users", "User", "TYPE_INTEGER", "any"),
  met("active7DayUsers", "7-day active users", "User", "TYPE_INTEGER", "any"),
  met("active28DayUsers", "28-day active users", "User", "TYPE_INTEGER", "any"),
];
const CUSTOM_METRIC = met("customEvent:signup_count", "Signups (custom)", "Custom", "TYPE_INTEGER", "any");
const CUSTOM_PROPERTY = "123456789";
const SESSION_METRICS = new Set(METRICS.filter((m) => m.scope === "session").map((m) => m.apiName));

export const DEFAULT_MOCK_ACCOUNTS: Ga4AccountSummary[] = [
  {
    accountId: "1001",
    displayName: "Example Co",
    properties: [
      { propertyId: "123456789", displayName: "Example GA4", propertyType: "PROPERTY_TYPE_ORDINARY" },
      { propertyId: "987654321", displayName: "Example Blog (India)", propertyType: "PROPERTY_TYPE_ORDINARY" },
      { propertyId: "111222333", displayName: "Example Sub-property", propertyType: "PROPERTY_TYPE_SUBPROPERTY" },
      { propertyId: "555000111", displayName: "Example Roll-up", propertyType: "PROPERTY_TYPE_ROLLUP" },
    ],
  },
  { accountId: "1002", displayName: "Other Co", properties: [{ propertyId: "444555666", displayName: "Other site", propertyType: "PROPERTY_TYPE_ORDINARY" }] },
];
export const MOCK_GA4_TIME_ZONES: Record<string, string> = { "123456789": "America/New_York", "987654321": "Asia/Kolkata", "111222333": "Europe/London", "444555666": "Australia/Sydney" };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
const pick = (name: string, fact: number, propertyId: string): string => {
  const values = VALUES[name]!;
  return values[Math.floor(hash(`${propertyId}|${name}|${fact}`) * values.length)]!;
};

export interface MockGa4ClientOptions {
  accounts?: Ga4AccountSummary[];
  timeZones?: Record<string, string>;
  now?: () => Date;
}

interface Totals {
  activeUsers: number;
  totalUsers: number;
  newUsers: number;
  sessions: number;
  engagedSessions: number;
  views: number;
  events: number;
  keyEvents: number;
  duration: number;
  transactions: number;
  revenue: number;
  itemsViewed: number;
  itemRevenue: number;
  signups: number;
  carts: number;
  checkouts: number;
  bought: number;
  promoViews: number;
  promoClicks: number;
}
const zero = (): Totals => ({ activeUsers: 0, totalUsers: 0, newUsers: 0, sessions: 0, engagedSessions: 0, views: 0, events: 0, keyEvents: 0, duration: 0, transactions: 0, revenue: 0, itemsViewed: 0, itemRevenue: 0, signups: 0, carts: 0, checkouts: 0, bought: 0, promoViews: 0, promoClicks: 0 });

/**
 * Fixture-backed stand-in for the Analytics Admin and Data APIs. It enforces property access, the
 * metadata (including property-specific custom fields), a simplified compatibility model, filters,
 * ordering, pagination and quota reporting, so the adapter's logic is exercised without Google credentials.
 * The compatibility rules are an approximation for tests; the real checkCompatibility is the authority.
 */
export class MockGa4ApiClient implements Ga4ApiClient {
  readonly mock = true;
  accounts: Ga4AccountSummary[];
  timeZones: Record<string, string>;
  readonly calls: Array<{ op: string; propertyId?: string; accessToken: string; request?: unknown }> = [];
  failures: Ga4ApiError[] = [];
  /** Merged over the next generated runReport response (thresholding, sampling, other-row, etc.). */
  override: Partial<Ga4RunReportResponse> | null = null;
  /** Property ids for which the Admin API works but the Data API denies access. */
  deniedProperties = new Set<string>();
  private readonly now: () => Date;
  private tokensUsed = 0;

  constructor(opts: MockGa4ClientOptions = {}) {
    this.accounts = opts.accounts ?? DEFAULT_MOCK_ACCOUNTS;
    this.timeZones = opts.timeZones ?? MOCK_GA4_TIME_ZONES;
    this.now = opts.now ?? (() => new Date());
  }

  private enter(op: string, accessToken: string, propertyId?: string, request?: unknown): void {
    this.calls.push({ op, accessToken, ...(propertyId && { propertyId }), ...(request !== undefined && { request }) });
    const next = this.failures.shift();
    if (next) throw next;
  }

  private known(propertyId: string): boolean {
    return this.accounts.some((a) => a.properties.some((p) => p.propertyId === propertyId));
  }

  private requireAccess(propertyId: string): void {
    if (!this.known(propertyId) || this.deniedProperties.has(propertyId)) throw new Ga4ApiError("no_resource_access", 403);
  }

  async listAccountSummaries(accessToken: string): Promise<Ga4AccountSummary[]> {
    this.enter("listAccountSummaries", accessToken);
    return structuredClone(this.accounts);
  }

  async getProperty(accessToken: string, propertyId: string): Promise<Ga4PropertyDetails> {
    this.enter("getProperty", accessToken, propertyId);
    if (!this.known(propertyId)) throw new Ga4ApiError("no_resource_access", 403);
    const name = this.accounts.flatMap((a) => a.properties).find((p) => p.propertyId === propertyId)!.displayName;
    return { propertyId, displayName: name, timeZone: this.timeZones[propertyId] ?? null, currencyCode: "USD" };
  }

  private fieldsFor(propertyId: string) {
    return {
      dims: propertyId === CUSTOM_PROPERTY ? [...DIMENSIONS, CUSTOM_DIM] : DIMENSIONS,
      mets: propertyId === CUSTOM_PROPERTY ? [...METRICS, CUSTOM_METRIC] : METRICS,
    };
  }

  async getMetadata(accessToken: string, propertyId: string): Promise<Ga4Metadata> {
    this.enter("getMetadata", accessToken, propertyId);
    this.requireAccess(propertyId);
    const { dims, mets } = this.fieldsFor(propertyId);
    const base = (f: { apiName: string; uiName: string; category: string; custom?: boolean; type?: string }): Ga4FieldMeta => ({
      apiName: f.apiName,
      uiName: f.uiName,
      category: f.category,
      deprecatedApiNames: [],
      custom: f.custom ?? false,
      ...(f.type && { type: f.type }),
    });
    return {
      dimensions: dims.map(base),
      metrics: mets.map((m) => base({ ...m, custom: m.category === "Custom" })),
    };
  }

  async checkCompatibility(accessToken: string, propertyId: string, fields: { dimensions: string[]; metrics: string[] }): Promise<Ga4Compatibility> {
    this.enter("checkCompatibility", accessToken, propertyId, fields);
    this.requireAccess(propertyId);
    const { dims, mets } = this.fieldsFor(propertyId);
    const dimMeta = fields.dimensions.map((n) => dims.find((d) => d.apiName === n)).filter((d): d is NonNullable<typeof d> => Boolean(d));
    const metMeta = fields.metrics.map((n) => mets.find((m) => m.apiName === n)).filter((m): m is NonNullable<typeof m> => Boolean(m));
    const bad = (d: (typeof dimMeta)[number], m: (typeof metMeta)[number]) =>
      (d.scope === "item") !== (m.scope === "item") && m.scope !== "any" ? true
      : d.scope === "item" && m.scope === "any" && !["itemName", "itemCategory", "itemBrand", "itemId", "itemPromotionName"].includes(d.apiName) ? true
      : d.custom && SESSION_METRICS.has(m.apiName); // event-scoped custom dimensions cannot be used with session metrics
    const incompatibleDimensions = dimMeta.filter((d) => metMeta.some((m) => bad(d, m))).map((d) => d.apiName);
    const incompatibleMetrics = metMeta.filter((m) => dimMeta.some((d) => bad(d, m))).map((m) => m.apiName);
    return { incompatibleDimensions, incompatibleMetrics };
  }

  async runReport(accessToken: string, propertyId: string, req: Ga4RunReportRequest): Promise<Ga4RunReportResponse> {
    this.enter("runReport", accessToken, propertyId, req);
    this.requireAccess(propertyId);
    if (req.cohortSpec) return this.cohortReport(propertyId, req);
    const { dims, mets } = this.fieldsFor(propertyId);
    const dimNames = req.dimensions.map((d) => d.name);
    const metNames = req.metrics.map((m) => m.name);
    if (dimNames.some((n) => !dims.some((d) => d.apiName === n)) || metNames.some((n) => !mets.some((m) => m.apiName === n))) throw new Ga4ApiError("invalid_request", 400);
    const range = req.dateRanges?.[0];
    if (!range) throw new Ga4ApiError("invalid_request", 400);
    if (range.startDate > range.endDate || range.startDate < "2015-08-14") throw new Ga4ApiError("invalid_request", 400);

    const tz = this.timeZones[propertyId] ?? "UTC";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(this.now());
    const days: string[] = [];
    for (let t = Date.parse(`${range.startDate}T00:00:00Z`); t <= Date.parse(`${range.endDate}T00:00:00Z`) && days.length <= MAX_DAYS; t += DAY) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d <= today) days.push(d);
    }
    if (days.length > MAX_DAYS) throw new Ga4ApiError("invalid_request", 400);

    const groups = new Map<string, { keys: string[]; t: Totals }>();
    for (let f = 0; f < FACTS; f++) {
      const attr = (n: string): string => (n === "date" ? "" : pick(n, f, propertyId));
      if (!matchesDimensionFilter(req.dimensionFilter, attr)) continue;
      for (const date of days) {
        const seed = hash(`${propertyId}|${f}|${date}`);
        if (seed < 0.75) continue;
        const sessions = 1 + Math.floor(seed * 40);
        const t = zero();
        t.sessions = sessions;
        t.engagedSessions = Math.round(sessions * (0.4 + hash(`e${f}${date}`) * 0.5));
        t.activeUsers = Math.max(1, Math.round(sessions * 0.8));
        t.totalUsers = t.activeUsers + Math.round(sessions * 0.05);
        t.newUsers = Math.round(t.activeUsers * 0.4);
        t.views = Math.round(sessions * (1.5 + hash(`v${f}`) * 2));
        t.events = t.views * 4;
        t.keyEvents = Math.round(sessions * hash(`k${f}${date}`) * 0.1);
        t.duration = sessions * (30 + Math.round(hash(`d${f}`) * 150));
        t.transactions = Math.round(t.keyEvents * 0.5);
        t.revenue = t.transactions * (20 + Math.round(hash(`r${f}`) * 80));
        t.itemsViewed = Math.round(sessions * 1.2);
        t.itemRevenue = t.revenue;
        t.signups = Math.round(t.keyEvents * 0.7);
        t.carts = Math.round(t.itemsViewed * 0.3);
        t.checkouts = Math.round(t.carts * 0.5);
        t.bought = Math.round(t.checkouts * 0.6);
        t.promoViews = Math.round(sessions * 2);
        t.promoClicks = Math.round(sessions * 0.4);
        const keys = dimNames.map((n) => (n === "date" ? date.replaceAll("-", "") : attr(n)));
        const id = keys.join("\u0000");
        const g = groups.get(id) ?? { keys, t: zero() };
        for (const k of Object.keys(t) as Array<keyof Totals>) g.t[k] += t[k];
        groups.set(id, g);
      }
    }

    const value = (t: Totals, name: string): number => {
      const per = (a: number, b: number) => (b > 0 ? a / b : 0);
      switch (name) {
        case "activeUsers": return t.activeUsers;
        case "totalUsers": return t.totalUsers;
        case "newUsers": return t.newUsers;
        case "sessions": return t.sessions;
        case "engagedSessions": return t.engagedSessions;
        case "engagementRate": return per(t.engagedSessions, t.sessions);
        case "bounceRate": return 1 - per(t.engagedSessions, t.sessions);
        case "sessionsPerUser": return per(t.sessions, t.activeUsers);
        case "averageSessionDuration": return per(t.duration, t.sessions);
        case "screenPageViews": return t.views;
        case "screenPageViewsPerSession": return per(t.views, t.sessions);
        case "eventCount": return t.events;
        case "eventCountPerUser": return per(t.events, t.activeUsers);
        case "keyEvents":
        case "conversions": return t.keyEvents;
        case "userEngagementDuration": return t.duration;
        case "transactions": return t.transactions;
        case "totalRevenue":
        case "purchaseRevenue": return t.revenue;
        case "itemsViewed": return t.itemsViewed;
        case "itemRevenue": return t.itemRevenue;
        case "customEvent:signup_count": return t.signups;
        case "ecommercePurchases": return t.bought;
        case "addToCarts":
        case "itemsAddedToCart": return t.carts;
        case "checkouts": return t.checkouts;
        case "itemsPurchased": return t.bought;
        case "itemsViewedInPromotion": return t.promoViews;
        case "itemsClickedInPromotion": return t.promoClicks;
        case "averagePurchaseRevenue": return per(t.revenue, t.transactions);
        case "averageRevenuePerUser": return per(t.revenue, t.activeUsers);
        case "dauPerMau": return 0.18;
        case "dauPerWau": return 0.35;
        case "wauPerMau": return 0.52;
        case "active1DayUsers": return Math.round(t.activeUsers / 28);
        case "active7DayUsers": return Math.round(t.activeUsers / 4);
        case "active28DayUsers": return t.activeUsers;
        default: return 0;
      }
    };

    let rows = [...groups.values()].map((g) => ({ keys: g.keys, t: g.t, metrics: metNames.map((n) => value(g.t, n)) }));
    rows = rows.filter((r) => matchesMetricFilter(req.metricFilter, (n) => r.metrics[metNames.indexOf(n)] ?? 0));
    const order = req.orderBys[0];
    if (order) {
      const mi = order.metric ? metNames.indexOf(order.metric.metricName) : -1;
      const di = order.dimension ? dimNames.indexOf(order.dimension.dimensionName) : -1;
      const sign = order.desc ? -1 : 1;
      rows.sort((a, b) => sign * (mi >= 0 ? a.metrics[mi]! - b.metrics[mi]! : (a.keys[di] ?? "").localeCompare(b.keys[di] ?? "")) || a.keys.join().localeCompare(b.keys.join()));
    }
    const total = rows.length;
    // Like Google, totals cover every matching row, not only the returned page; rates are recomputed, not summed.
    const grand = zero();
    for (const r of rows) for (const k of Object.keys(grand) as Array<keyof Totals>) grand[k] += r.t[k];
    const totals = req.metricAggregations?.includes("TOTAL") && total > 0 ? metNames.map((n) => String(Number(value(grand, n).toFixed(6)))) : null;
    const offset = Number(req.offset);
    rows = rows.slice(offset, offset + Number(req.limit));

    this.tokensUsed += 10;
    const response: Ga4RunReportResponse = {
      dimensionHeaders: dimNames,
      metricHeaders: req.metrics.map((m) => ({ name: m.name, type: mets.find((x) => x.apiName === m.name)!.type })),
      rows: rows.map((r) => ({ dimensions: r.keys, metrics: r.metrics.map((v) => String(Number.isInteger(v) ? v : Number(v.toFixed(6)))) })),
      rowCount: total,
      timeZone: tz,
      currencyCode: "USD",
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
      sampling: [],
      restrictedMetrics: [],
      hasEmptyReason: total === 0,
      totals,
      quota: {
        tokensPerDay: { consumed: this.tokensUsed, remaining: 200_000 - this.tokensUsed },
        tokensPerHour: { consumed: this.tokensUsed, remaining: 40_000 - this.tokensUsed },
        concurrentRequests: { consumed: 0, remaining: 10 },
      },
    };
    return { ...response, ...this.override };
  }

  /** Cohort retention fixture: each cohort shrinks period by period, deterministically. */
  private cohortReport(propertyId: string, req: Ga4RunReportRequest): Ga4RunReportResponse {
    const spec = req.cohortSpec!;
    const nth = req.dimensions[1]?.name ?? "cohortNthWeek";
    const metric = req.metrics[0]!.name;
    if (!["cohortActiveUsers", "cohortTotalUsers"].includes(metric) || req.dimensions[0]?.name !== "cohort" || !/^cohortNth(Day|Week|Month)$/.test(nth)) throw new Ga4ApiError("invalid_request", 400);
    const rows: Array<{ dimensions: string[]; metrics: string[] }> = [];
    for (const c of spec.cohorts) {
      if (!matchesDimensionFilter(req.dimensionFilter, () => "")) continue;
      const size = 200 + Math.floor(hash(`c|${propertyId}|${c.name}`) * 800);
      for (let n = spec.cohortsRange.startOffset; n <= spec.cohortsRange.endOffset; n++) {
        const decay = n === 0 ? 1 : 0.55 ** n * (0.8 + hash(`d|${c.name}|${n}`) * 0.4);
        rows.push({ dimensions: [c.name, String(n).padStart(4, "0")], metrics: [String(metric === "cohortTotalUsers" ? size : Math.round(size * decay))] });
      }
    }
    return {
      dimensionHeaders: ["cohort", nth],
      metricHeaders: [{ name: metric, type: "TYPE_INTEGER" }],
      rows,
      rowCount: rows.length,
      timeZone: this.timeZones[propertyId] ?? "UTC",
      currencyCode: "USD",
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
      sampling: [],
      restrictedMetrics: [],
      hasEmptyReason: rows.length === 0,
      totals: null,
      quota: {},
      ...this.override,
    };
  }

  async runRealtimeReport(accessToken: string, propertyId: string, req: Ga4RealtimeRequest): Promise<Ga4RunReportResponse> {
    this.enter("runRealtimeReport", accessToken, propertyId, req);
    this.requireAccess(propertyId);
    const dimNames = req.dimensions.map((d) => d.name);
    const metNames = req.metrics.map((m) => m.name);
    if (dimNames.some((n) => !REALTIME_DIMS.includes(n)) || metNames.some((n) => !REALTIME_METS.includes(n))) throw new Ga4ApiError("invalid_request", 400);
    const window = (req.minuteRanges[0]?.startMinutesAgo ?? 29) + 1;
    const nowMs = this.now().getTime();
    const bucket = Math.floor(nowMs / 60_000);
    const groups = new Map<string, { keys: string[]; users: number; views: number; events: number; keyEvents: number }>();
    for (let f = 0; f < 40; f++) {
      const attr = (n: string): string =>
        n === "minutesAgo" ? String(f % window).padStart(2, "0")
        : n === "unifiedScreenName" ? pick("pageTitle", f, propertyId)
        : VALUES[n] ? pick(n, f, propertyId)
        : "(not set)";
      if (!matchesDimensionFilter(req.dimensionFilter, attr)) continue;
      const seed = hash(`rt|${propertyId}|${f}|${bucket}`);
      const users = 1 + Math.floor(seed * 5);
      const keys = dimNames.map(attr);
      const id = keys.join("\u0000");
      const g = groups.get(id) ?? { keys, users: 0, views: 0, events: 0, keyEvents: 0 };
      g.users += users;
      g.views += users * 2;
      g.events += users * 7;
      g.keyEvents += seed > 0.8 ? 1 : 0;
      groups.set(id, g);
    }
    const val = (g: { users: number; views: number; events: number; keyEvents: number }, n: string) => (n === "activeUsers" ? g.users : n === "screenPageViews" ? g.views : n === "eventCount" ? g.events : g.keyEvents);
    let rows = [...groups.values()].map((g) => ({ keys: g.keys, g, metrics: metNames.map((n) => val(g, n)) }));
    const order = req.orderBys[0];
    const mi = order?.metric ? metNames.indexOf(order.metric.metricName) : 0;
    rows.sort((a, b) => (b.metrics[Math.max(mi, 0)]! - a.metrics[Math.max(mi, 0)]!) || a.keys.join().localeCompare(b.keys.join()));
    const total = rows.length;
    const sum = { users: 0, views: 0, events: 0, keyEvents: 0 };
    for (const r of rows) (sum.users += r.g.users, sum.views += r.g.views, sum.events += r.g.events, sum.keyEvents += r.g.keyEvents);
    rows = rows.slice(0, Number(req.limit));
    return {
      dimensionHeaders: dimNames,
      metricHeaders: metNames.map((name) => ({ name, type: "TYPE_INTEGER" })),
      rows: rows.map((r) => ({ dimensions: r.keys, metrics: r.metrics.map(String) })),
      rowCount: total,
      timeZone: null,
      currencyCode: null,
      subjectToThresholding: false,
      dataLossFromOtherRow: false,
      sampling: [],
      restrictedMetrics: [],
      hasEmptyReason: total === 0,
      totals: total > 0 ? metNames.map((n) => String(val(sum, n))) : null,
      quota: {},
      ...this.override,
    };
  }
}


const REALTIME_DIMS = ["appVersion", "city", "country", "deviceCategory", "eventName", "minutesAgo", "platform", "streamName", "unifiedScreenName", "audienceName"];
const REALTIME_METS = ["activeUsers", "conversions", "eventCount", "keyEvents", "screenPageViews"];

function leaf(f: Ga4Filter["filter"], dimValue: (n: string) => string): boolean {
  if ("inListFilter" in f) return f.inListFilter.values.map((v) => v.toLowerCase()).includes(dimValue(f.fieldName).toLowerCase());
  if (!("stringFilter" in f)) return true;
  const v = dimValue(f.fieldName).toLowerCase();
  const x = f.stringFilter.value.toLowerCase();
  switch (f.stringFilter.matchType) {
    case "EXACT": return v === x;
    case "BEGINS_WITH": return v.startsWith(x);
    case "ENDS_WITH": return v.endsWith(x);
    case "CONTAINS": return v.includes(x);
    case "FULL_REGEXP": return new RegExp(`^(?:${x})$`, "i").test(dimValue(f.fieldName));
    case "PARTIAL_REGEXP": return new RegExp(x, "i").test(dimValue(f.fieldName));
    default: return true;
  }
}

/** Evaluates a filter tree (AND, OR, NOT and leaves) the way Google does. */
function evaluate(expr: Ga4FilterExpression, test: (f: Ga4Filter["filter"]) => boolean): boolean {
  if (expr.andGroup) return expr.andGroup.expressions.every((e) => evaluate(e, test));
  if (expr.orGroup) return expr.orGroup.expressions.some((e) => evaluate(e, test));
  if (expr.notExpression) return !evaluate(expr.notExpression, test);
  return expr.filter ? test(expr.filter) : true;
}

function matchesDimensionFilter(expr: Ga4FilterExpression | undefined, dimValue: (n: string) => string): boolean {
  return !expr || evaluate(expr, (f) => leaf(f, dimValue));
}

function matchesMetricFilter(expr: Ga4FilterExpression | undefined, metric: (n: string) => number): boolean {
  if (!expr) return true;
  return evaluate(expr, (f) => {
    if (!("numericFilter" in f)) return true;
    const v = metric(f.fieldName);
    const x = f.numericFilter.value.doubleValue;
    switch (f.numericFilter.operation) {
      case "EQUAL": return v === x;
      case "GREATER_THAN": return v > x;
      case "GREATER_THAN_OR_EQUAL": return v >= x;
      case "LESS_THAN": return v < x;
      case "LESS_THAN_OR_EQUAL": return v <= x;
      default: return true;
    }
  });
}
