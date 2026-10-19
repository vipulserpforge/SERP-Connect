"use server";

import { redirect } from "next/navigation";
import { isConnectorException } from "@serp/contracts";
import { credentialsSchema, mapSignInError, mapSignUpError, safeNextPath } from "@serp/auth";
import { createLogger } from "@serp/observability";
import { GOOGLE_SCOPES } from "@serp/provider-google";
import { getEnv } from "@/lib/env";
import { getRepository, getServices, requireUser } from "@/lib/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const logger = createLogger({ bindings: { service: "web", area: "auth" } });

function fail(page: "login" | "signup", code: string, next?: string): never {
  redirect(`/${page}?error=${code}${next ? `&next=${encodeURIComponent(next)}` : ""}`);
}

function authEnabled() {
  return getEnv().AUTH_MODE === "supabase";
}

export async function signUpAction(formData: FormData): Promise<void> {
  if (!authEnabled()) redirect("/dashboard");
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) fail("signup", "invalid_input");

  const supabase = await createSupabaseServerClient();
  // Fixed, configured origin (must also be allowlisted in Supabase): never derived from request headers.
  const origin = getEnv().NEXT_PUBLIC_APP_URL;
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) {
    logger.warn("signup.failed", { authErrorCode: error.code, httpStatus: error.status });
    fail("signup", mapSignUpError(error.code));
  }
  // With email confirmation enabled no session exists yet. Same response for new and existing
  // emails, so the form cannot be used to discover registered addresses.
  redirect(data?.session ? "/dashboard" : "/login?notice=check_email");
}

export async function signInAction(formData: FormData): Promise<void> {
  if (!authEnabled()) redirect("/dashboard");
  const next = safeNextPath(formData.get("next"));
  const parsed = credentialsSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) fail("login", "invalid_credentials", next);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    logger.warn("signin.failed", { authErrorCode: error.code, httpStatus: error.status });
    fail("login", mapSignInError(error.code), next);
  }
  redirect(next);
}

/** "Continue with Google": sign-in identity only (email + profile). Separate from connecting Search Console/GA4. */
export async function signInWithGoogleAction(): Promise<void> {
  if (!authEnabled()) redirect("/dashboard");
  const supabase = await createSupabaseServerClient();
  // Fixed, configured origin (must also be allowlisted in Supabase): never derived from request headers.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${getEnv().NEXT_PUBLIC_APP_URL}/auth/callback`, skipBrowserRedirect: true },
  });
  if (error || !data?.url) {
    logger.warn("signin.google_failed", { authErrorCode: error?.code, httpStatus: error?.status });
    fail("login", "callback_failed");
  }
  redirect(data.url);
}

export async function signOutAction(): Promise<void> {
  if (authEnabled()) {
    const supabase = await createSupabaseServerClient();
    // Global scope revokes the refresh token on every device, not just this browser.
    await supabase.auth.signOut({ scope: "global" });
  }
  redirect("/login?notice=signed_out");
}

/** Toggles the MCP allowlist for a property. The repository only updates rows owned by the session user. */
export async function togglePropertyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const propertyId = String(formData.get("propertyId") ?? "");
  const enabled = formData.get("enabled") === "true";
  const ok = await getRepository().setPropertyEnabled(user.userId, propertyId, enabled);
  if (ok) await getRepository().recordAudit({ userId: user.userId, eventType: enabled ? "property.enabled" : "property.disabled" });
  redirect("/dashboard");
}

/**
 * Revokes the grant at Google (best effort), destroys the stored credentials, then removes the
 * connection, its properties and cached reports. Owner-scoped inside the service.
 */
export async function disconnectConnectionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const connectionId = String(formData.get("connectionId") ?? "");
  const { credentials, reports, repo } = getServices();
  const provider = (await repo.getConnection(user.userId, connectionId))?.provider;
  const result = await credentials.disconnect(user.userId, connectionId);
  // Saved reports for a removed connection must stop being served right away.
  if (result.disconnected) await reports.invalidateConnection(user.userId, connectionId);
  // Clarity tokens cannot be revoked from here: the stored copy is destroyed, and the owner can replace it in Clarity.
  if (result.disconnected && provider === "clarity") redirect("/dashboard?clarity=removed#clarity");
  // Bing documents no way to revoke an OAuth grant or API key from outside: the stored copy is destroyed, and the owner removes it at Bing.
  if (result.disconnected && provider === "bing") redirect("/dashboard?bing=removed#bing");
  redirect(result.disconnected && !result.revokedAtProvider ? "/dashboard?notice=revoke_manual" : "/dashboard");
}

/** Starts a Google connect flow for one product. A server action, so it is CSRF-protected. */
export async function startGoogleConnectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const product = formData.get("product");
  if (product !== "gsc" && product !== "ga4") redirect("/dashboard?oauth_error=failed");

  if (!getServices().googleConfigured) redirect("/dashboard?oauth_error=not_configured");

  let target: string;
  try {
    const { authorizationUrl } = await getServices().oauth.begin(user.userId, product);
    if (getEnv().DATA_MODE === "mock") {
      // Development stand-in for Google's consent screen: complete the callback immediately as a fake account.
      const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
      const fakeEmail = (user.email ?? "demo@example.com").toLowerCase();
      target = `/api/oauth/google/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`mock-code:${fakeEmail}#${product}`)}`;
    } else {
      target = authorizationUrl;
    }
  } catch (err) {
    logger.warn("oauth.start_failed", { reason: isConnectorException(err) ? err.code : "internal" });
    redirect(`/dashboard?oauth_error=${isConnectorException(err) && err.code === "PROVIDER_CAPABILITY_UNAVAILABLE" ? "not_configured" : "failed"}`);
  }
  redirect(target);
}

/** Re-reads which Search Console and GA4 properties a connected Google account can see. Owner-scoped. */
export async function syncPropertiesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const connectionId = String(formData.get("connectionId") ?? "");
  const conn = await getServices().repo.getConnection(user.userId, connectionId);
  if (!conn) redirect("/dashboard?sync_error=PROPERTY_NOT_CONNECTED");

  const params = new URLSearchParams();
  try {
    const { discovery } = getServices();
    if (conn.grantedScopes.includes(GOOGLE_SCOPES.gsc)) {
      const r = await discovery.syncGsc(user.userId, connectionId);
      params.set("synced", String(r.total));
      params.set("unverified", String(r.skipped.filter((s) => s.reason === "unverified").length));
    }
    if (conn.grantedScopes.includes(GOOGLE_SCOPES.ga4)) {
      const r = await discovery.syncGa4(user.userId, connectionId);
      params.set("synced_ga4", String(r.total));
    }
  } catch (err) {
    if (isConnectorException(err)) redirect(`/dashboard?sync_error=${err.code}`);
    throw err;
  }
  redirect(`/dashboard?${params}`);
}

const AUTHORIZATION_ID = /^[A-Za-z0-9_-]{8,200}$/;

/**
 * Approves or denies an OAuth authorization request from an AI client. The decision is made by Supabase Auth for the
 * signed-in user's own session; the request id alone grants nothing. Then sends the browser back to the client.
 */
export async function decideAuthorizationAction(formData: FormData): Promise<void> {
  const id = String(formData.get("authorizationId") ?? "");
  const decision = formData.get("decision");
  if (!AUTHORIZATION_ID.test(id) || (decision !== "approve" && decision !== "deny")) redirect("/dashboard");
  await requireUser(`/oauth/consent?authorization_id=${encodeURIComponent(id)}`);
  if (getEnv().AUTH_MODE !== "supabase") redirect("/dashboard");

  const supabase = await createSupabaseServerClient();
  const { data, error } =
    decision === "approve" ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true }) : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
  let target = "";
  try {
    const u = new URL(data?.redirect_url ?? "");
    if (u.protocol === "https:" || u.protocol === "http:") target = u.toString();
  } catch {
    /* fall through */
  }
  if (error || !target) {
    logger.warn("oauth.consent_failed", { decision });
    redirect("/dashboard?notice=connect_failed");
  }
  logger.info("oauth.consent_decided", { decision });
  redirect(target);
}

/** Removes an AI client's access (all of its tokens stop working at their next refresh). */
export async function revokeClientGrantAction(formData: FormData): Promise<void> {
  await requireUser();
  const clientId = String(formData.get("clientId") ?? "");
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(clientId) || getEnv().AUTH_MODE !== "supabase") redirect("/dashboard");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
  redirect(error ? "/dashboard?notice=connect_failed" : "/dashboard?notice=grant_revoked");
}
