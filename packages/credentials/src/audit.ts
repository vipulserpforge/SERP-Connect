import type { ConnectionProvider, ProviderKey } from "@serp/contracts";
import type { Repository } from "@serp/db";
import type { Logger } from "@serp/observability";

/** Only these metadata keys are ever persisted to the audit trail. */
const ALLOWED_KEYS = new Set(["product", "authMethod", "reason", "revokedAtProvider", "keyVersion", "errorKind", "count", "scopes"]);
const SAFE_VALUE = /^[A-Za-z0-9 _.:/-]{0,100}$/;

/**
 * Allowlist, not denylist: unknown keys are dropped, and values must be short plain strings, numbers
 * or booleans, so a token or code that slips into a call site cannot reach the audit table.
 */
export function safeAuditMetadata(input: Record<string, unknown> = {}): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && SAFE_VALUE.test(value) && !/^(ya29\.|1\/\/|eyJ)/.test(value)) out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      // e.g. granted scope URLs: allow only URL-ish scope names, join to one bounded string
      const joined = value.join(" ").slice(0, 300);
      if (/^[A-Za-z0-9 _.:/-]*$/.test(joined)) out[key] = joined;
    }
  }
  return out;
}

export interface AuditInput {
  userId: string;
  eventType: string;
  provider?: ProviderKey | ConnectionProvider;
  connectionId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

/** Writes an audit event. A failing audit write is logged, never allowed to break (or leak into) the main flow. */
export async function writeAudit(repo: Repository, logger: Logger, event: AuditInput): Promise<void> {
  try {
    await repo.recordAudit({
      userId: event.userId,
      eventType: event.eventType,
      ...(event.provider && { provider: event.provider }),
      ...(event.connectionId && { connectionId: event.connectionId }),
      ...(event.requestId && { requestId: event.requestId }),
      metadata: safeAuditMetadata(event.metadata),
    });
  } catch (err) {
    logger.error("audit.write_failed", { eventType: event.eventType, err });
  }
}
