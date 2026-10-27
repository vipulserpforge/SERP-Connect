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
  /** Endpoint, parameters and response fields are documented and the report was checked against a live Bing account. */
  | "verified"
  /** Endpoint, parameters and response fields are documented; not yet seen against a live account (the report says so). */
  | "documented"
  /** Something needed is missing or contradictory in the documentation. Disabled. */
  | "unverified"
  /** Changes data at Bing. Out of scope: this integration is read-only. */
  | "write_out_of_scope";

export interface BingCapability {
  id: string;
  feature: string;
  method: "GET" | "POST";
  /** Path segment after /api.svc/json/ */
  endpoint: string;
  parameters: string[];
  responseFields: string[];
  freshness: string;
  status: BingCapabilityStatus;
  enabled: boolean;
  note: string;
}

const cap = (c: Omit<BingCapability, "method" | "enabled" | "note"> & { note?: string; enabled?: boolean; method?: "GET" | "POST" }): BingCapability => ({ method: "GET", enabled: true, note: "", ...c });

/** The capability matrix. Only `enabled` rows are reachable from the dashboard and the MCP tools. */
export const BING_CAPABILITIES: readonly BingCapability[] = [
  cap({
    id: "sites",
    feature: "List the account's sites",
    endpoint: "GetUserSites",
    parameters: [],
    responseFields: ["Url", "IsVerified", "AuthenticationCode", "DnsVerificationCode"],
    freshness: "Live",
    status: "verified",
    note: "Only Url and IsVerified are used. AuthenticationCode and DnsVerificationCode are site-ownership codes: never stored, shown or logged.",
  }),
  cap({
    id: "traffic",
    feature: "Daily clicks and impressions",
    endpoint: "GetRankAndTrafficStats",
    parameters: ["siteUrl"],
    responseFields: ["Date", "Clicks", "Impressions"],
    freshness: "Documented as updated every day. Includes Web, Chat, News, Images, Videos and Knowledge Panel from 24 Mar 2023.",
    status: "verified",
    note: "Takes no date range: Bing returns its whole series and this app filters it.",
  }),
  cap({
    id: "queries",
    feature: "Search queries",
    endpoint: "GetQueryStats",
    parameters: ["siteUrl"],
    responseFields: ["Query", "Date", "Clicks", "Impressions", "AvgClickPosition", "AvgImpressionPosition"],
    freshness: "Documented as updated every week.",
    status: "verified",
    note: "Takes no date range. How many queries and which weeks Bing returns is not documented.",
  }),
  cap({
    id: "crawl",
    feature: "Crawl and index statistics",
    endpoint: "GetCrawlStats",
    parameters: ["siteUrl"],
    responseFields: ["Date", "CrawledPages", "CrawlErrors", "InIndex", "InLinks", "Code2xx", "Code301", "Code302", "Code4xx", "Code5xx", "AllOtherCodes", "BlockedByRobotsTxt", "ContainsMalware"],
    freshness: "Documented as updated every day; covers the last 6 months.",
    status: "verified",
  }),
  cap({
    id: "pages",
    feature: "Traffic by page",
    endpoint: "GetPageStats",
    parameters: ["siteUrl"],
    responseFields: ["Query (carries the page address), Date, Clicks, Impressions, AvgClickPosition, AvgImpressionPosition"],
    freshness: "Documented as updated every week.",
    status: "documented",
    note: "Microsoft's return type is QueryStats; its XML sample puts the page URL in the Query field. Read as a page address.",
  }),
  cap({
    id: "query_pages",
    feature: "Pages for one query",
    endpoint: "GetQueryPageStats",
    parameters: ["siteUrl", "query"],
    responseFields: ["Query (page address), Date, Clicks, Impressions, AvgClickPosition, AvgImpressionPosition"],
    freshness: "Documented as updated every week.",
    status: "documented",
    note: "Microsoft's sample returns QueryStats. Read as pages; confirm live.",
  }),
  cap({
    id: "page_queries",
    feature: "Queries for one page",
    endpoint: "GetPageQueryStats",
    parameters: ["siteUrl", "page"],
    responseFields: ["Query, Date, Clicks, Impressions, AvgClickPosition, AvgImpressionPosition"],
    freshness: "Documented as updated every week.",
    status: "documented",
  }),
  cap({
    id: "query_page_detail",
    feature: "Daily detail for one query on one page",
    endpoint: "GetQueryPageDetailStats",
    parameters: ["siteUrl", "query", "page"],
    responseFields: ["Date", "Clicks", "Impressions", "Position"],
    freshness: "Documented as updated every week.",
    status: "documented",
  }),
  cap({
    id: "crawl_issues",
    feature: "URLs with crawl issues",
    endpoint: "GetCrawlIssues",
    parameters: ["siteUrl"],
    responseFields: ["Url", "HttpCode", "Issues (bit flags)", "InLinks"],
    freshness: "A fixed issue can take a few days to disappear (Microsoft).",
    status: "documented",
    note: "Issues is a flags value; only 32 = ContainsMalware is shown in Microsoft's sample. Other flags are decoded from the crawl-statistics categories and unknown bits are reported raw.",
  }),
  cap({
    id: "blocked_urls",
    feature: "URLs and directories blocked in Bing",
    endpoint: "GetBlockedUrls",
    parameters: ["siteUrl"],
    responseFields: ["Url", "Date", "EntityType", "RequestType"],
    freshness: "Snapshot.",
    status: "documented",
    note: "Microsoft's page shows no sample response for this method; the fields come from the BlockedUrl object in the AddBlockedUrl sample. EntityType and RequestType numbers are not documented and are passed through.",
  }),
  cap({
    id: "inbound_links",
    feature: "Pages with inbound links",
    endpoint: "GetLinkCounts",
    parameters: ["siteUrl", "page (0-based page number)"],
    responseFields: ["Links[].Url", "Links[].Count", "TotalPages"],
    freshness: "Not documented.",
    status: "documented",
    note: "Paging confirmed by Microsoft's example loop (page from 0 while page < TotalPages). At most 5 pages are read per call.",
  }),
  cap({
    id: "url_links",
    feature: "Inbound links to one URL",
    endpoint: "GetUrlLinks",
    parameters: ["siteUrl", "link", "page (0-based)"],
    responseFields: ["Details[].Url", "Details[].AnchorText", "TotalPages"],
    freshness: "Not documented.",
    status: "documented",
  }),
  cap({
    id: "sitemaps",
    feature: "Submitted sitemaps and feeds",
    endpoint: "GetFeeds",
    parameters: ["siteUrl"],
    responseFields: ["Url", "Type", "Status", "Submitted", "LastCrawled", "UrlCount", "FileSize", "Compressed"],
    freshness: "Snapshot.",
    status: "documented",
  }),
  cap({
    id: "url_info",
    feature: "Index details of one URL",
    endpoint: "GetUrlInfo",
    parameters: ["siteUrl", "url"],
    responseFields: ["Url", "IsPage", "HttpStatus", "DocumentSize", "AnchorCount", "TotalChildUrlCount", "DiscoveryDate", "LastCrawledDate"],
    freshness: "Snapshot. A `domain:` prefix returns domain-level details.",
    status: "documented",
  }),
  cap({
    id: "url_traffic",
    feature: "Clicks and impressions of one URL",
    endpoint: "GetUrlTrafficInfo",
    parameters: ["siteUrl", "url"],
    responseFields: ["Url", "IsPage", "Clicks", "Impressions"],
    freshness: "Not documented.",
    status: "documented",
  }),
  cap({
    id: "submission_quota",
    feature: "URL submission quota (read only)",
    endpoint: "GetUrlSubmissionQuota",
    parameters: ["siteUrl"],
    responseFields: ["DailyQuota", "MonthlyQuota"],
    freshness: "Live.",
    status: "documented",
    note: "Only reads the quota. Submitting URLs is a write and is out of scope.",
  }),
  cap({
    id: "keyword_stats",
    feature: "Bing search-volume history of a keyword",
    endpoint: "GetKeywordStats",
    parameters: ["q", "country", "language"],
    responseFields: ["Query", "Date", "Impressions", "BroadImpressions"],
    freshness: "Not documented.",
    status: "documented",
    note: "Microsoft publishes the fields but no sample, and does not say which country and language values are accepted (the connector defaults to us / en-US). This is Bing-wide volume, not the site's own traffic.",
  }),
  cap({
    id: "query_traffic",
    feature: "Daily traffic of one top query",
    endpoint: "GetQueryTrafficStats",
    parameters: ["siteUrl", "query"],
    responseFields: ["Date", "Clicks", "Impressions"],
    freshness: "Documented as updated every day. Only top queries are saved and returned.",
    status: "documented",
  }),
  cap({
    id: "children_url_info",
    method: "POST",
    feature: "Index details of pages and folders under a URL",
    endpoint: "GetChildrenUrlInfo",
    parameters: ["siteUrl", "url", "page (0-based)", "filterProperties (sent as Any)"],
    responseFields: ["Url", "IsPage", "HttpStatus", "DocumentSize", "AnchorCount", "TotalChildUrlCount", "DiscoveryDate", "LastCrawledDate"],
    freshness: "Snapshot.",
    status: "documented",
    note: "The one method Microsoft documents as POST with a JSON body (it still only reads). The filter object is sent with every filter set to Any (0). A `domain:` prefix returns domain-level details.",
  }),
  cap({
    id: "children_url_traffic",
    feature: "Traffic of pages and folders under a URL",
    endpoint: "GetChildrenUrlTrafficInfo",
    parameters: ["siteUrl", "url", "page (0-based)"],
    responseFields: ["Url", "IsPage", "Clicks", "Impressions"],
    freshness: "Not documented.",
    status: "documented",
  }),
  cap({
    id: "crawl_settings",
    feature: "Crawl-rate setting",
    endpoint: "GetCrawlSettings",
    parameters: ["siteUrl"],
    responseFields: ["AjaxEnabled", "CrawlRate (24 numbers in the JSON sample)"],
    freshness: "Snapshot.",
    status: "documented",
    note: "What each CrawlRate position stands for is not documented. The XML sample shows a base64 string; both forms are read.",
  }),
  cap({
    id: "feed_details",
    feature: "Details of a sitemap index",
    endpoint: "GetFeedDetails",
    parameters: ["siteUrl", "feedUrl"],
    responseFields: ["Url", "Type", "Status", "Submitted", "LastCrawled", "UrlCount", "FileSize", "Compressed"],
    freshness: "Snapshot.",
    status: "documented",
  }),
  cap({
    id: "deep_link_blocks",
    feature: "Blocked deep links",
    endpoint: "GetDeepLinkBlocks",
    parameters: ["siteUrl"],
    responseFields: ["not documented"],
    freshness: "Snapshot.",
    status: "documented",
    note: "Microsoft publishes the method but no response shape. Fields are shown as Bing sends them (shape: unverified).",
  }),
  cap({
    id: "page_preview_blocks",
    feature: "Pages with a blocked preview",
    endpoint: "GetActivePagePreviewBlocks",
    parameters: ["siteUrl"],
    responseFields: ["not documented"],
    freshness: "Snapshot.",
    status: "documented",
    note: "No published response shape. Fields are shown as Bing sends them (shape: unverified).",
  }),
  cap({
    id: "country_region_settings",
    feature: "Target country or region",
    endpoint: "GetCountryRegionSettings",
    parameters: ["siteUrl"],
    responseFields: ["not documented"],
    freshness: "Snapshot.",
    status: "documented",
    note: "No published response shape. Fields are shown as Bing sends them (shape: unverified).",
  }),
  cap({
    id: "query_parameters",
    feature: "URL parameters Bing ignores",
    endpoint: "GetQueryParameters",
    parameters: ["siteUrl"],
    responseFields: ["Parameter", "IsEnabled", "Source", "Date"],
    freshness: "Snapshot.",
    status: "documented",
    note: "Source is Bing's enum number, passed through.",
  }),
  cap({
    id: "connected_pages",
    feature: "Connected pages",
    endpoint: "GetConnectedPages",
    parameters: ["siteUrl"],
    responseFields: ["not documented"],
    freshness: "Snapshot.",
    status: "documented",
    note: "No published response shape. Fields are shown as Bing sends them (shape: unverified).",
  }),
  cap({
    id: "site_moves",
    feature: "Site-move records",
    endpoint: "GetSiteMoves",
    parameters: ["siteUrl"],
    responseFields: ["not documented"],
    freshness: "Snapshot.",
    status: "documented",
    note: "No published response shape. Fields are shown as Bing sends them (shape: unverified).",
  }),
  cap({
    id: "site_roles",
    feature: "Who has access to the site",
    endpoint: "GetSiteRoles",
    parameters: ["siteUrl", "includeAllSubdomains"],
    responseFields: ["Email", "Role", "Site", "VerificationSite", "DelegatorEmail", "DelegatedCodeOwnerEmail", "Expired", "Date"],
    freshness: "Snapshot.",
    status: "documented",
    note: "Returns other people's email addresses. DelegatedCode (a delegated-verification secret) is dropped at the parse boundary and never stored, shown or logged. Only Role 2 = ReadWrite is named in Microsoft's sample.",
  }),
  cap({
    id: "content_submission_quota",
    feature: "Content submission quota (read only)",
    endpoint: "GetContentSubmissionQuota",
    parameters: ["siteUrl"],
    responseFields: ["DailyQuota", "MonthlyQuota"],
    freshness: "Live.",
    status: "documented",
    note: "Only reads the quota. Submitting content is a write and is out of scope.",
  }),
  cap({
    id: "keyword",
    feature: "Bing impressions for one keyword over a period",
    endpoint: "GetKeyword",
    parameters: ["q", "country", "language", "startDate", "endDate"],
    responseFields: ["Query", "Date", "Impressions", "BroadImpressions"],
    freshness: "Not documented.",
    status: "documented",
    note: "No published sample. The date arguments are sent in Bing's /Date(ms)/ form, which is unconfirmed live. Market-wide, not the site's traffic.",
  }),
  cap({
    id: "related_keywords",
    feature: "Keywords related to one keyword",
    endpoint: "GetRelatedKeywords",
    parameters: ["q", "country", "language", "startDate", "endDate"],
    responseFields: ["Query", "Date", "Impressions", "BroadImpressions"],
    freshness: "Not documented.",
    status: "documented",
    note: "No published sample (the documentation page shows the GetSiteRoles sample by mistake). Same date-argument caveat as GetKeyword. Market-wide, not the site's traffic.",
  }),
  cap({
    id: "writes",
    feature: "URL, sitemap and content submission; site, role, settings and block changes",
    endpoint: "SubmitUrl, SubmitUrlBatch, SubmitFeed, SubmitContent, AddSite, RemoveSite, Add*/Remove*/Save*/Enable*, FetchUrl, VerifySite, ...",
    parameters: [],
    responseFields: [],
    freshness: "n/a",
    status: "write_out_of_scope",
    enabled: false,
    note: "This integration is read-only (PRD). None of these are implemented, and the OAuth scope that would allow them is never requested.",
  }),
];

/**
 * Read methods of Microsoft's IWebmasterApi that this connector does NOT expose, with the reason. Kept next to the matrix so the
 * audit in docs/BING.md and `get_supported_metrics` stay honest.
 */
export const BING_READ_METHODS_NOT_COVERED: ReadonlyArray<{ method: string; reason: string }> = [
  { method: "GetCountryStats / any device or search-appearance view", reason: "Does not exist in IWebmasterApi. Bing Webmaster's web UI offers country, device and search-type filters; the public API does not expose them." },
  { method: "AI Performance, Copilot citations, Site Scan", reason: "Not part of the Bing Webmaster API." },
  { method: "GetFetchedUrls, GetFetchedUrlDetails", reason: "Results of 'Fetch as Bingbot' requests, which the connector would have to start (a write) to have any." },
  { method: "GetDeepLink, GetDeepLinkAlgoUrls", reason: "Marked obsolete by Microsoft." },
];

/** Write actions that would be useful but are deliberately NOT built (suggestions only). */
export const BING_SUGGESTED_WRITES: ReadonlyArray<{ method: string; use: string }> = [
  { method: "SubmitUrl / SubmitUrlBatch", use: "Ask Bing to index new or updated pages right away." },
  { method: "SubmitFeed", use: "Submit or resubmit a sitemap." },
  { method: "SubmitContent", use: "Send page content to Bing directly." },
  { method: "AddSite / RemoveSite / VerifySite", use: "Add and verify a site without opening Bing Webmaster Tools." },
  { method: "SaveCrawlSettings", use: "Change the crawl-rate setting." },
  { method: "SubmitSiteMove", use: "Tell Bing about a domain change." },
  { method: "AddBlockedUrl / RemoveBlockedUrl", use: "Block or unblock URLs in Bing results." },
  { method: "AddQueryParameter / RemoveQueryParameter / EnableDisableQueryParameter", use: "Tell Bing which URL parameters to ignore." },
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
