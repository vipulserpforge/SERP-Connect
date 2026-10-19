import { ZodError } from "zod";

export const CONNECTOR_ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "AUTH_REVOKED",
  "FORBIDDEN",
  "PROPERTY_NOT_CONNECTED",
  "PROPERTY_NOT_ACCESSIBLE",
  "INVALID_QUERY",
  "DIMENSION_METRIC_INCOMPATIBLE",
  "DATE_RANGE_UNSUPPORTED",
  "PROVIDER_RATE_LIMITED",
  /** Our own throttling (per user or per connection), as opposed to the provider's quota. */
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_CAPABILITY_UNAVAILABLE",
  "CLARITY_DAILY_BUDGET_EXHAUSTED",
  "PARTIAL_DATA",
  "INTERNAL_ERROR",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/** Safe, serializable error envelope. Never carries stack traces or upstream bodies. */
export interface ConnectorError {
  code: ConnectorErrorCode;
  message: string;
  retryable: boolean;
  provider?: string;
  requestId: string;
  suggestedAction?: string;
  retryAfterSeconds?: number;
}

export interface ConnectorExceptionOptions {
  retryable?: boolean;
  provider?: string;
  suggestedAction?: string;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/** Throw this for any expected, user-presentable failure. */
export class ConnectorException extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  readonly provider: string | undefined;
  readonly suggestedAction: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ConnectorErrorCode, message: string, options: ConnectorExceptionOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConnectorException";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.provider = options.provider;
    this.suggestedAction = options.suggestedAction;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * True for a ConnectorException from any copy of this package. Bundlers may load the class twice (server chunks,
 * separately bundled packages), which defeats `instanceof`, so the check is structural.
 */
export function isConnectorException(err: unknown): err is ConnectorException {
  if (err instanceof ConnectorException) return true;
  return err instanceof Error && err.name === "ConnectorException" && typeof (err as { code?: unknown }).code === "string";
}

/** Convert anything thrown into the safe envelope. Unknown errors become a generic INTERNAL_ERROR. */
export function toConnectorError(err: unknown, requestId: string): ConnectorError {
  if (isConnectorException(err)) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      requestId,
      ...(err.provider && { provider: err.provider }),
      ...(err.suggestedAction && { suggestedAction: err.suggestedAction }),
      ...(err.retryAfterSeconds !== undefined && { retryAfterSeconds: err.retryAfterSeconds }),
    };
  }
  if (err instanceof ZodError) {
    const detail = err.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
      .join("; ");
    return {
      code: "INVALID_QUERY",
      message: `Invalid input. ${detail}`,
      retryable: false,
      requestId,
      suggestedAction: "Correct the listed fields and try again.",
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred.",
    retryable: false,
    requestId,
  };
}

export function httpStatusFor(code: ConnectorErrorCode): number {
  switch (code) {
    case "AUTH_REQUIRED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "PROPERTY_NOT_CONNECTED":
    case "PROPERTY_NOT_ACCESSIBLE":
      return 404;
    case "INVALID_QUERY":
    case "DIMENSION_METRIC_INCOMPATIBLE":
    case "DATE_RANGE_UNSUPPORTED":
      return 400;
    case "PROVIDER_RATE_LIMITED":
    case "RATE_LIMITED":
    case "CLARITY_DAILY_BUDGET_EXHAUSTED":
      return 429;
    case "AUTH_EXPIRED":
    case "AUTH_REVOKED":
      return 409;
    case "PROVIDER_UNAVAILABLE":
      return 503;
    case "PROVIDER_CAPABILITY_UNAVAILABLE":
      return 501;
    case "PARTIAL_DATA":
      return 200;
    case "INTERNAL_ERROR":
      return 500;
  }
}
