import {
  ConnectorException,
  type ConnectionStatus,
  type PropertyRecord,
  type ProviderConnection,
  type ProviderKey,
} from "@serp/contracts";
import type { Repository } from "@serp/db";

/** The authenticated caller. Derived only from a validated token, never from tool input. */
export interface Principal {
  userId: string;
  clientId?: string;
  scopes: string[];
}

export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

export function extractBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/** Development only: accepts `mock:<userId>`. Startup refuses this mode in production. */
export class MockTokenVerifier implements TokenVerifier {
  async verify(token: string): Promise<Principal> {
    const match = token.match(/^mock:([0-9a-f-]{36})$/i);
    if (!match?.[1]) {
      throw new ConnectorException("AUTH_REQUIRED", "Invalid or missing access token.");
    }
    return { userId: match[1].toLowerCase(), clientId: "mock-client", scopes: ["mcp:read"] };
  }
}

/** Fails closed until the OAuth issuer (final phase) is configured. */
export class UnconfiguredOAuthVerifier implements TokenVerifier {
  async verify(): Promise<Principal> {
    throw new ConnectorException("AUTH_REQUIRED", "MCP OAuth is not configured on this server.");
  }
}

export interface AuthorizedProperty {
  property: PropertyRecord;
  connection: ProviderConnection;
}

function connectionStatusError(status: ConnectionStatus, provider: ProviderKey): ConnectorException | null {
  if (status === "connected") return null;
  // A saved Clarity token is "awaiting verification" until its first real request, which is how it gets verified
  // without spending quota on a separate test call.
  if (status === "pending" && provider === "clarity") return null;
  if (status === "revoked") {
    return new ConnectorException("AUTH_REVOKED", "Access to this account was revoked.", {
      provider,
      suggestedAction: "Reconnect the provider from the dashboard.",
    });
  }
  return new ConnectorException("AUTH_EXPIRED", "This connection needs attention.", {
    provider,
    suggestedAction: "Reconnect the provider from the dashboard.",
  });
}

/**
 * Resolves a model-supplied property id against the caller's own enabled properties.
 * Unknown and foreign ids are indistinguishable by design.
 */
export async function authorizeProperty(
  repo: Repository,
  principal: Principal,
  provider: ProviderKey,
  externalPropertyId: string,
): Promise<AuthorizedProperty> {
  const property = await repo.findEnabledProperty(principal.userId, provider, externalPropertyId);
  const connection = property ? await repo.getConnection(principal.userId, property.connectionId) : null;
  if (!property || !connection) {
    throw new ConnectorException("PROPERTY_NOT_CONNECTED", "That property is not connected or enabled for this account.", {
      provider,
      suggestedAction: "List your properties and choose one, or connect it from the dashboard.",
    });
  }
  const statusError = connectionStatusError(connection.status, provider);
  if (statusError) throw statusError;
  return { property, connection };
}
export * from "./web.js";
export * from "./jwt.js";
