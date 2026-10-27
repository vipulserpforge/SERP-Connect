import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type BingOwner = "alice" | "bob";

export interface BingCall {
  kind: "api" | "token";
  endpoint: string;
  method: string;
  /** How the caller authenticated. `apikey` means the documented query parameter, `bearer` the Authorization header. */
  via: "apikey" | "bearer" | "none";
  owner: BingOwner | null;
  /** Query parameter names seen (values are never recorded, so the API key cannot end up in a test log). */
  queryNames: string[];
  grantType?: string;
}

/** The date format Bing sends: /Date(ms-0700)/, midnight local at -07:00. */
export const bingDate = (isoDay: string) => `/Date(${Date.parse(`${isoDay}T07:00:00Z`)}-0700)/`;

const SITES: Record<BingOwner, Array<{ Url: string; IsVerified: boolean }>> = {
  alice: [
    { Url: "https://alice.example/", IsVerified: true },
    { Url: "https://alice-unverified.example/", IsVerified: false },
  ],
  bob: [{ Url: "https://bob.example/", IsVerified: true }],
};
const CLICKS: Record<BingOwner, number> = { alice: 111, bob: 222 };

/**
 * A local stand-in for the Bing Webmaster JSON API and its OAuth token endpoint. It is NOT Bing: it only mimics the documented
 * shapes our clients parse. It knows which Bing account owns each API key / access token and answers with data that names that
 * account (Alice's clicks are 111, Bob's 222), so a test can tell whose credentials reached Bing.
 */
export class FakeBing {
  readonly apiKeys = new Map<string, BingOwner>();
  readonly accessTokens = new Map<string, BingOwner>();
  readonly refreshTokens = new Map<string, BingOwner>();
  readonly revokedRefreshTokens = new Set<string>();
  readonly codes = new Map<string, BingOwner>();
  readonly calls: BingCall[] = [];
  /** Registered OAuth client, as in Bing Webmaster Tools > API Access. */
  client = { id: "bing-client-id", secret: "bing-client-secret", redirectUri: "http://localhost/api/oauth/bing/callback" };
  expiresIn = 3600;
  /** Whether the token endpoint puts a refresh_token in refresh responses (the documentation shows none). */
  rotateRefreshToken = false;
  tokenDelayMs = 0;
  /** Force the next API calls (any endpoint containing `endpoint`) to fail. */
  fail: { endpoint: string; status: number; body?: unknown; headers?: Record<string, string>; times?: number } | null = null;
  /** Raw values of the JSON-string arguments (query, page, url, link) exactly as received. */
  readonly rawParams: Array<{ endpoint: string; name: string; value: string }> = [];
  /** JSON bodies received by POST methods (GetChildrenUrlInfo). */
  readonly postBodies: Array<{ endpoint: string; body: unknown }> = [];
  /** TotalPages reported by GetLinkCounts. */
  linkPages = 1;
  /** Today's date for generated rows. */
  today = "2026-10-19";
  base = "";
  private n = 0;
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
  get apiBase() {
    return `${this.base}/webmaster/api.svc/json/`;
  }
  get tokenEndpoint() {
    return `${this.base}/webmasters/oauth/token`;
  }

  /** Simulates the user approving the consent screen: returns the authorization code Bing would redirect back with. */
  approve(owner: BingOwner): string {
    const code = `code-${owner}-${++this.n}`;
    this.codes.set(code, owner);
    return code;
  }

  private body(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  }

  private send(res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url ?? "/", this.base);
    if (url.pathname.endsWith("/oauth/token")) return this.token(req, res);
    let postBody: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        postBody = JSON.parse(await this.body(req)) as Record<string, unknown>;
      } catch {
        postBody = {};
      }
    }
    const endpoint = url.pathname.split("/").pop() ?? "";
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const key = url.searchParams.get("apikey");
    const owner = bearer ? (this.accessTokens.get(bearer) ?? null) : key ? (this.apiKeys.get(key) ?? null) : null;
    this.calls.push({ kind: "api", endpoint, method: req.method ?? "", via: bearer ? "bearer" : key ? "apikey" : "none", owner, queryNames: [...url.searchParams.keys()] });

    if (this.fail && endpoint.includes(this.fail.endpoint)) {
      const f = this.fail;
      if (f.times !== undefined && --f.times <= 0) this.fail = null;
      return this.send(res, f.status, f.body ?? {}, f.headers);
    }
    if (!owner) {
      // Documented: errors are HTTP 400 with {ErrorCode, Message}; InvalidApiKey is code 3. A bad bearer token is a 401.
      return bearer ? this.send(res, 401, { Message: "Unauthorized" }) : this.send(res, 400, { ErrorCode: 3, Message: "InvalidApiKey" });
    }
    if (endpoint === "GetUserSites") return this.send(res, 200, { d: SITES[owner].map((s) => ({ __type: "Site:#Microsoft.Bing.Webmaster.Api", AuthenticationCode: "OWNERSHIPCODE0000", DnsVerificationCode: "dns.ownershipcode.example", ...s })) });

    const day = (back: number) => new Date(Date.parse(`${this.today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
    if (endpoint === "GetKeywordStats") {
      const q = url.searchParams.get("q") ?? "";
      return this.send(res, 200, { d: [0, 1].map((i) => ({ Query: q, Date: bingDate(day(7 * (i + 1))), Impressions: 1000 * (i + 1), BroadImpressions: 4000 })) });
    }
    for (const kw of ["GetKeyword", "GetRelatedKeywords"]) {
      if (endpoint !== kw) continue;
      for (const name of ["q", "country", "language", "startDate", "endDate"]) this.rawParams.push({ endpoint, name, value: url.searchParams.get(name) ?? "" });
      const q = url.searchParams.get("q") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("startDate") ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("endDate") ?? "")) return this.send(res, 400, { ErrorCode: 8, Message: "ERROR!!! InvalidParameter" });
      // The live API sends no Date on these.
      if (kw === "GetKeyword") return this.send(res, 200, { d: { __type: "Keyword:#Microsoft.Bing.Webmaster.Api", Query: q, Impressions: 700, BroadImpressions: 2800 } });
      return this.send(res, 200, { d: [`${q} cheap`, `${q} best`].map((k, i) => ({ Query: k, Impressions: 500 - i * 100, BroadImpressions: 2000 })) });
    }
    if ([...url.searchParams].some(([k, v]) => k !== "apikey" && /^".*"$/.test(v))) return this.send(res, 400, { ErrorCode: 7, Message: "ERROR!!! InvalidUrl" });
    const site = (url.searchParams.get("siteUrl") ?? (typeof postBody.siteUrl === "string" ? postBody.siteUrl : null));
    if (!site || !SITES[owner].some((s) => s.Url === site && s.IsVerified)) return this.send(res, 400, { ErrorCode: 14, Message: "NotAuthorized" });
    if (endpoint === "GetRankAndTrafficStats") {
      return this.send(res, 200, { d: Array.from({ length: 40 }, (_, i) => ({ __type: "RankAndTrafficStats:#Microsoft.Bing.Webmaster.Api", Clicks: CLICKS[owner], Date: bingDate(day(i + 1)), Impressions: CLICKS[owner] * 10 })) });
    }
    if (endpoint === "GetQueryStats") {
      return this.send(res, 200, { d: [0, 1, 2].map((i) => ({ Query: `${owner} query ${i}`, Clicks: CLICKS[owner] + i, Impressions: 1000, AvgClickPosition: 3.5, AvgImpressionPosition: 4.5, Date: bingDate(day(7 * (i + 1))) })) });
    }
    if (endpoint === "GetCrawlStats") {
      return this.send(res, 200, { d: Array.from({ length: 10 }, (_, i) => ({ Date: bingDate(day(i + 1)), CrawledPages: CLICKS[owner], CrawlErrors: 0, InIndex: 5000, Code2xx: 90 })) });
    }
    const param = (name: string) => {
      const v = url.searchParams.get(name);
      if (v === null) return null;
      // The live API wants these arguments bare (a JSON-quoted value is rejected), so a quoted one is refused here too.
      this.rawParams.push({ endpoint, name, value: v });
      return v;
    };
    const pageRows = (labelPrefix: string, label: string) =>
      [0, 1, 2].map((i) => ({ Query: `${labelPrefix}${label}${i}`, Clicks: CLICKS[owner] + i, Impressions: 1000 + i, AvgClickPosition: 3.5, AvgImpressionPosition: 4.5, Date: bingDate(day(7 * (i + 1))) }));
    if (endpoint === "GetPageStats") return this.send(res, 200, { d: [0, 1, 2].map((i) => ({ Query: i === 2 ? `${site}page1/` : `${site}page${i}`, Clicks: CLICKS[owner] + i, Impressions: 1000, AvgClickPosition: 3.5, AvgImpressionPosition: 4.5, Date: bingDate(day(7 * (i + 1))) })) });
    if (endpoint === "GetQueryPageStats") return this.send(res, 200, { d: pageRows(site, `for-${param("query")}-`) });
    if (endpoint === "GetPageQueryStats") return this.send(res, 200, { d: pageRows(`${owner} `, `on-${(param("page") ?? "").replace(/\W+/g, "-")}-`) });
    if (endpoint === "GetQueryPageDetailStats") return this.send(res, 200, { d: [0, 1].map((i) => ({ Clicks: 5 + i, Impressions: 50, Position: 4, Date: bingDate(day(7 * (i + 1))) })) });
    if (endpoint === "GetCrawlIssues") return this.send(res, 200, { d: [{ HttpCode: 404, Issues: 4, Url: `${site}gone`, InLinks: 9 }, { HttpCode: 200, Issues: 32, Url: `${site}bad/`, InLinks: 1 }] });
    if (endpoint === "GetBlockedUrls") return this.send(res, 200, { d: [{ Date: bingDate(day(30)), EntityType: 0, RequestType: 1, Url: `${site}private` }] });
    if (endpoint === "GetLinkCounts") {
      const page = Number(url.searchParams.get("page") ?? "0");
      return this.send(res, 200, { d: { Links: [{ Count: 14 + page, Url: `${site}p${page}` }, { Count: 1, Url: `${site}p${page}/` }], TotalPages: this.linkPages } });
    }
    if (endpoint === "GetUrlLinks") return this.send(res, 200, { d: { Details: [{ AnchorText: `for ${param("link")}`, Url: "https://linker.example/x" }], TotalPages: 1 } });
    if (endpoint === "GetFeeds") return this.send(res, 200, { d: [{ Compressed: false, FileSize: 1024, LastCrawled: bingDate(day(2)), Status: "Success", Submitted: bingDate(day(30)), Type: "Sitemap", Url: `${site}sitemap.xml`, UrlCount: 1023 }] });
    if (endpoint === "GetUrlInfo") return this.send(res, 200, { d: { AnchorCount: 5, DiscoveryDate: bingDate(day(90)), DocumentSize: 100, HttpStatus: 200, IsPage: true, LastCrawledDate: bingDate(day(3)), TotalChildUrlCount: 0, Url: param("url") } });
    if (endpoint === "GetUrlTrafficInfo") return this.send(res, 200, { d: { Clicks: CLICKS[owner], Impressions: 900, IsPage: true, Url: param("url") } });
    if (endpoint === "GetUrlSubmissionQuota") return this.send(res, 200, { d: { DailyQuota: 5, MonthlyQuota: 24 } });
    if (endpoint === "GetQueryTrafficStats") return param("query") === null ? this.send(res, 400, { ErrorCode: 8, Message: "InvalidParameter" }) : this.send(res, 200, { d: Array.from({ length: 5 }, (_, i) => ({ Clicks: 3 + i, Date: bingDate(day(i + 1)), Impressions: 30 })) });
    if (endpoint === "GetChildrenUrlInfo") {
      this.postBodies.push({ endpoint, body: postBody });
      const page = Number(postBody.page ?? 0);
      return this.send(res, 200, { d: page === 0 ? [{ AnchorCount: 50, DiscoveryDate: bingDate(day(90)), DocumentSize: 0, HttpStatus: 0, IsPage: false, LastCrawledDate: bingDate(day(2)), TotalChildUrlCount: 100, Url: `${site}blog/` }] : [] });
    }
    if (endpoint === "GetChildrenUrlTrafficInfo") {
      const page = Number(url.searchParams.get("page") ?? "0");
      return this.send(res, 200, { d: page === 0 ? [{ Clicks: 10, Impressions: 100, IsPage: false, Url: param("url") }] : [] });
    }
    if (endpoint === "GetCrawlSettings") return this.send(res, 200, { d: { __type: "CrawlSettings:#Microsoft.Bing.Webmaster.Api", CrawlBoostAvailable: false, CrawlBoostEnabled: false, CrawlRate: Array.from({ length: 24 }, () => 5) } });
    if (endpoint === "GetFeedDetails") return this.send(res, 200, { d: [{ Compressed: false, FileSize: 2048, LastCrawled: bingDate(day(2)), Status: "Success", Submitted: bingDate(day(30)), Type: "Sitemap", Url: `${param("feedUrl")}`, UrlCount: 12 }] });
    if (endpoint === "GetDeepLinkBlocks") return this.send(res, 200, { d: [{ __type: "DeepLinkBlock:#Microsoft.Bing.Webmaster.Shared.DataContracts", Url: `${site}checkout`, Date: bingDate(day(20)), AuthenticationCode: "LEAKME-OWNERSHIP" }] });
    if (endpoint === "GetActivePagePreviewBlocks") return this.send(res, 200, { d: [] });
    if (endpoint === "GetCountryRegionSettings") return this.send(res, 200, { d: [{ Date: bingDate(day(100)), TwoLetterISORegionName: "IN", Type: 0, Url: site }] });
    if (endpoint === "GetQueryParameters") return this.send(res, 200, { d: [{ Date: "/Date(1314031258933)/", IsEnabled: false, Parameter: "cart", Source: 1 }] });
    if (endpoint === "GetConnectedPages") return this.send(res, 200, { d: [{ Name: "Example page", Url: "https://social.example/p" }] });
    if (endpoint === "GetSiteMoves") return this.send(res, 200, { d: [] });
    if (endpoint === "GetSiteRoles") {
      this.rawParams.push({ endpoint, name: "includeAllSubdomains", value: url.searchParams.get("includeAllSubdomains") ?? "" });
      return this.send(res, 200, { d: [{ Date: bingDate(day(300)), DelegatedCode: "LEAKME-DELEGATED-258CAD36", DelegatedCodeOwnerEmail: `${owner}@example.com`, DelegatorEmail: `${owner}@example.com`, Email: `${owner}@example.com`, Expired: false, Role: 2, Site: site, VerificationSite: site }, { Date: bingDate(day(200)), DelegatedCode: "LEAKME-DELEGATED-2", DelegatedCodeOwnerEmail: `${owner}@example.com`, DelegatorEmail: `${owner}@example.com`, Email: `reader-${owner}@example.com`, Expired: false, Role: 0, Site: site, VerificationSite: site }] });
    }
    if (endpoint === "GetContentSubmissionQuota") return this.send(res, 200, { d: { DailyQuota: 100, MonthlyQuota: 3000 } });
    return this.send(res, 404, {});
  }

  private async token(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const form = new URLSearchParams(await this.body(req));
    const grantType = form.get("grant_type") ?? "";
    this.calls.push({ kind: "token", endpoint: "token", method: req.method ?? "", via: "none", owner: null, queryNames: [...form.keys()], grantType });
    if (this.tokenDelayMs) await new Promise((r) => setTimeout(r, this.tokenDelayMs));
    if (form.get("client_id") !== this.client.id || form.get("client_secret") !== this.client.secret) return this.send(res, 401, { error: "invalid_client" });

    const issue = (owner: BingOwner, withRefresh: boolean) => {
      const access = `access-${owner}-${++this.n}`;
      this.accessTokens.set(access, owner);
      let refresh: string | undefined;
      if (withRefresh) {
        refresh = `refresh-${owner}-${++this.n}`;
        this.refreshTokens.set(refresh, owner);
      }
      return { access_token: access, token_type: "bearer", expires_in: this.expiresIn, ...(refresh && { refresh_token: refresh }) };
    };

    if (grantType === "authorization_code") {
      const owner = this.codes.get(form.get("code") ?? "");
      if (!owner || form.get("redirect_uri") !== this.client.redirectUri) return this.send(res, 400, { error: "invalid_grant" });
      this.codes.delete(form.get("code")!); // single use
      return this.send(res, 200, issue(owner, true));
    }
    if (grantType === "refresh_token") {
      const rt = form.get("refresh_token") ?? "";
      const owner = this.refreshTokens.get(rt);
      if (!owner || this.revokedRefreshTokens.has(rt)) return this.send(res, 400, { error: "invalid_grant" });
      return this.send(res, 200, issue(owner, this.rotateRefreshToken));
    }
    return this.send(res, 400, { error: "unsupported_grant_type" });
  }
}
