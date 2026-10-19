import { randomUUID } from "node:crypto";
import type { AuthMethod, ConnectionStatus, DiscoveredProperty, PropertyRecord, ProviderConnection, ProviderKey } from "@serp/contracts";
import type { CredentialRepository, OAuthProduct, StoredSecret, UpsertConnectionInput } from "./credential-repository.js";
import type { AuditEvent, Repository } from "./repository.js";

export const MOCK_USER_A_ID = "00000000-0000-4000-8000-00000000000a";
export const MOCK_USER_B_ID = "00000000-0000-4000-8000-00000000000b";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export interface MockSeed {
  connections: ProviderConnection[];
  properties: PropertyRecord[];
}

/** Demo data: user A uses distinct Google accounts for GSC (B) and GA4 (C). User B exists to exercise isolation. */
export function createMockSeed(): MockSeed {
  const base = { lastErrorCode: null, lastValidatedAt: "2026-10-19T05:00:00Z", authMethod: null } as const;
  const connections: ProviderConnection[] = [
    { ...base, id: "conn-a-gsc", userId: MOCK_USER_A_ID, provider: "google", providerAccountId: "g-sub-b", accountLabel: "Account B (gsc)", status: "connected", grantedScopes: [GSC_SCOPE] },
    { ...base, id: "conn-a-ga4", userId: MOCK_USER_A_ID, provider: "google", providerAccountId: "g-sub-c", accountLabel: "Account C (ga4)", status: "connected", grantedScopes: [GA4_SCOPE] },
    { ...base, id: "conn-a-clarity", userId: MOCK_USER_A_ID, provider: "clarity", providerAccountId: null, accountLabel: "Clarity demo project", status: "connected", grantedScopes: [] },
    { ...base, id: "conn-a-bing", userId: MOCK_USER_A_ID, provider: "bing", providerAccountId: "bing:key:mock-a", accountLabel: "Bing demo account", status: "connected", grantedScopes: [], authMethod: "api_key" },
    { ...base, id: "conn-b-bing", userId: MOCK_USER_B_ID, provider: "bing", providerAccountId: "bing:key:mock-b", accountLabel: "Other tenant (Bing)", status: "connected", grantedScopes: [], authMethod: "api_key" },
    { ...base, id: "conn-b-gsc", userId: MOCK_USER_B_ID, provider: "google", providerAccountId: "g-sub-x", accountLabel: "Other tenant", status: "connected", grantedScopes: [GSC_SCOPE] },
  ];
  const prop = (p: Partial<PropertyRecord> & Pick<PropertyRecord, "id" | "userId" | "connectionId" | "provider" | "externalPropertyId" | "displayName">): PropertyRecord => ({
    propertyType: null,
    timezone: null,
    enabledForMcp: true,
    ...p,
  });
  const properties: PropertyRecord[] = [
    prop({ id: "prop-a-gsc", userId: MOCK_USER_A_ID, connectionId: "conn-a-gsc", provider: "gsc", externalPropertyId: "sc-domain:example.com", displayName: "example.com", propertyType: "domain" }),
    prop({ id: "prop-a-ga4", userId: MOCK_USER_A_ID, connectionId: "conn-a-ga4", provider: "ga4", externalPropertyId: "123456789", displayName: "Example GA4", propertyType: "ga4_property", timezone: "America/New_York" }),
    prop({ id: "prop-a-clarity", userId: MOCK_USER_A_ID, connectionId: "conn-a-clarity", provider: "clarity", externalPropertyId: "clarity-demo-project", displayName: "Example Clarity project", propertyType: "clarity_project" }),
    prop({ id: "prop-a-bing", userId: MOCK_USER_A_ID, connectionId: "conn-a-bing", provider: "bing", externalPropertyId: "https://www.example.com/", displayName: "https://www.example.com/", propertyType: "bing_site_verified" }),
    prop({ id: "prop-b-bing", userId: MOCK_USER_B_ID, connectionId: "conn-b-bing", provider: "bing", externalPropertyId: "https://www.other-tenant.com/", displayName: "https://www.other-tenant.com/", propertyType: "bing_site_verified" }),
    prop({ id: "prop-b-gsc", userId: MOCK_USER_B_ID, connectionId: "conn-b-gsc", provider: "gsc", externalPropertyId: "sc-domain:other-tenant.com", displayName: "other-tenant.com", propertyType: "domain" }),
  ];
  return { connections, properties };
}

interface MockOAuthState {
  userId: string;
  product: OAuthProduct;
  codeVerifierEnc: StoredSecret | null;
  connectionId: string | null;
  expiresAt: Date;
  consumed: boolean;
}

/** In-memory Repository + CredentialRepository for development and tests. */
export class MockRepository implements Repository, CredentialRepository {
  readonly auditLog: AuditEvent[] = [];
  /** Exposed for tests that assert nothing sensitive is stored in the clear. */
  readonly secrets = new Map<string, StoredSecret>();
  readonly oauthStates = new Map<string, MockOAuthState>();
  private readonly versions = new Map<string, number>();
  private readonly connections: ProviderConnection[];
  private readonly properties: PropertyRecord[];

  constructor(seed: MockSeed = createMockSeed()) {
    this.connections = seed.connections;
    this.properties = seed.properties;
  }

  async listConnections(userId: string) {
    return this.connections.filter((c) => c.userId === userId);
  }

  async getConnection(userId: string, connectionId: string) {
    return this.connections.find((c) => c.userId === userId && c.id === connectionId) ?? null;
  }

  async listProperties(
    userId: string,
    filter: { provider?: ProviderKey; connectionId?: string; enabledOnly?: boolean } = {},
  ) {
    return this.properties.filter(
      (p) =>
        p.userId === userId &&
        (!filter.provider || p.provider === filter.provider) &&
        (!filter.connectionId || p.connectionId === filter.connectionId) &&
        (!filter.enabledOnly || p.enabledForMcp),
    );
  }

  async findEnabledProperty(userId: string, provider: ProviderKey, externalPropertyId: string) {
    return (
      this.properties.find(
        (p) => p.userId === userId && p.provider === provider && p.externalPropertyId === externalPropertyId && p.enabledForMcp,
      ) ?? null
    );
  }

  async setPropertyEnabled(userId: string, propertyId: string, enabled: boolean) {
    const prop = this.properties.find((p) => p.userId === userId && p.id === propertyId);
    if (!prop) return false;
    prop.enabledForMcp = enabled;
    return true;
  }

  async syncDiscoveredProperties(userId: string, connectionId: string, provider: ProviderKey, discovered: DiscoveredProperty[]) {
    if (!this.connections.some((c) => c.userId === userId && c.id === connectionId)) return null;
    let added = 0;
    let updated = 0;
    const keep = new Set(discovered.map((d) => d.externalPropertyId));
    for (const d of discovered) {
      const existing = this.properties.find((p) => p.connectionId === connectionId && p.provider === provider && p.externalPropertyId === d.externalPropertyId);
      if (existing) {
        Object.assign(existing, { displayName: d.displayName, propertyType: d.propertyType, timezone: d.timezone });
        updated++;
      } else {
        this.properties.push({ id: randomUUID(), userId, connectionId, provider, enabledForMcp: true, ...d });
        added++;
      }
    }
    let removed = 0;
    for (let i = this.properties.length - 1; i >= 0; i--) {
      const p = this.properties[i]!;
      if (p.userId === userId && p.connectionId === connectionId && p.provider === provider && !keep.has(p.externalPropertyId)) {
        this.properties.splice(i, 1);
        removed++;
      }
    }
    return { added, updated, removed };
  }

  async disconnectConnection(userId: string, connectionId: string) {
    const index = this.connections.findIndex((c) => c.userId === userId && c.id === connectionId);
    if (index < 0) return false;
    this.connections.splice(index, 1);
    this.secrets.delete(connectionId);
    for (let i = this.properties.length - 1; i >= 0; i--) {
      if (this.properties[i]!.connectionId === connectionId) this.properties.splice(i, 1);
    }
    return true;
  }

  async recordAudit(event: AuditEvent) {
    this.auditLog.push(event);
  }

  // ---- CredentialRepository ------------------------------------------------

  async upsertConnection(input: UpsertConnectionInput) {
    let conn = this.connections.find(
      (c) => c.userId === input.userId && c.provider === input.provider && c.providerAccountId === input.providerAccountId,
    );
    if (conn) {
      Object.assign(conn, { accountLabel: input.accountLabel, status: "pending", grantedScopes: input.grantedScopes, lastErrorCode: null, authMethod: input.authMethod ?? null });
    } else {
      conn = {
        id: randomUUID(),
        userId: input.userId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        accountLabel: input.accountLabel,
        status: "pending",
        grantedScopes: input.grantedScopes,
        lastValidatedAt: null,
        lastErrorCode: null,
        authMethod: input.authMethod ?? null,
      };
      this.connections.push(conn);
      this.versions.set(conn.id, 1);
    }
    return { id: conn.id, credentialVersion: this.versions.get(conn.id) ?? 1 };
  }

  async updateConnectionIdentity(userId: string, connectionId: string, change: { accountLabel?: string | null; providerAccountId?: string; authMethod?: AuthMethod | null }) {
    const conn = this.connections.find((c) => c.userId === userId && c.id === connectionId);
    if (!conn) return false;
    if (
      change.providerAccountId !== undefined &&
      this.connections.some((c) => c.id !== connectionId && c.userId === userId && c.provider === conn.provider && c.providerAccountId === change.providerAccountId)
    ) {
      return "conflict" as const;
    }
    if (change.accountLabel !== undefined) conn.accountLabel = change.accountLabel;
    if (change.providerAccountId !== undefined) conn.providerAccountId = change.providerAccountId;
    if (change.authMethod !== undefined) conn.authMethod = change.authMethod;
    return true;
  }

  async getSecret(userId: string, connectionId: string) {
    const conn = this.connections.find((c) => c.userId === userId && c.id === connectionId);
    const secret = conn && this.secrets.get(connectionId);
    return secret ? { secret: { ...secret }, credentialVersion: this.versions.get(connectionId) ?? 1 } : null;
  }

  async putSecret(userId: string, connectionId: string, secret: StoredSecret, expectedVersion: number | null) {
    const conn = this.connections.find((c) => c.userId === userId && c.id === connectionId);
    if (!conn) return null;
    const current = this.versions.get(connectionId) ?? 1;
    if (expectedVersion !== null && expectedVersion !== current) return null;
    this.secrets.set(connectionId, { ...secret });
    this.versions.set(connectionId, current + 1);
    return current + 1;
  }

  async setConnectionStatus(
    userId: string,
    connectionId: string,
    status: ConnectionStatus,
    options: { errorCode?: string | null; markValidated?: boolean; grantedScopes?: string[] } = {},
  ) {
    const conn = this.connections.find((c) => c.userId === userId && c.id === connectionId);
    if (!conn) return false;
    conn.status = status;
    conn.lastErrorCode = options.errorCode ?? null;
    if (options.markValidated) conn.lastValidatedAt = new Date().toISOString();
    if (options.grantedScopes) conn.grantedScopes = options.grantedScopes;
    return true;
  }

  async deleteSecret(userId: string, connectionId: string) {
    const conn = this.connections.find((c) => c.userId === userId && c.id === connectionId);
    return conn ? this.secrets.delete(connectionId) : false;
  }

  async listSecretsForRewrap(currentKeyVersion: string, limit: number) {
    const out: Array<{ userId: string; connectionId: string; secret: StoredSecret; credentialVersion: number }> = [];
    for (const [connectionId, secret] of this.secrets) {
      const conn = this.connections.find((c) => c.id === connectionId);
      if (conn && secret.keyVersion !== currentKeyVersion && out.length < limit) {
        out.push({ userId: conn.userId, connectionId, secret: { ...secret }, credentialVersion: this.versions.get(connectionId) ?? 1 });
      }
    }
    return out;
  }

  async createOAuthState(record: { stateHash: string; userId: string; product: OAuthProduct; codeVerifierEnc: StoredSecret | null; connectionId?: string | null; expiresAt: Date }) {
    this.oauthStates.set(record.stateHash, { ...record, connectionId: record.connectionId ?? null, consumed: false });
  }

  async consumeOAuthState(userId: string, stateHash: string, now: Date) {
    const st = this.oauthStates.get(stateHash);
    if (!st || st.userId !== userId || st.consumed || st.expiresAt <= now) return null;
    st.consumed = true;
    return { product: st.product, codeVerifierEnc: st.codeVerifierEnc, connectionId: st.connectionId };
  }

  async purgeExpiredOAuthStates(now: Date) {
    let n = 0;
    for (const [k, v] of this.oauthStates) {
      if (v.expiresAt <= now || v.consumed) {
        this.oauthStates.delete(k);
        n++;
      }
    }
    return n;
  }
}
