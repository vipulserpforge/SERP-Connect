import { CLARITY_ENDPOINT } from "./constants.js";

export type ClarityApiErrorKind = "invalid_request" | "unauthorized" | "forbidden" | "quota" | "unavailable" | "bad_response";

/** Carries only a kind and the HTTP status: never the token, the URL or the provider's response body. */
export class ClarityApiError extends Error {
  constructor(
    readonly kind: ClarityApiErrorKind,
    readonly httpStatus: number | null,
  ) {
    super(`Clarity API error: ${kind}`);
    this.name = "ClarityApiError";
  }
}

export interface ClarityExportRequest {
  numOfDays: 1 | 2 | 3;
  dimensions: readonly string[];
}

/** One call to the Data Export API. The caller owns quota accounting; this client never retries. */
export interface ClarityApiClient {
  readonly mock: boolean;
  /** Returns the parsed JSON body, untouched. Throws ClarityApiError. */
  exportLiveInsights(token: string, request: ClarityExportRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface HttpClarityClientOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Test seam only. */
  endpoint?: string;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class HttpClarityApiClient implements ClarityApiClient {
  readonly mock = false;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(opts: HttpClarityClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.endpoint = opts.endpoint ?? CLARITY_ENDPOINT;
  }

  async exportLiveInsights(token: string, request: ClarityExportRequest, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(this.endpoint);
    url.searchParams.set("numOfDays", String(request.numOfDays));
    request.dimensions.forEach((d, i) => url.searchParams.set(`dimension${i + 1}`, d));

    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        // Never follow a redirect: it would forward the Authorization header to another host.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new ClarityApiError("unavailable", null);
    }

    if (res.status === 400) throw new ClarityApiError("invalid_request", 400);
    if (res.status === 401) throw new ClarityApiError("unauthorized", 401);
    if (res.status === 403) throw new ClarityApiError("forbidden", 403);
    if (res.status === 429) throw new ClarityApiError("quota", 429);
    if (!res.ok) throw new ClarityApiError("unavailable", res.status);

    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new ClarityApiError("unavailable", res.status);
    }
    if (text.length > MAX_BODY_BYTES) throw new ClarityApiError("bad_response", res.status);
    try {
      return JSON.parse(text);
    } catch {
      throw new ClarityApiError("bad_response", res.status);
    }
  }
}
