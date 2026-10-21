import { NextResponse, type NextRequest } from "next/server";
import { isConnectorException } from "@serp/contracts";
import { createLogger, newRequestId } from "@serp/observability";
import { getServices, getSessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";
// Vercel: allow up to 60 s (the free plan's ceiling). Provider calls and property sync can take longer than the 10 s default.
export const maxDuration = 60;

const logger = createLogger({ bindings: { service: "web", area: "oauth" } });

/** Short, fixed codes shown on the dashboard: never upstream text. */
const FAILURE: Record<string, string> = {
  AUTH_REQUIRED: "attempt_invalid",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  PROVIDER_CAPABILITY_UNAVAILABLE: "not_configured",
};

/**
 * GET /api/oauth/google/callback
 * The connect flow starts from a server action (CSRF-protected); this route only completes it.
 * Query values (state, code) are never logged.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  const { searchParams, origin } = request.nextUrl;
  const to = (query: string) => NextResponse.redirect(new URL(`/dashboard?${query}`, origin), { headers: { "cache-control": "no-store" } });

  if (action !== "callback") return NextResponse.json({ error: { code: "INVALID_QUERY", message: "Not found." } }, { status: 404 });

  const requestId = newRequestId();
  let user;
  try {
    user = await getSessionUser();
  } catch {
    return NextResponse.redirect(new URL("/login?next=%2Fdashboard", origin));
  }

  try {
    const { product, connectionId } = await getServices().oauth.complete(
      user.userId,
      { state: searchParams.get("state"), code: searchParams.get("code"), error: searchParams.get("error") },
      requestId,
    );
    // Discovery is best effort: a connection that succeeded must not look failed because listing properties did not.
    try {
      const { discovery } = getServices();
      const sync = product === "gsc" ? await discovery.syncGsc(user.userId, connectionId, requestId) : await discovery.syncGa4(user.userId, connectionId, requestId);
      return to(`connected=${product}&${product === "gsc" ? "synced" : "synced_ga4"}=${sync.total}`);
    } catch {
      return to(`connected=${product}&sync_error=1`);
    }
  } catch (err) {
    // Structural check: package copies bundled separately would defeat instanceof.
    const known = isConnectorException(err);
    const code = known ? (err as { code: string }).code : "INTERNAL_ERROR";
    if (!known) logger.error("oauth.callback_error", { err, requestId });
    return to(`oauth_error=${FAILURE[code] ?? "failed"}`);
  }
}
