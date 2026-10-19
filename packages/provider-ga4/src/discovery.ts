import type { DiscoveredProperty } from "@serp/contracts";
import { GA4_PROPERTY_ID, type Ga4AccountSummary, type Ga4ApiClient } from "./api-client.js";

export interface SkippedGa4Property {
  propertyId: string;
  reason: "unsupported_type" | "malformed";
}

export interface Ga4Discovery {
  properties: DiscoveredProperty[];
  skipped: SkippedGa4Property[];
  /** Properties whose reporting time zone could not be read (they fall back to UTC for date checks). */
  timeZoneUnknown: number;
  /** False when the Data API could not be exercised (not an access problem for the properties themselves). */
  dataApiVerified: boolean;
}

/** Roll-up properties aggregate other properties and need different handling; they are not queryable here yet. */
const SUPPORTED_TYPES = new Set(["PROPERTY_TYPE_ORDINARY", "PROPERTY_TYPE_SUBPROPERTY"]);
const MAX_PROPERTIES = 200;
const DETAIL_CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** Keeps supported properties only, labelled with their account so same-named properties stay distinguishable. */
export function mapAccountSummaries(accounts: Ga4AccountSummary[]): { candidates: Array<{ id: string; name: string }>; skipped: SkippedGa4Property[] } {
  const candidates: Array<{ id: string; name: string }> = [];
  const skipped: SkippedGa4Property[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    for (const p of account.properties) {
      if (!GA4_PROPERTY_ID.test(p.propertyId)) {
        skipped.push({ propertyId: p.propertyId.slice(0, 40), reason: "malformed" });
      } else if (!SUPPORTED_TYPES.has(p.propertyType)) {
        skipped.push({ propertyId: p.propertyId, reason: "unsupported_type" });
      } else if (!seen.has(p.propertyId)) {
        seen.add(p.propertyId);
        candidates.push({ id: p.propertyId, name: account.displayName ? `${p.displayName} (${account.displayName})` : p.displayName });
      }
    }
  }
  return { candidates, skipped };
}

/**
 * Lists the properties an account can see (Admin API), reads each one's reporting time zone, and checks the
 * Data API is reachable with one metadata call. Everything returned is something the account can actually open.
 */
export async function discoverGa4Properties(client: Ga4ApiClient, accessToken: string, signal?: AbortSignal): Promise<Ga4Discovery> {
  const { candidates, skipped } = mapAccountSummaries(await client.listAccountSummaries(accessToken, signal));
  const capped = candidates.slice(0, MAX_PROPERTIES);

  let timeZoneUnknown = 0;
  const properties = await mapLimit(capped, DETAIL_CONCURRENCY, async (c): Promise<DiscoveredProperty> => {
    let timezone: string | null = null;
    try {
      timezone = (await client.getProperty(accessToken, c.id, signal)).timeZone;
    } catch {
      /* the property is still usable; date checks fall back to UTC and the report's own time zone wins */
    }
    if (!timezone) timeZoneUnknown++;
    return { externalPropertyId: c.id, displayName: c.name, propertyType: "ga4_property", timezone };
  });

  let dataApiVerified = false;
  if (properties[0]) {
    try {
      await client.getMetadata(accessToken, properties[0].externalPropertyId, signal);
      dataApiVerified = true;
    } catch (err) {
      // A token problem or a disabled API is the connection's problem, so surface it; a single property
      // the account cannot read is not.
      const kind = (err as { kind?: string }).kind;
      if (kind === "unauthenticated" || kind === "insufficient_scope" || kind === "api_disabled" || kind === "quota") throw err;
    }
  }
  return { properties, skipped, timeZoneUnknown, dataApiVerified };
}
