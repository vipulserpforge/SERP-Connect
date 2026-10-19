import { ConnectorException } from "@serp/contracts";
import type { CredentialRepository, OAuthProduct, Repository } from "@serp/db";
import type { Logger } from "@serp/observability";
import {
  GOOGLE_IDENTITY_SCOPES,
  GOOGLE_SCOPES,
  GoogleOAuthError,
  buildGoogleAuthUrl,
  connectScope,
  createPkcePair,
  createStateToken,
  hashState,
  maskEmail,
  parseIdToken,
  type GoogleOAuthClient,
} from "@serp/provider-google";
import { decryptSecret, encryptSecret, type KeyProvider } from "@serp/secrets";
import { writeAudit } from "./audit.js";
import { secretAad, type CredentialService } from "./service.js";

export interface OAuthFlowConfig {
  clientId: string;
  redirectUri: string;
  stateTtlMs?: number;
}

export interface OAuthFlowDeps {
  creds: CredentialRepository;
  repo: Repository;
  keys: KeyProvider;
  google: GoogleOAuthClient;
  credentials: CredentialService;
  logger: Logger;
  config: OAuthFlowConfig;
  clock?: () => number;
}

/** The Google flow serves these products; Bing has its own service (BingConnectionService). */
type GoogleProduct = Exclude<OAuthProduct, "bing">;

const stateAad = (stateHash: string, userId: string) => `oauth-state:v1:${userId}:${stateHash}`;
const RECONNECT = "Start the connection again from the dashboard.";

/** Authorization-code + PKCE flow with server-side, single-use, user-bound state. */
export class OAuthFlowService {
  private readonly clock: () => number;
  private readonly ttl: number;

  constructor(private readonly deps: OAuthFlowDeps) {
    this.clock = deps.clock ?? Date.now;
    this.ttl = deps.config.stateTtlMs ?? 10 * 60_000;
  }

  /** Starts a connect attempt for the signed-in user. The PKCE verifier never leaves the server. */
  async begin(userId: string, product: GoogleProduct, requestId?: string): Promise<{ authorizationUrl: string }> {
    const state = createStateToken();
    const stateHash = hashState(state);
    const pkce = createPkcePair();
    const codeVerifierEnc = await encryptSecret(pkce.verifier, this.deps.keys, stateAad(stateHash, userId));

    await this.deps.creds.purgeExpiredOAuthStates(new Date(this.clock()));
    await this.deps.creds.createOAuthState({
      stateHash,
      userId,
      product,
      codeVerifierEnc,
      expiresAt: new Date(this.clock() + this.ttl),
    });
    await writeAudit(this.deps.repo, this.deps.logger, { userId, requestId, eventType: "oauth.started", provider: product, metadata: { product } });

    return {
      authorizationUrl: buildGoogleAuthUrl({
        clientId: this.deps.config.clientId,
        redirectUri: this.deps.config.redirectUri,
        scope: connectScope(product),
        state,
        codeChallenge: pkce.challenge,
      }),
    };
  }

  /**
   * Finishes the flow. `userId` must come from the signed-in session; the state row is only honoured
   * for the user who created it, so a stolen callback link cannot attach a victim's Google account to
   * someone else (or vice versa).
   */
  async complete(
    userId: string,
    params: { state: string | null; code: string | null; error: string | null },
    requestId?: string,
  ): Promise<{ connectionId: string; accountLabel: string; product: GoogleProduct }> {
    const fail = async (reason: string, error: ConnectorException): Promise<never> => {
      await writeAudit(this.deps.repo, this.deps.logger, { userId, requestId, eventType: "oauth.failed", provider: "google", metadata: { reason } });
      throw error;
    };

    if (!params.state || params.state.length > 200) {
      return fail("state_missing", new ConnectorException("AUTH_REQUIRED", "This connection attempt is invalid.", { suggestedAction: RECONNECT }));
    }
    const stateHash = hashState(params.state);
    const attempt = await this.deps.creds.consumeOAuthState(userId, stateHash, new Date(this.clock()));
    if (!attempt) {
      return fail("state_invalid", new ConnectorException("AUTH_REQUIRED", "This connection attempt is invalid or has expired.", { suggestedAction: RECONNECT }));
    }
    // A Bing attempt (or any attempt without a PKCE verifier) must not be completable through the Google callback.
    if (attempt.product === "bing" || !attempt.codeVerifierEnc) {
      return fail("state_invalid", new ConnectorException("AUTH_REQUIRED", "This connection attempt is invalid or has expired.", { suggestedAction: RECONNECT }));
    }
    const product: GoogleProduct = attempt.product;
    const verifierEnc = attempt.codeVerifierEnc;
    if (params.error || !params.code || params.code.length > 2048) {
      return fail(
        params.error === "access_denied" ? "access_denied" : "no_code",
        new ConnectorException("AUTH_REQUIRED", "Google access was not granted.", { suggestedAction: RECONNECT }),
      );
    }

    let verifier: string;
    try {
      verifier = await decryptSecret(verifierEnc, this.deps.keys, stateAad(stateHash, userId));
    } catch {
      return fail("verifier_unreadable", new ConnectorException("AUTH_REQUIRED", "This connection attempt is invalid.", { suggestedAction: RECONNECT }));
    }

    let tokens;
    try {
      tokens = await this.deps.google.exchangeCode({ code: params.code, codeVerifier: verifier, redirectUri: this.deps.config.redirectUri });
    } catch (err) {
      const kind = err instanceof GoogleOAuthError ? err.kind : "transient";
      if (kind === "invalid_grant") {
        return fail("code_rejected", new ConnectorException("AUTH_REQUIRED", "Google rejected the authorization code.", { suggestedAction: RECONNECT }));
      }
      this.deps.logger.error("oauth.exchange_failed", { errorKind: kind });
      return fail(`exchange_${kind}`, new ConnectorException("PROVIDER_UNAVAILABLE", "Google is temporarily unavailable.", { provider: "google", retryable: kind === "transient" }));
    }

    // Granular consent lets users untick scopes: insist on the one this attempt is for.
    const required = GOOGLE_SCOPES[product];
    if (!tokens.scopes.includes(required)) {
      return fail("scope_missing", new ConnectorException("AUTH_REQUIRED", "The required read-only permission was not granted.", { provider: "google", suggestedAction: RECONNECT }));
    }

    let identity;
    try {
      if (!tokens.idToken) throw new Error("no id_token");
      identity = parseIdToken(tokens.idToken, { clientId: this.deps.config.clientId, now: this.clock() });
    } catch {
      return fail("identity_unverified", new ConnectorException("PROVIDER_UNAVAILABLE", "Could not verify the Google account.", { provider: "google" }));
    }

    const grantedScopes = tokens.scopes.filter((s) => !(GOOGLE_IDENTITY_SCOPES as readonly string[]).includes(s));
    const accountLabel = identity.email ? maskEmail(identity.email) : `Google account ...${identity.sub.slice(-4)}`;

    // Same Google account again (reconnect or second product) updates the existing connection.
    const { id: connectionId, credentialVersion } = await this.deps.creds.upsertConnection({
      userId,
      provider: "google",
      providerAccountId: identity.sub,
      accountLabel,
      grantedScopes,
    });

    let refreshToken = tokens.refreshToken;
    if (!refreshToken) {
      // Defensive: with prompt=consent Google always sends one. Keep the old one if we still have it.
      try {
        refreshToken = (await this.currentRefreshToken(userId, connectionId)) ?? undefined;
      } catch {
        refreshToken = undefined;
      }
    }
    if (!refreshToken) {
      await this.deps.creds.setConnectionStatus(userId, connectionId, "needs_attention", { errorCode: "NO_REFRESH_TOKEN" });
      return fail("no_refresh_token", new ConnectorException("AUTH_REQUIRED", "Google did not grant offline access.", { provider: "google", suggestedAction: RECONNECT }));
    }

    const written = await this.deps.credentials.storeTokens(
      userId,
      connectionId,
      { accessToken: tokens.accessToken, refreshToken, expiresAt: tokens.expiresAt, scopes: grantedScopes },
      credentialVersion,
    );
    if (written === null) {
      return fail("concurrent_update", new ConnectorException("PROVIDER_UNAVAILABLE", "The connection changed while saving. Try again.", { retryable: true }));
    }
    await this.deps.creds.setConnectionStatus(userId, connectionId, "connected", { markValidated: true, errorCode: null, grantedScopes });
    await writeAudit(this.deps.repo, this.deps.logger, {
      userId,
      connectionId,
      requestId,
      eventType: "oauth.completed",
      provider: product,
      metadata: { product, scopes: grantedScopes },
    });
    return { connectionId, accountLabel, product };
  }

  private async currentRefreshToken(userId: string, connectionId: string): Promise<string | null> {
    const row = await this.deps.creds.getSecret(userId, connectionId);
    if (!row) return null;
    const plain = await decryptSecret(row.secret, this.deps.keys, secretAad(userId, connectionId));
    const parsed = JSON.parse(plain) as { refreshToken?: string };
    return parsed.refreshToken ?? null;
  }
}
