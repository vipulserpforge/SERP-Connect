import { describe, expect, it } from "vitest";
import { MockTokenVerifier, authorizeProperty } from "@serp/auth";
import { loadSharedEnv } from "@serp/contracts";
import { MOCK_USER_A_ID, MOCK_USER_B_ID, MockRepository } from "@serp/db";
import { createMockReportService } from "@serp/reporting";

const env = loadSharedEnv({});
const service = () => createMockReportService(env, { now: () => new Date("2026-10-19T12:00:00Z") });
const userA = { userId: MOCK_USER_A_ID, scopes: [] };
const userB = { userId: MOCK_USER_B_ID, scopes: [] };

const gscQuery = (propertyId: string) => ({ propertyId, startDate: "2026-09-01", endDate: "2026-09-30", limit: 5 });

describe("tenant isolation", () => {
  it("user A cannot query user B's property, and the error does not reveal it exists", async () => {
    const foreign = service().queryGsc(userA, gscQuery("sc-domain:other-tenant.com"), "r1");
    const unknown = service().queryGsc(userA, gscQuery("sc-domain:does-not-exist.com"), "r2");
    await expect(foreign).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
    const [f, u] = await Promise.allSettled([foreign, unknown]);
    expect((f as PromiseRejectedResult).reason.message).toBe((u as PromiseRejectedResult).reason.message);
  });

  it("listings and status only include the caller's data", async () => {
    const s = service();
    expect((await s.listProperties(userA, "gsc")).map((p) => p.id)).toEqual(["sc-domain:example.com"]);
    expect((await s.listProperties(userB, "gsc")).map((p) => p.id)).toEqual(["sc-domain:other-tenant.com"]);
    expect((await s.getConnectionStatus(userB)).map((c) => c.id)).toEqual(["conn-b-bing", "conn-b-gsc"]);
  });

  it("cache entries are not shared across users", async () => {
    const s = service();
    await s.queryGsc(userA, gscQuery("sc-domain:example.com"), "r1");
    await expect(s.queryGsc(userB, gscQuery("sc-domain:example.com"), "r2")).rejects.toMatchObject({ code: "PROPERTY_NOT_CONNECTED" });
  });

  it("tool input cannot smuggle a user id", async () => {
    await expect(service().queryGsc(userA, { ...gscQuery("sc-domain:example.com"), userId: MOCK_USER_B_ID }, "r")).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("revoked connections fail safely", async () => {
    const repo = new MockRepository();
    (await repo.getConnection(MOCK_USER_A_ID, "conn-a-gsc"))!.status = "revoked";
    await expect(authorizeProperty(repo, userA, "gsc", "sc-domain:example.com")).rejects.toMatchObject({ code: "AUTH_REVOKED" });
  });

  it("mock verifier rejects malformed tokens", async () => {
    await expect(new MockTokenVerifier().verify("nope")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
