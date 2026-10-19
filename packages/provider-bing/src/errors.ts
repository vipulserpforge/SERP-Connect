import { ConnectorException, isConnectorException } from "@serp/contracts";
import { BingApiError } from "./client.js";

const RECONNECT = "Reconnect Bing Webmaster from the dashboard.";

/** Translates a Bing failure into the shared, user-presentable error. Never includes upstream text, URLs or credentials. */
export function toBingConnectorError(err: unknown): ConnectorException {
  if (isConnectorException(err)) return err;
  if (!(err instanceof BingApiError)) {
    return new ConnectorException("PROVIDER_UNAVAILABLE", "Bing Webmaster is temporarily unavailable. Try again shortly.", { provider: "bing", retryable: true });
  }
  switch (err.kind) {
    case "unauthenticated":
      return new ConnectorException("AUTH_EXPIRED", "Bing rejected the stored access. The connection needs to be reconnected.", { provider: "bing", suggestedAction: RECONNECT });
    case "forbidden":
      return new ConnectorException("FORBIDDEN", "Bing does not allow this account to use the Webmaster API.", {
        provider: "bing",
        suggestedAction: "Check that the account has verified sites in Bing Webmaster Tools and has accepted the API terms (Settings > API Access).",
      });
    case "not_found":
      return new ConnectorException("PROPERTY_NOT_ACCESSIBLE", "The connected Bing account cannot read this site (it may be removed, unverified, or the permission changed).", {
        provider: "bing",
        suggestedAction: "Refresh the site list in the dashboard, or connect an account that has access to the site.",
      });
    case "throttled":
      return new ConnectorException("PROVIDER_RATE_LIMITED", "Bing is rate limiting requests for this account. Wait a while and retry.", {
        provider: "bing",
        retryable: true,
        ...(err.retryAfterSeconds !== undefined && { retryAfterSeconds: err.retryAfterSeconds }),
      });
    case "invalid_request":
      return new ConnectorException("INVALID_QUERY", "Bing rejected the request. Check the site address.", { provider: "bing" });
    case "capability":
      return new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Bing no longer offers this report at the documented address. The integration needs updating.", { provider: "bing" });
    case "bad_response":
      return new ConnectorException("PROVIDER_UNAVAILABLE", "Bing returned an unexpected response.", { provider: "bing", retryable: true });
    case "unavailable":
      return new ConnectorException("PROVIDER_UNAVAILABLE", "Bing Webmaster is temporarily unavailable. Try again shortly.", { provider: "bing", retryable: true });
  }
}
