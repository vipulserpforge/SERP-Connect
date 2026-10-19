import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Runs the PRODUCTION BUILD of the MCP server (apps/mcp-server/dist) as a separate process, the way it is deployed.
// The environment is built from scratch so a developer's .env.local can never leak into (or change) the test.
// Run via `pnpm test:e2e` (builds first). Identity here is the mock bearer; real OAuth is covered by tests/mcp.

const entry = fileURLToPath(new URL("../../apps/mcp-server/dist/index.js", import.meta.url));
const running: ChildProcess[] = [];
afterEach(() => {
  for (const p of running.splice(0)) p.kill("SIGTERM");
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const starter = fileURLToPath(new URL("../../scripts/start-mcp.mjs", import.meta.url));

function launch(env: Record<string, string>, script = entry) {
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  running.push(child);
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  return { child, exited, output: () => out };
}

async function until(url: string, proc: ReturnType<typeof launch>) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`MCP server did not start:\n${proc.output()}`);
}

describe("built MCP server process", () => {
  it("starts, challenges unauthenticated callers, and serves tools to a mock-authenticated client", async () => {
    const port = await freePort();
    const proc = launch({ NODE_ENV: "development", PORT: String(port), MCP_PUBLIC_URL: `http://127.0.0.1:${port}`, MCP_AUTH_MODE: "mock", AUTH_MODE: "mock", DB_MODE: "mock", DATA_MODE: "mock" });
    await until(`http://127.0.0.1:${port}/healthz`, proc);

    const anon = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toMatch(/resource_metadata=/);

    const client = new Client({ name: "built-smoke", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer mock:00000000-0000-4000-8000-000000000001" } } }));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("query_gsc_performance");
    const r = await client.callTool({ name: "get_connection_status", arguments: {} });
    expect(r.isError).not.toBe(true);
    await client.close();
    expect(proc.output()).not.toMatch(/Bearer mock:|mock-access-token/);
  });

  it("refuses to run in production with mock authentication or mock data", async () => {
    const port = await freePort();
    const proc = launch({ NODE_ENV: "production", PORT: String(port), MCP_PUBLIC_URL: `https://mcp.example.com`, MCP_AUTH_MODE: "mock" });
    expect(await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("still running"), 8000))])).not.toBe("still running");
    expect(proc.output()).toMatch(/mock/i);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  }, 15_000);

  it("the hosting entry script defaults to production, so mock modes are refused even if NODE_ENV was never set", async () => {
    const port = await freePort();
    const proc = launch({ PORT: String(port), MCP_PUBLIC_URL: "https://mcp.example.com", MCP_AUTH_MODE: "mock" }, starter);
    expect(await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r("still running"), 8000))])).not.toBe("still running");
    expect(proc.output()).toMatch(/Refusing to start in production/);
  }, 15_000);

  it("the hosting entry script starts the real server when configured", async () => {
    const port = await freePort();
    const proc = launch({ NODE_ENV: "development", PORT: String(port), MCP_PUBLIC_URL: `http://127.0.0.1:${port}`, MCP_AUTH_MODE: "mock", DB_MODE: "mock", DATA_MODE: "mock" }, starter);
    await until(`http://127.0.0.1:${port}/healthz`, proc);
  });

  it("refuses OAuth mode without an issuer, and an unbound audience without explicit opt-in", async () => {
    for (const env of [
      { MCP_AUTH_MODE: "oauth" },
      { MCP_AUTH_MODE: "oauth", MCP_OAUTH_ISSUER_URL: "https://x.supabase.co/auth/v1", MCP_RESOURCE_AUDIENCE: "authenticated" },
    ]) {
      const port = await freePort();
      const proc = launch({ NODE_ENV: "development", PORT: String(port), MCP_PUBLIC_URL: `http://127.0.0.1:${port}`, ...env });
      expect(await proc.exited).not.toBe(0);
      expect(proc.output()).toMatch(/MCP_/);
    }
  });
});
