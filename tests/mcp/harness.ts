import { createServer as createNetServer } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadMcpEnv, mcpResourceUrl, type McpEnv } from "@serp/contracts";
import { createLogger } from "@serp/observability";
import { createMockReportService, type ReportService } from "@serp/reporting";
import { ConcurrencyLimiter } from "../../apps/mcp-server/src/limiter.js";
import { createHttpServer } from "../../apps/mcp-server/src/http.js";
import { buildVerifier } from "../../apps/mcp-server/src/verifier.js";
import { MockAuthServer, type MockAsOptions } from "./mock-oauth.js";

export const USER_A = "00000000-0000-4000-8000-00000000000a";
export const USER_B = "00000000-0000-4000-8000-00000000000b";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Stack {
  as: MockAuthServer;
  env: McpEnv;
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** The MCP endpoint, which is also the OAuth resource identifier. */
  url: string;
  logs: string[];
  service: ReportService;
  stop(): Promise<void>;
}

export interface StackOptions {
  as?: MockAsOptions;
  env?: Record<string, string>;
  service?: ReportService;
}

/** A real MCP HTTP server + mock authorization server on loopback. No mocks inside the server under test. */
export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const as = new MockAuthServer({ audience: "resource", ...options.as });
  await as.start();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = loadMcpEnv({
    NODE_ENV: "test",
    PORT: String(port),
    MCP_PUBLIC_URL: origin,
    MCP_AUTH_MODE: "oauth",
    MCP_OAUTH_ISSUER_URL: as.issuer,
    LOG_LEVEL: "debug",
    ...options.env,
  });
  const logs: string[] = [];
  const logger = createLogger({ level: "debug", write: (l) => logs.push(l) });
  const service = options.service ?? createMockReportService({ ...env, LOG_LEVEL: "error" }, { now: () => new Date("2026-10-19T12:00:00Z") });
  const server: Server = createHttpServer({
    env,
    verifier: buildVerifier(env),
    logger,
    tools: {
      service,
      logger,
      limiter: new ConcurrencyLimiter(env.MAX_MCP_CONCURRENT_REPORTS_PER_USER),
      providers: { gsc: true, ga4: true, clarity: env.PROVIDER_CLARITY_ENABLED, bing: env.PROVIDER_BING_ENABLED },
    },
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return {
    as,
    env,
    origin,
    url: mcpResourceUrl(env),
    logs,
    service,
    async stop() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await as.stop();
    },
  };
}

/** The official MCP SDK client, authenticated with a ready-made bearer token. */
export async function connectWithToken(stack: Stack, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(stack.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

/** Raw MCP POST for protocol-level assertions. */
export function rawPost(stack: Stack, init: { token?: string; headers?: Record<string, string>; body?: unknown; method?: string } = {}) {
  return fetch(stack.url, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(init.token && { authorization: `Bearer ${init.token}` }),
      ...init.headers,
    },
    ...(init.method !== "GET" && { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? { jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
  });
}
