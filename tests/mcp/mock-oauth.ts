import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from "jose";

export interface MockAsOptions {
  /** Path of the issuer, to mirror Supabase's `https://<ref>.supabase.co/auth/v1`. */
  issuerPath?: string;
  /** `resource`: aud = the RFC 8707 resource asked for. `authenticated`: aud is always "authenticated", like Supabase today. */
  audience?: "resource" | "authenticated";
  scopesSupported?: string[];
  /** Put the granted scopes in the access token (`scope` claim). Supabase's documented token has none. */
  scopeClaim?: boolean;
  advertiseDcr?: boolean;
  accessTokenSeconds?: number;
  codeChallengeMethods?: string[];
}

interface Registered {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string | undefined;
  scope: string;
  userId: string;
  expires: number;
}

export interface TokenClaims {
  [k: string]: unknown;
}

/**
 * A small OAuth 2.1 authorization server shaped like Supabase's: RFC 8414 discovery with path insertion, open dynamic
 * client registration, PKCE S256, rotating refresh tokens, ES256 JWTs with a `client_id` claim and a JWKS endpoint.
 * It lets the official MCP SDK client run the real discovery -> register -> authorize -> token -> refresh flow.
 */
export class MockAuthServer {
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: Array<{ contentType: string; body: URLSearchParams }> = [];
  readonly registrations: Registered[] = [];
  /** Who signs in when the browser reaches /authorize. */
  userId = "00000000-0000-4000-8000-00000000000a";
  /** Simulates the user pressing "Deny" on the consent screen. */
  deny = false;
  jwksDown = false;
  accessTokenSeconds: number;

  private server!: Server;
  private privateKey!: KeyLike;
  private jwk!: JWK;
  private readonly kid = randomUUID();
  private readonly clients = new Map<string, Registered>();
  private readonly codes = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, Grant>();
  base = "";
  issuer = "";

  constructor(private readonly options: MockAsOptions = {}) {
    this.accessTokenSeconds = options.accessTokenSeconds ?? 3600;
  }

  async start(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
    this.privateKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: this.kid, alg: "ES256", use: "sig" };
    this.server = createServer((req, res) => void this.handle(req, res).catch(() => res.writeHead(500).end()));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.issuer = this.base + (this.options.issuerPath ?? "/auth/v1");
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  get jwksUrl(): string {
    return `${this.issuer}/.well-known/jwks.json`;
  }

  /** Signs an access token with this server's key. Claims default to a valid MCP token for `userId`. */
  async mint(claims: TokenClaims = {}, signWith: KeyLike = this.privateKey, header: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.issuer,
      sub: this.userId,
      aud: "authenticated",
      role: "authenticated",
      client_id: randomUUID(),
      session_id: randomUUID(),
      iat: now,
      exp: now + this.accessTokenSeconds,
      ...claims,
    };
    const jwt = new SignJWT(payload as never).setProtectedHeader({ alg: "ES256", kid: this.kid, ...header });
    return jwt.sign(signWith);
  }

  private metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      jwks_uri: this.jwksUrl,
      ...(this.options.advertiseDcr !== false && { registration_endpoint: `${this.issuer}/oauth/register` }),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: this.options.codeChallengeMethods ?? ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: this.options.scopesSupported ?? ["openid", "email", "profile"],
      authorization_response_iss_parameter_supported: true,
    };
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.base);
    const path = url.pathname;
    const ip = this.options.issuerPath ?? "/auth/v1";

    if (path === `/.well-known/oauth-authorization-server${ip}` || path === `/.well-known/openid-configuration${ip}` || path === `${ip}/.well-known/openid-configuration`) {
      return this.json(res, 200, this.metadata());
    }
    if (path === `${ip}/.well-known/jwks.json`) {
      if (this.jwksDown) return void res.writeHead(503).end();
      return this.json(res, 200, { keys: [this.jwk] });
    }
    if (path === `${ip}/oauth/register` && req.method === "POST") {
      const meta = JSON.parse(await this.readBody(req)) as { redirect_uris?: string[]; client_name?: string };
      if (!Array.isArray(meta.redirect_uris) || meta.redirect_uris.length === 0) return this.json(res, 400, { error: "invalid_redirect_uri" });
      const client: Registered = { client_id: randomUUID(), redirect_uris: meta.redirect_uris, ...(meta.client_name && { client_name: meta.client_name }) };
      this.clients.set(client.client_id, client);
      this.registrations.push(client);
      return this.json(res, 201, { ...client, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    }
    if (path === `${ip}/oauth/authorize` && req.method === "GET") return this.authorize(url, res);
    if (path === `${ip}/oauth/token` && req.method === "POST") return this.token(req, res);
    res.writeHead(404).end();
  }

  private authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams;
    this.authorizeRequests.push(q);
    const client = this.clients.get(q.get("client_id") ?? "");
    const redirectUri = q.get("redirect_uri") ?? "";
    // Never redirect to an unregistered URI: report the problem on this page instead.
    if (!client || !client.redirect_uris.includes(redirectUri)) return this.json(res, 400, { error: "invalid_request", error_description: "unknown client or redirect_uri" });
    const back = new URL(redirectUri);
    if (q.get("state")) back.searchParams.set("state", q.get("state") as string);
    back.searchParams.set("iss", this.issuer);
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
      back.searchParams.set("error", "invalid_request");
    } else if (this.deny) {
      back.searchParams.set("error", "access_denied");
    } else {
      const code = randomBytes(24).toString("base64url");
      this.codes.set(code, {
        clientId: client.client_id,
        redirectUri,
        challenge: q.get("code_challenge") as string,
        resource: q.get("resource") ?? undefined,
        scope: q.get("scope") ?? "",
        userId: this.userId,
        expires: Date.now() + 600_000,
      });
      back.searchParams.set("code", code);
    }
    res.writeHead(302, { location: back.toString() }).end();
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const contentType = String(req.headers["content-type"] ?? "");
    const body = new URLSearchParams(await this.readBody(req));
    this.tokenRequests.push({ contentType, body });
    if (!contentType.startsWith("application/x-www-form-urlencoded")) return this.json(res, 415, { error: "invalid_request" });

    const grantType = body.get("grant_type");
    let grant: Grant | undefined;
    if (grantType === "authorization_code") {
      grant = this.codes.get(body.get("code") ?? "");
      this.codes.delete(body.get("code") ?? ""); // single use
      const verifier = body.get("code_verifier") ?? "";
      const ok =
        grant &&
        grant.expires > Date.now() &&
        grant.clientId === body.get("client_id") &&
        grant.redirectUri === body.get("redirect_uri") &&
        createHash("sha256").update(verifier).digest("base64url") === grant.challenge;
      if (!ok) return this.json(res, 400, { error: "invalid_grant" });
    } else if (grantType === "refresh_token") {
      grant = this.refreshTokens.get(body.get("refresh_token") ?? "");
      this.refreshTokens.delete(body.get("refresh_token") ?? ""); // rotation: the old one dies immediately
      if (!grant || grant.clientId !== body.get("client_id")) return this.json(res, 400, { error: "invalid_grant" });
    } else {
      return this.json(res, 400, { error: "unsupported_grant_type" });
    }

    const resource = body.get("resource") ?? grant.resource;
    const audience = this.options.audience === "resource" && resource ? resource : "authenticated";
    const scopes = grant.scope;
    const access = await this.mint({ sub: grant.userId, client_id: grant.clientId, aud: audience, ...(this.options.scopeClaim && scopes && { scope: scopes }) });
    const refresh = randomBytes(24).toString("base64url");
    this.refreshTokens.set(refresh, { ...grant, resource });
    this.json(res, 200, { access_token: access, token_type: "bearer", expires_in: this.accessTokenSeconds, refresh_token: refresh, ...(scopes && { scope: scopes }) });
  }

  /** Invalidates every refresh token, as when the user revokes the connector. */
  revokeAll(): void {
    this.refreshTokens.clear();
  }
}
