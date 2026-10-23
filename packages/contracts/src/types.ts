/** Provider keys used across properties, reports and cache keys. */
export type ProviderKey = "gsc" | "ga4" | "bing" | "clarity";

/** Credential-level provider (one Google grant can serve gsc and/or ga4). */
export type ConnectionProvider = "google" | "bing" | "clarity";

/** How a connection authenticates. Only Bing offers both; null for Google and Clarity. */
export type AuthMethod = "oauth" | "api_key";

export type ConnectionStatus = "connected" | "needs_attention" | "revoked" | "disconnected" | "pending";

export interface ProviderConnection {
  id: string;
  userId: string;
  provider: ConnectionProvider;
  /** Stable external subject (e.g. Google `sub`). Never the sole identity key as email. */
  providerAccountId: string | null;
  /** Masked label for display only. */
  accountLabel: string | null;
  status: ConnectionStatus;
  grantedScopes: string[];
  lastValidatedAt: string | null;
  lastErrorCode: string | null;
  /** Bing: "oauth" or "api_key", chosen explicitly and never silently switched. Null for other providers. */
  authMethod: AuthMethod | null;
}

export interface PropertyRecord {
  id: string;
  userId: string;
  connectionId: string;
  provider: ProviderKey;
  /** Provider-native key, e.g. `sc-domain:example.com`, GA4 numeric id, Clarity project id. */
  externalPropertyId: string;
  displayName: string;
  propertyType: string | null;
  timezone: string | null;
  enabledForMcp: boolean;
}

/** A property found at the provider during discovery, before it is stored. */
export interface DiscoveredProperty {
  externalPropertyId: string;
  displayName: string;
  propertyType: string | null;
  timezone: string | null;
}

export type ReportRow = Record<string, string | number | null>;

export interface ReportWarning {
  code: string;
  message: string;
}

export interface NormalizedReportResult {
  provider: ProviderKey;
  property: { id: string; name: string };
  report: {
    startDate: string | null;
    endDate: string | null;
    dateSemantics: string;
    dimensions: string[];
    metrics: string[];
    sort: Array<{ field: string; direction: "asc" | "desc" }>;
    limit: number;
    /** How the date range was obtained and which calendar it follows. Set by the reporting layer. */
    period?: {
      resolvedFrom: "explicit" | "lastDays";
      lastDays?: number;
      timeZone: string;
    };
  };
  rows: ReportRow[];
  rowCountReturned: number;
  rowCountReportedByProvider: number | null;
  fetchedAt: string;
  cache: { hit: boolean; ageSeconds: number; /** True when an expired entry was served because the provider failed. */ stale?: boolean };
  completeness: "complete" | "unknown_or_provider_limited" | "partial";
  /** True when data is synthetic fixture data, not from a provider. */
  mock: boolean;
  warnings: ReportWarning[];
  /** Whole-range totals for the same filters, when the provider can report them (Search Console). Row sums can differ. */
  totals?: Record<string, number | null>;
  /** Totals of the comparison range and the change against it, when `compareTo` was used. */
  comparison?: { label: string; startDate: string; endDate: string; totals: Record<string, number | null>; change: Record<string, number | null> };
  /** Short plain-language reading of the result for a non-technical reader. */
  summary?: string;
  /** One suggested follow-up, in plain words. */
  nextStep?: string;
  /** Safe, provider-supplied facts about the data (time zone, currency, metric types, quota). Never credentials. */
  providerMetadata?: Record<string, unknown>;
  requestId: string;
}

/**
 * Built only by the backend after token validation, connection lookup and
 * property ownership checks. Never constructed from tool input.
 */
export interface AuthorizedQueryContext {
  userId: string;
  requestId: string;
  property: PropertyRecord;
  connection: ProviderConnection;
  signal?: AbortSignal;
}

export interface ReportAdapter<Q> {
  readonly provider: ProviderKey;
  /** True for fixture-backed adapters. */
  readonly mock: boolean;
  query(query: Q, context: AuthorizedQueryContext): Promise<NormalizedReportResult>;
}
