import type { DiscoveredProperty } from "@serp/contracts";
import { GscApiError, type GscApiClient, type GscSite } from "./api-client.js";

export const GSC_PROPERTY_TIMEZONE = "America/Los_Angeles";

export interface SkippedSite {
  siteUrl: string;
  reason: "unverified" | "unknown_permission" | "malformed";
}

export interface GscDiscovery {
  properties: DiscoveredProperty[];
  skipped: SkippedSite[];
}

const DOMAIN = /^sc-domain:[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;

function parseSiteUrl(siteUrl: string): { id: string; name: string; type: "domain" | "url_prefix" } | null {
  if (DOMAIN.test(siteUrl)) return { id: siteUrl, name: siteUrl.slice("sc-domain:".length), type: "domain" };
  try {
    const u = new URL(siteUrl);
    if (u.protocol === "https:" || u.protocol === "http:") return { id: siteUrl, name: siteUrl, type: "url_prefix" };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Turns Google's site list into properties the product may store. Only sites the account can actually
 * query are kept: Search Console also lists sites where the account is an unverified user, and querying
 * those fails, so they are reported as skipped instead of being shown as usable.
 */
export function mapSitesToProperties(sites: GscSite[]): GscDiscovery {
  const properties: DiscoveredProperty[] = [];
  const skipped: SkippedSite[] = [];
  const seen = new Set<string>();
  for (const site of sites) {
    const parsed = parseSiteUrl(site.siteUrl);
    if (!parsed) {
      skipped.push({ siteUrl: site.siteUrl.slice(0, 200), reason: "malformed" });
      continue;
    }
    if (site.permissionLevel === "siteUnverifiedUser") {
      skipped.push({ siteUrl: parsed.id, reason: "unverified" });
      continue;
    }
    if (site.permissionLevel === "unknown") {
      skipped.push({ siteUrl: parsed.id, reason: "unknown_permission" });
      continue;
    }
    if (seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    properties.push({ externalPropertyId: parsed.id, displayName: parsed.name, propertyType: parsed.type, timezone: GSC_PROPERTY_TIMEZONE });
  }
  return { properties, skipped };
}

export async function discoverGscProperties(client: GscApiClient, accessToken: string, signal?: AbortSignal): Promise<GscDiscovery> {
  return mapSitesToProperties(await client.listSites(accessToken, signal));
}

export { GscApiError };
