import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";
import { USER_A, USER_B, startStack, type Stack } from "./harness.js";

/** Claude's hosted-app callback. The SDK client sends exactly what Claude documents for DCR. */
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

class TestProvider implements OAuthClientProvider {
  authUrl: URL | undefined;
  private info: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  private verifier = "";
  constructor(readonly redirect = CLAUDE_CALLBACK) {}
  get redirectUrl() {
    return this.redirect;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Claude", redirect_uris: [this.redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() {
    return randomBytes(16).toString("base64url");
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(i: OAuthClientInformationMixed) {
    this.info = i;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(t: OAuthTokens) {
    this.saved = t;
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.saved = undefined;
    if (scope === "all" || scope === "client") this.info = undefined;
  }
}

let stack: Stack | undefined;
afterEach(async () => {
  await stack?.stop();
  stack = undefined;
});

/** Plays the browser: opens the authorization URL, which approves immediately, and returns the callback parameters. */
async function approve(p: TestProvider): Promise<URLSearchParams> {
  const res = await fetch(p.authUrl as URL, { redirect: "manual" });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get("location") as string);
  expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
  return back.searchParams;
}

async function signIn(s: Stack, p = new TestProvider()): Promise<{ provider: TestProvider; client: Client }> {
  const first = new Client({ name: "claude-like", version: "1" });
  await expect(first.connect(new StreamableHTTPClientTransport(new URL(s.url), { authProvider: p }))).rejects.toBeInstanceOf(UnauthorizedError);
  const params = await approve(p);
  expect(params.get("error")).toBeNull();
  const finisher = new StreamableHTTPClientTransport(new URL(s.url), { authProvider: p });
  await finisher.finishAuth(params.get("code") as string);
  const client = new Client({ name: "claude-like", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { authProvider: p }));
  return { provider: p, client };
}

describe("full MCP authorization flow with the official SDK client", () => {
  it("discovers, registers, authorizes with PKCE + resource, and calls a tool as the signed-in user", async () => {
    stack = await startStack();
    stack.as.userId = USER_B;
    const { provider, client } = await signIn(stack);

    // Discovery -> dynamic registration happened against the authorization server named in our metadata.
    expect(stack.as.registrations).toHaveLength(1);
    expect(stack.as.registrations[0]).toMatchObject({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude" });

    // The authorization request carries PKCE S256 and the RFC 8707 resource, as the MCP spec requires.
    const q = stack.as.authorizeRequests[0]!;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("resource")).toBe(stack.url);
    expect(q.get("redirect_uri")).toBe(CLAUDE_CALLBACK);
    expect(q.get("client_id")).toBe(stack.as.registrations[0]!.client_id);

    // The token request is form-encoded, carries the verifier and the resource, and has no client secret.
    const t = stack.as.tokenRequests[0]!;
    expect(t.contentType).toMatch(/^application\/x-www-form-urlencoded/);
    expect(t.body.get("grant_type")).toBe("authorization_code");
    expect(t.body.get("code_verifier")).toMatch(/\S{43,}/);
    expect(t.body.get("resource")).toBe(stack.url);
    expect(t.body.has("client_secret")).toBe(false);

    // The access token is bound to this server and the tool sees user B (the one who signed in), nothing else.
    expect((provider.tokens() as OAuthTokens).access_token.split(".")).toHaveLength(3);
    const r = await client.callTool({ name: "list_gsc_properties", arguments: {} });
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text).properties).toEqual([expect.objectContaining({ id: "sc-domain:other-tenant.com" })]);
    await client.close();
  });

  it("the same flow for a different user yields that user's data", async () => {
    stack = await startStack();
    stack.as.userId = USER_A;
    const { client } = await signIn(stack);
    const r = await client.callTool({ name: "get_connection_status", arguments: {} });
    expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text).connections).toHaveLength(4);
    await client.close();
  });

  it("refreshes an expired access token on its own, rotating the refresh token", async () => {
    stack = await startStack();
    const { provider, client } = await signIn(stack);
    const before = provider.tokens() as OAuthTokens;
    // The access token the client holds has expired; the refresh token is still good.
    provider.saveTokens({ ...before, access_token: await stack.as.mint({ aud: stack.url, iat: 1, exp: 100 }) });

    const r = await client.callTool({ name: "get_connection_status", arguments: {} });
    expect(r.isError).toBeFalsy();

    const refreshes = stack.as.tokenRequests.filter((x) => x.body.get("grant_type") === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.body.get("refresh_token")).toBe(before.refresh_token);
    const after = provider.tokens() as OAuthTokens;
    expect(after.refresh_token).toBeTruthy();
    expect(after.refresh_token).not.toBe(before.refresh_token);
    await client.close();
  });

  it("requires a fresh sign-in once the grant is revoked", async () => {
    stack = await startStack();
    const { provider, client } = await signIn(stack);
    stack.as.revokeAll(); // the user removed the connector
    provider.saveTokens({ ...(provider.tokens() as OAuthTokens), access_token: await stack.as.mint({ aud: stack.url, iat: 1, exp: 100 }) });
    await expect(client.callTool({ name: "get_connection_status", arguments: {} })).rejects.toBeInstanceOf(UnauthorizedError);
    await client.close();
  });

  it("an authorization code cannot be replayed or redeemed without the PKCE verifier", async () => {
    stack = await startStack();
    const p = new TestProvider();
    const c = new Client({ name: "x", version: "1" });
    await expect(c.connect(new StreamableHTTPClientTransport(new URL(stack.url), { authProvider: p }))).rejects.toBeInstanceOf(UnauthorizedError);
    const params = await approve(p);
    const redeem = (verifier: string) =>
      fetch(`${stack!.as.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code: params.get("code") as string, code_verifier: verifier, client_id: (p.clientInformation() as { client_id: string }).client_id, redirect_uri: CLAUDE_CALLBACK }),
      });
    expect((await redeem("wrong-verifier-wrong-verifier-wrong-verifier-123")).status).toBe(400);
    // ...and the failed attempt consumed the code, so even the right verifier now fails.
    expect((await redeem(p.codeVerifier() as string)).status).toBe(400);
  });

  it("a denied consent ends the flow without a token", async () => {
    stack = await startStack();
    stack.as.deny = true;
    const p = new TestProvider();
    await expect(new Client({ name: "x", version: "1" }).connect(new StreamableHTTPClientTransport(new URL(stack.url), { authProvider: p }))).rejects.toBeInstanceOf(UnauthorizedError);
    const params = await approve(p);
    expect(params.get("error")).toBe("access_denied");
    expect(params.get("code")).toBeNull();
    expect(p.tokens()).toBeUndefined();
  });
});

describe("audience binding (the Supabase gap)", () => {
  it("with an issuer that always sets aud=authenticated, the strict default refuses the token", async () => {
    stack = await startStack({ as: { audience: "authenticated" } });
    const p = new TestProvider();
    const first = new Client({ name: "x", version: "1" });
    await expect(first.connect(new StreamableHTTPClientTransport(new URL(stack.url), { authProvider: p }))).rejects.toBeInstanceOf(UnauthorizedError);
    const params = await approve(p);
    await new StreamableHTTPClientTransport(new URL(stack.url), { authProvider: p }).finishAuth(params.get("code") as string);
    // The token was issued fine, but it is not bound to this server, so the server refuses it.
    const second = new Client({ name: "x", version: "1" });
    // The client refreshes once, gets another token with the same audience, and gives up: the connection never opens.
    await expect(second.connect(new StreamableHTTPClientTransport(new URL(stack.url), { authProvider: p }))).rejects.toThrow(/401|Unauthorized/);
  });

  it("accepting aud=authenticated is an explicit opt-in, and still demands an OAuth client grant", async () => {
    stack = await startStack({
      as: { audience: "authenticated" },
      env: { MCP_RESOURCE_AUDIENCE: "authenticated", MCP_ACCEPT_DEFAULT_SUPABASE_AUDIENCE: "true" },
    });
    const { client } = await signIn(stack);
    expect((await client.callTool({ name: "get_connection_status", arguments: {} })).isError).toBeFalsy();
    await client.close();

    // A plain user-session JWT has the same audience but no client_id: never accepted as an MCP grant.
    const sessionJwt = await stack.as.mint({ client_id: undefined });
    const raw = await fetch(stack.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${sessionJwt}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(raw.status).toBe(401);
  });

  it("a token minted for a different MCP server is rejected here", async () => {
    stack = await startStack();
    const other = await stack.as.mint({ aud: "https://another-mcp.example.com/mcp" });
    const raw = await fetch(stack.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${other}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(raw.status).toBe(401);
  });
});

describe("Claude Code style loopback callbacks work against the same server", () => {
  it("the server is indifferent to the client's redirect URI; the authorization server owns that check", async () => {
    stack = await startStack();
    const p = new TestProvider("http://localhost:3118/callback");
    const first = new Client({ name: "claude-code", version: "1" });
    await expect(first.connect(new StreamableHTTPClientTransport(new URL(stack.url), { authProvider: p }))).rejects.toBeInstanceOf(UnauthorizedError);
    const res = await fetch(p.authUrl as URL, { redirect: "manual" });
    expect(new URL(res.headers.get("location") as string).origin).toBe("http://localhost:3118");
  });
});

void USER_A;
