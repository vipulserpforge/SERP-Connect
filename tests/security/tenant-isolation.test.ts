import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USER_A, USER_B, connectWithToken, startStack, type Stack } from "../mcp/harness.js";

/**
 * Tenant isolation across every provider tool: user B guesses user A's property ids (and A guesses B's).
 * Each attempt must fail with the same "not connected" answer, and nothing of the other tenant may appear in the output.
 */
let stack: Stack;
const clients: Client[] = [];
beforeAll(async () => {
  stack = await startStack({ env: { PROVIDER_BING_ENABLED: "true", PROVIDER_CLARITY_ENABLED: "true" } });
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await stack.stop();
});

async function as(userId: string): Promise<Client> {
  const c = await connectWithToken(stack, await stack.as.mint({ sub: userId, aud: stack.url }));
  clients.push(c);
  await c.listTools();
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text: string }>)[0]!.text;
  return { isError: r.isError === true, text, parsed: JSON.parse(text) as { error?: { code: string } } };
}

const A_PROPS = {
  gsc: "sc-domain:example.com",
  ga4: "123456789",
  clarity: "clarity-demo-project",
  bing: "https://www.example.com/",
};

describe("user B cannot reach user A's data through any tool", () => {
  const attempts: Array<[string, Record<string, unknown>]> = [
    ["query_gsc_performance", { propertyId: A_PROPS.gsc, lastDays: 7 }],
    ["query_ga4_report", { propertyId: A_PROPS.ga4, lastDays: 7 }],
    ["query_ga4_realtime", { propertyId: A_PROPS.ga4 }],
    ["query_ga4_cohort", { propertyId: A_PROPS.ga4 }],
    ["get_supported_metrics", { provider: "ga4", propertyId: A_PROPS.ga4 }],
    ["get_clarity_insights", { propertyId: A_PROPS.clarity, numOfDays: 1 }],
    ["get_clarity_history", { propertyId: A_PROPS.clarity }],
    ["get_clarity_quota_status", { propertyId: A_PROPS.clarity }],
    ["query_bing_report", { propertyId: A_PROPS.bing, report: "traffic", lastDays: 7 }],
    ["get_bing_site_settings", { propertyId: A_PROPS.bing, report: "blocked_urls" }],
    ["get_bing_insights", { propertyId: A_PROPS.bing, preset: "top_queries" }],
  ];

  it.each(attempts)("%s", async (tool, args) => {
    const r = await call(await as(USER_B), tool, args);
    expect(r.isError, tool).toBe(true);
    expect(r.parsed.error?.code, tool).toBe("PROPERTY_NOT_CONNECTED");
    expect(r.text).not.toMatch(/example\.com|clarity-demo|Clarity demo|123456789/);
  });

  it.each(attempts)("control: the owner (user A) is served by %s", async (tool, args) => {
    const r = await call(await as(USER_A), tool, args);
    // Clarity history needs a database, which the in-memory stack lacks: reaching that message still proves the owner got past authorization.
    if (tool === "get_clarity_history") expect(r.parsed.error?.code).toBe("PROVIDER_CAPABILITY_UNAVAILABLE");
    else expect(r.isError, `${tool}: ${r.text.slice(0, 200)}`).toBe(false);
  });

  it("user A is refused user B's Bing site in the same way", async () => {
    const r = await call(await as(USER_A), "query_bing_report", { propertyId: "https://www.other-tenant.com/", report: "traffic", lastDays: 7 });
    expect(r.isError).toBe(true);
    expect(r.parsed.error?.code).toBe("PROPERTY_NOT_CONNECTED");
    expect(r.text).not.toContain("other-tenant");
  });

  it("an unknown id and another user's id are indistinguishable", async () => {
    const b = await as(USER_B);
    const foreign = await call(b, "get_clarity_insights", { propertyId: "clarity-demo-project", numOfDays: 1 });
    const unknown = await call(b, "get_clarity_insights", { propertyId: "clarity-does-not-exist", numOfDays: 1 });
    expect(foreign.parsed.error?.code).toBe(unknown.parsed.error?.code);
    const strip = (t: string) => t.replace(/"requestId":"[^"]+"/, "");
    expect(strip(foreign.text)).toBe(strip(unknown.text));
  });

  it("list tools never show the other tenant's properties", async () => {
    const b = await as(USER_B);
    for (const tool of ["list_gsc_properties", "list_ga4_properties", "list_clarity_projects"]) {
      const r = await call(b, tool, {});
      expect(r.text, tool).not.toMatch(/example\.com|clarity-demo|123456789/);
    }
    const bing = await call(b, "list_bing_sites", {});
    expect(bing.text).not.toContain("www.example.com");
  });
});
