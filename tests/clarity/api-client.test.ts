/**
 * Clarity API client, validation and response normalization.
 * DATA SOURCE: mocked fetch and the response sample from Microsoft's documentation. No test here calls clarity.ms.
 */
import { describe, expect, it } from "vitest";
import {
  ClarityApiError,
  HttpClarityApiClient,
  buildClarityResult,
  parseClarityResponse,
  validateClarityDimensions,
  validateClarityToken,
  validateConnectionName,
} from "@serp/provider-clarity";
import { GetClarityInsightsSchema } from "@serp/contracts";
import { SAMPLE_BODY, fakeToken } from "./fake-clarity.js";

const TOKEN = fakeToken("client");

function clientWith(handler: (url: URL, init: RequestInit) => Response | Promise<Response>, timeoutMs = 2000) {
  const seen: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { client: new HttpClarityApiClient({ fetchImpl, timeoutMs }), seen };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("request building", () => {
  it("calls the documented endpoint with Bearer auth, numOfDays and numbered dimensions", async () => {
    const { client, seen } = clientWith(() => json(SAMPLE_BODY));
    await client.exportLiveInsights(TOKEN, { numOfDays: 2, dimensions: ["OS", "Device", "Country/Region"] });
    const { url, init } = seen[0]!;
    expect(`${url.origin}${url.pathname}`).toBe("https://www.clarity.ms/export-data/api/v1/project-live-insights");
    expect(Object.fromEntries(url.searchParams)).toEqual({ numOfDays: "2", dimension1: "OS", dimension2: "Device", dimension3: "Country/Region" });
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("never puts the token in the URL and refuses redirects (which would forward the Authorization header)", async () => {
    const { client, seen } = clientWith(() => json(SAMPLE_BODY));
    await client.exportLiveInsights(TOKEN, { numOfDays: 1, dimensions: [] });
    expect(seen[0]!.url.toString()).not.toContain(TOKEN);
    expect(seen[0]!.init.redirect).toBe("error");
  });

  it("makes exactly one request per call: it never retries on its own", async () => {
    const { client, seen } = clientWith(() => new Response("", { status: 503 }));
    await expect(client.exportLiveInsights(TOKEN, { numOfDays: 1, dimensions: [] })).rejects.toMatchObject({ kind: "unavailable", httpStatus: 503 });
    expect(seen).toHaveLength(1);
  });
});

describe("provider errors", () => {
  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "quota"],
    [500, "unavailable"],
    [502, "unavailable"],
  ])("HTTP %i becomes %s, without echoing the body or the token", async (status, kind) => {
    const { client } = clientWith(() => new Response(`secret body ${TOKEN}`, { status }));
    const err = await client.exportLiveInsights(TOKEN, { numOfDays: 1, dimensions: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClarityApiError);
    expect(err).toMatchObject({ kind, httpStatus: status });
    expect(String((err as Error).message) + JSON.stringify(err)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain("secret body");
  });

  it("network failures are 'unavailable', not a crash", async () => {
    const { client } = clientWith(() => {
      throw new TypeError(`fetch failed for token ${TOKEN}`);
    });
    const err = await client.exportLiveInsights(TOKEN, { numOfDays: 1, dimensions: [] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "unavailable", httpStatus: null });
    expect(JSON.stringify(err) + (err as Error).message).not.toContain(TOKEN);
  });

  it("times out", async () => {
    const { client } = clientWith((_u, init) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))), 50);
    await expect(client.exportLiveInsights(TOKEN, { numOfDays: 1, dimensions: [] })).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("a body that is not JSON is a bad response", async () => {
    const { client } = clientWith(() => new Response("<html>nope</html>", { status: 200 }));
    await expect(client.exportLiveInsights(TOKEN, { numOfDays: 1, dimensions: [] })).rejects.toMatchObject({ kind: "bad_response" });
  });
});

describe("parameter validation", () => {
  it("accepts only 1, 2 or 3 days", () => {
    for (const ok of [1, 2, 3]) expect(GetClarityInsightsSchema.safeParse({ propertyId: "p", numOfDays: ok }).success).toBe(true);
    for (const bad of [0, 4, 30, 1.5, "1"]) expect(GetClarityInsightsSchema.safeParse({ propertyId: "p", numOfDays: bad }).success).toBe(false);
  });

  it("accepts the documented dimensions, at most three, each once", () => {
    expect(() => validateClarityDimensions(["Browser", "Device", "Country/Region"])).not.toThrow();
    expect(() => validateClarityDimensions(["Browser", "Device", "OS", "URL"])).toThrow(/at most 3/);
    expect(() => validateClarityDimensions(["Browser", "Browser"])).toThrow(/only once/);
    expect(() => validateClarityDimensions(["Revenue"])).toThrow(/Unsupported/);
    expect(() => validateClarityDimensions(["browser"])).toThrow(/Unsupported/);
  });

  it("rejects unknown input keys such as a user id", () => {
    expect(GetClarityInsightsSchema.safeParse({ propertyId: "p", userId: "someone-else" }).success).toBe(false);
  });

  it("token shape: long, no spaces or control characters", () => {
    expect(() => validateClarityToken(TOKEN)).not.toThrow();
    for (const bad of ["", "short", `${TOKEN} extra`, `${TOKEN}\r\nX-Evil: 1`, "a".repeat(5000), "tok en".padEnd(30, "x")]) {
      expect(() => validateClarityToken(bad), JSON.stringify(bad.slice(0, 20))).toThrow(/does not look like/);
    }
  });

  it("connection names are trimmed, bounded and plain", () => {
    expect(validateConnectionName("  My   shop  ")).toBe("My shop");
    for (const bad of ["", "a", "x".repeat(61), "<script>alert(1)</script>", "a\u0000b"]) expect(() => validateConnectionName(bad)).toThrow();
  });
});

describe("response normalization", () => {
  it("flattens the documented sample, converting numeric strings but keeping dimension text", () => {
    const parsed = parseClarityResponse(SAMPLE_BODY, ["OS"])!;
    expect(parsed.rows[0]).toEqual({ metricName: "Traffic", totalSessionCount: 9554, totalBotSessionCount: 8369, distantUserCount: 189733, PagesPerSessionPercentage: 1.0931, OS: "Other" });
    expect(parsed.rows[1]!.OS).toBe("Android");
    expect(parsed.blocks).toEqual([
      { metricName: "Traffic", rows: 2, truncated: false },
      { metricName: "Dead Click Count", rows: 1, truncated: false },
    ]);
    expect(parsed.metricFields).toContain("totalSessionCount");
    expect(parsed.metricFields).not.toContain("OS");
  });

  it("a numeric-looking dimension value stays text", () => {
    const parsed = parseClarityResponse([{ metricName: "Traffic", information: [{ Campaign: "2024", totalSessionCount: "5" }] }], ["Campaign"])!;
    expect(parsed.rows[0]).toMatchObject({ Campaign: "2024", totalSessionCount: 5 });
  });

  it("keeps explicit nulls and does not invent fields that are absent", () => {
    const parsed = parseClarityResponse([{ metricName: "Traffic", information: [{ totalSessionCount: null }, { distantUserCount: "7" }] }], [])!;
    expect(parsed.rows[0]).toEqual({ metricName: "Traffic", totalSessionCount: null });
    expect(parsed.rows[1]).toEqual({ metricName: "Traffic", distantUserCount: 7 });
    expect("totalSessionCount" in parsed.rows[1]!).toBe(false);
  });

  it("an empty array is an empty result with an explicit warning, not zeros", () => {
    const result = buildClarityResult({ parsed: parseClarityResponse([], [])!, numOfDays: 1, dimensions: [], property: { id: "p", name: "P" }, requestId: "r", now: new Date("2026-10-19T00:00:00Z"), mock: false });
    expect(result.rows).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain("EMPTY_RESULT");
    expect(result.completeness).toBe("unknown_or_provider_limited");
  });

  it("returns null for a body that is not the expected array", () => {
    for (const body of [{}, "x", null, 42]) expect(parseClarityResponse(body, [])).toBeNull();
  });

  it("tolerates malformed pieces: skips them and says so", () => {
    const parsed = parseClarityResponse([{ metricName: "Traffic", information: [1, null, { totalSessionCount: "3" }] }, { nope: true }, { metricName: "X", information: "bad" }], [])!;
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.warnings.map((w) => w.code)).toContain("UNEXPECTED_STRUCTURE");
  });

  it("flags a block that reached the 1,000-row cap as possibly truncated", () => {
    const information = Array.from({ length: 1000 }, (_, i) => ({ URL: `/p${i}`, totalSessionCount: String(i) }));
    const parsed = parseClarityResponse([{ metricName: "Popular Pages", information }], ["URL"])!;
    const result = buildClarityResult({ parsed, numOfDays: 3, dimensions: ["URL"], property: { id: "p", name: "P" }, requestId: "r", now: new Date(), mock: false });
    expect(result.warnings.map((w) => w.code)).toContain("ROW_LIMIT_REACHED");
    expect(result.completeness).toBe("unknown_or_provider_limited");
  });

  it("describes the window honestly: rolling hours in UTC, no calendar dates", () => {
    const parsed = parseClarityResponse(SAMPLE_BODY, [])!;
    const result = buildClarityResult({ parsed, numOfDays: 2, dimensions: [], property: { id: "p", name: "P" }, requestId: "r", now: new Date("2026-10-19T12:00:00Z"), mock: false });
    expect(result.report.startDate).toBeNull();
    expect(result.report.dateSemantics).toMatch(/UTC/);
    expect(result.providerMetadata).toMatchObject({ windowHours: 48, timeZone: "UTC", windowStartsApproximately: "2026-10-17T12:00:00.000Z" });
    expect(result.mock).toBe(false);
  });
});
