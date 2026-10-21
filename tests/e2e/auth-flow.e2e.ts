import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createTestDatabase } from "../db/harness.js";
import { Browser, freePort, location, setBase } from "./browser.js";
import { FakeGoTrue } from "./fake-gotrue.js";

// Drives the REAL built Next.js app (proxy, server actions, @supabase/ssr) against a fake Auth server.
// Run via `pnpm test:e2e` (builds the web app first).
//
// Two passes share this file. By default the app uses its in-memory repository. With E2E_DB=postgres it uses the
// real `pg` driver against a PGlite Postgres (migrations applied, served over the Postgres wire protocol), which
// is the same code path production uses with Supabase. Google is the mock in both passes.
const POSTGRES = process.env.E2E_DB === "postgres";
let pgDb: PGlite | undefined;
let pgServer: PGLiteSocketServer | undefined;

const webDir = fileURLToPath(new URL("../../apps/web", import.meta.url));
const fake = new FakeGoTrue();
let server: ChildProcess;
let base = "";
let serverLog = "";

beforeAll(async () => {
  await fake.start();
  const port = await freePort();
  base = `http://localhost:${port}`;
  setBase(base);
  let dbUrl = "";
  if (POSTGRES) {
    pgDb = await createTestDatabase();
    const dbPort = await freePort();
    pgServer = new PGLiteSocketServer({ db: pgDb, port: dbPort, host: "127.0.0.1", maxConnections: 10 });
    await pgServer.start();
    dbUrl = `postgres://postgres@127.0.0.1:${dbPort}/postgres`;
    const db = pgDb;
    fake.onUserCreated = async (u) => void (await db.query("insert into auth.users (id, email) values ($1, $2)", [u.id, u.email]));
  }
  server = spawn("node_modules/.bin/next", ["start", "-p", String(port)], {
    cwd: webDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      AUTH_MODE: "supabase",
      DB_MODE: POSTGRES ? "postgres" : "mock", // in mock mode, demo data must never be shown to real (non-demo) users
      ...(POSTGRES && { SUPABASE_DB_URL: dbUrl }),
      DATA_MODE: "mock",
      PROVIDER_BING_ENABLED: "true",
      CLARITY_LOCAL_DAILY_BUDGET: "8",
      ALLOW_MOCK_IN_PRODUCTION: "true",
      // Production refuses to start without an encryption key; this one is random per run.
      SECRET_KEYS: `e2e:${randomBytes(32).toString("base64")}`,
      CREDENTIAL_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
      NEXT_PUBLIC_APP_URL: base,
      NEXT_PUBLIC_SUPABASE_URL: fake.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-publishable-key",
    },
  });
  server.stdout?.on("data", (d) => (serverLog += d));
  server.stderr?.on("data", (d) => (serverLog += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Next did not start:\n${serverLog}`);
}, 60_000);

afterAll(async () => {
  server?.kill("SIGTERM");
  await fake.stop();
  await pgServer?.stop();
  await pgDb?.close();
});

const EMAIL_A = "alice@saas.test";
const EMAIL_B = "bob@saas.test";
const PASSWORD = "correct-horse-battery";

describe("protected routes", () => {
  it("redirects signed-out visitors from the dashboard to login, keeping the target", async () => {
    const res = await new Browser().request("/dashboard");
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/login?next=%2Fdashboard");
  });

  it("returns a 401 envelope from the API without a session", async () => {
    const res = await new Browser().request("/api/connections");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("AUTH_REQUIRED");
  });

  it("serves public pages", async () => {
    const b = new Browser();
    expect((await b.request("/")).status).toBe(200);
    expect((await b.request("/login")).status).toBe(200);
    expect((await b.request("/signup")).status).toBe(200);
    // Google's app verification requires a public home page that links to a public privacy policy.
    expect(await (await b.request("/")).text()).toContain('href="/privacy"');
    const privacy = await b.request("/privacy");
    expect(privacy.status).toBe(200);
    const text = await privacy.text();
    expect(text).toContain("Google API Services User Data Policy");
    expect(text).toContain("webmasters.readonly");
    expect(text).toContain("analytics.readonly");
  });
});

describe("sign-up", () => {
  it("rejects invalid input without calling the Auth server", async () => {
    const res = await new Browser().submitForm("/signup", { email: "nope", password: "short" });
    expect(location(res)).toContain("/signup?error=invalid_input");
    expect(fake.users.size).toBe(0);
  });

  it("requires email confirmation and behaves identically for existing addresses", async () => {
    const first = await new Browser().submitForm("/signup", { email: EMAIL_A, password: PASSWORD });
    expect(location(first)).toContain("/login?notice=check_email");
    const again = await new Browser().submitForm("/signup", { email: EMAIL_A, password: "another-password" });
    expect(location(again)).toBe(location(first)); // no account enumeration
    expect(fake.users.size).toBe(1);
  });
});

describe("sign-in", () => {
  it("cannot sign in before confirming, and wrong password/unknown user look the same", async () => {
    const unconfirmed = await new Browser().submitForm("/login", { email: EMAIL_A, password: PASSWORD });
    const wrong = await new Browser().submitForm("/login", { email: EMAIL_A, password: "wrong-password" });
    const unknown = await new Browser().submitForm("/login", { email: "ghost@saas.test", password: PASSWORD });
    for (const r of [unconfirmed, wrong, unknown]) expect(location(r)).toContain("error=invalid_credentials");
  });

  it("signs in after confirmation and shows the dashboard with the account email", async () => {
    fake.confirm(EMAIL_A);
    const b = new Browser();
    const res = await b.submitForm("/login", { email: EMAIL_A, password: PASSWORD, next: "/dashboard" });
    expect(location(res)).toBe("/dashboard");
    expect([...b.cookies.keys()].some((k) => k.startsWith("sb-"))).toBe(true);

    const dash = await b.request("/dashboard");
    expect(dash.status).toBe(200);
    const html = await dash.text();
    expect(html).toContain(EMAIL_A);
    expect(html).not.toContain("Mock mode"); // real session, not the demo user
  });

  it("ignores an off-site `next` target", async () => {
    const b = new Browser();
    const res = await b.submitForm("/login", { email: EMAIL_A, password: PASSWORD, next: "https://evil.example/steal" });
    expect(location(res)).toBe("/dashboard");
  });

  it("sends a signed-in user away from the login page", async () => {
    const b = new Browser();
    await b.submitForm("/login", { email: EMAIL_A, password: PASSWORD });
    const res = await b.request("/login");
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/dashboard");
  });
});

describe("tenant separation at the web layer", () => {
  it("two users each see only their own identity, and neither sees demo data", async () => {
    await new Browser().submitForm("/signup", { email: EMAIL_B, password: PASSWORD });
    fake.confirm(EMAIL_B);
    const a = new Browser();
    const b = new Browser();
    await a.submitForm("/login", { email: EMAIL_A, password: PASSWORD });
    await b.submitForm("/login", { email: EMAIL_B, password: PASSWORD });

    const htmlA = await (await a.request("/dashboard")).text();
    const htmlB = await (await b.request("/dashboard")).text();
    expect(htmlA).toContain(EMAIL_A);
    expect(htmlA).not.toContain(EMAIL_B);
    expect(htmlB).toContain(EMAIL_B);
    expect(htmlB).not.toContain(EMAIL_A);
    for (const html of [htmlA, htmlB]) expect(html).not.toMatch(/example\.com|Account B|Account C/);

    const api = await (await a.request("/api/connections")).json();
    expect(api.data).toEqual([]);
  });
});

describe("session integrity and sign-out", () => {
  it("rejects a forged session cookie", async () => {
    const real = new Browser();
    await real.submitForm("/login", { email: EMAIL_A, password: PASSWORD });
    const forged = new Browser();
    for (const [name, value] of real.cookies) {
      forged.cookies.set(name, name.startsWith("sb-") ? Buffer.from(JSON.stringify({ access_token: "forged.token.value", refresh_token: "x", user: { id: "u" } })).toString("base64") : value);
    }
    const res = await forged.request("/dashboard");
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/login");
  });

  it("sign-out clears the session and revokes the old token server-side", async () => {
    const b = new Browser();
    await b.submitForm("/login", { email: EMAIL_A, password: PASSWORD });
    const stolen = new Map(b.cookies); // an attacker who copied the cookies earlier
    expect((await b.request("/dashboard")).status).toBe(200);

    const out = await b.submitForm("/dashboard", {});
    expect(location(out)).toContain("/login?notice=signed_out");
    expect((await b.request("/dashboard")).status).toBe(307);

    const replay = new Browser();
    replay.cookies = stolen;
    const res = await replay.request("/dashboard");
    expect(res.status).toBe(307); // token was revoked on the Auth server, cookie alone is not trusted
  });
});

describe("continue with Google", () => {
  it("sends the browser to the Auth server's Google authorize URL", async () => {
    const res = await new Browser().submitForm("/login", {}, 1);
    const loc = location(res);
    // The fake Auth server serves /auth/v1/authorize; what matters is the app redirects there with its callback.
    expect(loc).toContain("/auth/v1/authorize");
    expect(loc).toContain("provider=google");
    expect(decodeURIComponent(loc)).toContain("/auth/callback");
  });
});

describe("auth callback", () => {
  it("rejects an invalid or missing code and never redirects off-site", async () => {
    const bad = await new Browser().request("/auth/callback?code=bogus&next=https://evil.example");
    expect(location(bad)).toContain("/login?error=callback_failed");
    const none = await new Browser().request("/auth/callback");
    expect(location(none)).toContain("/login?error=callback_failed");
  });
});

describe("provider credential connections (mock Google)", () => {
  const formIndexWith = (html: string, needle: string) =>
    html.split("<form").slice(1).findIndex((f) => (f.split("</form>")[0] ?? "").includes(needle));

  async function signedIn(email: string) {
    const b = new Browser();
    await b.submitForm("/login", { email, password: PASSWORD });
    return b;
  }

  it("connects through the server action, shows only to its owner, and disconnects", async () => {
    const a = await signedIn(EMAIL_A);
    const b = await signedIn(EMAIL_B);

    let html = await (await a.request("/dashboard")).text();
    const connectIdx = formIndexWith(html, 'value="gsc"');
    expect(connectIdx).toBeGreaterThan(-1);
    const start = await a.submitForm("/dashboard", { product: "gsc" }, connectIdx);
    expect(location(start)).toContain("/api/oauth/google/callback");
    const done = await a.request(location(start));
    expect(location(done)).toContain("connected=gsc&synced=3");

    html = await (await a.request("/dashboard")).text();
    expect(html).toMatch(/connected/);
    expect(await (await a.request(new URL(location(done)).pathname + new URL(location(done)).search)).text()).toContain("3 Search Console properties available");
    expect(html).toContain("example.com");
    expect(html).not.toContain("not-verified.example.net"); // unverified sites are never listed as usable

    // Manual refresh works, is owner-scoped, and reports the outcome.
    const refreshIdx = html.split("<form").slice(1).findIndex((f) => /Refresh properties/.test(f.split("</form>")[0] ?? ""));
    expect(refreshIdx).toBeGreaterThan(-1);
    const refreshId = /name="connectionId"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="connectionId"/.exec(html.split("<form")[refreshIdx + 1] ?? "");
    const refreshed = await a.submitForm("/dashboard", { connectionId: (refreshId?.[1] ?? refreshId?.[2])! }, refreshIdx);
    expect(location(refreshed)).toContain("synced=3&unverified=1");
    const foreign = await b.submitForm("/dashboard", { connectionId: (refreshId?.[1] ?? refreshId?.[2])! }, 1);
    expect(location(foreign)).not.toContain("synced=");
    const listA = (await (await a.request("/api/connections")).json()).data as Array<Record<string, unknown>>;
    expect(listA).toHaveLength(1);
    // The API never exposes credential material.
    expect(JSON.stringify(listA)).not.toMatch(/token|secret|ciphertext|wrapped|verifier|credential/i);
    expect((await (await b.request("/api/connections")).json()).data).toEqual([]);

    // A callback replay with a used state is refused.
    const replay = await a.request(location(start));
    expect(location(replay)).toContain("oauth_error=attempt_invalid");

    const connectionId = /name="connectionId"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="connectionId"/.exec(html);
    const id = connectionId?.[1] ?? connectionId?.[2];
    expect(id).toBeTruthy();
    const idx = html.split("<form").slice(1).findIndex((f) => /Disconnect/.test(f.split("</form>")[0] ?? ""));
    expect(idx).toBeGreaterThan(-1);
    const out = await a.submitForm("/dashboard", { connectionId: id! }, idx);
    expect(location(out)).toMatch(/dashboard/);
    expect((await (await a.request("/api/connections")).json()).data).toEqual([]);
  });

  it("connects GA4 on the same Google account without losing Search Console, and lists its properties with time zones", async () => {
    const a = await signedIn(EMAIL_A);
    // Search Console first, then GA4 on the same (mock) account: grants merge instead of replacing each other.
    let html = await (await a.request("/dashboard")).text();
    const gscStart = await a.submitForm("/dashboard", { product: "gsc" }, html.split("<form").slice(1).findIndex((f) => /value="gsc"/.test(f.split("</form>")[0] ?? "")));
    expect(location(await a.request(location(gscStart)))).toContain("connected=gsc&synced=3");

    html = await (await a.request("/dashboard")).text();
    const ga4Start = await a.submitForm("/dashboard", { product: "ga4" }, html.split("<form").slice(1).findIndex((f) => /value="ga4"/.test(f.split("</form>")[0] ?? "")));
    const done = await a.request(location(ga4Start));
    expect(location(done)).toContain("connected=ga4&synced_ga4=4");

    const dash = await (await a.request("/dashboard?synced_ga4=4")).text();
    expect(dash).toContain("4 GA4 properties available");
    expect(dash).toContain("Example GA4");
    expect(dash).not.toContain("Example Roll-up"); // roll-up properties are not offered
    const conns = (await (await a.request("/api/connections")).json()).data as Array<{ properties: unknown[] }>;
    expect(conns).toHaveLength(1); // one Google account -> one connection, now holding both products
    expect(conns[0]!.properties.length).toBe(7); // 3 Search Console + 4 GA4
  });

  it("rejects a callback with a forged or foreign state", async () => {
    const a = await signedIn(EMAIL_A);
    const res = await a.request("/api/oauth/google/callback?state=forged&code=mock-code:x@y.test");
    expect(location(res)).toContain("oauth_error=attempt_invalid");
    const anon = await new Browser().request("/api/oauth/google/callback?state=x&code=y");
    expect(location(anon)).toContain("/login");
  });
});

describe("reports API (mock Google)", () => {
  const formIndexWith = (html: string, needle: string) => html.split("<form").slice(1).findIndex((f) => (f.split("</form>")[0] ?? "").includes(needle));

  async function connectedWith(email: string, product: "gsc" | "ga4" = "gsc") {
    const b = new Browser();
    await b.submitForm("/login", { email, password: PASSWORD });
    const html = await (await b.request("/dashboard")).text();
    const start = await b.submitForm("/dashboard", { product }, formIndexWith(html, `value="${product}"`));
    await b.request(location(start));
    return b;
  }
  const post = (b: Browser, provider: string, body: unknown, headers: Record<string, string> = {}) =>
    b.request(`/api/reports/${provider}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const gsc = { propertyId: "sc-domain:example.com", lastDays: 7, dimensions: ["query"], limit: 5 };

  it("requires a session", async () => {
    const res = await post(new Browser(), "gsc", gsc);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("AUTH_REQUIRED");
  });

  it("returns a normalized report, then serves the repeat from cache, uncacheable by browsers", async () => {
    const a = await connectedWith(EMAIL_A);
    const first = await post(a, "gsc", gsc);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toMatch(/no-store/);
    const body = await first.json();
    expect(body).toMatchObject({ provider: "gsc", mock: true, cache: { hit: false }, report: { period: { resolvedFrom: "lastDays", lastDays: 7, timeZone: "America/Los_Angeles" } } });
    expect(body.rows).toHaveLength(5);
    expect((await (await post(a, "gsc", gsc)).json()).cache.hit).toBe(true);
  });

  it("does not let one customer read another's property or cached report", async () => {
    const a = await connectedWith(EMAIL_A);
    await post(a, "gsc", gsc);
    const bob = new Browser();
    await bob.submitForm("/login", { email: EMAIL_B, password: PASSWORD });
    const res = await post(bob, "gsc", gsc);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("PROPERTY_NOT_CONNECTED");
  });

  it("returns useful errors with the right status for invalid requests", async () => {
    const a = await connectedWith(EMAIL_A);
    const cases: Array<[string, unknown, number, string]> = [
      ["unknown provider", gsc, 400, "INVALID_QUERY"],
      ["both date forms", { ...gsc, startDate: "2026-09-01", endDate: "2026-09-07" }, 400, "INVALID_QUERY"],
      ["no dates", { propertyId: gsc.propertyId, dimensions: ["query"] }, 400, "INVALID_QUERY"],
      ["unknown field", { ...gsc, userId: "someone-else" }, 400, "INVALID_QUERY"],
      ["malformed JSON", "{not json", 400, "INVALID_QUERY"],
    ];
    for (const [name, body, status, code] of cases) {
      const res = await post(a, name === "unknown provider" ? "bing" : "gsc", body);
      expect(res.status, name).toBe(status);
      expect((await res.json()).error.code, name).toBe(code);
    }
  });

  it("refuses non-JSON and cross-origin posts (CSRF) and oversized bodies", async () => {
    const a = await connectedWith(EMAIL_A);
    const form = await a.request("/api/reports/gsc", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect(form.status).toBe(400);
    const cross = await post(a, "gsc", gsc, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const big = await post(a, "gsc", JSON.stringify({ ...gsc, pad: "x".repeat(40_000) }));
    expect(big.status).toBe(400);
  });

  it("serves GA4 in the property's time zone", async () => {
    const a = await connectedWith(EMAIL_A, "ga4");
    const res = await post(a, "ga4", { propertyId: "123456789", lastDays: 7, dimensions: ["pagePath"], metrics: ["sessions"], limit: 3 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.report.period).toMatchObject({ resolvedFrom: "lastDays", timeZone: "America/New_York" });
    expect(body.rows).toHaveLength(3);
  });

  it("rejects incompatible GA4 fields with the incompatibility spelled out", async () => {
    const a = await connectedWith(EMAIL_A, "ga4");
    const res = await post(a, "ga4", { propertyId: "123456789", lastDays: 7, dimensions: ["pagePath"], metrics: ["bogusMetric"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("DIMENSION_METRIC_INCOMPATIBLE");
  });
});

describe("OAuth consent for AI clients (Supabase OAuth server stand-in)", () => {
  const CLIENT = "0f8fad5b-d9cb-469f-a165-70867728950e";
  const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
  const registerRequest = (email: string, over: Partial<{ redirectUri: string; clientName: string }> = {}) => {
    const id = `authz-${Math.random().toString(36).slice(2, 12)}`;
    fake.authorizations.set(id, { userId: fake.idFor(email)!, clientId: CLIENT, clientName: over.clientName ?? "Claude", redirectUri: over.redirectUri ?? CALLBACK, scope: "email", state: "st4te" });
    return id;
  };
  async function signedInAs(email: string) {
    const b = new Browser();
    await b.submitForm("/login", { email, password: PASSWORD });
    return b;
  }
  const page = async (b: Browser, id: string) => b.request(`/oauth/consent?authorization_id=${id}`);
  /** React separates adjacent text nodes with comment markers; strip them to assert on visible text. */
  const visible = async (r: Response) => (await r.text()).replace(/<!-- -->/g, "");

  it("sends a signed-out user to sign in and brings them back to the same request", async () => {
    const id = registerRequest(EMAIL_A);
    const res = await new Browser().request(`/oauth/consent?authorization_id=${id}`);
    expect(res.status).toBe(307);
    expect(decodeURIComponent(location(res))).toContain(`/login?next=/oauth/consent?authorization_id=${id}`);
  });

  it("shows who is asking, what they can read and where the user will be sent", async () => {
    const id = registerRequest(EMAIL_A);
    const html = await visible(await page(await signedInAs(EMAIL_A), id));
    expect(html).toContain("Connect Claude to your account?");
    expect(html).toContain("claude.ai");
    expect(html).toMatch(/Only ever read/);
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).not.toMatch(/password=|access_token/);
  });

  it("does not show another user's request, and rejects malformed ids", async () => {
    const id = registerRequest(EMAIL_A);
    const bob = await signedInAs(EMAIL_B);
    expect(await (await page(bob, id)).text()).toContain("no longer valid");
    expect(await (await page(bob, "x")).text()).toContain("missing or invalid");
    expect(await (await page(bob, "..%2F..%2Fetc")).text()).toContain("missing or invalid");
  });

  it("approving sends the browser back to the client and records the grant, which can then be removed", async () => {
    const id = registerRequest(EMAIL_A);
    const a = await signedInAs(EMAIL_A);
    const out = await a.submitForm(`/oauth/consent?authorization_id=${id}`, { authorizationId: id, decision: "approve" }, 1);
    expect(out.status).toBe(303);
    const back = new URL(location(out));
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get("code")).toBe("fake-code");
    expect(back.searchParams.get("state")).toBe("st4te");
    expect(fake.grants.map((g) => g.name)).toContain("Claude");

    const dash = await (await a.request("/dashboard")).text();
    expect(dash).toContain("Apps with access");
    expect(dash).toContain("Claude");
    const html = dash.split("<form").slice(1).findIndex((f) => /Remove access/.test(f.split("</form>")[0] ?? ""));
    expect(html).toBeGreaterThan(-1);
    await a.submitForm("/dashboard", { clientId: CLIENT }, html);
    expect(fake.grants).toHaveLength(0);
  });

  it("denying sends access_denied and records no grant", async () => {
    const before = fake.grants.length;
    const id = registerRequest(EMAIL_A);
    const out = await (await signedInAs(EMAIL_A)).submitForm(`/oauth/consent?authorization_id=${id}`, { authorizationId: id, decision: "deny" }, 1);
    const back = new URL(location(out));
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
    expect(fake.grants).toHaveLength(before);
  });

  it("a user cannot approve a request that belongs to someone else", async () => {
    const id = registerRequest(EMAIL_A);
    const bob = await signedInAs(EMAIL_B);
    // Bob's own valid page supplies a genuine form; he then tampers with the authorization id.
    const own = registerRequest(EMAIL_B);
    const out = await bob.submitForm(`/oauth/consent?authorization_id=${own}`, { authorizationId: id, decision: "approve" }, 1);
    expect(location(out)).toContain("notice=connect_failed");
    expect(fake.authorizations.get(id)!.decision).toBeUndefined();
  });

  it("shows the loopback warning for local redirect addresses", async () => {
    const id = registerRequest(EMAIL_A, { redirectUri: "http://localhost:3118/callback", clientName: "Claude Code" });
    const html = await (await page(await signedInAs(EMAIL_A), id)).text();
    expect(html).toContain("localhost:3118");
    expect(html).toContain("on your own computer");
  });

  it("escapes a malicious client name", async () => {
    const id = registerRequest(EMAIL_A, { clientName: "<img src=x onerror=alert(1)>" });
    const html = await (await page(await signedInAs(EMAIL_A), id)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe.runIf(POSTGRES)("web app on the real Postgres driver (PGlite over the wire protocol)", () => {
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pgDb!.query<T>(text, params)).rows;
  const formIdx = (html: string, re: RegExp) => html.split("<form").slice(1).findIndex((f) => re.test(f.split("</form>")[0] ?? ""));
  const post = (b: Browser, body: unknown) =>
    b.request("/api/reports/gsc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const report = { propertyId: "sc-domain:example.com", lastDays: 7, dimensions: ["query"], limit: 5 };

  async function signedIn(email: string) {
    const b = new Browser();
    await b.submitForm("/login", { email, password: PASSWORD });
    return b;
  }
  async function connect(b: Browser) {
    const html = await (await b.request("/dashboard")).text();
    const start = await b.submitForm("/dashboard", { product: "gsc" }, formIdx(html, /value="gsc"/));
    await b.request(location(start));
  }

  it("is really using Postgres: each sign-up produced a profile, and the demo user is absent", async () => {
    const users = await q<{ id: string }>("select id from auth.users");
    expect(users.length).toBeGreaterThanOrEqual(2);
    expect((await q("select 1 from public.profiles")).length).toBe(users.length);
    expect(await q("select 1 from public.provider_connections where user_id = '00000000-0000-4000-8000-000000000001'")).toHaveLength(0);
  });

  it("stores connections, properties and an encrypted secret for the owner only", async () => {
    const a = await signedIn(EMAIL_A);
    await connect(a);
    const [alice] = await q<{ id: string }>("select id from auth.users where email = $1", [EMAIL_A]);
    const [bob] = await q<{ id: string }>("select id from auth.users where email = $1", [EMAIL_B]);
    const conns = await q<{ id: string; user_id: string; status: string }>("select id, user_id, status from public.provider_connections");
    expect(conns.map((c) => c.user_id)).toEqual([alice!.id]);
    expect((await q("select 1 from public.properties where user_id = $1", [bob!.id]))).toHaveLength(0);
    expect((await q("select 1 from public.properties where user_id = $1", [alice!.id])).length).toBeGreaterThan(0);

    const secrets = await q<{ dump: string }>("select to_json(s)::text as dump from public.provider_secrets s");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.dump).not.toMatch(/mock-(access|refresh)-token/);
    // Nothing left over from the one-time connect attempt that could be replayed.
    expect(await q("select 1 from public.oauth_states where consumed_at is null and user_id = $1", [alice!.id])).toHaveLength(0);
  });

  it("caches reports per user in Postgres, shares nothing across users, and drops them on disconnect", async () => {
    const a = await signedIn(EMAIL_A);
    expect((await post(a, report)).status).toBe(200);
    expect((await (await post(a, report)).json()).cache.hit).toBe(true);
    const rows = await q<{ user_id: string }>("select user_id from public.report_cache");
    expect(new Set(rows.map((r) => r.user_id)).size).toBe(1);

    const bob = await signedIn(EMAIL_B);
    expect((await post(bob, report)).status).toBe(404); // not Bob's property, so Alice's cached report is unreachable
    expect(await q("select 1 from public.report_cache")).toHaveLength(rows.length);

    const html = await (await a.request("/dashboard")).text();
    const id = /name="connectionId"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="connectionId"/.exec(html);
    await a.submitForm("/dashboard", { connectionId: (id?.[1] ?? id?.[2])! }, formIdx(html, /Disconnect/));
    expect(await q("select 1 from public.report_cache")).toHaveLength(0);
    expect(await q("select 1 from public.provider_secrets")).toHaveLength(0);
    expect(await q("select 1 from public.provider_connections")).toHaveLength(0);
    expect((await post(a, report)).status).toBe(404);
  });
});

describe("browser bundle hygiene", () => {
  it("ships no server-secret names or credential storage details to the client", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]))));
      return nested.flat();
    };
    const files = (await walk(join(webDir, ".next/static"))).filter((f) => /\.(js|css|html|json)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const banned = /SECRET_KEYS|GOOGLE_CLIENT_SECRET|SUPABASE_DB_URL|SUPABASE_SERVICE_ROLE_KEY|wrappedDek|wrapped_dek|provider_secrets|code_verifier/;
    for (const f of files) expect(await readFile(f, "utf8"), f).not.toMatch(banned);
  });
});

describe("logging hygiene", () => {
  it("does not write passwords or tokens to the server log", () => {
    expect(serverLog).not.toContain(PASSWORD);
    expect(serverLog).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(serverLog).not.toMatch(/mock-access-token|mock-refresh-token|mock-code:|ya29\.|state=[A-Za-z0-9_-]{20,}/);
  });
});


// DATA SOURCE: MOCK. Clarity itself is the built-in synthetic adapter (DATA_MODE=mock), so these prove the dashboard,
// server actions, ownership checks and quota display, not Clarity's behaviour. See docs/CLARITY.md for the live test.
describe("Microsoft Clarity connection (mock Clarity)", () => {
  const TOKEN = "e2e.clarity-token-must-never-leak." + "z".repeat(24);
  const forms = (html: string) => html.split("<form").slice(1).map((f) => f.split("</form>")[0] ?? "");
  const indexOf = (html: string, needle: string) => forms(html).findIndex((f) => f.includes(needle));
  const idIn = (form: string, name: string) => new RegExp(`name="${name}"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*name="${name}"`).exec(form);
  const hidden = (form: string, name: string) => {
    const m = idIn(form, name);
    return (m?.[1] ?? m?.[2])!;
  };
  async function signedIn(email: string) {
    const b = new Browser();
    await b.submitForm("/login", { email, password: PASSWORD });
    return b;
  }
  async function act(b: Browser, needle: string, fields: Record<string, string> = {}, page = "/dashboard") {
    const html = await (await b.request(page)).text();
    const i = indexOf(html, needle);
    expect(i, `form with ${needle}`).toBeGreaterThan(-1);
    // Like a browser, send the form's own hidden inputs (ids) along with what the user typed.
    const own: Record<string, string> = {};
    for (const m of (forms(html)[i] ?? "").matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(m[0])?.[1];
      if (name && !name.startsWith("$ACTION")) own[name] = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
    }
    return b.submitForm(page, { ...own, ...fields }, i);
  }
  const text = async (b: Browser, path: string) => (await (await b.request(path)).text()).replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("saves a token without contacting Clarity, never shows or logs it, and shows only the evidence", async () => {
    const a = await signedIn(EMAIL_A);
    const res = await act(a, 'placeholder="Paste the token here"', { name: "E2E shop", token: TOKEN });
    expect(location(res)).toContain("clarity=saved");
    expect(location(res)).not.toContain(TOKEN);
    const raw = await (await a.request("/dashboard")).text();
    expect(raw).not.toContain(TOKEN);
    const page = await text(a, "/dashboard");
    expect(page).toContain("E2E shop");
    expect(page).toContain("Awaiting verification");
    expect(page).not.toMatch(/Connected\s+E2E shop/);
    expect(page).toContain("0 of 8"); // nothing spent by saving
    expect(serverLog).not.toContain(TOKEN);
  });

  it("rejects an obviously wrong token and keeps it out of the URL", async () => {
    const a = await signedIn(EMAIL_A);
    const res = await act(a, 'placeholder="Paste the token here"', { name: "Bad one", token: "short" });
    expect(location(res)).toContain("clarity_error=INVALID_QUERY");
    expect(decodeURIComponent(location(res))).not.toContain("short");
    expect(await text(a, location(res).replace(base, ""))).toContain("does not look like a Clarity API token");
  });

  it("verifies with one counted request, then page views are free and a new view is fetched on demand", async () => {
    const a = await signedIn(EMAIL_A);
    const verified = await act(a, "Verify token");
    // DATA_MODE=mock: demo data is not evidence about the token, so it is not reported as verified.
    expect(location(verified)).toContain("clarity=verified_mock");
    expect(await text(a, location(verified).replace(base, ""))).toContain("the token has not been verified");
    let page = await text(a, "/dashboard");
    expect(page).toContain("Awaiting verification");
    expect(page).toContain("1 of 8");

    // The verification fetched numOfDays=1 with no dimensions, so that view is already saved.
    const reports = await text(a, "/dashboard/clarity");
    expect(reports).toContain("Demo data: not from Clarity");
    expect(reports).toContain("Traffic");
    for (let i = 0; i < 3; i++) await a.request("/dashboard/clarity");
    expect(await text(a, "/dashboard")).toContain("1 of 8");

    // A view that was never fetched shows the cost first and does not call Clarity by itself.
    const osView = await text(a, "/dashboard/clarity?days=1&dims=OS");
    expect(osView).toContain("No saved result for these settings");
    expect(await text(a, "/dashboard")).toContain("1 of 8");

    const fetched = await act(a, "Fetch from Clarity", {}, "/dashboard/clarity?days=1&dims=OS");
    expect(location(fetched)).toContain("/dashboard/clarity?");
    const after = await text(a, location(fetched).replace(base, ""));
    expect(after).toContain("by OS");
    expect(after).toContain("Demo data: not from Clarity");
    expect(after).toContain("2 of 8");

    // Repeating the same fetch is served from the saved result: no extra request.
    const again = await act(a, "Refresh from Clarity", {}, "/dashboard/clarity?days=1&dims=OS");
    expect(location(again)).toContain("/dashboard/clarity?");
    page = await text(a, "/dashboard");
    expect(page).toContain("2 of 8");
  });

  it("another customer sees nothing of it and cannot verify, read or change it", async () => {
    const a = await signedIn(EMAIL_A);
    const b = await signedIn(EMAIL_B);
    const aliceHtml = await (await a.request("/dashboard")).text();
    expect(await text(b, "/dashboard")).not.toContain("E2E shop");
    expect(await text(b, "/dashboard/clarity")).toContain("No Clarity project is connected yet");

    const verifyForm = forms(aliceHtml)[indexOf(aliceHtml, "Verify token")]!;
    const propertyId = hidden(verifyForm, "propertyId");
    const tryAsBob = async (formHtml: string, fields: Record<string, string>) => {
      const body = new FormData();
      for (const m of formHtml.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
        const name = /name="([^"]+)"/.exec(m[0])?.[1];
        const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
        if (name?.startsWith("$ACTION")) body.append(name, value);
      }
      for (const [k, v] of Object.entries(fields)) body.set(k, v);
      return b.request("/dashboard", { method: "POST", body });
    };
    expect(location(await tryAsBob(verifyForm, { propertyId }))).toContain("clarity_error=PROPERTY_NOT_CONNECTED");

    const renameForm = forms(aliceHtml)[indexOf(aliceHtml, "New name")]!;
    const connectionId = hidden(renameForm, "connectionId");
    expect(location(await tryAsBob(renameForm, { connectionId, name: "Hijacked" }))).toContain("clarity_error=PROPERTY_NOT_CONNECTED");
    const disconnectForm = forms(aliceHtml)[indexOf(aliceHtml, "Yes, remove this connection")]!;
    await tryAsBob(disconnectForm, { connectionId });
    const view = await text(a, "/dashboard");
    expect(view).toContain("E2E shop");
    expect(view).not.toContain("Hijacked");

    // A foreign property id in the URL resolves to nothing for Bob, and never to Alice's saved result.
    expect(await text(b, `/dashboard/clarity?property=${propertyId}`)).not.toContain("Traffic");
  });

  it("renames, replaces the token (back to awaiting verification), and removes only after the confirm step", async () => {
    const a = await signedIn(EMAIL_A);
    const renamed = await act(a, "New name", { name: "Renamed shop" });
    expect(location(renamed)).toContain("clarity=renamed");
    expect(await text(a, "/dashboard")).toContain("Renamed shop");

    const replaced = await act(a, "New API token", { token: TOKEN + "-rotated" });
    expect(location(replaced)).toContain("clarity=reconnected");
    expect(await text(a, "/dashboard")).toContain("Awaiting verification");
    expect(await (await a.request("/dashboard")).text()).not.toContain("rotated");

    const html = await (await a.request("/dashboard")).text();
    expect(html).toContain("Yes, remove this connection"); // the confirmation step exists before anything is deleted
    const removed = await act(a, "Yes, remove this connection");
    expect(location(removed)).toContain("clarity=removed");
    const page = await text(a, location(removed).replace(base, ""));
    expect(page).not.toContain("Renamed shop");
    expect(page).toContain("Connection removed");
    expect(await text(a, "/dashboard/clarity")).toContain("No Clarity project is connected yet");
  });
});


// DATA SOURCE: MOCK. Bing is the built-in synthetic adapter (DATA_MODE=mock), so these prove the dashboard, server actions,
// callback handling and ownership checks, not Bing's behaviour. See docs/BING.md for the live checklist.
describe("Bing Webmaster connection (mock Bing)", () => {
  const KEY = "e2ebingkeymustneverleak" + "k".repeat(16);
  const forms = (html: string) => html.split("<form").slice(1).map((f) => f.split("</form>")[0] ?? "");
  const indexOf = (html: string, needle: string) => forms(html).findIndex((f) => f.includes(needle));
  async function signedIn(email: string) {
    const b = new Browser();
    await b.submitForm("/login", { email, password: PASSWORD });
    return b;
  }
  async function act(b: Browser, needle: string, fields: Record<string, string> = {}, page = "/dashboard") {
    const html = await (await b.request(page)).text();
    const i = indexOf(html, needle);
    expect(i, `form with ${needle}`).toBeGreaterThan(-1);
    const own: Record<string, string> = {};
    for (const m of (forms(html)[i] ?? "").matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(m[0])?.[1];
      if (name && !name.startsWith("$ACTION")) own[name] = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
    }
    return b.submitForm(page, { ...own, ...fields }, i);
  }
  const text = async (b: Browser, path: string) => (await (await b.request(path)).text()).replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("rejects a malformed key without echoing it, then saves a good one without ever showing or logging it", async () => {
    const a = await signedIn(EMAIL_A);
    const bad = await act(a, 'placeholder="Paste the key here"', { name: "Bad", apiKey: "bad key!" });
    expect(location(bad)).toContain("bing_error=INVALID_QUERY");
    expect(decodeURIComponent(location(bad))).not.toContain("bad key");

    const res = await act(a, 'placeholder="Paste the key here"', { name: "E2E Bing", apiKey: KEY });
    expect(location(res)).toContain("bing");
    expect(location(res)).not.toContain(KEY);
    expect(await (await a.request("/dashboard")).text()).not.toContain(KEY);
    const page = await text(a, "/dashboard");
    expect(page).toContain("E2E Bing");
    expect(page).toMatch(/API key/);
    expect(serverLog).not.toContain(KEY);
  });

  it("OAuth: the callback needs a valid, unused state; a forged or replayed one is rejected", async () => {
    const a = await signedIn(EMAIL_A);
    const forged = await a.request("/api/oauth/bing/callback?state=forged&code=mock-bing-code:x");
    expect(forged.headers.get("location") ?? "").toContain("bing_error=AUTH_REQUIRED");
    const denied = await a.request("/api/oauth/bing/callback?error=access_denied&state=forged");
    expect(denied.headers.get("location") ?? "").toContain("bing_error=AUTH_REQUIRED");
    const anon = await new Browser().request("/api/oauth/bing/callback?state=x&code=y");
    expect(anon.headers.get("location") ?? "").toContain("/login");
  });

  it("Connect with Bing completes (mock consent) and a second customer sees none of it", async () => {
    const a = await signedIn(EMAIL_A);
    const started = await act(a, "Connect another Bing account");
    expect(location(started)).toContain("/api/oauth/bing/callback");
    const done = await a.request(location(started).replace(base, ""));
    expect(done.headers.get("location") ?? "").toMatch(/bing/);
    const b = await signedIn(EMAIL_B);
    const other = await text(b, "/dashboard");
    expect(other).not.toContain("E2E Bing");
    expect(await text(b, "/dashboard/bing")).not.toContain("E2E Bing");
  });
});
