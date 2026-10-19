import "server-only";
import { httpStatusFor, toConnectorError } from "@serp/contracts";
import { createLogger, newRequestId } from "@serp/observability";

const logger = createLogger({ bindings: { service: "web" } });

/** Wraps a route handler with a request id and the shared, redacted error envelope. */
export async function apiHandler(fn: (requestId: string) => Promise<unknown>): Promise<Response> {
  const requestId = newRequestId();
  try {
    const data = await fn(requestId);
    return Response.json({ data, requestId }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const error = toConnectorError(err, requestId);
    if (error.code === "INTERNAL_ERROR") logger.error("api.internal_error", { err, requestId });
    return Response.json({ error }, { status: httpStatusFor(error.code), headers: { "cache-control": "no-store" } });
  }
}
