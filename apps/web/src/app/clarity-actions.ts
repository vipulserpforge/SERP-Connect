"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isConnectorException } from "@serp/contracts";
import { createLogger, newRequestId } from "@serp/observability";
import { getServices, requireUser } from "@/lib/server";

const logger = createLogger({ bindings: { service: "web", area: "clarity" } });

const uuid = z.string().uuid();
const days = z.coerce.number().int().min(1).max(3);

/**
 * Sends the user back to the dashboard with a short code. Never the token, never upstream text: INVALID_QUERY carries one of
 * our own validation sentences (which never include input), everything else is a fixed message chosen by the page.
 */
function back(query: Record<string, string>, hash = "clarity"): never {
  redirect(`/dashboard?${new URLSearchParams(query)}#${hash}`);
}

function failure(err: unknown, requestId: string): never {
  if (isConnectorException(err)) {
    return back({ clarity_error: err.code, ...(err.code === "INVALID_QUERY" && { clarity_msg: err.message.slice(0, 200) }) });
  }
  logger.error("clarity.action_failed", { err, requestId });
  return back({ clarity_error: "INTERNAL_ERROR" });
}

/**
 * Saves a Clarity API token. The token arrives in the POST body of a server action (HTTPS, CSRF-protected), is encrypted
 * immediately, and is never echoed back, logged, placed in a URL, or kept in the browser. No request is made to Clarity.
 */
export async function saveClarityConnectionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  try {
    await getServices().clarity.connect(user.userId, { name: String(formData.get("name") ?? ""), token: String(formData.get("token") ?? "") }, requestId);
  } catch (err) {
    failure(err, requestId);
  }
  back({ clarity: "saved" });
}

export async function reconnectClarityAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  try {
    const name = String(formData.get("name") ?? "").trim();
    await getServices().clarity.reconnect(user.userId, String(formData.get("connectionId") ?? ""), { token: String(formData.get("token") ?? ""), ...(name && { name }) }, requestId);
    await getServices().reports.invalidateConnection(user.userId, String(formData.get("connectionId") ?? ""));
  } catch (err) {
    failure(err, requestId);
  }
  back({ clarity: "reconnected" });
}

export async function renameClarityAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  try {
    await getServices().clarity.rename(user.userId, String(formData.get("connectionId") ?? ""), String(formData.get("name") ?? ""));
  } catch (err) {
    failure(err, requestId);
  }
  back({ clarity: "renamed" });
}

/** Resolves the caller's own Clarity property (by its row id) to the provider-native key. Foreign ids resolve to nothing. */
async function ownProperty(userId: string, propertyRowId: string) {
  const parsed = uuid.safeParse(propertyRowId);
  if (!parsed.success) return null;
  return (await getServices().repo.listProperties(userId, { provider: "clarity" })).find((p) => p.id === parsed.data) ?? null;
}

/**
 * Verifies a token with one real request (numOfDays=1, no dimensions). This spends one request of the project's daily
 * quota unless the same report is already saved, and is only ever run when the user presses the button.
 */
export async function verifyClarityAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  const prop = await ownProperty(user.userId, String(formData.get("propertyId") ?? ""));
  if (!prop) return back({ clarity_error: "PROPERTY_NOT_CONNECTED" });
  let cached = false;
  let mock = false;
  try {
    const result = await getServices().reports.getClarityInsights({ userId: user.userId, scopes: [] }, { propertyId: prop.externalPropertyId, numOfDays: 1, dimensions: [] }, requestId);
    cached = result.cache.hit;
    mock = result.mock;
  } catch (err) {
    failure(err, requestId);
  }
  // Demo data proves nothing about the token, so it must never turn into a "verified" claim.
  back({ clarity: mock ? "verified_mock" : cached ? "verified_cached" : "verified" });
}

/** Fetches (or reuses a saved) report, then opens the report page. Page views themselves never call Clarity. */
export async function fetchClarityReportAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = newRequestId();
  const propertyRowId = String(formData.get("propertyId") ?? "");
  const prop = await ownProperty(user.userId, propertyRowId);
  const numOfDays = days.safeParse(formData.get("days"));
  if (!prop || !numOfDays.success) return redirect("/dashboard?clarity_error=INVALID_QUERY");
  const dims = ["dim1", "dim2", "dim3"].map((k) => String(formData.get(k) ?? "")).filter(Boolean);
  const params = new URLSearchParams({ property: propertyRowId, days: String(numOfDays.data), ...(dims.length > 0 && { dims: dims.join(",") }) });
  try {
    await getServices().reports.getClarityInsights({ userId: user.userId, scopes: [] }, { propertyId: prop.externalPropertyId, numOfDays: numOfDays.data, dimensions: dims }, requestId);
  } catch (err) {
    params.set("error", isConnectorException(err) ? err.code : "INTERNAL_ERROR");
    if (isConnectorException(err) && err.code === "INVALID_QUERY") params.set("msg", err.message.slice(0, 200));
    if (!isConnectorException(err)) logger.error("clarity.fetch_failed", { err, requestId });
  }
  redirect(`/dashboard/clarity?${params}`);
}
