import { BingApiError, type BingApiClient, type BingCrawlRow, type BingQueryRow, type BingRows, type BingSite, type BingTrafficRow } from "./client.js";
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

  private assertKnown(siteUrl: string) {
    if (!this.sites.some((s) => s.url === siteUrl)) throw new BingApiError("not_found", 400, 14);
  }
}
