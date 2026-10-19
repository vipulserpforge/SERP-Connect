import { ClarityApiError, type ClarityApiClient, type ClarityExportRequest } from "@serp/provider-clarity";

/** The sample response from Microsoft's documentation (trimmed), used wherever a test needs a realistic body. */
export const SAMPLE_BODY = [
  {
    metricName: "Traffic",
    information: [
      { totalSessionCount: "9554", totalBotSessionCount: "8369", distantUserCount: "189733", PagesPerSessionPercentage: 1.0931, OS: "Other" },
      { totalSessionCount: "291942", totalBotSessionCount: "31076", distantUserCount: "212836", PagesPerSessionPercentage: 2.2609, OS: "Android" },
    ],
  },
  { metricName: "Dead Click Count", information: [{ sessionsCount: "120", sessionsWithMetricPercentage: 3.4, subTotal: "180", OS: "Android" }] },
];

export type Behavior = unknown | ClarityApiError | ((req: ClarityExportRequest) => unknown);

/** Stands in for clarity.ms: records every call (token + parameters) and answers per token. Costs no real quota. */
export class FakeClarityClient implements ClarityApiClient {
  readonly mock = false;
  readonly calls: Array<{ token: string; request: ClarityExportRequest }> = [];
  private readonly byToken = new Map<string, Behavior>();
  default: Behavior = SAMPLE_BODY;
  delayMs = 0;

  when(token: string, behavior: Behavior): this {
    this.byToken.set(token, behavior);
    return this;
  }

  async exportLiveInsights(token: string, request: ClarityExportRequest): Promise<unknown> {
    this.calls.push({ token, request });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const b = this.byToken.get(token) ?? this.default;
    const out = typeof b === "function" ? (b as (r: ClarityExportRequest) => unknown)(request) : b;
    if (out instanceof ClarityApiError) throw out;
    return structuredClone(out);
  }
}

/** A string that passes token validation. Never a real token. */
export const fakeToken = (label: string) => `test.${label}.${"x".repeat(32)}`;
