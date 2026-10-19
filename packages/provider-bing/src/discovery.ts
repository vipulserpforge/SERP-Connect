import type { DiscoveredProperty } from "@serp/contracts";
import type { BingSite } from "./client.js";

export interface SkippedBingSite {
  url: string;
  reason: "unverified" | "verification_unknown";
}

export interface BingDiscovery {
  properties: DiscoveredProperty[];
  skipped: SkippedBingSite[];
}

/**
 * Turns Bing's site list into properties. A site is only stored (and so only reportable) when Bing says it is verified:
 * a missing flag is "unknown", which is never treated as verified. Unverified sites are returned so the UI can say so.
 */
export function discoverBingSites(sites: BingSite[]): BingDiscovery {
  const properties: DiscoveredProperty[] = [];
  const skipped: SkippedBingSite[] = [];
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    if (s.isVerified === true) {
      properties.push({ externalPropertyId: s.url, displayName: s.url, propertyType: "bing_site_verified", timezone: null });
    } else {
      skipped.push({ url: s.url, reason: s.isVerified === false ? "unverified" : "verification_unknown" });
    }
  }
  return { properties, skipped };
}
