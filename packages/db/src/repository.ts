import type { ConnectionProvider, DiscoveredProperty, PropertyRecord, ProviderConnection, ProviderKey } from "@serp/contracts";

export interface AuditEvent {
  userId: string;
  eventType: string;
  provider?: ProviderKey | ConnectionProvider;
  connectionId?: string;
  requestId?: string;
  /** Safe metadata only: never tokens, codes or report bodies. */
  metadata?: Record<string, unknown>;
}

/**
 * Data access contract. Every method takes the owning `userId` explicitly and must
 * scope by it, so a privileged (RLS-bypassing) implementation cannot leak across tenants.
 */
export interface Repository {
  listConnections(userId: string): Promise<ProviderConnection[]>;
  getConnection(userId: string, connectionId: string): Promise<ProviderConnection | null>;
  listProperties(
    userId: string,
    filter?: { provider?: ProviderKey; connectionId?: string; enabledOnly?: boolean },
  ): Promise<PropertyRecord[]>;
  /** Resolves a provider-native id against the user's own enabled properties only. */
  findEnabledProperty(userId: string, provider: ProviderKey, externalPropertyId: string): Promise<PropertyRecord | null>;
  /** Flips the MCP allowlist switch. Returns false if the property is not the caller's. */
  setPropertyEnabled(userId: string, propertyId: string, enabled: boolean): Promise<boolean>;
  /**
   * Reconciles a connection's properties of one provider with what the provider just reported:
   * new ones are added (enabled), known ones are refreshed (their enabled switch is kept), and ones the
   * account can no longer see are removed. Returns null if the connection is not the caller's.
   */
  syncDiscoveredProperties(
    userId: string,
    connectionId: string,
    provider: ProviderKey,
    discovered: DiscoveredProperty[],
  ): Promise<{ added: number; updated: number; removed: number } | null>;
  /**
   * Removes a connection together with its properties, cached reports and encrypted secret.
   * Returns false if the connection is not the caller's.
   */
  disconnectConnection(userId: string, connectionId: string): Promise<boolean>;
  recordAudit(event: AuditEvent): Promise<void>;
}
