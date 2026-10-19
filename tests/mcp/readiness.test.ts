import { afterEach, describe, expect, it } from "vitest";
import { checkAuthorizationServer, checkMcpOAuthReadiness, discoveryUrls, type Check } from "../../apps/mcp-server/src/readiness.js";
import { startStack, type Stack } from "./harness.js";

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

const failing = (checks: Check[]) => checks.filter((c) => c.level === "fail").map((c) => c.id);

describe("Claude connector readiness checker", () => {
  it("passes for a correctly configured server and authorization server", async () => {
    stack = await startStack();
    const checks = await checkMcpOAuthReadiness(stack.url);
    expect(failing(checks)).toEqual([]);
    for (const id of ["mcp.401", "mcp.challenge", "prm.found", "prm.resource", "as.metadata", "as.pkce", "as.registration", "as.grants", "as.jwks", "mcp.origin"]) {
      expect(checks.find((c) => c.id === id)?.level, id).toBe("pass");
    }
  });

  it("fails when the authorization server offers no way for Claude to register", async () => {
    stack = await startStack({ as: { advertiseDcr: false } });
    expect(failing(await checkMcpOAuthReadiness(stack.url))).toEqual(["as.registration"]);
  });

  it("fails when S256 PKCE is not advertised and warns when plain is", async () => {
    stack = await startStack({ as: { codeChallengeMethods: ["plain"] } });
    expect(failing(await checkMcpOAuthReadiness(stack.url))).toContain("as.pkce");
    await stack.stop();
    stack = await startStack({ as: { codeChallengeMethods: ["S256", "plain"] } });
    const checks = await checkMcpOAuthReadiness(stack.url);
    expect(failing(checks)).toEqual([]);
    expect(checks.find((c) => c.id === "as.pkce")?.level).toBe("warn");
  });

  it("fails when the server asks for a scope the authorization server cannot grant", async () => {
    stack = await startStack({ env: { MCP_REQUIRED_SCOPES: "mcp:read" }, as: { scopesSupported: ["openid", "email"] } });
    expect(failing(await checkMcpOAuthReadiness(stack.url))).toEqual(["as.scopes"]);
  });

  it("fails when `resource` does not match the URL the user enters (e.g. entering the bare origin)", async () => {
    stack = await startStack();
    const fetcher: typeof fetch = async (input, init) => {
      const u = String(input);
      if (u.includes("/.well-known/oauth-protected-resource")) {
        const real = await fetch(input, init);
        return new Response(JSON.stringify({ ...(await real.json()), resource: stack!.origin }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return fetch(input, init);
    };
    expect(failing(await checkMcpOAuthReadiness(stack.url, { fetcher }))).toEqual(["prm.resource"]);
  });

  it("fails when an unauthenticated request does not get 401 (Claude ignores WWW-Authenticate on 200)", async () => {
    stack = await startStack();
    const fetcher: typeof fetch = async () => new Response("{}", { status: 200, headers: { "www-authenticate": "Bearer" } });
    expect(failing(await checkMcpOAuthReadiness(stack.url, { fetcher }))).toEqual(["mcp.401"]);
  });

  it("fails when the foreign-Origin request is not refused", async () => {
    stack = await startStack();
    const real = stack;
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (headers.get("origin") === "https://evil.invalid") return new Response("{}", { status: 200 });
      return fetch(input, init);
    };
    expect(failing(await checkMcpOAuthReadiness(real.url, { fetcher }))).toEqual(["mcp.origin"]);
  });

  it("flags http for non-loopback hosts", async () => {
    const checks = await checkAuthorizationServer("http://auth.example.com/v1", { fetcher: async () => new Response("", { status: 404 }) });
    expect(failing(checks)).toEqual(expect.arrayContaining(["as.https", "as.metadata"]));
  });

  it("recognizes Supabase's disabled OAuth server", async () => {
    const fetcher: typeof fetch = async (input) => {
      const u = String(input);
      if (u.endsWith("/auth/v1/.well-known/openid-configuration")) {
        return new Response(JSON.stringify({ issuer: "https://ref.supabase.co/auth/v1", authorization_endpoint: "https://ref.supabase.co/auth/v1/oauth/authorize", token_endpoint: "https://ref.supabase.co/auth/v1/oauth/token", jwks_uri: "https://ref.supabase.co/auth/v1/.well-known/jwks.json", code_challenge_methods_supported: ["S256", "plain"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"] }), { status: 200 });
      }
      if (u.endsWith("/jwks.json")) return new Response(JSON.stringify({ keys: [{ kty: "EC", alg: "ES256" }] }), { status: 200 });
      return new Response(JSON.stringify({ code: 404, error_code: "feature_disabled", msg: "OAuth server is disabled" }), { status: 404 });
    };
    const checks = await checkAuthorizationServer("https://ref.supabase.co/auth/v1", { fetcher });
    expect(failing(checks)).toEqual(expect.arrayContaining(["as.enabled", "as.registration"]));
  });

  it("builds discovery URLs in the MCP spec's priority order", () => {
    expect(discoveryUrls("https://ref.supabase.co/auth/v1")).toEqual([
      "https://ref.supabase.co/.well-known/oauth-authorization-server/auth/v1",
      "https://ref.supabase.co/.well-known/openid-configuration/auth/v1",
      "https://ref.supabase.co/auth/v1/.well-known/openid-configuration",
    ]);
    expect(discoveryUrls("https://auth.example.com")).toEqual(["https://auth.example.com/.well-known/oauth-authorization-server", "https://auth.example.com/.well-known/openid-configuration"]);
  });
});
