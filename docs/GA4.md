# Google Analytics 4 integration

Status: implemented and tested against **mock Analytics Admin and Data APIs**. No Google Cloud project, OAuth client or real account has been used. See "Needs live verification" and "Live-connection requirements" below.

## Flow

1. **Connect**: dashboard "Connect GA4" -> OAuth (PKCE, `analytics.readonly`) -> encrypted tokens stored ([`SECRETS.md`](SECRETS.md)). A Google account that already granted Search Console keeps that grant (incremental authorization); the two products can use the same or different Google accounts.
2. **Discover** (on connect and via "Refresh properties"): Admin API `accountSummaries` lists properties; `properties.get` reads each property's **reporting time zone**; one Data API `getMetadata` call proves the Data API works for this connection. Ordinary and sub-properties are stored (labelled `Property (Account)`); roll-up and malformed entries are skipped. Re-sync keeps the user's enable/disable choices and removes properties the account lost. Empty accounts get an honest message.
3. **Query**: MCP `query_ga4_report` -> ownership check -> date validation in the property's time zone -> cache -> adapter: **property metadata** (cached) -> field validation -> `checkCompatibility` (cached) -> `runReport` -> normalized rows + warnings.
4. **Capabilities**: MCP `get_supported_metrics` with `provider: "ga4"` and a `propertyId` returns that property's actual dimensions and metrics, including its custom ones.

Code: `packages/provider-ga4` (API client, mock API, validation, normalization, adapter, discovery), shared Google REST plumbing in `packages/provider-google/src/rest.ts` (also used by Search Console), `packages/credentials/src/discovery.ts`, `packages/reporting`, `apps/mcp-server/src/live.ts`.

## What a query supports

Any dimension or metric the property exposes: users (`activeUsers`, `totalUsers`, `newUsers`), `sessions`, `engagedSessions`, `engagementRate`, views (`screenPageViews`), events (`eventCount`, `eventName` dimension), key events/conversions, revenue, and custom fields (`customEvent:...`). Up to 9 dimensions and 10 metrics, string dimension filters (exact / begins / ends / contains, case-insensitive), numeric metric filters, ordering by any requested field, `limit` up to 1,000 with `offset` pagination.

## Validation (before any report is requested)

| Rule | Result |
|---|---|
| Field names | Must look like GA4 API names (schema) |
| Unknown field | Names it, suggests close matches, points to `get_supported_metrics` |
| Metric used as dimension (or reverse), deprecated alias | Says so |
| Repeated fields; `orderBy` not in the request | Rejected |
| Incompatible combination | `checkCompatibility` result -> `DIMENSION_METRIC_INCOMPATIBLE` naming the fields to remove |
| Dates | Real dates, start <= end, not before 2015-08-14, not in the future **in the property's time zone** |

## Time zones

GA4 interprets dates in the property's reporting time zone. The zone is stored at discovery; "today" and "future date" checks use it (a Sydney property can legitimately query a date that is still tomorrow in New York). Each report also returns the time zone Google actually used, which wins over the stored value; a mismatch adds `TIMEZONE_CHANGED`. If a zone is unknown, UTC is used for checks with a `TIMEZONE_UNKNOWN` warning.

## Warnings returned with data

`MOCK_DATA`, `PARTIAL_DAY` / `RECENT_DATA_INCOMPLETE` (GA4 can take 24-48 h), `MORE_ROWS_AVAILABLE` (with the next `offset`; `completeness: partial`), `THRESHOLDING_APPLIED`, `OTHER_ROW_AGGREGATION`, `SAMPLED_DATA` (with the sampled share), `RESTRICTED_METRICS`, `LOW_QUOTA`, `UNIQUE_METRICS_NOT_ADDITIVE`, `NO_DATA`, `TIMEZONE_CHANGED`, `TIMEZONE_UNKNOWN`. `providerMetadata` carries time zone, currency, Google's metric types, pagination and quota counters. Metric types are preserved (numbers stay numbers; `YYYYMMDD` dates become `YYYY-MM-DD`).

## Errors (fixed messages; no upstream text, tokens or reasons)

| Google | Code | Notes |
|---|---|---|
| 401 | `AUTH_EXPIRED` | connection flagged `needs_attention` |
| 403 insufficient scope | `FORBIDDEN` | user did not approve Analytics |
| 403 / 404 on a property | `PROPERTY_NOT_ACCESSIBLE` | role removed; connection stays usable |
| 429 / `RESOURCE_EXHAUSTED` | `PROVIDER_RATE_LIMITED` (retryable) | **not auto-retried**: GA4 quotas reset hourly/daily; message says so |
| 403 API not enabled | `PROVIDER_CAPABILITY_UNAVAILABLE` | server config, also caught at connect time |
| 400 | `INVALID_QUERY` | |
| 5xx, timeout, bad body | `PROVIDER_UNAVAILABLE` (retryable) | 5xx/timeouts retried twice with backoff |

Expired access tokens are refreshed transparently; a revoked refresh token becomes `AUTH_REVOKED`. At most 5 reports run at once per property (GA4 allows 10) so bursts queue instead of burning concurrency quota.

## Tools and report coverage (GA4 Reports areas)

The GA4 tools keep no field list of their own: every request is checked against the property's metadata and `checkCompatibility` (limited to the requested fields), so any dimension or metric the property lists can be asked for.

### Tools

| Tool | What it does |
| --- | --- |
| `query_ga4_report` | Any standard report; presets; filters; comparison; paging; `fresh` |
| `query_ga4_cohort` | Retention by cohort (daily, weekly or monthly) |
| `query_ga4_realtime` | Last 1-30 minutes |
| `get_supported_metrics` (`provider: ga4`, `propertyId`) | The exact fields for a property |

### Filters (`query_ga4_report`)

- Dimension filters: `EXACT`, `BEGINS_WITH`, `ENDS_WITH`, `CONTAINS`, `FULL_REGEXP`, `PARTIAL_REGEXP` (RE2), `IN_LIST`; `exclude: true` negates one.
- Metric filters: `EQUAL`, `GREATER_THAN`, `GREATER_THAN_OR_EQUAL`, `LESS_THAN`, `LESS_THAN_OR_EQUAL`.
- `filterMode`: `and` (default) or `or`, applied to each list. Mixed trees (A and (B or C)) are not supported.

### Presets

| Area | Presets |
| --- | --- |
| Acquisition | `organic_landing_pages`, `sessions_by_channel`, `traffic_by_channel_medium`, `traffic_by_source_medium`, `traffic_by_campaign`, `user_acquisition_by_channel`, `new_vs_returning`, `traffic_trend` |
| Engagement | `engagement_by_page`, `landing_pages`, `key_events_by_page`, `events_overview` |
| Audience | `device_breakdown`, `country_breakdown`, `city_breakdown`, `age_breakdown`, `gender_breakdown` |
| Retention | `user_stickiness` (DAU/WAU/MAU), and the `query_ga4_cohort` tool |
| Monetization | `revenue_by_product`, `revenue_by_category`, `revenue_by_channel`, `promotions_performance`, `ecommerce_funnel`, `lifetime_value_by_channel` |

A preset sets dimensions, metrics and sort; your own filters are added to the preset's.

### Report areas

| Area | Status | Notes |
| --- | --- | --- |
| Acquisition (user and traffic) | Full | First-user and session-scoped dimensions all work; presets for the common views |
| Engagement (events, pages, landing pages, key events, engagement time) | Full | |
| Engagement: user flow / path exploration | Not possible | The Data API has no path or flow report |
| Retention: new vs returning, stickiness, cohorts | Full | Cohorts: most recent complete cohorts, up to 12 x 12 |
| Retention: lifetime value | Partly | Revenue per user inside the date range by first-touch channel. GA4's multi-year LTV exploration is not in the Data API |
| Monetization (purchases, items, revenue, promotions, brand, category) | Full | Funnel steps count events, not people |
| Audience (device, country, city, age, gender) | Full | Age and gender cover only users Google can identify |
| Comparison | Partly | `compareTo` = previous period or previous year, per row and in totals. Arbitrary extra date ranges are not supported |
| Segments | Not possible | Segments exist only in the alpha Data API |
| Audiences | Partly | Use an audience dimension if the property lists one; audience definitions (Admin API) are not read |
| Explore (free-form, funnel, path), Advertising, Admin | Not supported | Not in the Data API (Explore, Advertising attribution) or not yet built (Admin: key events, audiences, data streams, BigQuery links) |

### Limits that are Google's, not ours

- Sampling and thresholding are applied by Google and reported as warnings; they cannot be avoided.
- The latest 24-48 hours can still change.
- Quotas are per property and reset hourly and daily; the tool does not retry a quota error within seconds.
- Dates follow each property's own time zone, which can differ from Search Console (Pacific Time) and Clarity (UTC).
- Cohort and funnel behaviour, and the compatibility of each preset's fields, were tested against a mock of the Data API, not against live Google.

## Needs live verification (cannot be proven with mocks)

1. Admin API v1beta: `accountSummaries` shape, paging, `propertyType` values; `properties.get` `timeZone` / `currencyCode`. Whether v1beta suffices or v1alpha is needed for anything we use.
2. Data API v1beta: exact `metadata`, `checkCompatibility`, `runReport` shapes, including `metadata.timeZone`, `subjectToThresholding`, `dataLossFromOtherRow`, `samplingMetadatas`, `schemaRestrictionResponse`, `emptyReason`, `propertyQuota` bucket names.
3. Compatibility semantics: that fields flagged `INCOMPATIBLE` are exactly those to remove (the mock's rules are only an approximation); whether filters need checking too.
4. That `orderBy` must reference requested fields (we enforce it conservatively).
5. Error mapping: reasons/status strings for quota (per property vs per project), disabled API, insufficient scope; whether quota errors ever carry `Retry-After`.
6. Earliest start date (2015-08-14) and per-request limits (9 dimensions, 10 metrics, `limit`/`offset` ceiling).
7. Roll-up and sub-property behavior (roll-ups are skipped; sub-properties assumed to behave like ordinary ones).
8. Deprecated field aliases (`conversions` vs `keyEvents`) in a real metadata response.
9. Real quota consumption per report and whether 5 concurrent reports per property is a sensible ceiling.
10. Incremental authorization: one grant holding both `webmasters.readonly` and `analytics.readonly`.

## Live-connection requirements (when you decide to configure Google Cloud)

Nothing here has been done and nothing needs doing now.

- **Google Cloud project** with these APIs enabled: *Google Analytics Admin API*, *Google Analytics Data API* (and *Google Search Console API* for GSC). A disabled API surfaces as `PROVIDER_CAPABILITY_UNAVAILABLE` at connect time.
- **OAuth consent screen and web client** with scopes `https://www.googleapis.com/auth/analytics.readonly` and `.../webmasters.readonly` (plus `openid email`), and the redirect URI `https://<app>/api/oauth/google/callback`. Both product scopes are sensitive/restricted-tier for production use, so Google's OAuth verification will be needed before users outside your test list can connect.
- **Secrets**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `SECRET_KEYS`, `SUPABASE_DB_URL` (see [`SECRETS.md`](SECRETS.md)); `DATA_MODE=live`, `DB_MODE=postgres`.
- **Test accounts**: one Google account with access to at least one GA4 property (Viewer is enough), ideally two accounts (to test the A/B/C identity case) and one property with custom dimensions and a non-UTC time zone.
- **Quota**: standard GA4 property quotas apply per property and per project; request rate in the pilot should stay well under them (see the Data API quota page linked in the TRD).

Not built yet: report persistence in the Postgres cache, comparisons across date ranges, pivot/cohort reports, audience/realtime reports, and cross-source (GSC vs GA4) comparison.
9. The presets' field combinations (for example `userAgeBracket`, `averageRevenuePerUser`, the stickiness metrics, `itemsViewedInPromotion`) and the purchase-funnel metrics together without dimensions.
10. Cohort reports: the `cohortSpec` request (cohorts by `firstSessionDate`, Sunday-to-Saturday weeks, `cohortNthDay/Week/Month`) and its response shape.
11. Nested filters: `orGroup`, `notExpression`, `inListFilter` and regular-expression match types in a real request.
12. Realtime: `runRealtimeReport` field list and `minuteRanges`.
