import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USER_A, rawPost, startStack, type Stack } from "./harness.js";

let stack: Stack;
beforeAll(async () => {
  stack = await startStack({ env: { MCP_ALLOWED_ORIGINS: "https://inspector.example" } });
});
afterAll(async () => {
  await stack.stop();
});

const wwwAuth = (r: Response) => r.headers.get("www-authenticate") ?? "";
const metadataUrl = () => `${stack.origin}/.well-known/oauth-protected-resource/mcp`;

describe("discovery (RFC 9728) as Claude needs it", () => {
  it("answers an unauthenticated MCP request with 401 and a resource_metadata pointer", async () => {
    const r = await rawPost(stack);
    expect(r.status).toBe(401);
    expect(wwwAuth(r)).toBe(`Bearer resource_metadata="${metadataUrl()}"`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body.error.code).toBe("AUTH_REQUIRED");
  });

  it("serves protected-resource metadata whose `resource` is exactly the MCP URL and lists the issuer first", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const r = await fetch(stack.origin + path);
      expect(r.status).toBe(200);
      const doc = await r.json();
      expect(doc.resource).toBe(stack.url);
      expect(doc.authorization_servers).toEqual([stack.as.issuer]);
      expect(doc.bearer_methods_supported).toEqual(["header"]);
    }
  });

  it("the advertised authorization server really publishes RFC 8414 metadata with S256 PKCE and DCR", async () => {
    const doc = await (await fetch(`${stack.as.base}/.well-known/oauth-authorization-server/auth/v1`)).json();
    expect(doc.issuer).toBe(stack.as.issuer);
    expect(doc.code_challenge_methods_supported).toContain("S256");
    expect(doc.registration_endpoint).toBeTruthy();
  });

  it("does not hand out discovery for other methods", async () => {
    const r = await fetch(`${stack.origin}/.well-known/oauth-protected-resource/mcp`, { method: "POST" });
    expect(r.status).toBe(405);
  });
});

describe("token validation", () => {
  const good = () => stack.as.mint({ aud: stack.url });

  it("accepts a valid token and derives the user from `sub` only", async () => {
    const r = await rawPost(stack, { token: await good() });
    expect(r.status).toBe(200);
  });

  async function expectRejected(token: string, status = 401, errorCode = "invalid_token") {
    const r = await rawPost(stack, { token });
    expect(r.status).toBe(status);
    expect(wwwAuth(r)).toContain(`error="${errorCode}"`);
    expect(wwwAuth(r)).toContain(`resource_metadata="${metadataUrl()}"`);
    const text = await r.text();
    expect(text).not.toContain(token);
    return text;
  }

  it.each([
    ["garbage", async () => "not-a-jwt"],
    ["an expired token", () => stack.as.mint({ aud: stack.url, iat: 1, exp: 100 })],
    ["the wrong issuer", () => stack.as.mint({ aud: stack.url, iss: "https://evil.example/auth/v1" })],
    ["a token for another audience (confused deputy)", () => stack.as.mint({ aud: "https://other-api.example/mcp" })],
    ["Supabase's default audience when binding is required", () => stack.as.mint({ aud: "authenticated" })],
    ["a user-session JWT without an OAuth client", async () => stack.as.mint({ aud: stack.url, client_id: undefined })],
    ["an anonymous user", () => stack.as.mint({ aud: stack.url, is_anonymous: true })],
    ["a service-role token", () => stack.as.mint({ aud: stack.url, role: "service_role" })],
    ["a non-UUID subject", () => stack.as.mint({ aud: stack.url, sub: "alice@example.com" })],
    ["no subject", () => stack.as.mint({ aud: stack.url, sub: undefined })],
    ["no expiry", () => stack.as.mint({ aud: stack.url, exp: undefined })],
    ["a token signed by a different key", async () => stack.as.mint({ aud: stack.url }, (await generateKeyPair("ES256")).privateKey)],
  ] as const)("rejects %s", async (_name, make) => {
    await expectRejected(await make());
  });

  it("rejects an HS256 token forged with a known secret and an alg=none token (algorithm confusion)", async () => {
    const hs = await new SignJWT({ sub: USER_A, aud: stack.url, iss: stack.as.issuer, client_id: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-shared-secret-of-sufficient-length-1234"));
    await expectRejected(hs);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: USER_A, aud: stack.url, iss: stack.as.issuer, client_id: "x", exp: Math.floor(Date.now() / 1000) + 3600, iat: 1 })}.`;
    await expectRejected(none);
  });

  it("never explains the exact reason to the caller", async () => {
    const texts = [
      await expectRejected(await stack.as.mint({ aud: "https://other.example" })),
      await expectRejected(await stack.as.mint({ aud: stack.url, sub: "nope" })),
    ];
    for (const t of texts) expect(t).not.toMatch(/audience|subject|signature|jwks/i);
  });

  it("returns 503 (not 401) when the signing keys cannot be fetched, so clients do not loop through sign-in", async () => {
    const down = await startStack();
    try {
      const token = await down.as.mint({ aud: down.url });
      down.as.jwksDown = true;
      const r = await rawPost(down, { token });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("5");
    } finally {
      await down.stop();
    }
  });

  it("logs rejection reasons for operators but never the token", async () => {
    const token = await stack.as.mint({ aud: "https://other.example" });
    await rawPost(stack, { token });
    const joined = stack.logs.join("\n");
    expect(joined).toContain("mcp.token_rejected");
    expect(joined).toContain("claim_aud");
    expect(joined).not.toContain(token);
    expect(joined).not.toContain(token.split(".")[1]!);
  });
});

describe("scopes", () => {
  it("returns 403 insufficient_scope with the needed scope when a required scope is missing", async () => {
    const s = await startStack({ as: { scopeClaim: true, scopesSupported: ["mcp:read"] }, env: { MCP_REQUIRED_SCOPES: "mcp:read" } });
    try {
      const missing = await rawPost(s, { token: await s.as.mint({ aud: s.url }) });
      expect(missing.status).toBe(403);
      expect(wwwAuth(missing)).toContain('error="insufficient_scope"');
      expect(wwwAuth(missing)).toContain('scope="mcp:read"');
      expect(wwwAuth(missing)).toContain("resource_metadata=");

      const ok = await rawPost(s, { token: await s.as.mint({ aud: s.url, scope: "openid mcp:read" }) });
      expect(ok.status).toBe(200);

      // The 401 challenge tells clients which scope to request, and the metadata advertises it.
      const challenge = wwwAuth(await rawPost(s));
      expect(challenge).toContain('scope="mcp:read"');
      expect((await (await fetch(`${s.origin}/.well-known/oauth-protected-resource/mcp`)).json()).scopes_supported).toEqual(["mcp:read"]);
    } finally {
      await s.stop();
    }
  });
});

describe("HTTP transport rules", () => {
  const token = () => stack.as.mint({ aud: stack.url });

  it("authenticates before anything else, then answers GET/DELETE with 405 (stateless, no event stream)", async () => {
    expect((await rawPost(stack, { method: "GET" })).status).toBe(401);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const r = await fetch(stack.url, { method, headers: { authorization: `Bearer ${await token()}`, accept: "text/event-stream" } });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toContain("POST");
    }
  });

  it("validates the Origin header (DNS rebinding): unknown origins are refused, allow-listed ones get CORS", async () => {
    const bad = await rawPost(stack, { token: await token(), headers: { origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const localhostRebind = await rawPost(stack, { token: await token(), headers: { origin: "http://localhost:3000" } });
    expect(localhostRebind.status).toBe(403);

    const good = await rawPost(stack, { token: await token(), headers: { origin: "https://inspector.example" } });
    expect(good.status).toBe(200);
    expect(good.headers.get("access-control-allow-origin")).toBe("https://inspector.example");

    const preflight = await fetch(stack.url, { method: "OPTIONS", headers: { origin: "https://inspector.example", "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(/authorization/);
    const badPreflight = await fetch(stack.url, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(badPreflight.status).toBe(403);
  });

  it("an unauthenticated 401 is readable by an allow-listed browser client (WWW-Authenticate exposed)", async () => {
    const r = await rawPost(stack, { headers: { origin: "https://inspector.example" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/i);
  });

  it("requires JSON, a body, valid JSON and a bounded size", async () => {
    const t = await token();
    expect((await rawPost(stack, { token: t, headers: { "content-type": "text/plain" } })).status).toBe(415);
    const empty = await rawPost(stack, { token: t, body: "" });
    expect(empty.status).toBe(400);
    const bad = await rawPost(stack, { token: t, body: "{not json" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    const big = await rawPost(stack, { token: t, body: JSON.stringify({ pad: "x".repeat(1_100_000) }) });
    expect(big.status).toBe(413);
  });

  it("requires the Accept header the Streamable HTTP transport defines", async () => {
    const r = await rawPost(stack, { token: await token(), headers: { accept: "text/html" } });
    expect(r.status).toBe(406);
  });

  it("refuses a protocol version it does not implement, so newer clients fall back to the older handshake", async () => {
    const r = await rawPost(stack, { token: await token(), headers: { "mcp-protocol-version": "2026-07-28" } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toMatch(/protocol version/i);
  });

  it("serves a health probe without authentication and without revealing configuration", async () => {
    const r = await fetch(`${stack.origin}/healthz`);
    expect(await r.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for any other path", async () => {
    expect((await fetch(`${stack.origin}/admin`)).status).toBe(404);
    expect((await fetch(`${stack.origin}/mcp/extra`, { method: "POST" })).status).toBe(404);
  });
});

describe("configuration safety", () => {
  it("refuses to start in oauth mode without an issuer, and refuses the unbound Supabase audience unless explicitly accepted", async () => {
    const { loadMcpEnv } = await import("@serp/contracts");
    const base = { NODE_ENV: "test", MCP_PUBLIC_URL: "https://mcp.example.com", MCP_AUTH_MODE: "oauth" };
    expect(() => loadMcpEnv(base)).toThrow(/MCP_OAUTH_ISSUER_URL/);
    const withIssuer = { ...base, MCP_OAUTH_ISSUER_URL: "https://ref.supabase.co/auth/v1" };
    expect(() => loadMcpEnv(withIssuer)).not.toThrow();
    expect(() => loadMcpEnv({ ...withIssuer, MCP_RESOURCE_AUDIENCE: "authenticated" })).toThrow(/not bound/);
    expect(() => loadMcpEnv({ ...withIssuer, MCP_RESOURCE_AUDIENCE: "authenticated", MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE: "true" })).not.toThrow();
  });

  it("production requires https for the public URL and the issuer, and refuses mock auth", async () => {
    const { loadMcpEnv } = await import("@serp/contracts");
    const prod = { NODE_ENV: "production", DATA_MODE: "live", DB_MODE: "postgres", MCP_AUTH_MODE: "oauth", MCP_OAUTH_ISSUER_URL: "https://ref.supabase.co/auth/v1" };
    expect(() => loadMcpEnv({ ...prod, MCP_PUBLIC_URL: "http://mcp.example.com" })).toThrow(/https/);
    expect(() => loadMcpEnv({ ...prod, MCP_PUBLIC_URL: "https://mcp.example.com", MCP_OAUTH_ISSUER_URL: "http://ref.example/auth/v1" })).toThrow(/https/);
    expect(() => loadMcpEnv({ ...prod, MCP_PUBLIC_URL: "https://mcp.example.com", MCP_AUTH_MODE: "mock" })).toThrow(/mock authentication/);
    expect(() => loadMcpEnv({ ...prod, MCP_PUBLIC_URL: "https://mcp.example.com" })).not.toThrow();
  });
});

describe("failed sign-in trail", () => {
  it("logs who was refused (address and reason) but never the token", async () => {
    const before = stack.logs.length;
    await rawPost(stack); // no token
    await rawPost(stack, { token: "not.a.jwt", headers: { "x-real-ip": "203.0.113.9" } });
    const lines = stack.logs.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>);
    const missing = lines.find((l) => l.msg === "mcp.token_missing");
    const rejected = lines.find((l) => l.msg === "mcp.token_rejected");
    expect(missing?.remote).toEqual(expect.any(String));
    expect(rejected).toMatchObject({ remote: "203.0.113.9" });
    expect(rejected?.reason).toBeTruthy();
    expect(stack.logs.slice(before).join("\n")).not.toContain("not.a.jwt");
  });

  it("ignores a malformed X-Real-IP instead of logging attacker-chosen text", async () => {
    const before = stack.logs.length;
    await rawPost(stack, { token: "x.y.z", headers: { "x-real-ip": "1.2.3.4\"}{\"msg\":\"forged" } });
    const rejected = stack.logs.slice(before).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "mcp.token_rejected");
    expect(rejected?.remote).not.toContain("forged");
  });
});
