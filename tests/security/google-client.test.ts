import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  GoogleOAuthError,
  HttpGoogleOAuthClient,
  buildGoogleAuthUrl,
  connectScope,
  createPkcePair,
  createStateToken,
  hashState,
  maskEmail,
  parseIdToken,
} from "@serp/provider-google";

// Fake token endpoint on localhost: exercises the real HTTP client without Google or credentials.
// Token-like values are assembled at runtime so no secret-shaped literal sits in the repo.
const FAKE_ACCESS = ["ya29", "fake-access-value-0123456789"].join(".");
const FAKE_REFRESH = ["1/", "/fake-refresh-value-0123456789abcdef"].join("");
const CLIENT_SECRET = "client-secret-for-tests-only";

interface Seen {
  path: string;
  body: URLSearchParams;
  url: string;
}
let server: Server;
let base = "";
let seen: Seen[] = [];
let respond: (path: string) => { status: number; body?: unknown; raw?: string; delayMs?: number };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idTokenFor = (claims: Record<string, unknown>) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

beforeAll(async () => {
  server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ path: url.pathname, url: req.url ?? "", body: new URLSearchParams(Buffer.concat(chunks).toString()) });
    const r = respond(url.pathname);
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.raw ?? (r.body === undefined ? "" : JSON.stringify(r.body)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  seen = [];
  respond = () => ({ status: 500 });
});

const client = (extra: Partial<ConstructorParameters<typeof HttpGoogleOAuthClient>[0]> = {}) =>
  new HttpGoogleOAuthClient({
    clientId: "cid",
    clientSecret: CLIENT_SECRET,
    tokenEndpoint: `${base}/token`,
    revokeEndpoint: `${base}/revoke`,
    now: () => 1_000_000,
    ...extra,
  });

const goodToken = { access_token: FAKE_ACCESS, expires_in: 3599, refresh_token: FAKE_REFRESH, scope: "openid email https://www.googleapis.com/auth/webmasters.readonly", token_type: "Bearer" };

describe("HttpGoogleOAuthClient", () => {
  it("exchanges a code with PKCE and returns a normalized token set", async () => {
    respond = () => ({ status: 200, body: goodToken });
    const t = await client().exchangeCode({ code: "the-code", codeVerifier: "the-verifier", redirectUri: "http://localhost/cb" });
    expect(t).toMatchObject({ accessToken: FAKE_ACCESS, refreshToken: FAKE_REFRESH, expiresAt: 1_000_000 + 3599_000 });
    expect(t.scopes).toContain("https://www.googleapis.com/auth/webmasters.readonly");
    const sent = seen[0]!;
    expect(sent.body.get("grant_type")).toBe("authorization_code");
    expect(sent.body.get("code_verifier")).toBe("the-verifier");
    // Secrets travel in the POST body only, never in the URL.
    expect(sent.url).not.toContain(CLIENT_SECRET);
    expect(sent.url).not.toContain("the-code");
  });

  it("refreshes with the refresh token and tolerates Google omitting a new one", async () => {
    respond = () => ({ status: 200, body: { ...goodToken, refresh_token: undefined } });
    const t = await client().refresh(FAKE_REFRESH);
    expect(t.refreshToken).toBeUndefined();
    expect(seen[0]!.body.get("grant_type")).toBe("refresh_token");
  });

  it.each([
    [400, { error: "invalid_grant", error_description: `bad ${FAKE_REFRESH}` }, "invalid_grant"],
    [401, { error: "invalid_client" }, "invalid_client"],
    [429, { error: "rate" }, "transient"],
    [503, { error: "backend" }, "transient"],
    [400, { error: "something_else" }, "bad_response"],
  ] as const)("classifies HTTP %i %j as %s", async (status, body, kind) => {
    respond = () => ({ status, body });
    const err = await client().refresh("r").catch((e) => e);
    expect(err).toBeInstanceOf(GoogleOAuthError);
    expect(err.kind).toBe(kind);
  });

  it("errors carry no upstream text, tokens or secrets", async () => {
    respond = () => ({ status: 400, body: { error: "invalid_grant", error_description: `echo ${FAKE_REFRESH} ${CLIENT_SECRET}` } });
    const err = await client().refresh(FAKE_REFRESH).catch((e) => e);
    const dump = JSON.stringify(err) + String(err.message) + String(err.stack);
    expect(dump).not.toContain(FAKE_REFRESH);
    expect(dump).not.toContain(CLIENT_SECRET);
  });

  it.each([
    ["not json", { raw: "<html>oops</html>" }],
    ["missing access token", { body: { expires_in: 10, token_type: "Bearer" } }],
    ["wrong token type", { body: { ...goodToken, token_type: "mac" } }],
    ["absurd lifetime", { body: { ...goodToken, expires_in: 10 ** 9 } }],
    ["oversized token", { body: { ...goodToken, access_token: "x".repeat(5000) } }],
  ])("rejects a malformed success response: %s", async (_name, reply) => {
    respond = () => ({ status: 200, ...reply });
    const err = await client().refresh("r").catch((e) => e);
    expect(err.kind).toBe("bad_response");
  });

  it("times out as a transient failure", async () => {
    respond = () => ({ status: 200, body: goodToken, delayMs: 300 });
    const err = await client({ timeoutMs: 50 }).refresh("r").catch((e) => e);
    expect(err.kind).toBe("transient");
  });

  it("a network failure is transient", async () => {
    const err = await client({ tokenEndpoint: "http://127.0.0.1:1/token" }).refresh("r").catch((e) => e);
    expect(err.kind).toBe("transient");
  });

  it("revoke succeeds, treats already-revoked (400) as done, and surfaces outages", async () => {
    respond = () => ({ status: 200, body: {} });
    await expect(client().revoke(FAKE_REFRESH)).resolves.toBeUndefined();
    expect(seen[0]!.body.get("token")).toBe(FAKE_REFRESH);
    respond = () => ({ status: 400, body: { error: "invalid_token" } });
    await expect(client().revoke(FAKE_REFRESH)).resolves.toBeUndefined();
    respond = () => ({ status: 503 });
    await expect(client().revoke(FAKE_REFRESH)).rejects.toMatchObject({ kind: "transient" });
  });

  it("does not follow redirects (cannot be bounced to another host with the secret)", async () => {
    const redirecting = createServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
      res.end();
    });
    await new Promise<void>((r) => redirecting.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/token`;
    const err = await client({ tokenEndpoint: url }).refresh("r").catch((e) => e);
    expect(err.kind).toBe("transient");
    redirecting.close();
  });
});

describe("id_token identity", () => {
  const future = Math.floor(Date.now() / 1000) + 600;
  const good = { iss: "https://accounts.google.com", aud: "cid", sub: "1234567890", exp: future, email: "alice@example.com" };

  it("extracts the stable subject and email", () => {
    expect(parseIdToken(idTokenFor(good), { clientId: "cid" })).toEqual({ sub: "1234567890", email: "alice@example.com" });
  });

  it.each([
    ["wrong audience", { ...good, aud: "someone-else" }],
    ["wrong issuer", { ...good, iss: "https://evil.example" }],
    ["expired", { ...good, exp: 1 }],
    ["no subject", { ...good, sub: "" }],
  ])("rejects %s", (_n, claims) => {
    expect(() => parseIdToken(idTokenFor(claims), { clientId: "cid" })).toThrow(GoogleOAuthError);
  });

  it("rejects garbage", () => {
    expect(() => parseIdToken("not-a-jwt", { clientId: "cid" })).toThrow(GoogleOAuthError);
  });

  it("masks emails for display", () => {
    expect(maskEmail("alice@example.com")).toBe("a***@example.com");
  });
});

describe("authorization request", () => {
  it("is read-only, PKCE, offline and requests exactly one product scope", () => {
    const { challenge } = createPkcePair();
    const url = new URL(buildGoogleAuthUrl({ clientId: "cid", redirectUri: "http://localhost/cb", scope: connectScope("ga4"), state: "s", codeChallenge: challenge }));
    expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/analytics.readonly");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.searchParams.get("scope")).not.toMatch(/webmasters|\.write|auth\/analytics(?!\.readonly)/);
  });

  it("state tokens are unique, high-entropy and stored only as hashes", () => {
    const a = createStateToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(createStateToken()).not.toBe(a);
    expect(hashState(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashState(a)).not.toContain(a);
  });
});
