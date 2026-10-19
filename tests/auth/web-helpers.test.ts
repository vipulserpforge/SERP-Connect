import { describe, expect, it } from "vitest";
import { credentialsSchema, decideRoute, mapSignInError, mapSignUpError, safeNextPath } from "@serp/auth";
import { loadMcpEnv, loadWebEnv } from "@serp/contracts";

describe("safeNextPath (open-redirect protection)", () => {
  it.each(["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "evil", "", null, undefined, 42, "/a\nb"])(
    "rejects %j",
    (input) => expect(safeNextPath(input)).toBe("/dashboard"),
  );
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/dashboard/settings?x=1")).toBe("/dashboard/settings?x=1");
  });
});

describe("credentials", () => {
  it("normalizes email and enforces password length", () => {
    expect(credentialsSchema.parse({ email: "  Me@Example.COM ", password: "12345678" }).email).toBe("me@example.com");
    expect(credentialsSchema.safeParse({ email: "x", password: "12345678" }).success).toBe(false);
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
    expect(credentialsSchema.safeParse({ email: "a@b.co", password: "x".repeat(73) }).success).toBe(false);
  });
});

describe("route policy", () => {
  it("protects the dashboard for signed-out users, preserving the target", () => {
    expect(decideRoute("/dashboard", false)).toEqual({ action: "redirect", to: "/login?next=%2Fdashboard" });
    expect(decideRoute("/dashboard/anything", false).action).toBe("redirect");
  });
  it("does not treat look-alike paths as protected", () => {
    expect(decideRoute("/dashboardx", false).action).toBe("allow");
  });
  it("sends signed-in users away from login/signup, allows public pages", () => {
    expect(decideRoute("/login", true)).toEqual({ action: "redirect", to: "/dashboard" });
    expect(decideRoute("/signup", true).action).toBe("redirect");
    expect(decideRoute("/", false).action).toBe("allow");
    expect(decideRoute("/dashboard", true).action).toBe("allow");
  });
});

describe("auth error mapping does not enumerate accounts", () => {
  it("collapses unknown/unconfirmed/wrong-password sign-in failures into one code", () => {
    for (const c of ["invalid_credentials", "email_not_confirmed", "user_not_found", undefined]) {
      expect(mapSignInError(c)).toBe("invalid_credentials");
    }
    expect(mapSignInError("over_request_rate_limit")).toBe("rate_limited");
  });
  it("maps sign-up failures to safe codes", () => {
    expect(mapSignUpError("weak_password")).toBe("weak_password");
    expect(mapSignUpError("user_already_exists")).toBe("signup_failed");
    expect(mapSignUpError("email_address_invalid")).toBe("email_rejected");
    expect(mapSignUpError("email_address_not_authorized")).toBe("email_not_deliverable");
  });
});

describe("environment safety", () => {
  const supabaseAuth = { AUTH_MODE: "supabase" };
  it("web: Supabase auth requires URL and key", () => {
    expect(() => loadWebEnv(supabaseAuth)).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(
      loadWebEnv({ ...supabaseAuth, NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }).AUTH_MODE,
    ).toBe("supabase");
  });
  it("refuses mock auth, mock data or mock DB in production", () => {
    expect(() => loadWebEnv({ NODE_ENV: "production" })).toThrow(/Refusing/);
    expect(() => loadMcpEnv({ NODE_ENV: "production" })).toThrow(/Refusing/);
    expect(() => loadMcpEnv({ NODE_ENV: "production", MCP_AUTH_MODE: "oauth", DATA_MODE: "live", DB_MODE: "mock" })).toThrow(/DB_MODE=mock/);
  });
  it("never echoes env values in validation errors", () => {
    expect(() => loadWebEnv({ NEXT_PUBLIC_APP_URL: "not-a-url-SECRET123" })).toThrow(/NEXT_PUBLIC_APP_URL/);
    try {
      loadWebEnv({ NEXT_PUBLIC_APP_URL: "not-a-url-SECRET123" });
    } catch (e) {
      expect(String(e)).not.toContain("SECRET123");
    }
  });
});
