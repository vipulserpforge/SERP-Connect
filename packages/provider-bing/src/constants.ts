/**
 * Everything here comes from Microsoft's Bing Webmaster documentation, read on 19 Oct 2026:
 *   https://learn.microsoft.com/en-us/bingwebmaster/oauth2
 *   https://learn.microsoft.com/en-us/bingwebmaster/getting-access
 *   https://www.bing.com/webmasters/help/soap-pox-api-retirement-s0appox01
 *   https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
 * Nothing is taken from memory or from third-party examples. What the documentation does not say is marked as such.
 */

export const BING_DOCS_URL = "https://learn.microsoft.com/en-us/bingwebmaster/";

/** Documented OAuth endpoints (note the plural "webmasters" in the OAuth paths). */
export const BING_AUTHORIZE_ENDPOINT = "https://www.bing.com/webmasters/oauth/authorize";
export const BING_TOKEN_ENDPOINT = "https://www.bing.com/webmasters/oauth/token";

/** Documented read-only scope. `webmaster.manage` (read and write) is deliberately never requested. */
export const BING_READ_SCOPE = "webmaster.read";

/**
 * REST = the JSON/HTTP protocol. SOAP and POX were announced for retirement on 31 Aug 2026 and are never used.
 * API-key requests use ssl.bing.com (documented for every method). Microsoft's only OAuth example for calling a method
 * uses www.bing.com; whether both hosts accept both credentials is NOT documented, so the live check must confirm it.
 */
export const BING_API_KEY_BASE_URL = "https://ssl.bing.com/webmaster/api.svc/json/";
export const BING_OAUTH_BASE_URL = "https://www.bing.com/webmaster/api.svc/json/";

export type BingCapabilityStatus =
  /** Endpoint, parameters and response fields are documented; still needs the live check before it is trusted. */
  | "documented"
  /** Something needed is missing or contradictory in the documentation. Disabled. */
  | "unverified"
  /** Changes data at Bing. Out of scope: this integration is read-only. */
  | "write_out_of_scope";

export interface BingCapability {
  id: string;
  feature: string;
  method: "GET";
  /** Path segment after /api.svc/json/ */
  endpoint: string;
  parameters: string[];
  responseFields: string[];
  freshness: string;
  status: BingCapabilityStatus;
  enabled: boolean;
  note: string;
}

/** The capability matrix. Only `enabled` rows are reachable from the dashboard and the MCP tools. */
export const BING_CAPABILITIES: readonly BingCapability[] = [
  {
    id: "sites",
    feature: "List the account's sites",
    method: "GET",
    endpoint: "GetUserSites",
    parameters: [],
    responseFields: ["Url", "IsVerified", "AuthenticationCode", "DnsVerificationCode"],
    freshness: "Live",
    status: "documented",
    enabled: true,
    note: "Only Url and IsVerified are used. AuthenticationCode and DnsVerificationCode are site-ownership codes: never stored, shown or logged.",
  },
  {
    id: "traffic",
    feature: "Daily clicks and impressions",
    method: "GET",
    endpoint: "GetRankAndTrafficStats",
    parameters: ["siteUrl"],
    responseFields: ["Date", "Clicks", "Impressions"],
    freshness: "Documented as updated every day. Includes Web, Chat, News, Images, Videos and Knowledge Panel from 24 Mar 2023.",
    status: "documented",
    enabled: true,
    note: "Takes no date range: Bing returns its whole series and this app filters it.",
  },
  {
    id: "queries",
    feature: "Search queries",
    method: "GET",
    endpoint: "GetQueryStats",
    parameters: ["siteUrl"],
    responseFields: ["Query", "Date", "Clicks", "Impressions", "AvgClickPosition", "AvgImpressionPosition"],
    freshness: "Documented as updated every week.",
    status: "documented",
    enabled: true,
    note: "Takes no date range. How many queries and which weeks Bing returns is not documented.",
  },
  {
    id: "crawl",
    feature: "Crawl and index statistics",
    method: "GET",
    endpoint: "GetCrawlStats",
    parameters: ["siteUrl"],
    responseFields: ["Date", "CrawledPages", "CrawlErrors", "InIndex", "InLinks", "Code2xx", "Code301", "Code302", "Code4xx", "Code5xx", "AllOtherCodes", "BlockedByRobotsTxt", "ContainsMalware"],
    freshness: "Documented as updated every day; covers the last 6 months.",
    status: "documented",
    enabled: true,
    note: "",
  },
  {
    id: "page_stats",
    feature: "Traffic by page",
    method: "GET",
    endpoint: "GetPageStats",
    parameters: ["siteUrl"],
    responseFields: [],
    freshness: "Documented as updated every week.",
    status: "unverified",
    enabled: false,
    note: "The documented sample response is labelled QueryStats and shows a Query field, not a page field. The real shape is unknown, so this is disabled until the live check shows it.",
  },
  {
    id: "link_counts",
    feature: "Inbound links by page",
    method: "GET",
    endpoint: "GetLinkCounts",
    parameters: ["siteUrl", "page"],
    responseFields: ["Links[].Url", "Links[].Count", "TotalPages"],
    freshness: "Not documented.",
    status: "unverified",
    enabled: false,
    note: "The meaning of the `page` parameter is not documented (the sample uses 0 with TotalPages 3). Disabled until paging is confirmed.",
  },
  {
    id: "writes",
    feature: "URL, sitemap and content submission; site, role and setting changes",
    method: "GET",
    endpoint: "SubmitUrl, SubmitUrlBatch, SubmitFeed, AddSite, RemoveSite, Save*Settings, ...",
    parameters: [],
    responseFields: [],
    freshness: "n/a",
    status: "write_out_of_scope",
    enabled: false,
    note: "This integration is read-only (PRD). None of these are implemented, and the OAuth scope that would allow them is never requested.",
  },
];

export const enabledBingCapabilities = () => BING_CAPABILITIES.filter((c) => c.enabled);

import { ConnectorException } from "@serp/contracts";

export type BingAuth = { method: "oauth"; accessToken: string } | { method: "api_key"; apiKey: string };

/**
 * Bing's API key is a 32-character hexadecimal string in every Microsoft example. The documentation states no format,
 * so only a loose, safe shape check is applied (it also keeps junk out of a URL query string).
 */
const API_KEY_SHAPE = /^[A-Za-z0-9]{16,64}$/;

export function validateBingApiKey(raw: string): string {
  const key = raw.trim();
  if (!API_KEY_SHAPE.test(key)) {
    throw new ConnectorException("INVALID_QUERY", "That does not look like a Bing Webmaster API key. It is a string of letters and numbers (usually 32 characters). Copy it again from Bing Webmaster Tools.", { provider: "bing" });
  }
  return key;
}

/** Display name for a connection. */
export function validateBingConnectionName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!/^[\p{L}\p{N} ._&()'-]{2,60}$/u.test(name)) {
    throw new ConnectorException("INVALID_QUERY", "Give the connection a name of 2-60 characters (letters, numbers, spaces and . _ & ( ) ' -).", { provider: "bing" });
  }
  return name;
}

export const BING_DATE_SEMANTICS =
  "Calendar dates exactly as Bing reports them (Bing sends each date with its own UTC offset; the date shown is the local calendar date in that offset). Bing does not state its reporting time zone.";
