import { ConnectorException } from "@serp/contracts";

/** Source of truth: https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api (verified 2026-10-19). */
export const CLARITY_ENDPOINT = "https://www.clarity.ms/export-data/api/v1/project-live-insights";
export const CLARITY_DOCS_URL = "https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api";

/** The provider's own limit: 10 requests per project per day. */
export const CLARITY_DAILY_REQUEST_LIMIT = 10;
export const CLARITY_MAX_DIMENSIONS = 3;
/** The response is capped at 1,000 rows and cannot be paginated. */
export const CLARITY_MAX_ROWS = 1000;
export const CLARITY_NUM_OF_DAYS = [1, 2, 3] as const;

/** Documented dimensions. The documentation notes that further metrics and dimensions may appear in real responses. */
export const CLARITY_DIMENSIONS = ["Browser", "Device", "Country/Region", "OS", "Source", "Medium", "Campaign", "Channel", "URL"] as const;
export type ClarityDimension = (typeof CLARITY_DIMENSIONS)[number];

/** Documented metric names. Responses are not guaranteed to contain all of them, nor only these. */
export const CLARITY_DOCUMENTED_METRICS = [
  "Scroll Depth",
  "Engagement Time",
  "Traffic",
  "Popular Pages",
  "Browser",
  "Device",
  "OS",
  "Country/Region",
  "Page Title",
  "Referrer URL",
  "Dead Click Count",
  "Excessive Scroll",
  "Rage Click Count",
  "Quickback Click",
  "Script Error Count",
  "Error Click Count",
] as const;

export const CLARITY_TIME_SEMANTICS =
  "Rolling window ending when the request is made: the last 24, 48 or 72 hours (numOfDays 1, 2 or 3). The provider reports in UTC. Not calendar days and no custom date ranges.";

export function validateClarityDimensions(dimensions: readonly string[]): void {
  if (dimensions.length > CLARITY_MAX_DIMENSIONS) {
    throw new ConnectorException("INVALID_QUERY", `Clarity allows at most ${CLARITY_MAX_DIMENSIONS} dimensions per request.`, { provider: "clarity" });
  }
  const allowed = new Set<string>(CLARITY_DIMENSIONS);
  const bad = dimensions.filter((d) => !allowed.has(d));
  if (bad.length > 0) {
    throw new ConnectorException("INVALID_QUERY", `Unsupported Clarity dimension(s): ${bad.join(", ")}.`, {
      provider: "clarity",
      suggestedAction: `Use up to three of: ${CLARITY_DIMENSIONS.join(", ")}.`,
    });
  }
  if (new Set(dimensions).size !== dimensions.length) {
    throw new ConnectorException("INVALID_QUERY", "Each Clarity dimension can be used only once per request.", { provider: "clarity" });
  }
}

/** A Clarity token is a JWT. Only shape and length are checked: the token's contents are never parsed or trusted. */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

export function validateClarityToken(token: string): void {
  if (!TOKEN_SHAPE.test(token)) {
    throw new ConnectorException("INVALID_QUERY", "That does not look like a Clarity API token. Copy the whole token from Clarity (Settings → Data Export) without spaces.", {
      provider: "clarity",
    });
  }
}

/** Friendly connection names: letters, digits, spaces and basic punctuation, 2-60 characters. */
export function validateConnectionName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!/^[\p{L}\p{N} ._&()'-]{2,60}$/u.test(trimmed)) {
    throw new ConnectorException("INVALID_QUERY", "Give the connection a name of 2-60 characters (letters, numbers, spaces and . _ & ( ) ' -).", { provider: "clarity" });
  }
  return trimmed;
}
