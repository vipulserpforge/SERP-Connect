import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, freePort, location, setBase } from "./browser.js";
import { FakeGoTrue } from "./fake-gotrue.js";

// The built web app in DATA_MODE=live with a PLACEHOLDER Google client. This checks the real (non-mock) OAuth
// wiring up to the moment the browser would leave for accounts.google.com: it does not call Google, and it cannot
// show that a real client is accepted. For that, use `pnpm google:check --probe` and a real sign-in.

const webDir = fileURLToPath(new URL("../../apps/web", import.meta.url));
const fake = new FakeGoTrue();
const CLIENT_ID = "123456789012-placeholderplaceholder.apps.googleusercontent.com";
const CLIENT_SECRET = ["GOC", "SPX-placeholder-secret-never-real-0000"].join("");
const PASSWORD = "correct-horse-battery";

interface App {
  base: string;
  log: () => string;
  stop: () => void;
}
const apps: App[] = [];

async function startApp(extra: Record<string, string>): Promise<App> {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  let log = "";
  const child: ChildProcess = spawn("node_modules/.bin/next", ["start", "-p", String(port)], {
    cwd: webDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      AUTH_MODE: "supabase",
      DB_MODE: "mock",
      DATA_MODE: "live",
      ALLOW_MOCK_IN_PRODUCTION: "true",
      SECRET_KEYS: `e2e:${randomBytes(32).toString("base64")}`,
      NEXT_PUBLIC_APP_URL: base,
      NEXT_PUBLIC_SUPABASE_URL: fake.url,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-publishable-key",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      ...extra,
    },
  });
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        const app = { base, log: () => log, stop: () => child.kill("SIGTERM") };
        apps.push(app);
        return app;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error(`Next did not start:\n${log}`);
}

async function signedIn(app: App, email: string) {
  setBase(app.base);
  const b = new Browser();
  await b.submitForm("/signup", { email, password: PASSWORD });
  fake.confirm(email);
  await b.submitForm("/login", { email, password: PASSWORD });
  return b;
}
const formWith = (html: string, needle: string) => html.split("<form").slice(1).findIndex((f) => (f.split("</form>")[0] ?? "").includes(needle));

beforeAll(async () => {
  await fake.start();
}, 30_000);
afterAll(async () => {
  for (const a of apps) a.stop();
  await fake.stop();
});

describe("live Google wiring with a placeholder client", () => {
  it("sends the browser to Google with exactly the redirect URI, scope and PKCE parameters the guide tells you to register", async () => {
    const app = await startApp({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
    const b = await signedIn(app, "live@saas.test");
    const html = await (await b.request("/dashboard")).text();
    expect(html).not.toContain("Available after Google Cloud setup");

    for (const [product, scope] of [
      ["gsc", "openid email https://www.googleapis.com/auth/webmasters.readonly"],
      ["ga4", "openid email https://www.googleapis.com/auth/analytics.readonly"],
    ] as const) {
      const page = await (await b.request("/dashboard")).text();
      const res = await b.submitForm("/dashboard", { product }, formWith(page, `value="${product}"`));
      const target = new URL(location(res));
      expect(`${target.origin}${target.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      const q = target.searchParams;
      expect(q.get("client_id")).toBe(CLIENT_ID);
      expect(q.get("redirect_uri")).toBe(`${app.base}/api/oauth/google/callback`);
      expect(q.get("scope")).toBe(scope);
      expect(q.get("response_type")).toBe("code");
      expect(q.get("code_challenge_method")).toBe("S256");
      expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(q.get("access_type")).toBe("offline");
      expect(q.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location(res)).not.toContain(CLIENT_SECRET);
    }
  });

  it("an explicit GOOGLE_REDIRECT_URI wins over the app URL", async () => {
    const app = await startApp({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
    const custom = `${app.base}/api/oauth/google/callback`;
    const app2 = await startApp({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_REDIRECT_URI: custom });
    const b = await signedIn(app2, "live2@saas.test");
    const page = await (await b.request("/dashboard")).text();
    const res = await b.submitForm("/dashboard", { product: "gsc" }, formWith(page, 'value="gsc"'));
    expect(new URL(location(res)).searchParams.get("redirect_uri")).toBe(custom);
  });

  it("a Google denial or a forged state ends safely on the dashboard with nothing connected", async () => {
    const app = await startApp({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
    const b = await signedIn(app, "live3@saas.test");
    const page = await (await b.request("/dashboard")).text();
    const start = await b.submitForm("/dashboard", { product: "gsc" }, formWith(page, 'value="gsc"'));
    const state = new URL(location(start)).searchParams.get("state")!;

    const denied = await b.request(`/api/oauth/google/callback?error=access_denied&state=${state}`);
    expect(location(denied)).toMatch(/oauth_error=/);
    const forged = await b.request("/api/oauth/google/callback?code=4/0abc&state=forged");
    expect(location(forged)).toContain("oauth_error=attempt_invalid");
    expect(((await (await b.request("/api/connections")).json()).data as unknown[]).length).toBe(0);
  });

  it("never exposes the client secret in pages, redirects or logs", async () => {
    const app = await startApp({ GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET });
    const b = await signedIn(app, "live4@saas.test");
    const page = await (await b.request("/dashboard")).text();
    await b.submitForm("/dashboard", { product: "gsc" }, formWith(page, 'value="gsc"'));
    const html = await (await b.request("/dashboard")).text();
    expect(html).not.toContain(CLIENT_SECRET);
    expect(app.log()).not.toContain(CLIENT_SECRET);
  });

  it("without a configured client, Connect stays disabled and the action fails closed", async () => {
    const app = await startApp({});
    const b = await signedIn(app, "live5@saas.test");
    const html = await (await b.request("/dashboard")).text();
    expect(html).toContain("Available after Google Cloud setup");
    const res = await b.submitForm("/dashboard", { product: "gsc" }, 0).catch(() => null);
    if (res) expect(location(res)).not.toContain("accounts.google.com");
  });
});
