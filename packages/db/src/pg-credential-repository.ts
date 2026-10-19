import type { AuthMethod, ConnectionStatus } from "@serp/contracts";
import type { CredentialRepository, OAuthProduct, StoredSecret, UpsertConnectionInput } from "./credential-repository.js";
import type { SqlExecutor } from "./pg-repository.js";

interface SecretRow {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  wrapped_dek: string;
  key_version: string;
  credential_version: number;
}

const toStored = (r: SecretRow): StoredSecret => ({
  ciphertext: r.ciphertext,
  nonce: r.nonce,
  authTag: r.auth_tag,
  wrappedDek: r.wrapped_dek,
  keyVersion: r.key_version,
});

/** Postgres implementation. A direct connection bypasses RLS, so every statement scopes by user_id. */
export class PgCredentialRepository implements CredentialRepository {
  constructor(private readonly db: SqlExecutor) {}

  async upsertConnection(input: UpsertConnectionInput) {
    const rows = await this.db.query<{ id: string; credential_version: number }>(
      `insert into public.provider_connections (user_id, provider, provider_account_id, account_label, status, granted_scopes, auth_method)
       values ($1, $2, $3, $4, 'pending', $5, $6)
       on conflict (user_id, provider, provider_account_id) where provider_account_id is not null
       do update set account_label = excluded.account_label,
                     status = 'pending',
                     granted_scopes = excluded.granted_scopes,
                     auth_method = excluded.auth_method,
                     last_error_code = null
       returning id, credential_version`,
      [input.userId, input.provider, input.providerAccountId, input.accountLabel, input.grantedScopes, input.authMethod ?? null],
    );
    return { id: rows[0]!.id, credentialVersion: rows[0]!.credential_version };
  }

  async updateConnectionIdentity(userId: string, connectionId: string, change: { accountLabel?: string | null; providerAccountId?: string; authMethod?: AuthMethod | null }) {
    try {
      const rows = await this.db.query(
        `update public.provider_connections
            set account_label = case when $3::boolean then $4 else account_label end,
                provider_account_id = coalesce($5, provider_account_id),
                auth_method = case when $6::boolean then $7 else auth_method end
          where id = $1 and user_id = $2
          returning id`,
        [connectionId, userId, change.accountLabel !== undefined, change.accountLabel ?? null, change.providerAccountId ?? null, change.authMethod !== undefined, change.authMethod ?? null],
      );
      return rows.length > 0;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return "conflict" as const; // unique (user, provider, account)
      throw err;
    }
  }

  async getSecret(userId: string, connectionId: string) {
    const rows = await this.db.query<SecretRow>(
      `select s.ciphertext, s.nonce, s.auth_tag, s.wrapped_dek, s.key_version, c.credential_version
         from public.provider_secrets s
         join public.provider_connections c on c.id = s.connection_id
        where c.id = $1 and c.user_id = $2`,
      [connectionId, userId],
    );
    return rows[0] ? { secret: toStored(rows[0]), credentialVersion: rows[0].credential_version } : null;
  }

  async putSecret(userId: string, connectionId: string, secret: StoredSecret, expectedVersion: number | null) {
    // One statement: the version bump and the secret write succeed or fail together.
    const rows = await this.db.query<{ v: number }>(
      `with bumped as (
         update public.provider_connections
            set credential_version = credential_version + 1
          where id = $1 and user_id = $2 and ($3::int is null or credential_version = $3)
          returning credential_version
       )
       insert into public.provider_secrets (connection_id, ciphertext, nonce, auth_tag, wrapped_dek, key_version, rotated_at)
       select $1, $4, $5, $6, $7, $8, now() from bumped
       on conflict (connection_id) do update
         set ciphertext = excluded.ciphertext, nonce = excluded.nonce, auth_tag = excluded.auth_tag,
             wrapped_dek = excluded.wrapped_dek, key_version = excluded.key_version, rotated_at = now()
       returning (select credential_version from bumped) as v`,
      [connectionId, userId, expectedVersion, secret.ciphertext, secret.nonce, secret.authTag, secret.wrappedDek, secret.keyVersion],
    );
    return rows[0]?.v ?? null;
  }

  async setConnectionStatus(
    userId: string,
    connectionId: string,
    status: ConnectionStatus,
    options: { errorCode?: string | null; markValidated?: boolean; grantedScopes?: string[] } = {},
  ) {
    const rows = await this.db.query(
      `update public.provider_connections
          set status = $3,
              last_error_code = $4,
              last_validated_at = case when $5::boolean then now() else last_validated_at end,
              granted_scopes = coalesce($6::text[], granted_scopes)
        where id = $1 and user_id = $2
        returning id`,
      [connectionId, userId, status, options.errorCode ?? null, options.markValidated ?? false, options.grantedScopes ?? null],
    );
    return rows.length > 0;
  }

  async deleteSecret(userId: string, connectionId: string) {
    const rows = await this.db.query(
      `delete from public.provider_secrets s
        using public.provider_connections c
        where s.connection_id = c.id and c.id = $1 and c.user_id = $2
        returning s.id`,
      [connectionId, userId],
    );
    return rows.length > 0;
  }

  async listSecretsForRewrap(currentKeyVersion: string, limit: number) {
    const rows = await this.db.query<SecretRow & { user_id: string; connection_id: string }>(
      `select c.user_id, s.connection_id, s.ciphertext, s.nonce, s.auth_tag, s.wrapped_dek, s.key_version, c.credential_version
         from public.provider_secrets s
         join public.provider_connections c on c.id = s.connection_id
        where s.key_version <> $1
        order by s.rotated_at nulls first
        limit $2`,
      [currentKeyVersion, limit],
    );
    return rows.map((r) => ({ userId: r.user_id, connectionId: r.connection_id, secret: toStored(r), credentialVersion: r.credential_version }));
  }

  async createOAuthState(record: { stateHash: string; userId: string; product: OAuthProduct; codeVerifierEnc: StoredSecret | null; connectionId?: string | null; expiresAt: Date }) {
    await this.db.query(
      `insert into public.oauth_states (state_hash, user_id, product, code_verifier_enc, connection_id, expires_at)
       values ($1, $2, $3, $4::jsonb, $5, $6)`,
      [record.stateHash, record.userId, record.product, record.codeVerifierEnc ? JSON.stringify(record.codeVerifierEnc) : null, record.connectionId ?? null, record.expiresAt.toISOString()],
    );
  }

  async consumeOAuthState(userId: string, stateHash: string, now: Date) {
    const rows = await this.db.query<{ product: OAuthProduct; code_verifier_enc: StoredSecret | null; connection_id: string | null }>(
      `update public.oauth_states
          set consumed_at = $3
        where state_hash = $1 and user_id = $2 and consumed_at is null and expires_at > $3
        returning product, code_verifier_enc, connection_id`,
      [stateHash, userId, now.toISOString()],
    );
    return rows[0] ? { product: rows[0].product, codeVerifierEnc: rows[0].code_verifier_enc, connectionId: rows[0].connection_id } : null;
  }

  async purgeExpiredOAuthStates(now: Date) {
    const rows = await this.db.query(
      "delete from public.oauth_states where expires_at <= $1 or consumed_at is not null returning state_hash",
      [now.toISOString()],
    );
    return rows.length;
  }
}
