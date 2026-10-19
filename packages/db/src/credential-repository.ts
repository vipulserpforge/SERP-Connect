import type { AuthMethod, ConnectionProvider, ConnectionStatus } from "@serp/contracts";

/** Same shape as EncryptedSecret in @serp/secrets (kept structural so this package stays dependency-light). */
export interface StoredSecret {
  ciphertext: string;
  nonce: string;
  authTag: string;
  wrappedDek: string;
  keyVersion: string;
}

export type OAuthProduct = "gsc" | "ga4" | "bing";

export interface UpsertConnectionInput {
  userId: string;
  provider: ConnectionProvider;
  /** Stable provider subject (Google `sub`). */
  providerAccountId: string;
  /** Masked label for display only. */
  accountLabel: string | null;
  grantedScopes: string[];
  /** Bing only. Stored with the connection so the API client uses the right mechanism. */
  authMethod?: AuthMethod | null;
}

/**
 * Server-only persistence for provider credentials and OAuth attempts.
 * Not exposed to browsers. Every method takes the owning userId and scopes by it.
 */
export interface CredentialRepository {
  /** Creates or updates the connection for (user, provider, account). New/reconnected rows start `pending`. */
  upsertConnection(input: UpsertConnectionInput): Promise<{ id: string; credentialVersion: number }>;
  /**
   * Changes a connection's display label and/or its provider account key (Clarity: the token fingerprint).
   * Returns "conflict" when the user already has another connection with that account key, false when it is not the caller's.
   */
  updateConnectionIdentity(
    userId: string,
    connectionId: string,
    change: { accountLabel?: string | null; providerAccountId?: string; authMethod?: AuthMethod | null },
  ): Promise<true | false | "conflict">;
  getSecret(userId: string, connectionId: string): Promise<{ secret: StoredSecret; credentialVersion: number } | null>;
  /**
   * Stores ciphertext and bumps credential_version atomically. With `expectedVersion`, it is a
   * compare-and-swap: returns null (and writes nothing) if another writer got there first.
   * Pass null for an unconditional write (initial grant).
   */
  putSecret(userId: string, connectionId: string, secret: StoredSecret, expectedVersion: number | null): Promise<number | null>;
  setConnectionStatus(
    userId: string,
    connectionId: string,
    status: ConnectionStatus,
    options?: { errorCode?: string | null; markValidated?: boolean; grantedScopes?: string[] },
  ): Promise<boolean>;
  deleteSecret(userId: string, connectionId: string): Promise<boolean>;
  /** Secrets still wrapped by a key version other than `currentKeyVersion`, for key-rotation jobs. */
  listSecretsForRewrap(
    currentKeyVersion: string,
    limit: number,
  ): Promise<Array<{ userId: string; connectionId: string; secret: StoredSecret; credentialVersion: number }>>;

  createOAuthState(record: {
    stateHash: string;
    userId: string;
    product: OAuthProduct;
    /** Null when the provider's flow has no PKCE (Bing: Microsoft documents none). */
    codeVerifierEnc: StoredSecret | null;
    /** Reconnect attempts name the connection they are meant for; null starts a new connection. */
    connectionId?: string | null;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * Single-use: atomically marks the state consumed and returns it. Returns null if unknown, expired,
   * already used, or created for a different user (a foreign attempt must not burn someone else's state).
   */
  consumeOAuthState(
    userId: string,
    stateHash: string,
    now: Date,
  ): Promise<{ product: OAuthProduct; codeVerifierEnc: StoredSecret | null; connectionId: string | null } | null>;
  purgeExpiredOAuthStates(now: Date): Promise<number>;
}
