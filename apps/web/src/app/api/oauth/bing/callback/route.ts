import { NextResponse, type NextRequest } from "next/server";
import { isConnectorException } from "@serp/contracts";
import { createLogger, newRequestId } from "@serp/observability";
import { getServices, getSessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";
// Vercel: allow up to 60 s (the free plan's ceiling). Provider calls and property sync can take longer than the 10 s default.
export const maxDuration = 60;

const logger = createLogger({ bindings: { service: "web", area: "oauth-bing" } });

/**
 * GET /api/oauth/bing/callback
 * The connect flow starts from a server action (CSRF-protected); this route only completes it. Query values (state, code) are
 * never logged, and only a short fixed code ever reaches the dashboard URL.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const to = (query: string) => NextResponse.redirect(new URL(`/dashboard?${query}#bing`, origin), { headers: { "cache-control": "no-store" } });

  const requestId = newRequestId();
  let user;
  try {
    user = await getSessionUser();
  } catch {
    return NextResponse.redirect(new URL("/login?next=%2Fdashboard", origin));
  }

  let connectionId: string;
  try {
    ({ connectionId } = await getServices().bing.completeOAuth(
      user.userId,
      { state: searchParams.get("state"), code: searchParams.get("code"), error: searchParams.get("error") },
      requestId,
    ));
  } catch (err) {
    const known = isConnectorException(err);
    if (!known) logger.error("oauth.callback_error", { err, requestId });
    return to(`bing_error=${known ? err.code : "INTERNAL_ERROR"}`);
  }

  // Discovery is best effort: a grant that succeeded must not look failed because listing sites did not.
  try {
    const sync = await getServices().bing.syncSites(user.userId, connectionId, requestId);
    return to(`bing=connected&bing_sites=${sync.total}`);
  } catch (err) {
    return to(`bing=connected&bing_sync_error=${isConnectorException(err) ? err.code : "INTERNAL_ERROR"}`);
  }
}
