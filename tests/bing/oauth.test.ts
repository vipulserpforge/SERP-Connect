/**
 * Bing OAuth client and authorization URL. DATA SOURCE: MOCK (fake fetch shaped like Microsoft's documented token responses).
 */
import { describe, expect, it } from "vitest";
import { BING_AUTHORIZE_ENDPOINT, BING_READ_SCOPE, BING_TOKEN_ENDPOINT, BingOAuthError, HttpBingOAuthClient, buildBingAuthUrl } from "@serp/provider-bing";

describe("authorization URL", () => {
  const url = new URL(buildBingAuthUrl({ clientId: "client-123", redirectUri: "https://app.example.com/api/oauth/bing/callback", state: "state-abc" }));
  it("uses the documented endpoint and parameters, with the read-only scope", () => {
    expect(url.origin + url.pathname).toBe(BING_AUTHORIZE_ENDPOINT);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/api/oauth/bing/callback");
    expect(url.searchParams.get("scope")).toBe(BING_READ_SCOPE);
    expect(url.searchParams.get("state")).toBe("state-abc");
  });
  it("never requests the read/write scope, and sends no PKCE or client secret (none documented)", () => {
    expect(url.searchParams.get("scope")).not.toMatch(/manage/i);
    for (const p of ["code_challenge", "code_challenge_method", "client_secret", "access_type", "prompt"]) expect(url.searchParams.has(p)).toBe(false);
  });
  it("keeps the redirect URI exactly as registered (including a trailing slash)", () => {
    const u = new URL(buildBingAuthUrl({ clientId: "c", redirectUri: "https://app.example.com/cb/", state: "s" }));
    expect(u.searchParams.get("redirect_uri")).toBe("https://app.example.com/cb/");
  });
});

interface Seen {
  url: string;
  init: RequestInit;
  form: URLSearchParams;
}
function client(respond: (s: Seen) => Response | Promise<Response>, now = () => 1_000_000) {
  const seen: Seen[] = [];
  const c = new HttpBingOAuthClient({
    clientId: "client-123",
    clientSecret: "secret-456",
    now,
    fetch: (async (input: string, init: RequestInit) => {
      const s = { url: String(input), init, form: new URLSearchParams(String(init.body)) };
      seen.push(s);
      return respond(s);
    }) as typeof fetch,
  });
  return { c, seen };
}
const ok = (body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ access_token: "access-token-abcdef", token_type: "bearer", expires_in: 3599, refresh_token: "refresh-token-abcdef", ...body }), { status: 200 });

describe("token exchange", () => {
  it("POSTs form-encoded with the documented parameters on the documented endpoint", async () => {
    const { c, seen } = client(() => ok());
    const t = await c.exchangeCode({ code: "the-code", redirectUri: "https://app.example.com/cb" });
    expect(seen[0]!.url).toBe(BING_TOKEN_ENDPOINT);
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(seen[0]!.form)).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: "https://app.example.com/cb", client_id: "client-123", client_secret: "secret-456" });
    expect(t).toEqual({ accessToken: "access-token-abcdef", refreshToken: "refresh-token-abcdef", expiresAt: 1_000_000 + 3599_000 });
  });

  it("refresh uses grant_type=refresh_token (the documented sample and RFC 6749), not the table's authorization_code", async () => {
    const { c, seen } = client(() => ok({ refresh_token: undefined }));
    const t = await c.refresh("old-refresh-token-value");
    expect(Object.fromEntries(seen[0]!.form)).toEqual({ grant_type: "refresh_token", refresh_token: "old-refresh-token-value", client_id: "client-123", client_secret: "secret-456" });
    expect(t.refreshToken).toBeUndefined(); // documented refresh response has none: the caller keeps its own
  });

  it("classifies failures without exposing upstream text", async () => {
    const kinds = async (status: number, body: unknown) => (await client(() => new Response(JSON.stringify(body), { status })).c.exchangeCode({ code: "c", redirectUri: "r" }).catch((e) => e)) as BingOAuthError;
    expect((await kinds(400, { error: "invalid_grant", error_description: "SECRET detail" })).kind).toBe("invalid_grant");
    expect((await kinds(401, { error: "invalid_client" })).kind).toBe("invalid_client");
    expect((await kinds(400, { error: "invalid_request" })).kind).toBe("invalid_client");
    expect((await kinds(400, "not json")).kind).toBe("invalid_grant");
    expect((await kinds(429, {})).kind).toBe("transient");
    expect((await kinds(503, {})).kind).toBe("transient");
    const e = await kinds(400, { error: "invalid_grant", error_description: "SECRET detail" });
    expect(JSON.stringify(e) + e.message).not.toMatch(/SECRET|secret-456|the-code/);
  });

  it("network error is transient; malformed success is bad_response", async () => {
    const down = new HttpBingOAuthClient({ clientId: "c", clientSecret: "s", fetch: (async () => { throw new TypeError("x"); }) as typeof fetch });
    await expect(down.refresh("r".repeat(20))).rejects.toMatchObject({ kind: "transient" });
    for (const body of [{}, { access_token: "short" }, { access_token: "access-token-abcdef", token_type: "mac", expires_in: 3600 }, { access_token: "access-token-abcdef", token_type: "bearer", expires_in: -1 }]) {
      await expect(client(() => new Response(JSON.stringify(body), { status: 200 })).c.refresh("r".repeat(20))).rejects.toMatchObject({ kind: "bad_response" });
    }
  });

  it("does not follow redirects", async () => {
    const { c, seen } = client(() => ok());
    await c.refresh("r".repeat(20));
    expect(seen[0]!.init.redirect).toBe("error");
  });
});
