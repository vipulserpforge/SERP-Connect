import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { checkGoogleConfig, describeGoogleAuthError, effectiveRedirectUri, probeGoogle } from "@serp/provider-google";

const good = {
  NODE_ENV: "production",
  DATA_MODE: "live",
  DB_MODE: "postgres",
  GOOGLE_CLIENT_ID: "123456789012-abcdefghij0123456789.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: ["GOC", "SPX-0123456789abcdefghijklmnop"].join(""),
  NEXT_PUBLIC_APP_URL: "https://app.example.com",
  SECRET_KEYS: "v1:x",
};
const levels = (env: Record<string, string | undefined>) => Object.fromEntries(checkGoogleConfig(env).map((c) => [c.name, c.level]));

describe("Google configuration checks", () => {
  it("derives the redirect URI exactly as the application does", () => {
    expect(effectiveRedirectUri({ NEXT_PUBLIC_APP_URL: "https://app.example.com/" })).toBe("https://app.example.com/api/oauth/google/callback");
    expect(effectiveRedirectUri({})).toBe("http://localhost:3000/api/oauth/google/callback");
    expect(effectiveRedirectUri({ GOOGLE_REDIRECT_URI: "https://x.example/api/oauth/google/callback", NEXT_PUBLIC_APP_URL: "https://y.example" })).toBe("https://x.example/api/oauth/google/callback");
  });

  it("passes a correct production configuration", () => {
    const checks = checkGoogleConfig(good);
    expect(checks.filter((c) => c.level === "fail")).toEqual([]);
    expect(checks.find((c) => c.name.startsWith("Redirect URI"))!.detail).toBe("https://app.example.com/api/oauth/google/callback");
  });

  it("never prints the client secret", () => {
    expect(JSON.stringify(checkGoogleConfig(good))).not.toContain(good.GOOGLE_CLIENT_SECRET);
  });

  it.each([
    ["missing client id", { GOOGLE_CLIENT_ID: undefined }, "GOOGLE_CLIENT_ID"],
    ["missing secret", { GOOGLE_CLIENT_SECRET: undefined }, "GOOGLE_CLIENT_SECRET"],
    ["quoted secret", { GOOGLE_CLIENT_SECRET: `"${good.GOOGLE_CLIENT_SECRET}"` }, "GOOGLE_CLIENT_SECRET"],
    ["wrong callback path", { GOOGLE_REDIRECT_URI: "https://app.example.com/oauth/callback" }, "Redirect path"],
    ["http in production", { NEXT_PUBLIC_APP_URL: "http://app.example.com" }, "Redirect scheme"],
    ["raw IP", { NEXT_PUBLIC_APP_URL: "https://203.0.113.5" }, "Redirect host"],
    ["localhost in production", { NEXT_PUBLIC_APP_URL: "http://localhost:3000" }, "Redirect host"],
    ["query string", { GOOGLE_REDIRECT_URI: "https://app.example.com/api/oauth/google/callback?x=1" }, "Redirect URI"],
    ["no encryption key", { SECRET_KEYS: undefined }, "SECRET_KEYS"],
    ["live without postgres", { DB_MODE: "mock" }, "DB_MODE"],
  ])("fails on %s", (_n, change, name) => {
    expect(levels({ ...good, ...change })[name]).toBe("fail");
  });

  it("allows http for localhost in development and warns about mock mode and cross-origin redirects", () => {
    const dev = levels({ ...good, NODE_ENV: "development", DATA_MODE: "mock", NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(dev["Redirect scheme"]).toBeUndefined();
    expect(dev.DATA_MODE).toBe("warn");
    expect(levels({ ...good, GOOGLE_REDIRECT_URI: "https://other.example.com/api/oauth/google/callback" })["Redirect origin"]).toBe("warn");
  });
});

describe("Google error page decoding", () => {
  it("reads the error Google really returned for an unknown client", () => {
    // authError value captured from accounts.google.com for a client id that does not exist.
    expect(describeGoogleAuthError("Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw")).toMatch(/^invalid_client: The OAuth client was not found/);
  });
  it("degrades safely on garbage", () => {
    expect(describeGoogleAuthError("%%%")).toBeTypeOf("string");
  });
});

describe("probe (against local stand-ins for Google)", () => {
  async function fakeGoogle(handler: (url: URL, body: string) => { status: number; headers?: Record<string, string>; json?: unknown }) {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = handler(new URL(req.url ?? "/", "http://x"), Buffer.concat(chunks).toString());
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(r.json === undefined ? undefined : JSON.stringify(r.json));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  it("reports acceptance when Google continues to sign-in, and the reason when it does not", async () => {
    const ok = await fakeGoogle(() => ({ status: 302, headers: { location: "https://accounts.google.com/v3/signin/identifier" } }));
    const mismatch = await fakeGoogle(() => ({ status: 302, headers: { location: `/signin/oauth/error?authError=${Buffer.from("\n\u0016redirect_uri_mismatch\x12\x20Error: the redirect is not registered.").toString("base64url")}` } }));
    try {
      expect((await probeGoogle(good, { authEndpoint: `${ok.base}/auth` })).every((c) => c.level === "ok")).toBe(true);
      const bad = await probeGoogle(good, { authEndpoint: `${mismatch.base}/auth` });
      expect(bad[0]).toMatchObject({ level: "fail" });
      expect(bad[0]!.detail).toContain("redirect_uri_mismatch");
      expect(bad[0]!.detail).toContain(`add exactly ${effectiveRedirectUri(good)}`);
      expect(bad[0]!.detail).toContain("Authorized redirect URIs");
    } finally {
      ok.close();
      mismatch.close();
    }
  });

  it("distinguishes a good secret (invalid_grant for the fake code) from a wrong one (invalid_client)", async () => {
    const authOk = await fakeGoogle(() => ({ status: 302, headers: { location: "https://accounts.google.com/v3/signin/identifier" } }));
    const goodSecret = await fakeGoogle(() => ({ status: 400, json: { error: "invalid_grant" } }));
    const badSecret = await fakeGoogle(() => ({ status: 401, json: { error: "invalid_client" } }));
    try {
      const a = await probeGoogle(good, { authEndpoint: `${authOk.base}/auth`, checkSecret: true, tokenEndpoint: `${goodSecret.base}/token` });
      expect(a.find((c) => c.name === "Client secret")!.level).toBe("ok");
      const b = await probeGoogle(good, { authEndpoint: `${authOk.base}/auth`, checkSecret: true, tokenEndpoint: `${badSecret.base}/token` });
      expect(b.find((c) => c.name === "Client secret")!.level).toBe("fail");
      expect(JSON.stringify(b)).not.toContain(good.GOOGLE_CLIENT_SECRET);
    } finally {
      authOk.close();
      goodSecret.close();
      badSecret.close();
    }
  });

  it("an unreachable Google is a warning, not a verdict", async () => {
    const r = await probeGoogle(good, { authEndpoint: "http://127.0.0.1:1/auth" });
    expect(r[0]!.level).toBe("warn");
  });
});

describe("blank environment variables", () => {
  it("are treated as unset, so copying .env.example (which has empty entries) does not break startup", async () => {
    const { loadSharedEnv, loadMcpEnv } = await import("@serp/contracts");
    const blank = { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "  ", GOOGLE_REDIRECT_URI: "", SECRET_KEYS: "", SUPABASE_DB_URL: "", MCP_OAUTH_ISSUER_URL: "" };
    expect(loadSharedEnv(blank)).toMatchObject({ DATA_MODE: "mock" });
    expect(loadSharedEnv(blank).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(loadMcpEnv(blank).MCP_OAUTH_ISSUER_URL).toBeUndefined();
  });
  it("still rejects a blank value that has no safe default when it is required", async () => {
    const { loadMcpEnv } = await import("@serp/contracts");
    expect(() => loadMcpEnv({ MCP_AUTH_MODE: "oauth", MCP_OAUTH_ISSUER_URL: "" })).toThrow(/MCP_OAUTH_ISSUER_URL/);
  });
});
