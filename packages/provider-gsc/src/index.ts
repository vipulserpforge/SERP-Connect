import type { AuthorizedQueryContext } from "@serp/contracts";
import { ConnectorException } from "@serp/contracts";
import { type GscApiClient, HttpGscApiClient } from "./api-client.js";
import { GoogleGscAdapter, type GscAdapter } from "./adapter.js";
import { MockGscApiClient } from "./mock-client.js";

export * from "./api-client.js";
export * from "./adapter.js";
export * from "./discovery.js";
export * from "./mock-client.js";
export * from "./query.js";

/** Mock mode runs the real adapter over the mock API, so validation and normalization are always exercised. */
export function createGscAdapter(
  mode: "mock" | "live",
  live?: { getAccessToken: (ctx: AuthorizedQueryContext) => Promise<string>; onAuthRejected?: (ctx: AuthorizedQueryContext) => Promise<void>; client?: GscApiClient },
): GscAdapter {
  if (mode === "mock") return new GoogleGscAdapter({ client: new MockGscApiClient(), getAccessToken: async () => "mock-access-token" });
  if (!live) {
    return {
      provider: "gsc",
      mock: false,
      async query() {
        throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Live Search Console access is not configured yet.", { provider: "gsc" });
      },
    };
  }
  return new GoogleGscAdapter({ client: live.client ?? new HttpGscApiClient(), getAccessToken: live.getAccessToken, ...(live.onAuthRejected && { onAuthRejected: live.onAuthRejected }) });
}
