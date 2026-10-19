/**
 * Checks a deployed MCP server and its authorization server against the requirements that decide whether Claude can
 * connect: the MCP authorization spec plus the places where Claude's OAuth client is stricter
 * (https://claude.com/docs/connectors/building/authentication). It only performs unauthenticated GET/POST requests.
 */
export interface Check {
  id: string;
  /** `fail` blocks a connection; `warn` is a risk or a deviation worth knowing about. */
  level: "pass" | "fail" | "warn";
  detail: string;
}

type Fetcher = typeof fetch;

const isLoopback = (u: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
const secure = (u: URL) => u.protocol === "https:" || isLoopback(u);

async function getJson(fetcher: Fetcher, url: string): Promise<{ status: number; json?: Record<string, unknown>; text?: string }> {
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { status: res.status, text: (await res.text()).slice(0, 300) };
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  } catch {
    return { status: 0 };
  }
}

/** RFC 8414 / OIDC discovery URLs for an issuer, in the priority order the MCP spec gives. */
export function discoveryUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  return path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
}

export async function checkAuthorizationServer(issuer: string, options: { fetcher?: Fetcher; scopes?: string[] } = {}): Promise<Check[]> {
  const fetcher = options.fetcher ?? fetch;
  const checks: Check[] = [];
  const add = (id: string, level: Check["level"], detail: string) => checks.push({ id, level, detail });

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    return [{ id: "as.issuer", level: "fail", detail: `"${issuer}" is not a URL.` }];
  }
  if (!secure(issuerUrl)) add("as.https", "fail", "The authorization server issuer must use https.");

  let meta: Record<string, unknown> | undefined;
  const tried: string[] = [];
  let disabled = false;
  for (const url of discoveryUrls(issuer)) {
    const r = await getJson(fetcher, url);
    tried.push(`${url} -> ${r.status || "unreachable"}`);
    if (/oauth server is disabled|feature_disabled/i.test(r.text ?? "")) disabled = true;
    if (r.json) {
      meta = r.json;
      add("as.metadata", "pass", `Authorization server metadata found at ${url}.`);
      if (disabled) add("as.enabled", "fail", "The RFC 8414 endpoint reports the OAuth server is disabled (Supabase: Authentication > OAuth Server). The OpenID document that is served is not enough: it advertises no client registration.");
      break;
    }
  }
  if (!meta) {
    add("as.metadata", "fail", `No authorization server metadata (RFC 8414 or OpenID Connect discovery). Tried: ${tried.join("; ")}. For Supabase, enable Authentication > OAuth Server.`);
    return checks;
  }

  if (meta.issuer !== issuer) add("as.issuer", "fail", `Metadata issuer "${String(meta.issuer)}" differs from the configured issuer "${issuer}" (compared exactly).`);
  else add("as.issuer", "pass", "Metadata issuer matches exactly.");

  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    const v = meta[key];
    if (typeof v !== "string") add(`as.${key}`, "fail", `${key} is missing.`);
    else if (!secure(new URL(v))) add(`as.${key}`, "fail", `${key} must use https.`);
  }

  const methods = (meta.code_challenge_methods_supported as string[] | undefined) ?? [];
  if (!methods.includes("S256")) add("as.pkce", "fail", 'code_challenge_methods_supported must include "S256" (Claude always sends S256 and spec-compliant clients check for it).');
  else if (methods.includes("plain")) add("as.pkce", "warn", 'S256 is supported, but "plain" is also advertised; "plain" PKCE offers no protection against code interception.');
  else add("as.pkce", "pass", "PKCE S256 advertised.");

  const authMethods = (meta.token_endpoint_auth_methods_supported as string[] | undefined) ?? [];
  const cimd = meta.client_id_metadata_document_supported === true && authMethods.includes("none");
  const dcr = typeof meta.registration_endpoint === "string";
  if (dcr) add("as.registration", "pass", "Dynamic Client Registration endpoint advertised (Claude falls back to it when CIMD is not advertised).");
  else if (cimd) add("as.registration", "pass", "Client ID Metadata Documents advertised.");
  else add("as.registration", "fail", "Neither Dynamic Client Registration (registration_endpoint) nor Client ID Metadata Documents (client_id_metadata_document_supported plus token_endpoint_auth_methods_supported including none) is advertised. Claude cannot identify itself; use Anthropic-held credentials or custom client credentials instead.");
  if (dcr) add("as.dcr_open", "warn", "Dynamic registration lets any client register; rely on a clear consent screen, redirect-URI validation and monitoring.");

  if (!authMethods.includes("none")) add("as.public_client", "warn", 'token_endpoint_auth_methods_supported does not include "none"; Claude registers as a public client.');
  const grants = (meta.grant_types_supported as string[] | undefined) ?? ["authorization_code"];
  if (!grants.includes("authorization_code")) add("as.grants", "fail", "authorization_code grant not supported.");
  else if (!grants.includes("refresh_token")) add("as.grants", "warn", "refresh_token grant not advertised: users would have to sign in again whenever the access token expires.");
  else add("as.grants", "pass", "authorization_code and refresh_token grants advertised.");

  if (meta.authorization_response_iss_parameter_supported !== true) add("as.iss", "warn", "authorization_response_iss_parameter_supported is not true (RFC 9207 mix-up protection).");

  const supported = (meta.scopes_supported as string[] | undefined) ?? [];
  const wanted = options.scopes ?? [];
  const unknown = wanted.filter((s) => supported.length > 0 && !supported.includes(s));
  if (unknown.length > 0) add("as.scopes", "fail", `The MCP server asks clients for scope(s) the authorization server does not list: ${unknown.join(", ")}. Claude would request them and sign-in would fail.`);

  if (typeof meta.jwks_uri === "string") {
    const jwks = await getJson(fetcher, meta.jwks_uri);
    const keys = (jwks.json?.keys as Array<{ alg?: string; kty?: string }> | undefined) ?? [];
    if (keys.length === 0) add("as.jwks", "fail", `The signing keys at ${meta.jwks_uri} could not be fetched (status ${jwks.status || "unreachable"}).`);
    else if (keys.some((k) => k.kty === "oct")) add("as.jwks", "fail", "The key set contains symmetric keys.");
    else add("as.jwks", "pass", `${keys.length} asymmetric signing key(s) published (${keys.map((k) => k.alg ?? k.kty).join(", ")}).`);
  }
  return checks;
}

export async function checkMcpOAuthReadiness(mcpUrl: string, options: { fetcher?: Fetcher } = {}): Promise<Check[]> {
  const fetcher = options.fetcher ?? fetch;
  const checks: Check[] = [];
  const add = (id: string, level: Check["level"], detail: string) => checks.push({ id, level, detail });

  const url = new URL(mcpUrl);
  if (!secure(url)) add("mcp.https", "fail", "The MCP URL must be https (Claude cannot reach a private or plain-http server).");

  let res: Response;
  try {
    res = await fetcher(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    add("mcp.reachable", "fail", `${mcpUrl} is unreachable.`);
    return checks;
  }

  if (res.status !== 401) {
    add("mcp.401", "fail", `An unauthenticated request returned ${res.status}, not 401. Claude only starts sign-in from a 401 and ignores WWW-Authenticate on other statuses.`);
    return checks;
  }
  add("mcp.401", "pass", "Unauthenticated requests get 401.");

  const header = res.headers.get("www-authenticate") ?? "";
  const pointer = /resource_metadata="([^"]+)"/.exec(header)?.[1];
  const scope = /scope="([^"]+)"/.exec(header)?.[1];
  if (!/^Bearer\b/i.test(header)) add("mcp.challenge", "fail", "The 401 has no `WWW-Authenticate: Bearer` header.");
  else if (!pointer) add("mcp.challenge", "warn", "The 401 has no resource_metadata pointer; Claude then probes /.well-known paths, which only works if the platform serves them.");
  else add("mcp.challenge", "pass", "401 carries a Bearer challenge with resource_metadata.");

  const candidates = [
    ...(pointer ? [pointer] : []),
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/+$/, "")}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
  let prm: Record<string, unknown> | undefined;
  for (const c of candidates) {
    const r = await getJson(fetcher, c);
    if (r.json) {
      prm = r.json;
      add("prm.found", "pass", `Protected resource metadata served at ${c}.`);
      break;
    }
  }
  if (!prm) {
    add("prm.found", "fail", "No protected resource metadata (RFC 9728) could be fetched.");
    return checks;
  }
  if (prm.resource !== mcpUrl) add("prm.resource", "fail", `Metadata \`resource\` is "${String(prm.resource)}" but must equal the MCP URL "${mcpUrl}" exactly, as entered in Claude.`);
  else add("prm.resource", "pass", "`resource` equals the MCP URL.");

  const servers = (prm.authorization_servers as string[] | undefined) ?? [];
  if (servers.length === 0) {
    add("prm.authorization_servers", "fail", "authorization_servers is empty.");
    return checks;
  }
  if (servers.length > 1) add("prm.authorization_servers", "warn", "Claude uses only the first authorization server and does not fall back to later ones.");

  const advertisedScopes = [...(scope ? scope.split(" ") : []), ...((prm.scopes_supported as string[] | undefined) ?? [])];
  checks.push(...(await checkAuthorizationServer(servers[0] as string, { fetcher, scopes: advertisedScopes })));

  // DNS-rebinding protection (MCP transport requirement).
  try {
    const evil = await fetcher(mcpUrl, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.invalid" }, body: "{}", redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (evil.status === 403) add("mcp.origin", "pass", "A foreign Origin header is refused with 403.");
    else add("mcp.origin", "fail", `A foreign Origin header got ${evil.status}; servers must answer 403 (DNS rebinding protection).`);
  } catch {
    add("mcp.origin", "warn", "Origin check could not be performed.");
  }
  return checks;
}

export function formatChecks(checks: Check[]): string {
  const mark = { pass: "PASS", warn: "WARN", fail: "FAIL" } as const;
  return checks.map((c) => `${mark[c.level]}  ${c.id}: ${c.detail}`).join("\n");
}
