import { ConnectorException } from "@serp/contracts";
import type { Repository } from "@serp/db";
import type { Logger } from "@serp/observability";
import { GOOGLE_SCOPES } from "@serp/provider-google";
import { Ga4ApiError, discoverGa4Properties, toGa4ConnectorError, type Ga4ApiClient, type SkippedGa4Property } from "@serp/provider-ga4";
import { GscApiError, discoverGscProperties, toGscConnectorError, type GscApiClient, type SkippedSite } from "@serp/provider-gsc";
import { writeAudit } from "./audit.js";
import type { CredentialService } from "./service.js";

export interface GscSyncResult {
  added: number;
  updated: number;
  removed: number;
  /** Properties now stored for this connection. */
  total: number;
  /** Sites Google lists but the account cannot query (e.g. unverified). Not stored. */
  skipped: SkippedSite[];
  /** Human-readable outcome, including the "no sites" case. */
  message: string;
}

export interface Ga4SyncResult {
  added: number;
  updated: number;
  removed: number;
  total: number;
  /** Properties Google lists that are not queryable here (e.g. roll-up properties). Not stored. */
  skipped: SkippedGa4Property[];
  timeZoneUnknown: number;
  dataApiVerified: boolean;
  message: string;
}

export interface PropertyDiscoveryDeps {
  repo: Repository;
  credentials: CredentialService;
  gsc: GscApiClient;
  ga4: Ga4ApiClient;
  logger: Logger;
}

/** Lists what a connected Google account can see in Search Console and stores it for its owner. */
export class PropertyDiscoveryService {
  constructor(private readonly deps: PropertyDiscoveryDeps) {}

  async syncGsc(userId: string, connectionId: string, requestId?: string): Promise<GscSyncResult> {
    const { repo, credentials, gsc, logger } = this.deps;
    const conn = await repo.getConnection(userId, connectionId);
    if (!conn || conn.provider !== "google") {
      throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.");
    }
    if (!conn.grantedScopes.includes(GOOGLE_SCOPES.gsc)) {
      throw new ConnectorException("FORBIDDEN", "This Google connection was not granted Search Console access.", {
        provider: "gsc",
        suggestedAction: "Connect Search Console from the dashboard and approve the permission.",
      });
    }

    const { accessToken } = await credentials.getAccessToken(userId, connectionId, requestId);
    let discovery;
    try {
      discovery = await discoverGscProperties(gsc, accessToken);
    } catch (err) {
      if (err instanceof GscApiError && err.kind === "unauthenticated") {
        await credentials.markNeedsAttention(userId, connectionId, "AUTH_EXPIRED", requestId);
      }
      await writeAudit(repo, logger, { userId, connectionId, requestId, provider: "gsc", eventType: "properties.sync_failed", metadata: { errorKind: err instanceof GscApiError ? err.kind : "unknown" } });
      throw toGscConnectorError(err);
    }

    const counts = await repo.syncDiscoveredProperties(userId, connectionId, "gsc", discovery.properties);
    if (!counts) throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.");

    await writeAudit(repo, logger, {
      userId,
      connectionId,
      requestId,
      provider: "gsc",
      eventType: "properties.synced",
      metadata: { count: discovery.properties.length },
    });
    const message =
      discovery.properties.length === 0
        ? "This Google account has no Search Console properties it can read. Connect an account that has access."
        : `Found ${discovery.properties.length} Search Console ${discovery.properties.length === 1 ? "property" : "properties"}.`;
    return { ...counts, total: discovery.properties.length, skipped: discovery.skipped, message };
  }

  async syncGa4(userId: string, connectionId: string, requestId?: string): Promise<Ga4SyncResult> {
    const { repo, credentials, ga4, logger } = this.deps;
    const conn = await repo.getConnection(userId, connectionId);
    if (!conn || conn.provider !== "google") {
      throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.");
    }
    if (!conn.grantedScopes.includes(GOOGLE_SCOPES.ga4)) {
      throw new ConnectorException("FORBIDDEN", "This Google connection was not granted Google Analytics access.", {
        provider: "ga4",
        suggestedAction: "Connect GA4 from the dashboard and approve the permission.",
      });
    }

    const { accessToken } = await credentials.getAccessToken(userId, connectionId, requestId);
    let discovery;
    try {
      discovery = await discoverGa4Properties(ga4, accessToken);
    } catch (err) {
      if (err instanceof Ga4ApiError && err.kind === "unauthenticated") {
        await credentials.markNeedsAttention(userId, connectionId, "AUTH_EXPIRED", requestId);
      }
      await writeAudit(repo, logger, { userId, connectionId, requestId, provider: "ga4", eventType: "properties.sync_failed", metadata: { errorKind: err instanceof Ga4ApiError ? err.kind : "unknown" } });
      throw toGa4ConnectorError(err);
    }

    const counts = await repo.syncDiscoveredProperties(userId, connectionId, "ga4", discovery.properties);
    if (!counts) throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That connection is not available for this account.");

    await writeAudit(repo, logger, { userId, connectionId, requestId, provider: "ga4", eventType: "properties.synced", metadata: { count: discovery.properties.length } });
    const n = discovery.properties.length;
    const message =
      n === 0
        ? "This Google account has no Google Analytics 4 properties it can read. Connect an account that has access."
        : `Found ${n} GA4 ${n === 1 ? "property" : "properties"}.`;
    return { ...counts, total: n, skipped: discovery.skipped, timeZoneUnknown: discovery.timeZoneUnknown, dataApiVerified: discovery.dataApiVerified, message };
  }
}
