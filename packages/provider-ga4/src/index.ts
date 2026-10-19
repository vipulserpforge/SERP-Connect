import { ConnectorException, type AuthorizedQueryContext } from "@serp/contracts";
import { GoogleGa4Adapter, type Ga4Adapter } from "./adapter.js";
import { HttpGa4ApiClient, type Ga4ApiClient } from "./api-client.js";
import { MockGa4ApiClient } from "./mock-client.js";

export * from "./api-client.js";
export * from "./adapter.js";
export * from "./discovery.js";
export * from "./mock-client.js";
export * from "./query.js";

/** Mock mode runs the real adapter over the mock API, so validation and normalization are always exercised. */
export function createGa4Adapter(
  mode: "mock" | "live",
  live?: { getAccessToken: (ctx: AuthorizedQueryContext) => Promise<string>; onAuthRejected?: (ctx: AuthorizedQueryContext) => Promise<void>; client?: Ga4ApiClient },
): Ga4Adapter {
  if (mode === "mock") return new GoogleGa4Adapter({ client: new MockGa4ApiClient(), getAccessToken: async () => "mock-access-token" });
  if (!live) {
    return {
      provider: "ga4",
      mock: false,
      async query() {
        throw new ConnectorException("PROVIDER_CAPABILITY_UNAVAILABLE", "Live GA4 access is not configured yet.", { provider: "ga4" });
      },
    };
  }
  return new GoogleGa4Adapter({ client: live.client ?? new HttpGa4ApiClient(), getAccessToken: live.getAccessToken, ...(live.onAuthRejected && { onAuthRejected: live.onAuthRejected }) });
}
