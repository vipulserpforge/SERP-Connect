import { randomUUID } from "node:crypto";
import { ConnectorException, type AuthMethod, type AuthorizedQueryContext, type ProviderConnection } from "@serp/contracts";
import type { CredentialRepository, Repository } from "@serp/db";
import type { Logger } from "@serp/observability";
import {
  BING_READ_SCOPE,
  BingApiError,
  BingOAuthError,
  buildBingAuthUrl,
  discoverBingSites,
  toBingConnectorError,
  validateBingApiKey,
  validateBingConnectionName,
  type BingApiClient,
  type BingAuth,
  type BingConnectionHooks,
  type BingOAuthClient,
  type SkippedBingSite,
} from "@serp/provider-bing";
import { createStateToken, hashState } from "@serp/provider-google";
import { decryptSecret, encryptSecret, type Fingerprinter, type KeyProvider } from "@serp/secrets";
import { z } from "zod";
import { writeAudit } from "./audit.js";
import { secretAad } from "./service.js";

const payloadSchema = z.discriminatedUnion("method", [
  z.object({ v: z.literal(1), kind: z.literal("bing"), method: z.literal("oauth"), accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number() }),
  z.object({ v: z.literal(1), kind: z.literal("bing"), method: z.literal("api_key"), apiKey: z.string().min(16) }),
]);
type Payload = z.infer<typeof payloadSchema>;
type OAuthPayload = Extract<Payload, { method: "oauth" }>;

/** Per-user cap, so one account cannot create unbounded connections. */
export const MAX_BING_CONNECTIONS_PER_USER = 5;
const DEFAULT_LABEL = "Bing Webmaster account";
const RECONNECT = "Start the connection again from the dashboard.";

export interface BingOAuthConfig {
  clientId: string;
  redirectUri: string;
  stateTtlMs?: number;
}

export interface BingConnectionDeps {
  creds: CredentialRepository;
  repo: Repository;
  keys: KeyProvider;
  api: BingApiClient;
  /** Null when the operator has not registered a Bing OAuth client: OAuth is then unavailable, the API-key path still works. */
  oauth: { client: BingOAuthClient; config: BingOAuthConfig } | null;
  /** Created lazily by the caller so a missing CREDENTIAL_FINGERPRINT_KEY fails only an API-key save. */
  fingerprinter: () => Fingerprinter;
  logger: Logger;
  clock?: () => number;
  /** Refresh this long before the access token expires. */
  skewMs?: number;
}

export interface BingSyncResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
  skipped: SkippedBingSite[];
  message: string;
}

/**
 * Stores and uses Bing Webmaster credentials: an OAuth grant (access + refresh token) or the customer's own API key. The
 * method is chosen explicitly, stored with the connection, and never changed or substituted by a fallback. Secrets use the
 * same envelope encryption as the other providers (bound to user + connection), are decrypted only just-in-time, and are
 * never logged, audited or returned. One connection = one Bing login or key = many sites (properties).
 */
export class BingConnectionService {
  private readonly clock: () => number;
  private readonly skewMs: number;
  private readonly inflight = new Map<string, Promise<BingAuth>>();

  constructor(private readonly deps: BingConnectionDeps) {
    this.clock = deps.clock ?? Date.now;
    this.skewMs = deps.skewMs ?? 60_000;
  }

  get oauthConfigured(): boolean {
    return this.deps.oauth !== null;
  }

  // ---- OAuth ----------------------------------------------------------------------------------

  /**
   * Starts an OAuth attempt for the signed-in user. With `connectionId` it reconnects (or switches to OAuth) that connection;
   * without it, a new connection is created when the attempt completes. The state is single-use, expires, and is bound to
   * the user and to the intended connection.
   */
  async beginOAuth(userId: string, options: { connectionId?: string } = {}, requestId?: string): Promise<{ authorizationUrl: string; state: string }> {
    const oauth = this.deps.oauth;
    if (!oauth) {
      throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Connecting with a Bing login is not set up on this server yet.", {
        provider: "bing",
        suggestedAction: "Use your Bing API key instead, or ask the operator to configure the Bing OAuth client (docs/BING.md).",
      });
    }
    if (options.connectionId) await this.own(userId, options.connectionId);
    else await this.assertRoom(userId);

    const state = createStateToken();
    await this.deps.creds.purgeExpiredOAuthStates(new Date(this.clock()));
    await this.deps.creds.createOAuthState({
      stateHash: hashState(state),
      userId,
      product: "bing",
      codeVerifierEnc: null,
      connectionId: options.connectionId ?? null,
      expiresAt: new Date(this.clock() + (oauth.config.stateTtlMs ?? 10 * 60_000)),
    });
    await writeAudit(this.deps.repo, this.deps.logger, { userId, requestId, eventType: "oauth.started", provider: "bing", metadata: { product: "bing" } });
    return { authorizationUrl: buildBingAuthUrl({ clientId: oauth.config.clientId, redirectUri: oauth.config.redirectUri, state }), state };
  }

  /** Finishes the flow. `userId` must come from the signed-in session; a state row is honoured only for the user who made it. */
  async completeOAuth(
    userId: string,
    params: { state: string | null; code: string | null; error: string | null },
    requestId?: string,
  ): Promise<{ connectionId: string }> {
    const oauth = this.deps.oauth;
    const fail = async (reason: string, error: ConnectorException): Promise<never> => {
      await writeAudit(this.deps.repo, this.deps.logger, { userId, requestId, eventType: "oauth.failed", provider: "bing", metadata: { reason } });
      throw error;
    };
    const invalid = (message: string) => new ConnectorException("AUTH_REQUIRED", message, { provider: "bing", suggestedAction: RECONNECT });

    if (!oauth) return fail("not_configured", new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Connecting with a Bing login is not set up on this server yet.", { provider: "bing" }));
    if (!params.state || params.state.length > 200) return fail("state_missing", invalid("This connection attempt is invalid."));
    const attempt = await this.deps.creds.consumeOAuthState(userId, hashState(params.state), new Date(this.clock()));
    // A state made for Google (or for another user) is indistinguishable from an unknown one.
    if (!attempt || attempt.product !== "bing") return fail("state_invalid", invalid("This connection attempt is invalid or has expired."));
    if (params.error || !params.code || params.code.length > 2048) {
      return fail(params.error === "access_denied" ? "access_denied" : "no_code", invalid("Bing access was not granted."));
    }

    // The attempt may name a connection to reconnect: it must still be the caller's own Bing connection.
    let existing: ProviderConnection | null = null;
    if (attempt.connectionId) {
      existing = await this.deps.repo.getConnection(userId, attempt.connectionId);
      if (!existing || existing.provider !== "bing") return fail("connection_missing", invalid("The connection being reconnected no longer exists."));
    } else {
      await this.assertRoom(userId);
    }

    let tokens;
    try {
      tokens = await oauth.client.exchangeCode({ code: params.code, redirectUri: oauth.config.redirectUri });
    } catch (err) {
      const kind = err instanceof BingOAuthError ? err.kind : "transient";
      if (kind === "invalid_grant") return fail("code_rejected", invalid("Bing rejected the authorization code (it is only valid for 5 minutes and once)."));
      this.deps.logger.error("bing.oauth.exchange_failed", { errorKind: kind });
      return fail(`exchange_${kind}`, new ConnectorException("PROVIDER_UNAVAILABLE", "Bing is temporarily unavailable.", { provider: "bing", retryable: kind === "transient" }));
    }
    if (!tokens.refreshToken) {
      // Documented to be issued on the first grant. Without it the connection would silently die in an hour.
      return fail("no_refresh_token", invalid("Bing did not provide long-lived access. Start the connection again."));
    }

    let connectionId: string;
    let version: number | null;
    if (existing) {
      connectionId = existing.id;
      // Switching from an API key: the connection takes a fresh opaque account key (the old one was derived from the key).
      const switching = existing.authMethod !== "oauth";
      const changed = await this.deps.creds.updateConnectionIdentity(userId, connectionId, {
        authMethod: "oauth",
        ...(switching && { providerAccountId: `bing:oauth:${randomUUID()}` }),
      });
      if (changed !== true) return fail("connection_missing", invalid("The connection being reconnected no longer exists."));
      version = (await this.deps.creds.getSecret(userId, connectionId))?.credentialVersion ?? null;
    } else {
      const created = await this.deps.creds.upsertConnection({
        userId,
        provider: "bing",
        providerAccountId: `bing:oauth:${randomUUID()}`,
        accountLabel: DEFAULT_LABEL,
        grantedScopes: [BING_READ_SCOPE],
        authMethod: "oauth",
      });
      connectionId = created.id;
      version = null;
    }
    await this.storePayload(userId, connectionId, { v: 1, kind: "bing", method: "oauth", accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt }, version);
    // The grant is proven; API access is proven by the first successful call (site discovery), which marks it connected.
    await this.deps.creds.setConnectionStatus(userId, connectionId, "pending", { errorCode: null, grantedScopes: [BING_READ_SCOPE] });
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, eventType: "oauth.completed", provider: "bing", metadata: { product: "bing", authMethod: "oauth", scopes: [BING_READ_SCOPE] } });
    return { connectionId };
  }

  // ---- API key --------------------------------------------------------------------------------

  /** Saves a Bing API key as a new connection, or onto `connectionId` (replace the key, or switch that connection to a key). */
  async connectApiKey(userId: string, input: { name?: string; apiKey: string; connectionId?: string }, requestId?: string): Promise<{ connectionId: string }> {
    const apiKey = validateBingApiKey(input.apiKey);
    const fp = this.deps.fingerprinter().fingerprint(apiKey);
    const accountKey = `bing:key:${fp.slice(0, 32)}`;

    let connectionId: string;
    let version: number | null;
    if (input.connectionId) {
      const conn = await this.own(userId, input.connectionId);
      const name = input.name ? validateBingConnectionName(input.name) : (conn.accountLabel ?? DEFAULT_LABEL);
      const changed = await this.deps.creds.updateConnectionIdentity(userId, conn.id, { accountLabel: name, providerAccountId: accountKey, authMethod: "api_key" });
      if (changed === "conflict") {
        throw new ConnectorException("INVALID_QUERY", "That API key is already connected under another name. Remove the other connection first.", { provider: "bing" });
      }
      connectionId = conn.id;
      version = (await this.deps.creds.getSecret(userId, connectionId))?.credentialVersion ?? null;
    } else {
      const name = validateBingConnectionName(input.name ?? DEFAULT_LABEL);
      const mine = (await this.deps.repo.listConnections(userId)).filter((c) => c.provider === "bing");
      const duplicate = mine.find((c) => c.providerAccountId === accountKey);
      if (!duplicate && mine.length >= MAX_BING_CONNECTIONS_PER_USER) {
        throw new ConnectorException("INVALID_QUERY", `You can connect up to ${MAX_BING_CONNECTIONS_PER_USER} Bing accounts. Remove one first.`, { provider: "bing" });
      }
      // The same key again is the same Bing user: update in place.
      const created = await this.deps.creds.upsertConnection({ userId, provider: "bing", providerAccountId: accountKey, accountLabel: name, grantedScopes: [], authMethod: "api_key" });
      connectionId = created.id;
      version = duplicate ? created.credentialVersion : null;
    }
    await this.storePayload(userId, connectionId, { v: 1, kind: "bing", method: "api_key", apiKey }, version);
    await this.deps.creds.setConnectionStatus(userId, connectionId, "pending", { errorCode: null, grantedScopes: [] });
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, eventType: "bing.api_key_saved", provider: "bing", metadata: { authMethod: "api_key" } });
    return { connectionId };
  }

  async rename(userId: string, connectionId: string, newName: string): Promise<void> {
    const conn = await this.own(userId, connectionId);
    await this.deps.creds.updateConnectionIdentity(userId, connectionId, { accountLabel: validateBingConnectionName(newName) });
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId: conn.id, eventType: "bing.renamed", provider: "bing" });
  }

  // ---- using the credential ---------------------------------------------------------------------

  /**
   * The credential for exactly the connection the authorization step resolved, in the method stored with it. OAuth access
   * tokens are refreshed shortly before expiry; concurrent callers share one refresh. A connection that needs attention is
   * never retried blindly.
   */
  getAuth(userId: string, connectionId: string): Promise<BingAuth> {
    const key = `${userId}:${connectionId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const run = this.resolve(userId, connectionId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async resolve(userId: string, connectionId: string): Promise<BingAuth> {
    const conn = await this.own(userId, connectionId);
    if (conn.status === "revoked") {
      throw new ConnectorException("AUTH_REVOKED", "Access to this Bing account was revoked.", { provider: "bing", suggestedAction: "Reconnect Bing Webmaster from the dashboard." });
    }
    if (conn.status !== "connected" && conn.status !== "pending") {
      throw new ConnectorException("AUTH_EXPIRED", "This Bing connection needs attention.", { provider: "bing", suggestedAction: "Reconnect Bing Webmaster from the dashboard." });
    }
    const loaded = await this.load(userId, conn);
    if (loaded.payload.method === "api_key") return { method: "api_key", apiKey: loaded.payload.apiKey };
    const p = loaded.payload;
    if (p.expiresAt - this.skewMs > this.clock()) return { method: "oauth", accessToken: p.accessToken };
    return this.refresh(userId, conn.id, p, loaded.version);
  }

  private async load(userId: string, conn: ProviderConnection): Promise<{ payload: Payload; version: number }> {
    const row = await this.deps.creds.getSecret(userId, conn.id);
    if (!row) {
      await this.deps.creds.setConnectionStatus(userId, conn.id, "needs_attention", { errorCode: "CREDENTIAL_MISSING" });
      throw new ConnectorException("AUTH_EXPIRED", "This connection has no stored credentials. Please reconnect.", { provider: "bing", suggestedAction: "Reconnect Bing Webmaster from the dashboard." });
    }
    try {
      const payload = payloadSchema.parse(JSON.parse(await decryptSecret(row.secret, this.deps.keys, secretAad(userId, conn.id))));
      // The stored method and the stored secret must agree: a mismatch is never papered over by guessing.
      if (payload.method !== conn.authMethod) throw new Error("method mismatch");
      return { payload, version: row.credentialVersion };
    } catch {
      await this.deps.creds.setConnectionStatus(userId, conn.id, "needs_attention", { errorCode: "CREDENTIAL_UNREADABLE" });
      await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId: conn.id, eventType: "credential.unreadable", provider: "bing" });
      throw new ConnectorException("AUTH_EXPIRED", "Stored credentials could not be used. Please reconnect.", { provider: "bing", suggestedAction: "Reconnect Bing Webmaster from the dashboard." });
    }
  }

  private async refresh(userId: string, connectionId: string, current: OAuthPayload, version: number): Promise<BingAuth> {
    const oauth = this.deps.oauth;
    if (!oauth) {
      throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Bing logins are not configured on this server, so the access cannot be renewed.", { provider: "bing" });
    }
    let fresh;
    try {
      fresh = await oauth.client.refresh(current.refreshToken);
    } catch (err) {
      return this.refreshFailed(userId, connectionId, err);
    }
    const next: OAuthPayload = {
      v: 1,
      kind: "bing",
      method: "oauth",
      accessToken: fresh.accessToken,
      // The documented refresh response has no refresh_token: keep ours unless a new one is issued.
      refreshToken: fresh.refreshToken ?? current.refreshToken,
      expiresAt: fresh.expiresAt,
    };
    const written = await this.deps.creds.putSecret(userId, connectionId, await encryptSecret(JSON.stringify(next), this.deps.keys, secretAad(userId, connectionId)), version);
    if (written === null) {
      // Another instance refreshed first: use what it stored rather than overwrite newer data.
      const conn = await this.own(userId, connectionId);
      const reloaded = await this.load(userId, conn);
      if (reloaded.payload.method === "oauth" && reloaded.payload.expiresAt - this.skewMs > this.clock()) return { method: "oauth", accessToken: reloaded.payload.accessToken };
      throw new ConnectorException("PROVIDER_UNAVAILABLE", "Credentials changed while renewing. Try again.", { provider: "bing", retryable: true });
    }
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, eventType: "credential.refreshed", provider: "bing" });
    return { method: "oauth", accessToken: next.accessToken };
  }

  private async refreshFailed(userId: string, connectionId: string, err: unknown): Promise<never> {
    const kind = err instanceof BingOAuthError ? err.kind : "transient";
    const base = { userId, connectionId, provider: "bing" as const, eventType: "credential.refresh_failed", metadata: { errorKind: kind } };
    if (kind === "invalid_grant") {
      // Revoked by the user at Bing, or expired: retrying cannot help. Stop and ask to reconnect.
      await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode: "AUTH_REVOKED" });
      await writeAudit(this.deps.repo, this.deps.logger, base);
      throw new ConnectorException("AUTH_REVOKED", "Bing access was revoked or has expired. Please reconnect.", { provider: "bing", suggestedAction: "Reconnect Bing Webmaster from the dashboard." });
    }
    await writeAudit(this.deps.repo, this.deps.logger, base);
    if (kind === "invalid_client" || kind === "bad_response") {
      // Our configuration or Bing's response is at fault: do not blame (or lock out) the user's connection.
      this.deps.logger.error("bing.credential.refresh_misconfigured", { connectionId, errorKind: kind });
      throw new ConnectorException("PROVIDER_UNAVAILABLE", "Bing access is temporarily unavailable.", { provider: "bing" });
    }
    throw new ConnectorException("PROVIDER_UNAVAILABLE", "Bing is temporarily unavailable. Try again shortly.", { provider: "bing", retryable: true });
  }

  /** Records only what a real provider answer proves. */
  readonly hooks: BingConnectionHooks = {
    onSuccess: async (ctx: AuthorizedQueryContext) => {
      await this.deps.creds.setConnectionStatus(ctx.userId, ctx.connection.id, "connected", { markValidated: true, errorCode: null });
    },
    onAuthRejected: async (ctx: AuthorizedQueryContext) => {
      await this.markNeedsAttention(ctx.userId, ctx.connection.id, "AUTH_EXPIRED", ctx.requestId);
    },
  };

  async markNeedsAttention(userId: string, connectionId: string, errorCode: string, requestId?: string): Promise<void> {
    const changed = await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode });
    if (changed) await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, provider: "bing", eventType: "connection.needs_attention", metadata: { reason: errorCode } });
  }

  // ---- site discovery -------------------------------------------------------------------------

  /** Lists the sites the connected Bing account can see and stores the verified ones for its owner. */
  async syncSites(userId: string, connectionId: string, requestId?: string): Promise<BingSyncResult> {
    const conn = await this.own(userId, connectionId);
    const auth = await this.getAuth(userId, conn.id);
    let sites;
    try {
      sites = await this.deps.api.getUserSites(auth);
    } catch (err) {
      if (err instanceof BingApiError && err.kind === "unauthenticated") await this.markNeedsAttention(userId, conn.id, "AUTH_EXPIRED", requestId);
      await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, provider: "bing", eventType: "properties.sync_failed", metadata: { errorKind: err instanceof BingApiError ? err.kind : "unknown" } });
      throw toBingConnectorError(err);
    }
    const { properties, skipped } = discoverBingSites(sites);
    const counts = await this.deps.repo.syncDiscoveredProperties(userId, conn.id, "bing", properties);
    if (!counts) throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.", { provider: "bing" });
    // GetUserSites answered, so the credential works (even when the account has no sites yet).
    if (!this.deps.api.mock) await this.deps.creds.setConnectionStatus(userId, conn.id, "connected", { markValidated: true, errorCode: null });
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, provider: "bing", eventType: "properties.synced", metadata: { count: properties.length } });
    const n = properties.length;
    const message =
      n === 0
        ? "This Bing account has no verified sites it can read. Verify a site in Bing Webmaster Tools, then refresh."
        : `Found ${n} verified Bing ${n === 1 ? "site" : "sites"}.`;
    return { ...counts, total: n, skipped, message };
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private async storePayload(userId: string, connectionId: string, payload: Payload, expectedVersion: number | null): Promise<void> {
    const secret = await encryptSecret(JSON.stringify(payload), this.deps.keys, secretAad(userId, connectionId));
    const written = await this.deps.creds.putSecret(userId, connectionId, secret, expectedVersion);
    if (written === null) throw new ConnectorException("PROVIDER_UNAVAILABLE", "The connection changed while saving. Try again.", { provider: "bing", retryable: true });
  }

  private async assertRoom(userId: string): Promise<void> {
    const mine = (await this.deps.repo.listConnections(userId)).filter((c) => c.provider === "bing");
    if (mine.length >= MAX_BING_CONNECTIONS_PER_USER) {
      throw new ConnectorException("INVALID_QUERY", `You can connect up to ${MAX_BING_CONNECTIONS_PER_USER} Bing accounts. Remove one first.`, { provider: "bing" });
    }
  }

  private async own(userId: string, connectionId: string): Promise<ProviderConnection> {
    const conn = await this.deps.repo.getConnection(userId, connectionId);
    // Same answer for "missing" and "someone else's".
    if (!conn || conn.provider !== "bing") throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.", { provider: "bing" });
    return conn;
  }
}

export type { AuthMethod };
