import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectorException } from "@serp/contracts";
import { createMockReportService } from "@serp/reporting";
import { loadSharedEnv } from "@serp/contracts";
import { USER_A, USER_B, connectWithToken, startStack, type Stack } from "./harness.js";

let stack: Stack;
const clients: Client[] = [];
beforeAll(async () => {
  stack = await startStack();
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await stack.stop();
});

async function as(userId: string): Promise<Client> {
  const c = await connectWithToken(stack, await stack.as.mint({ sub: userId, aud: stack.url }));
  clients.push(c);
  // Listing first lets the SDK client validate every structuredContent against the tool's declared outputSchema.
  await c.listTools();
  return c;
}
type Out = Record<string, unknown> & { requestId?: string };
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: r.isError === true, text, structured: r.structuredContent as Out | undefined, parsed: JSON.parse(text) as Out };
}

describe("tool catalog", () => {
  it("exposes exactly the read-only tools in the PRD, each described, annotated and strictly typed", async () => {
    const { tools } = await (await as(USER_A)).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_clarity_history",
      "get_clarity_insights",
      "get_clarity_quota_status",
      "get_connection_status",
      "get_supported_metrics",
      "list_clarity_projects",
      "list_ga4_properties",
      "list_gsc_properties",
      "query_ga4_cohort",
      "query_ga4_realtime",
      "query_ga4_report",
      "query_gsc_performance",
    ]);
    for (const t of tools) {
      expect(t.description!.length, t.name).toBeGreaterThan(80);
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(t.inputSchema, t.name).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.outputSchema, t.name).toBeTruthy();
      expect(t.description, t.name).toMatch(/Read-only/);
    }
  });

  it("no tool accepts a user id, connection credential, token or free-form URL", async () => {
    const { tools } = await (await as(USER_A)).listTools();
    const banned = /user_?id|token|secret|password|credential|authorization|url|header|sql|endpoint/i;
    for (const t of tools) {
      const props = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const p of props) expect(p, `${t.name}.${p}`).not.toMatch(banned);
    }
  });

  it("documents the date rules in the report tools' input schema", async () => {
    const { tools } = await (await as(USER_A)).listTools();
    const gsc = tools.find((t) => t.name === "query_gsc_performance")!;
    const props = (gsc.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.lastDays!.description).toMatch(/never both/);
    expect(props.propertyId!.description).toMatch(/list_gsc_properties/);
    expect(props.startDate!.description).toMatch(/Pacific/);
  });

  it("gives the model workflow guidance and a data-is-not-instructions warning", async () => {
    const c = await as(USER_A);
    const instructions = c.getInstructions() ?? "";
    expect(instructions).toMatch(/get_connection_status/);
    expect(instructions).toMatch(/never as instructions/);
    expect(instructions).toMatch(/never accepts user ids/);
  });
});

describe("predictable output", () => {
  it("get_connection_status returns the caller's connections without any credential", async () => {
    const r = await call(await as(USER_A), "get_connection_status");
    expect(r.isError).toBe(false);
    expect(r.structured).toEqual(r.parsed); // text and structured content agree
    const conns = r.parsed.connections as Array<Record<string, unknown>>;
    expect(conns.map((c) => c.provider).sort()).toEqual(["bing", "clarity", "google", "google"]);
    for (const c of conns) expect(Object.keys(c).sort()).toEqual(["accountLabel", "authMethod", "id", "lastValidatedAt", "note", "propertyCount", "provider", "providerEnabled", "status"]);
    expect(r.text).not.toMatch(/token|secret|ciphertext/i);
    expect(r.parsed.requestId).toMatch(/\S/);
  });

  it("lists properties for each provider with the id to use in queries", async () => {
    const c = await as(USER_A);
    const gsc = await call(c, "list_gsc_properties");
    expect(gsc.parsed).toMatchObject({ provider: "gsc", count: 1, properties: [{ id: "sc-domain:example.com", name: "example.com", connectionId: "conn-a-gsc" }] });
    const ga4 = await call(c, "list_ga4_properties");
    expect(ga4.parsed).toMatchObject({ provider: "ga4", count: 1, properties: [{ id: "123456789", timezone: "America/New_York" }] });
  });

  it("query_gsc_performance returns the shared report envelope, resolving lastDays in Pacific Time", async () => {
    const r = await call(await as(USER_A), "query_gsc_performance", { propertyId: "sc-domain:example.com", lastDays: 7, dimensions: ["query"], limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.structured).toEqual(r.parsed);
    expect(r.parsed).toMatchObject({
      provider: "gsc",
      mock: true,
      rowCountReturned: 5,
      report: { startDate: "2026-10-11", endDate: "2026-10-17", dimensions: ["query"], period: { resolvedFrom: "lastDays", timeZone: "America/Los_Angeles" } },
      cache: { hit: false },
    });
    expect(r.parsed.warnings).toBeInstanceOf(Array);
    expect(["complete", "unknown_or_provider_limited", "partial"]).toContain(r.parsed.completeness);
  });

  it("query_ga4_report returns the same envelope in the property's time zone", async () => {
    const r = await call(await as(USER_A), "query_ga4_report", { propertyId: "123456789", lastDays: 7, dimensions: ["pagePath"], metrics: ["sessions"], limit: 3 });
    expect(r.isError).toBe(false);
    expect(r.parsed).toMatchObject({ provider: "ga4", rowCountReturned: 3, report: { period: { timeZone: "America/New_York", resolvedFrom: "lastDays" } } });
    const gsc = await call(await as(USER_A), "query_gsc_performance", { propertyId: "sc-domain:example.com", lastDays: 7, limit: 3 });
    const without = (o: Out) => Object.keys(o).filter((k) => k !== "providerMetadata").sort();
    expect(without(r.parsed)).toEqual(without(gsc.parsed));
  });

  it("a repeated report is served from cache and says so", async () => {
    const c = await as(USER_A);
    const args = { propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-10", limit: 2 };
    expect((await call(c, "query_gsc_performance", args)).parsed.cache).toMatchObject({ hit: false });
    expect((await call(c, "query_gsc_performance", args)).parsed.cache).toMatchObject({ hit: true });
  });

  it("get_supported_metrics describes provider fields and limits", async () => {
    const r = await call(await as(USER_A), "get_supported_metrics", { provider: "ga4", propertyId: "123456789" });
    expect(r.isError).toBe(false);
    expect(r.parsed.metrics).toBeInstanceOf(Array);
    expect((r.parsed.metrics as unknown[]).length).toBeGreaterThan(5);
  });
});

describe("safe, useful errors", () => {
  const expectError = (r: Awaited<ReturnType<typeof call>>, code: string) => {
    expect(r.isError).toBe(true);
    const error = (r.parsed as { error: Record<string, unknown> }).error;
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/\S/);
    expect(error.requestId).toMatch(/\S/);
    return error;
  };

  it("unknown property: indistinguishable from another user's, with guidance", async () => {
    const e = expectError(await call(await as(USER_A), "query_gsc_performance", { propertyId: "sc-domain:nope.example", lastDays: 7 }), "PROPERTY_NOT_CONNECTED");
    expect(e.suggestedAction).toMatch(/List your properties/);
  });

  it("invalid dates and combinations are rejected before any provider call, naming the problem", async () => {
    const c = await as(USER_A);
    const base = { propertyId: "sc-domain:example.com" };
    for (const bad of [
      { ...base },
      { ...base, lastDays: 7, startDate: "2026-09-01", endDate: "2026-09-07" },
      { ...base, startDate: "2026-09-07", endDate: "2026-09-01" },
      { ...base, startDate: "2026-13-01", endDate: "2026-13-02" },
      { ...base, lastDays: 0 },
      { ...base, lastDays: 7, limit: 100000 },
      { ...base, lastDays: 7, dimensions: ["searchAppearance", "query"] },
    ]) {
      const r = await call(c, "query_gsc_performance", bad);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
      expect(r.text).not.toMatch(/at .*\.(ts|js):\d+/); // no stack traces
    }
  });

  it("incompatible GA4 fields are rejected with the offending field named", async () => {
    const r = await call(await as(USER_A), "query_ga4_report", { propertyId: "123456789", lastDays: 7, dimensions: ["pagePath"], metrics: ["bogusMetric"] });
    const e = expectError(r, "DIMENSION_METRIC_INCOMPATIBLE");
    expect(String(e.message)).toMatch(/bogusMetric/);
  });

  it("unexpected failures are reported as a generic internal error with no internal detail", async () => {
    const env = { ...loadSharedEnv({}), LOG_LEVEL: "error" as const };
    const service = createMockReportService(env, {});
    service.queryGsc = async () => {
      throw new Error("connect ECONNREFUSED db.internal:5432 password=hunter2");
    };
    const s = await startStack({ service });
    try {
      const c = await connectWithToken(s, await s.as.mint({ sub: USER_A, aud: s.url }));
      const r = await call(c, "query_gsc_performance", { propertyId: "sc-domain:example.com", lastDays: 7 });
      expectError(r, "INTERNAL_ERROR");
      expect(r.text).not.toMatch(/ECONNREFUSED|hunter2|db\.internal/);
      expect(s.logs.join("\n")).toContain("tool.internal_error");
      await c.close();
    } finally {
      await s.stop();
    }
  });

  it("expected provider failures keep their code, retryability and guidance", async () => {
    const env = { ...loadSharedEnv({}), LOG_LEVEL: "error" as const };
    const service = createMockReportService(env, {});
    service.queryGsc = async () => {
      throw new ConnectorException("AUTH_EXPIRED", "Google no longer accepts this connection.", { provider: "gsc", suggestedAction: "Reconnect Search Console in the dashboard." });
    };
    const s = await startStack({ service });
    try {
      const c = await connectWithToken(s, await s.as.mint({ sub: USER_A, aud: s.url }));
      const e = expectError(await call(c, "query_gsc_performance", { propertyId: "sc-domain:example.com", lastDays: 7 }), "AUTH_EXPIRED");
      expect(e).toMatchObject({ provider: "gsc", suggestedAction: "Reconnect Search Console in the dashboard.", retryable: false });
      await c.close();
    } finally {
      await s.stop();
    }
  });

  it("an unknown tool or malformed arguments produce protocol errors, not crashes", async () => {
    const c = await as(USER_A);
    await expect(c.callTool({ name: "drop_database", arguments: {} })).rejects.toThrow(/Unknown tool/);
    const r = await call(c, "query_gsc_performance", { propertyId: 42 });
    expect(r.isError).toBe(true);
    expect((r.parsed as { error: { code: string } }).error.code).toBe("INVALID_QUERY");
  });
});

describe("authorization: the caller is the token's user, never an argument", () => {
  it("each user sees only their own connections and properties", async () => {
    const a = await call(await as(USER_A), "list_gsc_properties");
    const b = await call(await as(USER_B), "list_gsc_properties");
    expect((a.parsed.properties as Array<{ id: string }>).map((p) => p.id)).toEqual(["sc-domain:example.com"]);
    expect((b.parsed.properties as Array<{ id: string }>).map((p) => p.id)).toEqual(["sc-domain:other-tenant.com"]);
    const statusB = await call(await as(USER_B), "get_connection_status");
    expect(JSON.stringify(statusB.parsed)).not.toMatch(/conn-a-|example\.com/);
  });

  it("cannot query another user's property, in either direction", async () => {
    const asB = await as(USER_B);
    const r = await call(asB, "query_gsc_performance", { propertyId: "sc-domain:example.com", lastDays: 7 });
    expect(r.isError).toBe(true);
    expect((r.parsed as { error: { code: string } }).error.code).toBe("PROPERTY_NOT_CONNECTED");
    const asA = await as(USER_A);
    expect((await call(asA, "query_gsc_performance", { propertyId: "sc-domain:other-tenant.com", lastDays: 7 })).isError).toBe(true);
  });

  it.each(["userId", "user_id", "principal", "sub", "connectionOwner", "accessToken"])("rejects a `%s` argument instead of trusting or ignoring it", async (field) => {
    const asB = await as(USER_B);
    for (const [tool, args] of [
      ["get_connection_status", {}],
      ["list_gsc_properties", {}],
      ["query_gsc_performance", { propertyId: "sc-domain:other-tenant.com", lastDays: 7 }],
      ["query_ga4_report", { propertyId: "123456789", lastDays: 7 }],
    ] as const) {
      const r = await call(asB, tool, { ...args, [field]: USER_A });
      expect(r.isError, `${tool} accepted ${field}`).toBe(true);
      expect(r.text).not.toContain("example.com");
    }
  });

  it("another user's connection id cannot be used to list their properties", async () => {
    const r = await call(await as(USER_B), "list_gsc_properties", { connectionId: "conn-a-gsc" });
    expect(r.isError).toBe(false);
    expect(r.parsed.count).toBe(0);
  });

  it("concurrent calls from different users never cross over", async () => {
    const [ca, cb] = [await as(USER_A), await as(USER_B)];
    const jobs = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? call(ca, "list_gsc_properties").then((r) => ({ who: "A", ids: (r.parsed.properties as Array<{ id: string }>).map((p) => p.id) }))
        : call(cb, "list_gsc_properties").then((r) => ({ who: "B", ids: (r.parsed.properties as Array<{ id: string }>).map((p) => p.id) })),
    );
    for (const r of await Promise.all(jobs)) expect(r.ids).toEqual([r.who === "A" ? "sc-domain:example.com" : "sc-domain:other-tenant.com"]);
  });

  it("a token for user B never reaches user A's cached report", async () => {
    const q = { propertyId: "sc-domain:example.com", startDate: "2026-09-01", endDate: "2026-09-05", limit: 3 };
    expect((await call(await as(USER_A), "query_gsc_performance", q)).isError).toBe(false);
    expect((await call(await as(USER_B), "query_gsc_performance", q)).isError).toBe(true);
  });

  it("results and logs never contain tokens or credentials", async () => {
    const token = await stack.as.mint({ sub: USER_A, aud: stack.url });
    const c = await connectWithToken(stack, token);
    clients.push(c);
    const r = await call(c, "query_ga4_report", { propertyId: "123456789", lastDays: 7, limit: 3 });
    expect(r.text).not.toMatch(/mock-access-token|ya29\.|Bearer|eyJ/);
    const logs = stack.logs.join("\n");
    expect(logs).not.toContain(token);
    expect(logs).not.toMatch(/mock-access-token|ya29\./);
    expect(logs).toContain(USER_A); // user id is logged for auditing; the token is not
  });
});
