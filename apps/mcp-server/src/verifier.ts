import { JwtTokenVerifier, MockTokenVerifier, type TokenVerifier } from "@serp/auth";
import { mcpResourceUrl, type McpEnv } from "@serp/contracts";

/** Real token validation: signature (JWKS), issuer, audience bound to this server, expiry, OAuth-client claim, scopes. */
export function buildVerifier(env: McpEnv): TokenVerifier {
  if (env.MCP_AUTH_MODE === "mock") return new MockTokenVerifier();
  const issuer = env.MCP_OAUTH_ISSUER_URL as string; // loadMcpEnv guarantees it in oauth mode
  const audience = [env.MCP_RESOURCE_AUDIENCE ?? mcpResourceUrl(env)];
  return new JwtTokenVerifier({
    issuer,
    audience,
    jwksUri: env.MCP_JWKS_URL ?? `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`,
    requiredScopes: env.MCP_REQUIRED_SCOPES,
  });
}
