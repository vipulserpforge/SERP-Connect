"use server";

import { redirect } from "next/navigation";
import { isConnectorException } from "@serp/contracts";
import { createLogger, newRequestId } from "@serp/observability";
import { MOCK_BING_CODE_PREFIX } from "@serp/provider-bing";
import { getEnv } from "@/lib/env";
import { getServices, requireUser } from "@/lib/server";

const logger = createLogger({ bindings: { service: "web", area: "bing" } });

/**
 * Sends the user back to the dashboard with a short code. Never a key, token, code or upstream text: INVALID_QUERY carries one
 * of our own validation sentences (which never include input), everything else is a fixed message chosen by the page.
 */
function back(query: Record<string, string>): never {
  redirect(`/dashboard?${new URLSearchParams(query)}#bing`);
}

function failure(err: unknown, requestId: string): never {
  if (isConnectorException(err)) {
    return back({ bing_error: err.code, ...(err.code === "INVALID_QUERY" && { bing_msg: err.message.slice(0, 200) }) });
  }
  logger.error("bing.action_failed", { err, requestId });
  return back({ bing_error: "INTERNAL_ERROR" });
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

/** Starts "Connect with Bing" (OAuth), for a new connection or to reconnect / switch an existing one. A server action, so CSRF-protected. */
export async function startBingOAuthAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  const connectionId = text(formData, "connectionId");
  let target: string;
  try {
    const { authorizationUrl, state } = await getServices().bing.beginOAuth(user.userId, connectionId ? { connectionId } : {}, requestId);
    // Development stand-in for Bing's consent screen: complete the callback immediately.
    target = getEnv().DATA_MODE === "mock" ? `/api/oauth/bing/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`${MOCK_BING_CODE_PREFIX}${user.userId.slice(-6)}`)}` : authorizationUrl;
  } catch (err) {
    return failure(err, requestId);
  }
  redirect(target);
}

/**
 * Saves a Bing API key (new connection, or `connectionId` to replace the key / switch that connection to a key). The key arrives
 * in the POST body of a server action (HTTPS, CSRF-protected), is encrypted immediately, and is never echoed back, logged, put in
 * a page URL, or kept in the browser. Sites are then listed straight away, which also proves the key works.
 */
export async function saveBingApiKeyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  const { bing, reports } = getServices();
  const connectionId = text(formData, "connectionId");
  const name = text(formData, "name").trim();
  let id: string;
  try {
    ({ connectionId: id } = await bing.connectApiKey(user.userId, { apiKey: text(formData, "apiKey"), ...(name && { name }), ...(connectionId && { connectionId }) }, requestId));
    await reports.invalidateConnection(user.userId, id);
  } catch (err) {
    return failure(err, requestId);
  }
  try {
    const sync = await bing.syncSites(user.userId, id, requestId);
    back({ bing: connectionId ? "key_replaced" : "saved", bing_sites: String(sync.total) });
  } catch (err) {
    // next/navigation redirects are thrown: do not swallow them.
    if (!isConnectorException(err)) throw err;
    back({ bing: connectionId ? "key_replaced" : "saved", bing_sync_error: err.code });
  }
}

/** Re-reads which sites the connected Bing account can see. Owner-scoped inside the service. */
export async function syncBingSitesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  try {
    const sync = await getServices().bing.syncSites(user.userId, text(formData, "connectionId"), requestId);
    back({ bing: "synced", bing_sites: String(sync.total), bing_unverified: String(sync.skipped.length) });
  } catch (err) {
    if (!isConnectorException(err)) throw err;
    back({ bing_error: err.code });
  }
}

export async function renameBingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  try {
    await getServices().bing.rename(user.userId, text(formData, "connectionId"), text(formData, "name"));
  } catch (err) {
    return failure(err, requestId);
  }
  back({ bing: "renamed" });
}
