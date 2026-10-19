import { ConnectorException, type AuthorizedQueryContext } from "@serp/contracts";
import type { CredentialRepository, Repository } from "@serp/db";
import type { Logger } from "@serp/observability";
import { validateClarityToken, validateConnectionName, type ClarityConnectionHooks } from "@serp/provider-clarity";
import { decryptSecret, encryptSecret, type Fingerprinter, type KeyProvider } from "@serp/secrets";
import { z } from "zod";
import { writeAudit } from "./audit.js";
import { secretAad } from "./service.js";

const payloadSchema = z.object({ v: z.literal(1), kind: z.literal("clarity"), token: z.string().min(20) });

/** Per-user cap, so one account cannot create unbounded connections. */
export const MAX_CLARITY_CONNECTIONS_PER_USER = 10;

/** Provider-native property key: derived from the keyed fingerprint, never from the token itself. */
export const clarityProjectKey = (fingerprint: string) => `clarity:${fingerprint.slice(0, 32)}`;

export interface ClarityConnectionDeps {
  creds: CredentialRepository;
  repo: Repository;
  keys: KeyProvider;
  /** Created lazily by the caller so a missing CREDENTIAL_FINGERPRINT_KEY fails only the Clarity save, not the whole app. */
  fingerprinter: () => Fingerprinter;
  logger: Logger;
}

/**
 * Stores and uses Microsoft Clarity API tokens. The token is encrypted with the same envelope scheme as Google
 * credentials (bound to user + connection), decrypted only just-in-time for one API call, and never logged,
 * audited, returned, or used as a cache or quota key (a keyed fingerprint is).
 *
 * One connection = one Clarity project token = one property (the project), so the existing property authorization,
 * cache scoping and MCP allowlist apply unchanged.
 */
export class ClarityConnectionService {
  constructor(private readonly deps: ClarityConnectionDeps) {}

  /** Saves a token as a new connection. Makes no call to Clarity: verification would spend daily quota. */
  async connect(userId: string, input: { name: string; token: string }, requestId?: string): Promise<{ connectionId: string }> {
    const name = validateConnectionName(input.name);
    const token = input.token.trim();
    validateClarityToken(token);
    const fp = this.deps.fingerprinter().fingerprint(token);

    const existing = (await this.deps.repo.listConnections(userId)).filter((c) => c.provider === "clarity");
    const duplicate = existing.find((c) => c.providerAccountId === fp);
    if (!duplicate && existing.length >= MAX_CLARITY_CONNECTIONS_PER_USER) {
      throw new ConnectorException("INVALID_QUERY", `You can connect up to ${MAX_CLARITY_CONNECTIONS_PER_USER} Clarity projects. Remove one first.`, { provider: "clarity" });
    }

    // Same token again = same project: update it in place (and reset it to "awaiting verification").
    const { id, credentialVersion } = await this.deps.creds.upsertConnection({
      userId,
      provider: "clarity",
      providerAccountId: fp,
      accountLabel: name,
      grantedScopes: [],
    });
    await this.storeAndExpose(userId, id, token, name, fp, duplicate ? credentialVersion : null);
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId: id, requestId, provider: "clarity", eventType: duplicate ? "clarity.reconnected" : "clarity.connected" });
    return { connectionId: id };
  }

  /** Replaces the token of one of the caller's own connections (e.g. after rotating it in Clarity). */
  async reconnect(userId: string, connectionId: string, input: { token: string; name?: string }, requestId?: string): Promise<void> {
    const conn = await this.own(userId, connectionId);
    const name = input.name ? validateConnectionName(input.name) : (conn.accountLabel ?? "Clarity project");
    const token = input.token.trim();
    validateClarityToken(token);
    const fp = this.deps.fingerprinter().fingerprint(token);

    const changed = await this.deps.creds.updateConnectionIdentity(userId, connectionId, {
      accountLabel: name,
      ...(fp !== conn.providerAccountId && { providerAccountId: fp }),
    });
    if (changed === "conflict") {
      throw new ConnectorException("INVALID_QUERY", "That token is already connected under another name. Remove the other connection first.", { provider: "clarity" });
    }
    const current = await this.deps.creds.getSecret(userId, connectionId);
    await this.storeAndExpose(userId, connectionId, token, name, fp, current?.credentialVersion ?? null);
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, requestId, provider: "clarity", eventType: "clarity.reconnected" });
  }

  async rename(userId: string, connectionId: string, newName: string): Promise<void> {
    const conn = await this.own(userId, connectionId);
    const name = validateConnectionName(newName);
    await this.deps.creds.updateConnectionIdentity(userId, connectionId, { accountLabel: name });
    const property = (await this.deps.repo.listProperties(userId, { provider: "clarity", connectionId }))[0];
    if (property) {
      await this.deps.repo.syncDiscoveredProperties(userId, connectionId, "clarity", [
        { externalPropertyId: property.externalPropertyId, displayName: name, propertyType: property.propertyType, timezone: property.timezone },
      ]);
    }
    await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId: conn.id, provider: "clarity", eventType: "clarity.renamed" });
  }

  private async storeAndExpose(userId: string, connectionId: string, token: string, name: string, fp: string, expectedVersion: number | null) {
    const secret = await encryptSecret(JSON.stringify({ v: 1, kind: "clarity", token }), this.deps.keys, secretAad(userId, connectionId));
    const written = await this.deps.creds.putSecret(userId, connectionId, secret, expectedVersion);
    if (written === null) throw new ConnectorException("PROVIDER_UNAVAILABLE", "The connection changed while saving. Try again.", { provider: "clarity", retryable: true });
    await this.deps.creds.setConnectionStatus(userId, connectionId, "pending", { errorCode: null });
    // The project is the single property of this connection. Re-syncing with a new key replaces the old one (and its cache).
    await this.deps.repo.syncDiscoveredProperties(userId, connectionId, "clarity", [
      { externalPropertyId: clarityProjectKey(fp), displayName: name, propertyType: "clarity_project", timezone: "UTC" },
    ]);
  }

  private async own(userId: string, connectionId: string) {
    const conn = await this.deps.repo.getConnection(userId, connectionId);
    // Same answer for "missing" and "someone else's".
    if (!conn || conn.provider !== "clarity") throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.", { provider: "clarity" });
    return conn;
  }

  /**
   * Decrypts the token for exactly the connection the authorization step resolved. Pending ("awaiting verification")
   * and connected are usable; a connection flagged as needing attention is not retried blindly.
   */
  async getToken(userId: string, connectionId: string): Promise<string> {
    const conn = await this.own(userId, connectionId);
    if (conn.status !== "connected" && conn.status !== "pending") {
      throw new ConnectorException("AUTH_EXPIRED", "This Clarity connection needs attention.", { provider: "clarity", suggestedAction: "Reconnect it from the dashboard with a new token." });
    }
    const row = await this.deps.creds.getSecret(userId, connectionId);
    if (!row) {
      await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode: "CREDENTIAL_MISSING" });
      throw new ConnectorException("AUTH_EXPIRED", "This connection has no stored token. Please reconnect.", { provider: "clarity" });
    }
    try {
      const plain = await decryptSecret(row.secret, this.deps.keys, secretAad(userId, connectionId));
      return payloadSchema.parse(JSON.parse(plain)).token;
    } catch {
      await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode: "CREDENTIAL_UNREADABLE" });
      await writeAudit(this.deps.repo, this.deps.logger, { userId, connectionId, provider: "clarity", eventType: "credential.unreadable" });
      throw new ConnectorException("AUTH_EXPIRED", "The stored token could not be used. Please reconnect.", { provider: "clarity" });
    }
  }

  /** Records only what a real provider answer proves. */
  readonly hooks: ClarityConnectionHooks = {
    onSuccess: async (ctx: AuthorizedQueryContext) => {
      await this.deps.creds.setConnectionStatus(ctx.userId, ctx.connection.id, "connected", { markValidated: true, errorCode: null });
    },
    onAuthRejected: async (ctx, code) => {
      await this.deps.creds.setConnectionStatus(ctx.userId, ctx.connection.id, "needs_attention", { errorCode: code });
      await writeAudit(this.deps.repo, this.deps.logger, { userId: ctx.userId, connectionId: ctx.connection.id, requestId: ctx.requestId, provider: "clarity", eventType: "connection.needs_attention", metadata: { reason: code } });
    },
    onRateLimited: async (ctx) => {
      // A rate limit says nothing about the token's validity: keep its status, remember why requests stopped.
      const status = ctx.connection.status === "pending" ? "pending" : "connected";
      await this.deps.creds.setConnectionStatus(ctx.userId, ctx.connection.id, status, { errorCode: "PROVIDER_RATE_LIMITED" });
    },
  };
}
