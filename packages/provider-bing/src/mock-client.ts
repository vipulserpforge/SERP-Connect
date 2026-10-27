import {
  BingApiError,
  type BingApiClient,
  type BingBlockedUrlRow,
  type BingContentQuota,
  type BingCrawlSettings,
  type BingKeywordPoint,
  type BingLooseRow,
  type BingQueryParameterRow,
  type BingSiteRoleRow,
  type BingUrlFilter,
  type BingCrawlIssueRow,
  type BingCrawlRow,
  type BingFeedRow,
  type BingKeywordRow,
  type BingLinkCountsPage,
  type BingLinkDetailsPage,
  type BingPageRow,
  type BingQueryPageDetailRow,
  type BingQueryRow,
  type BingRows,
  type BingSite,
  type BingSubmissionQuota,
  type BingTrafficRow,
  type BingUrlInfo,
  type BingUrlTrafficInfo,
} from "./client.js";
import type { BingAuth } from "./constants.js";

/** Obviously fake credentials the mock treats as rejected, so tests and the demo can exercise the failure paths. */
export const MOCK_BING_REJECTED_KEY = "rejectedrejectedrejected0000000000";
export const MOCK_BING_REJECTED_TOKEN_PREFIX = "mock-bing-expired";

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
const wave = (i: number, seed: number) => Math.abs(Math.round(Math.sin(i * 1.7 + seed) * 40 + 60));

/** Deterministic fixture data. Never contacts Bing. Sites: one verified (both domains) and one unverified. */
export class MockBingApiClient implements BingApiClient {
  readonly mock = true;
  calls: Array<{ endpoint: string; method: BingAuth["method"] }> = [];
  failWith: BingApiError | null = null;
  sites: BingSite[] = [
    { url: "https://www.example.com/", isVerified: true },
    { url: "https://blog.example.com/", isVerified: true },
    { url: "https://pending.example.org/", isVerified: false },
  ];

  constructor(private readonly now: () => Date = () => new Date()) {}

  private guard(auth: BingAuth, endpoint: string) {
    this.calls.push({ endpoint, method: auth.method });
    if (this.failWith) throw this.failWith;
    if (auth.method === "api_key" && auth.apiKey === MOCK_BING_REJECTED_KEY) throw new BingApiError("unauthenticated", 400, 3);
    if (auth.method === "oauth" && auth.accessToken.startsWith(MOCK_BING_REJECTED_TOKEN_PREFIX)) throw new BingApiError("unauthenticated", 401);
  }

  async getUserSites(auth: BingAuth) {
    this.guard(auth, "GetUserSites");
    return this.sites.map((s) => ({ ...s }));
  }

  async getRankAndTrafficStats(auth: BingAuth, siteUrl: string): Promise<BingRows<BingTrafficRow>> {
    this.guard(auth, "GetRankAndTrafficStats");
    this.assertKnown(siteUrl);
    const today = this.now();
    return { rows: Array.from({ length: 45 }, (_, i) => ({ date: addDays(today, -(i + 1)), clicks: wave(i, 1), impressions: wave(i, 2) * 20 })), skipped: 0 };
  }

  async getQueryStats(auth: BingAuth, siteUrl: string): Promise<BingRows<BingQueryRow>> {
    this.guard(auth, "GetQueryStats");
    this.assertKnown(siteUrl);
    const today = this.now();
    const queries = ["blue widgets", "widget repair", "buy widgets online", "widget size chart"];
    const rows: BingQueryRow[] = [];
    queries.forEach((query, q) => {
      for (let w = 0; w < 4; w++) {
        rows.push({ query, date: addDays(today, -(7 * (w + 1))), clicks: wave(w + q, 3), impressions: wave(w + q, 4) * 15, avgClickPosition: 3 + q + w * 0.5, avgImpressionPosition: 4 + q + w * 0.5 });
      }
    });
    return { rows, skipped: 0 };
  }

  async getCrawlStats(auth: BingAuth, siteUrl: string): Promise<BingRows<BingCrawlRow>> {
    this.guard(auth, "GetCrawlStats");
    this.assertKnown(siteUrl);
    const today = this.now();
    return {
      rows: Array.from({ length: 30 }, (_, i) => ({
        date: addDays(today, -(i + 1)),
        crawledPages: wave(i, 5) * 10,
        crawlErrors: i % 9 === 0 ? 3 : 0,
        inIndex: 1200 + i,
        inLinks: 340,
        code2xx: wave(i, 6) * 9,
        code301: 4,
        code302: 0,
        code4xx: 2,
        code5xx: 0,
        allOtherCodes: 0,
        blockedByRobotsTxt: 1,
        containsMalware: 0,
      })),
      skipped: 0,
    };
  }

  async getPageStats(auth: BingAuth, siteUrl: string): Promise<BingRows<BingPageRow>> {
    this.guard(auth, "GetPageStats");
    this.assertKnown(siteUrl);
    return { rows: this.pageRows(siteUrl, ["/", "/widgets", "/widgets/", "/widgets?ref=a#top", "/repair"]), skipped: 0 };
  }

  async getQueryPageStats(auth: BingAuth, siteUrl: string, _query: string): Promise<BingRows<BingPageRow>> {
    this.guard(auth, "GetQueryPageStats");
    this.assertKnown(siteUrl);
    return { rows: this.pageRows(siteUrl, ["/widgets", "/repair"]), skipped: 0 };
  }

  async getPageQueryStats(auth: BingAuth, siteUrl: string, _page: string): Promise<BingRows<BingQueryRow>> {
    this.guard(auth, "GetPageQueryStats");
    this.assertKnown(siteUrl);
    return this.getQueryStats(auth, siteUrl);
  }

  async getQueryPageDetailStats(auth: BingAuth, siteUrl: string): Promise<BingRows<BingQueryPageDetailRow>> {
    this.guard(auth, "GetQueryPageDetailStats");
    this.assertKnown(siteUrl);
    const today = this.now();
    return { rows: Array.from({ length: 4 }, (_, w) => ({ date: addDays(today, -(7 * (w + 1))), clicks: wave(w, 7), impressions: wave(w, 8) * 10, position: 4 + w * 0.5 })), skipped: 0 };
  }

  async getCrawlIssues(auth: BingAuth, siteUrl: string): Promise<BingRows<BingCrawlIssueRow>> {
    this.guard(auth, "GetCrawlIssues");
    this.assertKnown(siteUrl);
    return {
      rows: [
        { url: `${siteUrl}old-page`, httpCode: 404, issues: 4, inLinks: 12 },
        { url: `${siteUrl}broken/`, httpCode: 500, issues: 8, inLinks: 3 },
      ],
      skipped: 0,
    };
  }

  async getBlockedUrls(auth: BingAuth, siteUrl: string): Promise<BingRows<BingBlockedUrlRow>> {
    this.guard(auth, "GetBlockedUrls");
    this.assertKnown(siteUrl);
    return { rows: [{ url: `${siteUrl}private/`, date: addDays(this.now(), -30), entityType: 1, requestType: 1 }], skipped: 0 };
  }

  async getLinkCounts(auth: BingAuth, siteUrl: string, page: number): Promise<BingLinkCountsPage> {
    this.guard(auth, "GetLinkCounts");
    this.assertKnown(siteUrl);
    const all = [
      { url: `${siteUrl}`, count: 320 },
      { url: `${siteUrl}widgets`, count: 90 },
      { url: `${siteUrl}widgets/`, count: 10 },
      { url: `${siteUrl}repair`, count: 25 },
    ];
    return { links: page === 0 ? all : [], totalPages: 1 };
  }

  async getUrlLinks(auth: BingAuth, siteUrl: string, _link: string, page: number): Promise<BingLinkDetailsPage> {
    this.guard(auth, "GetUrlLinks");
    this.assertKnown(siteUrl);
    return { details: page === 0 ? [{ url: "https://news.example.net/a", anchorText: "blue widgets" }, { url: "https://blog.example.org/b", anchorText: null }] : [], totalPages: 1 };
  }

  async getFeeds(auth: BingAuth, siteUrl: string): Promise<BingRows<BingFeedRow>> {
    this.guard(auth, "GetFeeds");
    this.assertKnown(siteUrl);
    const today = this.now();
    return {
      rows: [
        { url: `${siteUrl}sitemap.xml`, type: "Sitemap", status: "Success", submitted: addDays(today, -60), lastCrawled: addDays(today, -2), urlCount: 1023, fileSize: 40960, compressed: false },
        { url: `${siteUrl}news-sitemap.xml`, type: "Sitemap", status: "Pending", submitted: addDays(today, -1), lastCrawled: null, urlCount: null, fileSize: null, compressed: false },
      ],
      skipped: 0,
    };
  }

  async getUrlInfo(auth: BingAuth, siteUrl: string, url: string): Promise<BingUrlInfo | null> {
    this.guard(auth, "GetUrlInfo");
    this.assertKnown(siteUrl);
    return { url, isPage: true, httpStatus: 200, documentSize: 51200, anchorCount: 40, totalChildUrlCount: 0, discoveryDate: addDays(this.now(), -200), lastCrawledDate: addDays(this.now(), -3) };
  }

  async getUrlTrafficInfo(auth: BingAuth, siteUrl: string, url: string): Promise<BingUrlTrafficInfo | null> {
    this.guard(auth, "GetUrlTrafficInfo");
    this.assertKnown(siteUrl);
    return { url, isPage: true, clicks: 42, impressions: 1800 };
  }

  async getUrlSubmissionQuota(auth: BingAuth, siteUrl: string): Promise<BingSubmissionQuota | null> {
    this.guard(auth, "GetUrlSubmissionQuota");
    this.assertKnown(siteUrl);
    return { dailyQuota: 100, monthlyQuota: 3000 };
  }

  async getKeywordStats(auth: BingAuth, query: string): Promise<BingRows<BingKeywordRow>> {
    this.guard(auth, "GetKeywordStats");
    return { rows: Array.from({ length: 4 }, (_, w) => ({ query, date: addDays(this.now(), -(7 * (w + 1))), impressions: wave(w, 9) * 100, broadImpressions: wave(w, 10) * 400 })), skipped: 0 };
  }

  async getQueryTrafficStats(auth: BingAuth, siteUrl: string, _query: string): Promise<BingRows<BingTrafficRow>> {
    this.guard(auth, "GetQueryTrafficStats");
    this.assertKnown(siteUrl);
    return { rows: Array.from({ length: 10 }, (_, i) => ({ date: addDays(this.now(), -(i + 1)), clicks: wave(i, 13), impressions: wave(i, 14) * 5 })), skipped: 0 };
  }

  async getChildrenUrlInfo(auth: BingAuth, siteUrl: string, url: string, page: number, _filter: BingUrlFilter): Promise<BingRows<BingUrlInfo>> {
    this.guard(auth, "GetChildrenUrlInfo");
    this.assertKnown(siteUrl);
    const base = url.replace(/\/$/, "");
    const rows: BingUrlInfo[] = page === 0
      ? [
          { url: `${base}/widgets`, isPage: true, httpStatus: 200, documentSize: 40000, anchorCount: 12, totalChildUrlCount: 0, discoveryDate: addDays(this.now(), -100), lastCrawledDate: addDays(this.now(), -4) },
          { url: `${base}/blog/`, isPage: false, httpStatus: 0, documentSize: 0, anchorCount: 50, totalChildUrlCount: 100, discoveryDate: addDays(this.now(), -300), lastCrawledDate: addDays(this.now(), -2) },
        ]
      : [];
    return { rows, skipped: 0 };
  }

  async getChildrenUrlTrafficInfo(auth: BingAuth, siteUrl: string, url: string, page: number): Promise<BingRows<BingUrlTrafficInfo>> {
    this.guard(auth, "GetChildrenUrlTrafficInfo");
    this.assertKnown(siteUrl);
    const base = url.replace(/\/$/, "");
    return { rows: page === 0 ? [{ url: `${base}/widgets`, isPage: true, clicks: 30, impressions: 900 }, { url: `${base}/blog/`, isPage: false, clicks: 10, impressions: 400 }] : [], skipped: 0 };
  }

  async getCrawlSettings(auth: BingAuth, siteUrl: string): Promise<BingCrawlSettings | null> {
    this.guard(auth, "GetCrawlSettings");
    this.assertKnown(siteUrl);
    return { ajaxEnabled: null, crawlBoostAvailable: false, crawlBoostEnabled: false, crawlRate: Array.from({ length: 24 }, () => 5) };
  }

  async getFeedDetails(auth: BingAuth, siteUrl: string, feedUrl: string): Promise<BingRows<BingFeedRow>> {
    this.guard(auth, "GetFeedDetails");
    this.assertKnown(siteUrl);
    return { rows: [{ url: `${feedUrl.replace(/\.xml$/, "")}-1.xml`, type: "Sitemap", status: "Success", submitted: addDays(this.now(), -30), lastCrawled: addDays(this.now(), -3), urlCount: 500, fileSize: 20480, compressed: true }], skipped: 0 };
  }

  async getDeepLinkBlocks(auth: BingAuth, siteUrl: string): Promise<BingRows<BingLooseRow>> {
    this.guard(auth, "GetDeepLinkBlocks");
    this.assertKnown(siteUrl);
    return { rows: [{ url: `${siteUrl}checkout`, date: addDays(this.now(), -20) }], skipped: 0 };
  }

  async getActivePagePreviewBlocks(auth: BingAuth, siteUrl: string): Promise<BingRows<BingLooseRow>> {
    this.guard(auth, "GetActivePagePreviewBlocks");
    this.assertKnown(siteUrl);
    return { rows: [], skipped: 0 };
  }

  async getCountryRegionSettings(auth: BingAuth, siteUrl: string): Promise<BingRows<BingLooseRow>> {
    this.guard(auth, "GetCountryRegionSettings");
    this.assertKnown(siteUrl);
    return { rows: [{ twoLetterIsoRegionName: "US", type: 0, url: siteUrl, date: addDays(this.now(), -90) }], skipped: 0 };
  }

  async getQueryParameters(auth: BingAuth, siteUrl: string): Promise<BingRows<BingQueryParameterRow>> {
    this.guard(auth, "GetQueryParameters");
    this.assertKnown(siteUrl);
    return { rows: [{ parameter: "utm_source", isEnabled: true, source: 1, date: addDays(this.now(), -40) }, { parameter: "cart", isEnabled: false, source: 1, date: addDays(this.now(), -10) }], skipped: 0 };
  }

  async getConnectedPages(auth: BingAuth, siteUrl: string): Promise<BingRows<BingLooseRow>> {
    this.guard(auth, "GetConnectedPages");
    this.assertKnown(siteUrl);
    return { rows: [{ url: "https://www.facebook.com/example", name: "Example" }], skipped: 0 };
  }

  async getSiteMoves(auth: BingAuth, siteUrl: string): Promise<BingRows<BingLooseRow>> {
    this.guard(auth, "GetSiteMoves");
    this.assertKnown(siteUrl);
    return { rows: [], skipped: 0 };
  }

  async getSiteRoles(auth: BingAuth, siteUrl: string, _includeAllSubdomains: boolean): Promise<BingRows<BingSiteRoleRow>> {
    this.guard(auth, "GetSiteRoles");
    this.assertKnown(siteUrl);
    return { rows: [{ email: "owner@example.com", role: 2, site: siteUrl, verificationSite: siteUrl, delegatorEmail: "owner@example.com", delegatedCodeOwnerEmail: "owner@example.com", expired: false, date: addDays(this.now(), -365) }], skipped: 0 };
  }

  async getContentSubmissionQuota(auth: BingAuth, siteUrl: string): Promise<BingContentQuota | null> {
    this.guard(auth, "GetContentSubmissionQuota");
    this.assertKnown(siteUrl);
    return { dailyQuota: 100, monthlyQuota: 3000 };
  }

  async getKeyword(auth: BingAuth, query: string, _country: string, _language: string, startDate: string): Promise<BingRows<BingKeywordPoint>> {
    this.guard(auth, "GetKeyword");
    return { rows: [{ query, date: startDate, impressions: 1200, broadImpressions: 4800 }], skipped: 0 };
  }

  async getRelatedKeywords(auth: BingAuth, query: string, _country: string, _language: string, startDate: string): Promise<BingRows<BingKeywordPoint>> {
    this.guard(auth, "GetRelatedKeywords");
    return { rows: [`${query} price`, `${query} near me`, `best ${query}`].map((q, i) => ({ query: q, date: startDate, impressions: 900 - i * 200, broadImpressions: 3000 - i * 700 })), skipped: 0 };
  }

  private pageRows(siteUrl: string, paths: string[]): BingPageRow[] {
    const today = this.now();
    const rows: BingPageRow[] = [];
    paths.forEach((path, p) => {
      for (let w = 0; w < 8; w++) {
        rows.push({ page: `${siteUrl.replace(/\/$/, "")}${path}`, date: addDays(today, -(7 * (w + 1))), clicks: wave(w + p, 11), impressions: wave(w + p, 12) * 12, avgClickPosition: 3 + p + w * 0.2, avgImpressionPosition: 4 + p + w * 0.2 });
      }
    });
    return rows;
  }

  private assertKnown(siteUrl: string) {
    if (!this.sites.some((s) => s.url === siteUrl)) throw new BingApiError("not_found", 400, 14);
  }
}
