import { ConnectorException, type ConnectionStatus } from "@serp/contracts";
import type { CredentialRepository, Repository, StoredSecret } from "@serp/db";
import type { Logger } from "@serp/observability";
import { GoogleOAuthError, type GoogleOAuthClient, type GoogleTokenSet } from "@serp/provider-google";
import { decryptSecret, encryptSecret, rewrapSecret, type KeyProvider } from "@serp/secrets";
import { z } from "zod";
import { writeAudit } from "./audit.js";

const payloadSchema = z.object({
  v: z.literal(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
  scopes: z.array(z.string()),
});
type Payload = z.infer<typeof payloadSchema>;

export interface AccessToken {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface CredentialServiceDeps {
  creds: CredentialRepository;
  repo: Repository;
  keys: KeyProvider;
  google: GoogleOAuthClient;
  logger: Logger;
  clock?: () => number;
  /** Refresh this long before actual expiry so a token never dies mid-request. */
  skewMs?: number;
}

/** Binds ciphertext to its owner: a secret copied to another user's or connection's row will not decrypt. */
export const secretAad = (userId: string, connectionId: string) => `cred:v1:${userId}:${connectionId}`;

const RECONNECT_HINT = "Open the SERP Connect dashboard, find this Google account under Connections and click Reconnect, then ask again.";

/**
 * The only code that reads or writes provider credentials. Tokens are decrypted just-in-time, kept in
 * local variables, and never logged, audited or returned to anything but the calling adapter.
 */
export class CredentialService {
  private readonly clock: () => number;
  private readonly skewMs: number;
  private readonly inflight = new Map<string, Promise<AccessToken>>();

  constructor(private readonly deps: CredentialServiceDeps) {
    this.clock = deps.clock ?? Date.now;
    this.skewMs = deps.skewMs ?? 60_000;
  }

  // ---- storing -----------------------------------------------------------------

  /** Encrypts and stores a token set under CAS. Used for first grants, reconnects and refreshes. */
  async storeTokens(
    userId: string,
    connectionId: string,
    tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] },
    expectedVersion: number | null,
  ): Promise<number | null> {
    const payload: Payload = { v: 1, ...tokens };
    const secret = await encryptSecret(JSON.stringify(payload), this.deps.keys, secretAad(userId, connectionId));
    return this.deps.creds.putSecret(userId, connectionId, secret, expectedVersion);
  }

  private async load(userId: string, connectionId: string): Promise<{ payload: Payload; version: number } | null> {
    const row = await this.deps.creds.getSecret(userId, connectionId);
    if (!row) return null;
    try {
      const plain = await decryptSecret(row.secret, this.deps.keys, secretAad(userId, connectionId));
      return { payload: payloadSchema.parse(JSON.parse(plain)), version: row.credentialVersion };
    } catch {
      // Tampered, moved between rows, or encrypted with a key we no longer have.
      await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode: "CREDENTIAL_UNREADABLE" });
      await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, eventType: "credential.unreadable" });
      throw new ConnectorException("AUTH_EXPIRED", "Stored credentials could not be used. Please reconnect.", {
        suggestedAction: RECONNECT_HINT,
      });
    }
  }

  // ---- using -------------------------------------------------------------------

  /**
   * Returns a valid access token, refreshing if needed. Concurrent callers for the same connection share
   * one refresh. Never retries a connection that is already marked as needing attention.
   */
  async getAccessToken(userId: string, connectionId: string, requestId?: string): Promise<AccessToken> {
    const key = `${userId}:${connectionId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const run = this.resolveToken(userId, connectionId, requestId).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async resolveToken(userId: string, connectionId: string, requestId?: string): Promise<AccessToken> {
    const conn = await this.deps.repo.getConnection(userId, connectionId);
    if (!conn) {
      // Same answer for "does not exist" and "belongs to someone else".
      throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.");
    }
    // A single rejected token (AUTH_EXPIRED) is not proof the grant is gone: try one refresh. A failed refresh
    // (invalid_grant) sets AUTH_REVOKED, which does stay blocked until the user reconnects.
    if (!(conn.status === "needs_attention" && conn.lastErrorCode === "AUTH_EXPIRED")) this.assertUsable(conn.status);

    const loaded = await this.load(userId, connectionId);
    if (!loaded) {
      await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode: "CREDENTIAL_MISSING" });
      throw new ConnectorException("AUTH_EXPIRED", "This connection has no stored credentials. Please reconnect.", {
        suggestedAction: RECONNECT_HINT,
      });
    }
    const { payload, version } = loaded;
    if (payload.expiresAt - this.skewMs > this.clock()) {
      return { accessToken: payload.accessToken, expiresAt: payload.expiresAt, scopes: payload.scopes };
    }
    return this.refresh(userId, connectionId, payload, version, requestId);
  }

  /**
   * Refreshes the access token now, even if the stored one looks valid. Used once after Google answers 401 for a token
   * we believed good (it can be invalidated early), so a stale token never surfaces as a reconnect request when the
   * refresh token still works. A revoked refresh token still ends in AUTH_REVOKED.
   */
  async forceRefreshAccessToken(userId: string, connectionId: string, requestId?: string): Promise<AccessToken> {
    const conn = await this.deps.repo.getConnection(userId, connectionId);
    if (!conn) throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.");
    if (!(conn.status === "needs_attention" && conn.lastErrorCode === "AUTH_EXPIRED")) this.assertUsable(conn.status);
    const loaded = await this.load(userId, connectionId);
    if (!loaded) throw new ConnectorException("AUTH_EXPIRED", "This connection has no stored credentials. Please reconnect.", { suggestedAction: RECONNECT_HINT });
    return this.refresh(userId, connectionId, loaded.payload, loaded.version, requestId);
  }

  private assertUsable(status: ConnectionStatus): void {
    if (status === "connected") return;
    if (status === "revoked") {
      throw new ConnectorException("AUTH_REVOKED", "Access to this account was revoked.", {
        suggestedAction: RECONNECT_HINT,
      });
    }
    throw new ConnectorException("AUTH_EXPIRED", "This connection needs attention.", {
      suggestedAction: RECONNECT_HINT,
    });
  }

  private async refresh(userId: string, connectionId: string, current: Payload, version: number, requestId?: string): Promise<AccessToken> {
    let fresh: GoogleTokenSet;
    try {
      fresh = await this.deps.google.refresh(current.refreshToken);
    } catch (err) {
      return this.handleRefreshFailure(userId, connectionId, err, requestId);
    }

    const next = {
      accessToken: fresh.accessToken,
      // Google normally does not rotate the refresh token; keep ours unless a new one is issued.
      refreshToken: fresh.refreshToken ?? current.refreshToken,
      expiresAt: fresh.expiresAt,
      scopes: fresh.scopes.length > 0 ? fresh.scopes : current.scopes,
    };
    const written = await this.storeTokens(userId, connectionId, next, version);
    if (written === null) {
      // Another instance refreshed first. Use what it stored instead of overwriting newer data.
      const reloaded = await this.load(userId, connectionId);
      if (reloaded && reloaded.payload.expiresAt - this.skewMs > this.clock()) {
        return { accessToken: reloaded.payload.accessToken, expiresAt: reloaded.payload.expiresAt, scopes: reloaded.payload.scopes };
      }
      throw new ConnectorException("PROVIDER_UNAVAILABLE", "Credentials changed while refreshing. Try again.", { retryable: true });
    }
    await this.deps.creds.setConnectionStatus(userId, connectionId, "connected", { markValidated: true });
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, eventType: "credential.refreshed", provider: "google" });
    return { accessToken: next.accessToken, expiresAt: next.expiresAt, scopes: next.scopes };
  }

  private async handleRefreshFailure(userId: string, connectionId: string, err: unknown, requestId?: string): Promise<never> {
    const kind = err instanceof GoogleOAuthError ? err.kind : "transient";
    const base = { userId, connectionId, requestId, provider: "google" as const };

    if (kind === "invalid_grant") {
      // Revoked by the user in their Google account, or expired. Retrying cannot help: stop and ask to reconnect.
      await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode: "AUTH_REVOKED" });
      await writeAudit(this.deps.repo, this.deps.logger, { ...base, eventType: "credential.refresh_failed", metadata: { errorKind: kind } });
      throw new ConnectorException("AUTH_REVOKED", "Google access was revoked or has expired. Please reconnect.", {
        provider: "google",
        suggestedAction: RECONNECT_HINT,
      });
    }
    if (kind === "invalid_client" || kind === "bad_response") {
      // Our configuration or Google's response is at fault; do not blame (or lock out) the user's connection.
      this.deps.logger.error("credential.refresh_misconfigured", { connectionId, errorKind: kind });
      await writeAudit(this.deps.repo, this.deps.logger, { ...base, eventType: "credential.refresh_failed", metadata: { errorKind: kind } });
      throw new ConnectorException("PROVIDER_UNAVAILABLE", "Google access is temporarily unavailable.", { provider: "google" });
    }
    await writeAudit(this.deps.repo, this.deps.logger, { ...base, eventType: "credential.refresh_failed", metadata: { errorKind: "transient" } });
    throw new ConnectorException("PROVIDER_UNAVAILABLE", "Google is temporarily unavailable. Try again shortly.", {
      provider: "google",
      retryable: true,
    });
  }

  /** Flags a connection after Google rejected a token we believed valid (e.g. revoked just now). */
  async markNeedsAttention(userId: string, connectionId: string, errorCode: string, requestId?: string): Promise<void> {
    const changed = await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode });
    if (changed) {
      await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, provider: "google", eventType: "connection.needs_attention", metadata: { reason: errorCode } });
    }
  }

  // ---- revoking and deleting ---------------------------------------------------

  /**
   * Disconnects one connection: revoke the grant at Google (best effort), destroy the stored secret,
   * then remove the connection with its properties and cached reports. Local removal always happens,
   * because the user's intent to disconnect must not depend on Google being reachable.
   */
  async disconnect(userId: string, connectionId: string, requestId?: string): Promise<{ disconnected: boolean; revokedAtProvider: boolean }> {
    const conn = await this.deps.repo.getConnection(userId, connectionId);
    if (!conn) return { disconnected: false, revokedAtProvider: false };

    let revokedAtProvider = false;
    if (conn.provider === "google") {
      revokedAtProvider = await this.revokeAtGoogle(userId, connectionId);
    }
    await this.deps.creds.deleteSecret(userId, connectionId);
    const removed = await this.deps.repo.disconnectConnection(userId, connectionId);
    await writeAudit(this.deps.repo, this.deps.logger, {
      userId,
      requestId,
      eventType: "connection.disconnected",
      provider: conn.provider,
      metadata: { revokedAtProvider },
    });
    return { disconnected: removed, revokedAtProvider };
  }

  private async revokeAtGoogle(userId: string, connectionId: string): Promise<boolean> {
    try {
      const row = await this.deps.creds.getSecret(userId, connectionId);
      if (!row) return false;
      const plain = await decryptSecret(row.secret, this.deps.keys, secretAad(userId, connectionId));
      const payload = payloadSchema.parse(JSON.parse(plain));
      // Revoking the refresh token also invalidates the access tokens issued from it.
      await this.deps.google.revoke(payload.refreshToken);
      return true;
    } catch (err) {
      this.deps.logger.warn("credential.revoke_failed", { connectionId, errorKind: err instanceof GoogleOAuthError ? err.kind : "unreadable" });
      return false;
    }
  }

  /** Account deletion: revoke and remove every connection the user owns. */
  async disconnectAll(userId: string, requestId?: string): Promise<{ total: number; revokedAtProvider: number }> {
    const connections = await this.deps.repo.listConnections(userId);
    let revoked = 0;
    for (const c of connections) {
      const r = await this.disconnect(userId, c.id, requestId);
      if (r.revokedAtProvider) revoked++;
    }
    return { total: connections.length, revokedAtProvider: revoked };
  }

  // ---- key rotation ------------------------------------------------------------

  /**
   * Re-wraps data keys that still use an old key version. The encrypted payload is untouched.
   * Run from a scheduled job after adding a new key to SECRET_KEYS and making it current.
   */
  async rewrapBatch(limit = 100): Promise<{ rewrapped: number; skipped: number }> {
    const rows = await this.deps.creds.listSecretsForRewrap(this.deps.keys.keyVersion, limit);
    let rewrapped = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const next: StoredSecret = await rewrapSecret(row.secret, this.deps.keys);
        const written = await this.deps.creds.putSecret(row.userId, row.connectionId, next, row.credentialVersion);
        if (written === null) skipped++;
        else rewrapped++;
      } catch {
        skipped++;
        this.deps.logger.error("credential.rewrap_failed", { connectionId: row.connectionId });
      }
    }
    return { rewrapped, skipped };
  }
}
