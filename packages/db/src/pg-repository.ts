import type { AuthMethod, ConnectionProvider, ConnectionStatus, DiscoveredProperty, PropertyRecord, ProviderConnection, ProviderKey } from "@serp/contracts";
import type { AuditEvent, Repository } from "./repository.js";

/** Minimal SQL surface so the repository runs on `pg` in production and PGlite in tests. */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

interface ConnectionRow {
  id: string;
  user_id: string;
  provider: ConnectionProvider;
  provider_account_id: string | null;
  account_label: string | null;
  status: ConnectionStatus;
  granted_scopes: string[];
  last_validated_at: Date | string | null;
  last_error_code: string | null;
  auth_method: AuthMethod | null;
}

interface PropertyRow {
  id: string;
  user_id: string;
  connection_id: string;
  provider: ProviderKey;
  external_property_id: string;
  display_name: string;
  property_type: string | null;
  timezone: string | null;
  enabled_for_mcp: boolean;
}

const CONNECTION_COLUMNS =
  "c.id, c.user_id, c.provider, c.provider_account_id, c.account_label, c.status, c.granted_scopes, c.last_validated_at, c.last_error_code, c.auth_method";
const PROPERTY_COLUMNS =
  "p.id, p.user_id, p.connection_id, p.provider, p.external_property_id, p.display_name, p.property_type, p.timezone, p.enabled_for_mcp";

const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

const toConnection = (r: ConnectionRow): ProviderConnection => ({
  id: r.id,
  userId: r.user_id,
  provider: r.provider,
  providerAccountId: r.provider_account_id,
  accountLabel: r.account_label,
  status: r.status,
  grantedScopes: r.granted_scopes,
  lastValidatedAt: iso(r.last_validated_at),
  lastErrorCode: r.last_error_code,
  authMethod: r.auth_method,
});

const toProperty = (r: PropertyRow): PropertyRecord => ({
  id: r.id,
  userId: r.user_id,
  connectionId: r.connection_id,
  provider: r.provider,
  externalPropertyId: r.external_property_id,
  displayName: r.display_name,
  propertyType: r.property_type,
  timezone: r.timezone,
  enabledForMcp: r.enabled_for_mcp,
});

/**
 * Postgres-backed repository for trusted server code. A direct database connection bypasses
 * RLS, so EVERY statement here scopes by user_id (and joins through the owning connection).
 * RLS remains the second layer for anything that reaches the Data API with a user JWT.
 */
export class PgRepository implements Repository {
  constructor(private readonly db: SqlExecutor) {}

  async listConnections(userId: string) {
    const rows = await this.db.query<ConnectionRow>(
      `select ${CONNECTION_COLUMNS} from public.provider_connections c where c.user_id = $1 order by c.created_at`,
      [userId],
    );
    return rows.map(toConnection);
  }

  async getConnection(userId: string, connectionId: string) {
    const rows = await this.db.query<ConnectionRow>(
      `select ${CONNECTION_COLUMNS} from public.provider_connections c where c.user_id = $1 and c.id = $2`,
      [userId, connectionId],
    );
    return rows[0] ? toConnection(rows[0]) : null;
  }

  async listProperties(
    userId: string,
    filter: { provider?: ProviderKey; connectionId?: string; enabledOnly?: boolean } = {},
  ) {
    const rows = await this.db.query<PropertyRow>(
      `select ${PROPERTY_COLUMNS}
         from public.properties p
         join public.provider_connections c on c.id = p.connection_id and c.user_id = p.user_id
        where p.user_id = $1
          and ($2::text is null or p.provider = $2)
          and ($3::uuid is null or p.connection_id = $3)
          and (not $4::boolean or p.enabled_for_mcp)
        order by p.display_name`,
      [userId, filter.provider ?? null, filter.connectionId ?? null, filter.enabledOnly ?? false],
    );
    return rows.map(toProperty);
  }

  async findEnabledProperty(userId: string, provider: ProviderKey, externalPropertyId: string) {
    const rows = await this.db.query<PropertyRow>(
      `select ${PROPERTY_COLUMNS}
         from public.properties p
         join public.provider_connections c on c.id = p.connection_id and c.user_id = p.user_id
        where p.user_id = $1 and p.provider = $2 and p.external_property_id = $3 and p.enabled_for_mcp
        limit 1`,
      [userId, provider, externalPropertyId],
    );
    return rows[0] ? toProperty(rows[0]) : null;
  }

  async setPropertyEnabled(userId: string, propertyId: string, enabled: boolean) {
    const rows = await this.db.query(
      "update public.properties set enabled_for_mcp = $3 where user_id = $1 and id = $2 returning id",
      [userId, propertyId, enabled],
    );
    return rows.length > 0;
  }

  async syncDiscoveredProperties(userId: string, connectionId: string, provider: ProviderKey, discovered: DiscoveredProperty[]) {
    const owned = await this.db.query("select 1 from public.provider_connections where id = $1 and user_id = $2", [connectionId, userId]);
    if (owned.length === 0) return null;
    let added = 0;
    let updated = 0;
    if (discovered.length > 0) {
      // One statement; the composite FK (connection_id, user_id) additionally pins the rows to this tenant.
      const rows = await this.db.query<{ inserted: boolean }>(
        `insert into public.properties as p (user_id, connection_id, provider, external_property_id, display_name, property_type, timezone, last_discovered_at)
         select $1, $2, $3, d.id, d.name, d.type, d.tz, now()
           from unnest($4::text[], $5::text[], $6::text[], $7::text[]) as d(id, name, type, tz)
         on conflict (connection_id, provider, external_property_id)
         do update set display_name = excluded.display_name, property_type = excluded.property_type,
                       timezone = excluded.timezone, last_discovered_at = now()
         returning (xmax = 0) as inserted`,
        [
          userId,
          connectionId,
          provider,
          discovered.map((d) => d.externalPropertyId),
          discovered.map((d) => d.displayName),
          discovered.map((d) => d.propertyType),
          discovered.map((d) => d.timezone),
        ],
      );
      added = rows.filter((r) => r.inserted).length;
      updated = rows.length - added;
    }
    const gone = await this.db.query(
      `delete from public.properties
        where user_id = $1 and connection_id = $2 and provider = $3 and external_property_id <> all($4::text[])
        returning id`,
      [userId, connectionId, provider, discovered.map((d) => d.externalPropertyId)],
    );
    return { added, updated, removed: gone.length };
  }

  async disconnectConnection(userId: string, connectionId: string) {
    // Properties, secrets and cache rows go via ON DELETE CASCADE.
    const rows = await this.db.query(
      "delete from public.provider_connections where user_id = $1 and id = $2 returning id",
      [userId, connectionId],
    );
    return rows.length > 0;
  }

  async recordAudit(event: AuditEvent) {
    await this.db.query(
      `insert into public.audit_events (user_id, event_type, provider, connection_id, metadata, request_id)
       values ($1, $2, $3, $4, $5::jsonb, $6)`,
      [event.userId, event.eventType, event.provider ?? null, event.connectionId ?? null, JSON.stringify(event.metadata ?? {}), event.requestId ?? null],
    );
  }
}
