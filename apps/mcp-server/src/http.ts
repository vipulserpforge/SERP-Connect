import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TokenVerificationError, extractBearer, type Principal, type TokenVerifier } from "@serp/auth";
import { mcpResourceUrl, toConnectorError, httpStatusFor, type McpEnv } from "@serp/contracts";
import { newRequestId, type Logger } from "@serp/observability";
import { buildMcpServer, type ToolDeps } from "./server.js";

const MAX_BODY_BYTES = 1_000_000;
const MCP_PATH = "/mcp";
const PRM_PATH = "/.well-known/oauth-protected-resource";

const BASE_HEADERS = { "x-content-type-options": "nosniff", "cache-control": "no-store" };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...BASE_HEADERS, ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const IP_TEXT = /^[0-9a-f:.]{3,45}$/i;

/**
 * Address of the caller, for the failed-sign-in trail. Behind nginx (which sets X-Real-IP and is the only way in: the
 * app port is not exposed) that header is the real client; otherwise the socket address. Never trusted for any decision.
 */
function clientAddress(req: IncomingMessage): string {
  const header = req.headers["x-real-ip"];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value && IP_TEXT.test(value)) return value;
  return (req.socket.remoteAddress ?? "unknown").slice(0, 45);
}

/** JSON-RPC error envelope for failures that happen before a message can be handled. */
const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new BodyError(413, "Request body too large.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new BodyError(400, "Empty request body.");
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, "Request body is not valid JSON.");
  }
}

export interface HttpDeps {
  env: McpEnv;
  verifier: TokenVerifier;
  tools: ToolDeps;
  logger: Logger;
}

export function createHttpServer({ env, verifier, tools, logger }: HttpDeps): Server {
  const origin = env.MCP_PUBLIC_URL.replace(/\/+$/, "");
  const resource = mcpResourceUrl(env);
  // RFC 9728: for a resource with a path, the metadata lives at /.well-known/oauth-protected-resource<path>.
  const metadataUrl = `${origin}${PRM_PATH}${MCP_PATH}`;
  const allowedOrigins = new Set(env.MCP_ALLOWED_ORIGINS.map((o) => o.replace(/\/+$/, "")));
  const requiredScopes = env.MCP_REQUIRED_SCOPES;

  const metadata = () => ({
    resource,
    authorization_servers: env.MCP_OAUTH_ISSUER_URL ? [env.MCP_OAUTH_ISSUER_URL] : [],
    bearer_methods_supported: ["header"],
    ...(requiredScopes.length > 0 && { scopes_supported: requiredScopes }),
    resource_name: "SEO Analytics",
  });

  /** RFC 6750 / RFC 9728 challenge. Claude starts sign-in only from a 401 that carries resource_metadata. */
  const challenge = (error?: { code: "invalid_token" | "insufficient_scope"; description: string }, scopes: string[] = requiredScopes): string => {
    const parts = [`resource_metadata="${metadataUrl}"`];
    if (scopes.length > 0) parts.push(`scope="${scopes.join(" ")}"`);
    if (error) parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
    return `Bearer ${parts.join(", ")}`;
  };

  const corsHeaders = (reqOrigin: string | undefined): Record<string, string> =>
    reqOrigin && allowedOrigins.has(reqOrigin)
      ? {
          "access-control-allow-origin": reqOrigin,
          "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id",
          vary: "Origin",
        }
      : {};

  async function authenticate(req: IncomingMessage, res: ServerResponse, requestId: string, cors: Record<string, string>): Promise<Principal | null> {
    const token = extractBearer(req.headers.authorization);
    if (!token) {
      logger.warn("mcp.token_missing", { requestId, remote: clientAddress(req) });
      send(res, 401, { error: { code: "AUTH_REQUIRED", message: "Authorization required.", requestId } }, { ...cors, "www-authenticate": challenge() });
      return null;
    }
    try {
      return await verifier.verify(token);
    } catch (err) {
      if (err instanceof TokenVerificationError) {
        logger.warn("mcp.token_rejected", { requestId, reason: err.reason, remote: clientAddress(req) });
        if (err.kind === "insufficient_scope") {
          send(res, 403, { error: { code: "FORBIDDEN", message: err.message, requestId } }, { ...cors, "www-authenticate": challenge({ code: "insufficient_scope", description: err.message }, err.requiredScopes) });
        } else if (err.kind === "unavailable") {
          send(res, 503, { error: { code: "PROVIDER_UNAVAILABLE", message: err.message, retryable: true, requestId } }, { ...cors, "retry-after": "5" });
        } else {
          send(res, 401, { error: { code: "AUTH_REQUIRED", message: err.message, requestId } }, { ...cors, "www-authenticate": challenge({ code: "invalid_token", description: err.message }) });
        }
        return null;
      }
      // Mock verifier and anything unexpected: never explain why.
      logger.warn("mcp.token_rejected", { requestId, reason: "unrecognized", remote: clientAddress(req) });
      send(res, 401, { error: { code: "AUTH_REQUIRED", message: "Invalid or missing access token.", requestId } }, { ...cors, "www-authenticate": challenge({ code: "invalid_token", description: "The access token is invalid." }) });
      return null;
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", origin);
    const reqOrigin = typeof req.headers.origin === "string" ? req.headers.origin.replace(/\/+$/, "") : undefined;

    if (url.pathname === "/healthz") {
      return send(res, 200, { status: "ok" });
    }

    // Public discovery documents: safe to expose and to read cross-origin.
    if (url.pathname === PRM_PATH || url.pathname === `${PRM_PATH}${MCP_PATH}`) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" }, { allow: "GET, HEAD" });
      if (!env.MCP_OAUTH_ISSUER_URL) return send(res, 404, { error: "OAuth is not configured on this server." });
      return send(res, 200, metadata(), { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" });
    }

    if (url.pathname !== MCP_PATH) return send(res, 404, { error: "Not found" });

    // DNS-rebinding protection: a browser Origin we have not allow-listed is refused outright.
    if (reqOrigin !== undefined && !allowedOrigins.has(reqOrigin)) {
      return send(res, 403, rpcError(-32000, "Forbidden: origin not allowed."));
    }
    const cors = corsHeaders(reqOrigin);
    if (req.method === "OPTIONS") {
      return send(res, 204, undefined, {
        ...cors,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
        "access-control-max-age": "600",
      });
    }

    const requestId = newRequestId();
    const principal = await authenticate(req, res, requestId, cors);
    if (!principal) return;

    // This server is stateless: no GET event stream and no sessions (both optional in the Streamable HTTP transport).
    if (req.method !== "POST") return send(res, 405, rpcError(-32000, "Method not allowed."), { ...cors, allow: "POST, OPTIONS" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      return send(res, 415, rpcError(-32000, "Content-Type must be application/json."), cors);
    }

    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      const e = err as BodyError;
      return send(res, e.status ?? 400, rpcError(e.status === 413 ? -32000 : -32700, e.message), cors);
    }

    const server = buildMcpServer(tools, principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...cors })) res.setHeader(k, v);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const error = toConnectorError(err, newRequestId());
      logger.error("http.unhandled", { err, requestId: error.requestId });
      send(res, httpStatusFor(error.code), { error });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
