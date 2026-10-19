import { GOOGLE_SCOPES, HttpGoogleOAuthClient, GoogleOAuthError, buildGoogleAuthUrl, connectScope, createPkcePair, type GoogleProductKey } from "./index.js";

/** The one path Google redirects back to. Mirrors apps/web/src/app/api/oauth/google/[action]/route.ts. */
export const GOOGLE_CALLBACK_PATH = "/api/oauth/google/callback";

export type CheckLevel = "ok" | "warn" | "fail";
export interface Check {
  level: CheckLevel;
  name: string;
  detail: string;
}

export interface GoogleConfigEnv {
  NODE_ENV?: string | undefined;
  DATA_MODE?: string | undefined;
  DB_MODE?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_REDIRECT_URI?: string | undefined;
  NEXT_PUBLIC_APP_URL?: string | undefined;
  SECRET_KEYS?: string | undefined;
}

/** What the application will send to Google as `redirect_uri` (same rule as apps/web/src/lib/server.ts). */
export function effectiveRedirectUri(env: Pick<GoogleConfigEnv, "GOOGLE_REDIRECT_URI" | "NEXT_PUBLIC_APP_URL">): string {
  return env.GOOGLE_REDIRECT_URI ?? `${(env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")}${GOOGLE_CALLBACK_PATH}`;
}

const CLIENT_ID = /^\d{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Offline checks on the configuration. Never returns or logs the client secret. */
export function checkGoogleConfig(env: GoogleConfigEnv): Check[] {
  const out: Check[] = [];
  const add = (level: CheckLevel, name: string, detail: string) => out.push({ level, name, detail });
  const production = env.NODE_ENV === "production";

  if (env.DATA_MODE === "live") add("ok", "DATA_MODE", "live: the app will use real Google.");
  else add("warn", "DATA_MODE", `${env.DATA_MODE ?? "mock"}: the app still uses the mock Google. Set DATA_MODE=live to test the real flow.`);

  if (!env.GOOGLE_CLIENT_ID) add("fail", "GOOGLE_CLIENT_ID", "Not set.");
  else if (CLIENT_ID.test(env.GOOGLE_CLIENT_ID)) add("ok", "GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID);
  else add("warn", "GOOGLE_CLIENT_ID", "Does not look like <number>-<id>.apps.googleusercontent.com. Copy the Client ID from the Clients page.");

  if (!env.GOOGLE_CLIENT_SECRET) add("fail", "GOOGLE_CLIENT_SECRET", "Not set.");
  else if (/^\s|\s$|["']/.test(env.GOOGLE_CLIENT_SECRET)) add("fail", "GOOGLE_CLIENT_SECRET", "Contains whitespace or quotes: re-enter it without them.");
  else if (env.GOOGLE_CLIENT_SECRET.length < 20) add("warn", "GOOGLE_CLIENT_SECRET", "Shorter than a Google client secret normally is.");
  else add("ok", "GOOGLE_CLIENT_SECRET", "Set (value not shown).");

  const redirect = effectiveRedirectUri(env);
  add("ok", "Redirect URI to register in Google", redirect);
  try {
    const u = new URL(redirect);
    const loopback = LOOPBACK.has(u.hostname);
    if (u.pathname !== GOOGLE_CALLBACK_PATH) add("fail", "Redirect path", `Must be exactly ${GOOGLE_CALLBACK_PATH}; the application only handles that route.`);
    if (u.search || u.hash) add("fail", "Redirect URI", "Must not contain a query string or fragment.");
    if (u.protocol !== "https:" && !(loopback && u.protocol === "http:")) add("fail", "Redirect scheme", "Google requires https (http is allowed only for localhost).");
    if (!loopback && /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) add("fail", "Redirect host", "Google does not allow raw IP addresses (except localhost).");
    if (u.username || u.password) add("fail", "Redirect URI", "Must not contain credentials.");
    if (production && loopback) add("fail", "Redirect host", "A localhost redirect cannot be used in production.");
    if (env.GOOGLE_REDIRECT_URI && env.NEXT_PUBLIC_APP_URL && new URL(env.NEXT_PUBLIC_APP_URL).origin !== u.origin) {
      add("warn", "Redirect origin", "GOOGLE_REDIRECT_URI is on a different origin than NEXT_PUBLIC_APP_URL. The session cookie is set on the app origin, so the callback will not see the signed-in user.");
    }
  } catch {
    add("fail", "Redirect URI", "Not a valid URL.");
  }

  if (!env.SECRET_KEYS) add(production || env.DATA_MODE === "live" ? "fail" : "warn", "SECRET_KEYS", "Not set. Connected-account tokens cannot be stored durably without it.");
  else add("ok", "SECRET_KEYS", "Set (value not shown).");
  if (env.DATA_MODE === "live" && env.DB_MODE !== "postgres") add("fail", "DB_MODE", "DATA_MODE=live requires DB_MODE=postgres.");

  for (const p of Object.keys(GOOGLE_SCOPES) as GoogleProductKey[]) add("ok", `Scopes requested for ${p}`, connectScope(p));
  return out;
}

export function formatChecks(checks: Check[]): string {
  const mark = { ok: "PASS", warn: "WARN", fail: "FAIL" } as const;
  return checks.map((c) => `${mark[c.level]}  ${c.name}: ${c.detail}`).join("\n");
}

/** Decodes the `authError` Google puts on its error page. It is a short protobuf-like blob containing the OAuth error word. */
export function describeGoogleAuthError(authError: string): string {
  try {
    const text = Buffer.from(authError, "base64url").toString("latin1");
    const word = /(invalid_client|redirect_uri_mismatch|invalid_request|invalid_scope|access_denied|org_internal|disallowed_useragent|deleted_client)/.exec(text);
    const message = /[A-Z][A-Za-z0-9 ,.'_:/-]{12,}/.exec(text.slice(text.indexOf("\x12") + 2));
    return [word?.[1], message?.[0]].filter(Boolean).join(": ") || "unrecognised error";
  } catch {
    return "unrecognised error";
  }
}

/** Plain-language next step for the most common failure: the redirect URI is not registered on the client. */
export function redirectHint(reason: string, redirectUri: string): string {
  if (!reason.includes("redirect_uri_mismatch")) return "";
  return (
    `\n      Fix: Google Cloud console -> Google Auth Platform -> Clients -> open this client -> under "Authorized redirect URIs" (NOT "Authorized JavaScript origins") ` +
    `add exactly ${redirectUri} with no spaces and no trailing slash, then click SAVE at the bottom of the page. Changes can take a few minutes to apply. ` +
    `Also confirm you opened the client whose Client ID matches GOOGLE_CLIENT_ID.`
  );
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  /** Also send the secret to Google's token endpoint with a deliberately invalid code. */
  checkSecret?: boolean;
  tokenEndpoint?: string;
  authEndpoint?: string;
}

/**
 * Live pre-checks against Google, without a user. (1) Asks Google's authorization endpoint whether the client id
 * exists and the redirect URI is registered. This relies on Google's observed behaviour of redirecting to a
 * /signin/oauth/error page, which is not a documented contract, so treat it as a convenience, not a guarantee.
 * (2) Optionally verifies the secret: a valid client with a bogus code answers `invalid_grant`; a wrong secret
 * answers `invalid_client`. The real proof is always a full sign-in through the dashboard.
 */
export async function probeGoogle(env: GoogleConfigEnv, options: ProbeOptions = {}): Promise<Check[]> {
  const out: Check[] = [];
  const f = options.fetchImpl ?? fetch;
  if (!env.GOOGLE_CLIENT_ID) return [{ level: "fail", name: "Probe", detail: "GOOGLE_CLIENT_ID is not set." }];
  const redirectUri = effectiveRedirectUri(env);
  const { challenge } = createPkcePair();
  for (const product of ["gsc", "ga4"] as const) {
    const url = buildGoogleAuthUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, scope: connectScope(product), state: "probe", codeChallenge: challenge });
    try {
      const res = await f(options.authEndpoint ? url.replace("https://accounts.google.com/o/oauth2/v2/auth", options.authEndpoint) : url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const location = res.headers.get("location") ?? "";
      if (location.includes("/signin/oauth/error")) {
        const authError = new URL(location, "https://accounts.google.com").searchParams.get("authError") ?? "";
        const reason = describeGoogleAuthError(authError);
        out.push({ level: "fail", name: `Google accepts the ${product} authorization request`, detail: reason + redirectHint(reason, redirectUri) });
      } else if (res.status >= 300 && res.status < 400) {
        out.push({ level: "ok", name: `Google accepts the ${product} authorization request`, detail: "Client id and redirect URI were accepted (Google went on to the sign-in step)." });
      } else if (res.status === 400) {
        out.push({ level: "fail", name: `Google accepts the ${product} authorization request`, detail: "Google answered 400. Open the authorization URL in a browser to read Google's error." });
      } else {
        out.push({ level: "warn", name: `Google accepts the ${product} authorization request`, detail: `Unexpected HTTP ${res.status}; check by signing in through the dashboard.` });
      }
    } catch {
      out.push({ level: "warn", name: "Probe", detail: "Could not reach Google (network or timeout)." });
      return out;
    }
  }
  if (options.checkSecret && env.GOOGLE_CLIENT_SECRET) {
    const client = new HttpGoogleOAuthClient({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      ...(options.tokenEndpoint && { tokenEndpoint: options.tokenEndpoint }),
    });
    try {
      await client.exchangeCode({ code: "4/0-probe-not-a-real-code", codeVerifier: "probe-verifier-probe-verifier-probe-verifier-1234", redirectUri });
      out.push({ level: "warn", name: "Client secret", detail: "Google accepted a probe code, which should be impossible. Do not rely on this check." });
    } catch (err) {
      const kind = err instanceof GoogleOAuthError ? err.kind : "unknown";
      if (kind === "invalid_grant") out.push({ level: "ok", name: "Client secret", detail: "Google recognised the client id and secret (it rejected only the fake code)." });
      else if (kind === "invalid_client") out.push({ level: "fail", name: "Client secret", detail: "Google rejected the client id or secret. Re-copy them, or add a new secret on the client's page." });
      else out.push({ level: "warn", name: "Client secret", detail: `Inconclusive (${kind}).` });
    }
  }
  return out;
}
