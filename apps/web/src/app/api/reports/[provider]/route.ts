import { NextResponse, type NextRequest } from "next/server";
import { ConnectorException, httpStatusFor, toConnectorError } from "@serp/contracts";
import { createLogger, newRequestId } from "@serp/observability";
import { getEnv } from "@/lib/env";
import { getServices, getSessionUser } from "@/lib/server";

export const dynamic = "force-dynamic";
// Vercel: allow up to 30 s (the free plan's ceiling is 60 s). Provider calls have their own 20 s deadline.
export const maxDuration = 30;

const logger = createLogger({ bindings: { service: "web", area: "reports" } });
const MAX_BODY_BYTES = 32 * 1024;
const NO_STORE = { "cache-control": "no-store" };

/**
 * POST /api/reports/{gsc|ga4}
 * Dashboard entry to the shared reporting layer. The caller is always the signed-in user from the session:
 * no user id, connection id or credential is ever read from the request.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const requestId = newRequestId();
  const fail = (err: unknown) => {
    const error = toConnectorError(err, requestId);
    if (error.code === "INTERNAL_ERROR") logger.error("report.route_error", { err, requestId });
    return NextResponse.json({ error }, { status: httpStatusFor(error.code), headers: { ...NO_STORE, ...(error.retryAfterSeconds !== undefined && { "retry-after": String(error.retryAfterSeconds) }) } });
  };

  try {
    const { provider } = await params;
    if (provider !== "gsc" && provider !== "ga4") throw new ConnectorException("INVALID_QUERY", "Unknown report provider.");

    // Cookie-authenticated POST: require JSON (forms cannot send it cross-site without a preflight) and a same-origin Origin.
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new ConnectorException("INVALID_QUERY", "Send the request as application/json.");
    }
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(getEnv().NEXT_PUBLIC_APP_URL).origin) {
      throw new ConnectorException("FORBIDDEN", "Cross-origin report requests are not allowed.");
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    const text = declared > MAX_BODY_BYTES ? null : await request.text();
    if (text === null || text.length > MAX_BODY_BYTES) throw new ConnectorException("INVALID_QUERY", "Request body is too large.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ConnectorException("INVALID_QUERY", "Request body must be valid JSON.");
    }

    const user = await getSessionUser();
    const principal = { userId: user.userId, scopes: [] as string[] };
    const { reports } = getServices();
    const result = provider === "gsc" ? await reports.queryGsc(principal, body, requestId) : await reports.queryGa4(principal, body, requestId);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    return fail(err);
  }
}
