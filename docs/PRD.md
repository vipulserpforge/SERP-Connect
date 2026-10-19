# Product Requirements Document (PRD)

## SEO Analytics MCP Connector

**Document status:** Draft for implementation  
**Version:** 1.0  
**Last updated:** 19 October 2026  
**Audience:** Product owner, engineering, UX, security, QA, and launch stakeholders

---

## 1. Executive summary

Build a public, multi-tenant SaaS application that lets users connect their own Google Search Console (GSC), Google Analytics 4 (GA4), Bing Webmaster Tools, and Microsoft Clarity data sources, then query those sources conversationally from Claude through a hosted remote Model Context Protocol (MCP) server.

A user signs up to the SaaS with one identity, but can authorize provider data using any Google account that has access to the desired property. For example, the SaaS account may be created with Google Account A, GSC may be authorized through Account B, and GA4 through Account C. These identities must never be assumed to be the same. The SaaS account owns the provider connections and selected properties; the provider account supplies the actual data permissions.

The product must distinguish three separate authentication layers:

1. **SaaS authentication:** identifies the person and their workspace/account.
2. **Provider authorization:** grants the backend permission to access a particular provider account and its properties.
3. **Claude-to-MCP authorization:** lets Claude call the SaaS MCP server as the authenticated SaaS user.

The application will use the SaaS operator's Google Cloud project and OAuth client for Google integrations. Customers must not be asked to create their own Google Cloud projects, Google API keys, or OAuth clients. Customers consent to access via Google's standard account chooser and OAuth consent flow.

The MVP prioritizes robust, read-only GSC and GA4 reporting. Bing and Clarity are part of the target product, but must respect their different API capabilities. Clarity's Data Export API is restricted to the last 1–3 days and has a hard quota of 10 requests per project per day, at most three dimensions, and 1,000 rows without pagination. Bing's legacy SOAP/POX APIs were scheduled to retire on 31 August 2026; new work must target verified current REST APIs, not assume legacy endpoints remain available.

## 2. Product vision

Make SEO and web analytics data easy to query in natural language without requiring every user to build dashboards, export spreadsheets, or configure developer credentials.

A user should be able to ask questions such as:

- “Show the top 20 pages by clicks in GSC over the last 20 days.”
- “Show the top 30 pages by active users in GA4 over the last 30 completed days.”
- “Which landing pages lost GSC clicks but gained GA4 active users compared with the previous period?”
- “Show available recent Clarity rage-click insights for the connected project.”
- “Which connected data sources are unavailable, and why?”

The service should return correctly scoped, explainable, time-bounded results with data freshness, source, limits, and warnings where relevant. It must never fabricate unavailable rows or claim that a provider can answer a query beyond its documented API limits.

## 3. Problem statement

SEO specialists, agencies, consultants, and in-house marketing teams use separate reporting products and frequently need to answer ad hoc questions spanning search performance, analytics and behavior insights. The workflows commonly require switching applications, manually exporting reports, joining page URLs, and translating questions into dimensions and metrics.

Existing generic AI workflows can be brittle if they lack typed query tools, user-specific authorization, metric compatibility checks, rate-limit handling and clear data provenance. This product will provide the connection, authorization, reporting and reliability layers necessary for Claude to query the user's own data safely.

## 4. Goals and success measures

### 4.1 Product goals

1. Let a public user create an account without needing developer-console access.
2. Let one SaaS user connect multiple independent provider identities and multiple properties.
3. Let customers authorize GSC and GA4 with any Google accounts that actually have access to the properties.
4. Let the user connect a hosted MCP server to Claude through OAuth.
5. Provide strongly typed read-only tools for common SEO/analytics reports.
6. Make common queries accurate and repeatable, with visible date ranges and source properties.
7. Protect customer credentials and prevent cross-tenant data access.
8. Build for expansion: provider-specific adapters, explicit capability metadata and tested reconnection flows.

### 4.2 Proposed launch metrics

These are internal targets, not promises to customers. Revisit them after an initial pilot.

| Metric | Initial target | Measurement method |
|---|---:|---|
| Signup-to-first-provider connection | 70% or higher | Product analytics funnel |
| Connected GSC/GA4 report successfully returned in end-to-end tests | 99% or higher, excluding provider-side outages and invalid grants | Synthetic test suite and monitored requests |
| Successful MCP OAuth completion | 95% or higher | OAuth callback outcome events |
| Cross-tenant authorization defects | 0 | Security tests, code review and incident monitoring |
| Common supported queries answered with correct property and date range | 95% or higher in acceptance test set | Golden-query evaluation suite |
| Clarity API requests exceeding configured daily budget | 0 | Request-budget metrics |
| Repeated identical cached report requests generating unnecessary upstream calls | Reduce steadily; target under 10% after cache stabilization | Cache hit rate and provider-call telemetry |

### 4.3 Non-goals for MVP

- Write access to GSC, GA4, Bing, or Clarity.
- Arbitrary SQL execution or user-provided code execution.
- Guaranteeing every possible natural-language question can be answered.
- Promising complete exposure of all Search Console rows. Google explicitly notes that Search Analytics API results can be limited and may not include all rows.
- Backfilling historical Clarity data that the Data Export API does not expose.
- Reconstructing pre-connection historical data outside provider retention.
- Replacing GA4 or GSC dashboards.
- Cross-client agency workspace administration, role hierarchies or billing plans in the first build unless needed for launch.
- Building a complete data warehouse before live-query and cache performance is validated.

## 5. Target users and jobs to be done

### 5.1 Primary personas

**SEO specialist / consultant**  
Needs fast access to GSC clicks, impressions, CTR, position, queries and pages. May need to connect multiple client properties.

**Growth or performance marketer**  
Needs GA4 landing page, active user, session, engagement, conversion and event reports, often compared with organic search performance.

**Agency team member**  
May use one SaaS login but access provider properties through several client-managed Google accounts. Needs clear ownership and property selection so client data does not mix.

**Technical SEO / analytics practitioner**  
Needs filters, date ranges, country/device breakdowns, report metadata, pagination, error transparency and dependable tool contracts.

### 5.2 Jobs to be done

- When I connect a source, I want to choose an account that actually has property access and see only the properties available to that account.
- When I ask for a report, I want the tool to map the intent to valid provider metrics and dimensions, not guess invalid API parameters.
- When the provider cannot provide the requested date range or complete dataset, I want the limitation explained and a feasible alternative offered.
- When my authorization expires or is revoked, I want a clear reconnect action and an accurate connection status.
- When I connect Claude, I want it to see only the provider connections and selected properties I have authorized through this SaaS account.

## 6. Product principles

1. **Account identity is not property identity.** Signup email, provider-account email, provider subject ID and property ID are distinct values.
2. **The SaaS user owns connections.** Every provider connection and property selection is assigned to a stable internal `user_id`.
3. **Provider access remains least-privilege.** Request read-only scopes for the MVP; request scopes only when a user initiates the related integration.
4. **Fail clearly, not silently.** Show provider, property, time range and errors/warnings.
5. **Never claim completeness without evidence.** Respect source-specific row, date, quota and sampling limitations.
6. **Tools are typed and bounded.** Claude should use schema-defined reporting operations, not construct arbitrary API requests or SQL.
7. **Security decisions are server-side.** Tool input from an LLM is untrusted and must never prove ownership or permission.
8. **Do not block the whole product when one provider is down.** Provider adapters isolate failure and status.

## 7. User journey and workflows

### 7.1 Signup and account creation

1. Visitor opens the public marketing site.
2. Visitor creates an account using Google sign-in (Supabase Auth).
3. Backend creates or upserts a profile tied to Supabase's stable user ID.
4. User lands on the integrations dashboard.
5. User sees the four providers and an MCP connection setup section.

Acceptance criteria:

- The application does not use the email address as its primary database key.
- Sign-in and signup are idempotent and safe against duplicate callback processing.
- No data connection is implied by signing into the SaaS with Google.
- The app explains that connecting an analytics property is a separate consent action.

### 7.2 Google Search Console connection

1. User clicks **Connect GSC**.
2. Application starts Google OAuth with the GSC read-only scope and a CSRF-protected state value. Request offline access when durable access is needed. The account chooser should let the user select the Google identity with property access.
3. Google redirects to the backend callback with an authorization code.
4. Backend verifies state, exchanges the code, validates the response, stores tokens encrypted and records the provider identity.
5. Backend calls `sites.list` and presents accessible Search Console properties and permission levels.
6. User selects one or more properties and saves selection.
7. The dashboard displays the account identity used, selected properties, last validation time and connection status.

Acceptance criteria:

- No Google API key is requested from customers.
- The user may use a different Google account than the SaaS signup account.
- Only sites returned by the authorized account may be selected.
- Property IDs are preserved in provider-native form, including `sc-domain:example.com` and URL-prefix properties.
- A user with read access can connect where provider permissions allow; don't require administrator access unless the relevant API operation actually requires it.

### 7.3 GA4 connection

1. User clicks **Connect GA4**.
2. Application runs a separate or incrementally authorized Google OAuth flow requesting `analytics.readonly`.
3. User selects the relevant Google account, which may differ from the GSC account and the SaaS signup account.
4. Backend discovers available Analytics accounts/properties using the Analytics Admin API and verifies access to reporting using the Data API.
5. User selects property/properties. Store the numeric GA4 property ID, display name and property time zone where available.
6. Dashboard displays connected account, selected properties and status.

Acceptance criteria:

- GSC and GA4 connections need not be associated with the same Google account.
- The user can connect additional Google identities later.
- Analytics access is verified by a real report or metadata call, not merely by successful OAuth callback.
- Report dates use the property's time zone unless the API explicitly defines the report range differently.

### 7.4 Bing Webmaster connection

1. User clicks **Connect Bing**.
2. Prefer delegated OAuth 2.0 using the current supported Bing Webmaster REST flow and application registration owned by the SaaS operator.
3. Discover sites accessible to the authorized account; user selects sites.
4. Store refresh/access credentials securely when applicable and show connection status.

Important launch gate: Microsoft's docs state that legacy SOAP and POX API protocols were due for retirement on 31 August 2026. The current implementation must use and test supported REST routes. Do not ship based on old `/webmaster/api.svc` assumptions without validating the current endpoint, token audience, scopes and response schema.

Acceptance criteria:

- Bing is marked “coming soon” or unavailable until the REST adapter's real-account integration tests pass.
- The user never needs to provide a Google Cloud key for Bing.
- If a supported API-key path is added, the UI explains that it is a provider credential and the backend encrypts it.

### 7.5 Microsoft Clarity connection

1. User clicks **Connect Clarity**.
2. UI explains that a Clarity project administrator must generate the project's Data Export API token in Clarity Settings → Data Export.
3. User pastes the token and optionally provides a friendly project name / project identifier, if needed by the supported API contract.
4. Backend validates the token by making a bounded test request, stores it encrypted, and returns only masked status to the client.
5. User selects the connection/profile and can request recent insights.

Acceptance criteria:

- The token is sent to the backend over TLS and never stored or logged in plaintext.
- UI clearly states the export API's 1–3-day time window, 10 requests per project per day, maximum three dimensions and 1,000 rows without pagination.
- The app caches results and never calls Clarity once per conversational question by default.
- Connection is not shown as healthy if the token is invalid or the provider rejects it.

### 7.6 Claude MCP connection

1. Dashboard shows the hosted MCP endpoint and setup instructions.
2. User adds the remote connector to a supported Claude client/plan.
3. Claude discovers the OAuth authorization server and initiates OAuth authorization.
4. User signs in to the SaaS account and explicitly authorizes the MCP client.
5. MCP access token represents the SaaS user, not a provider token.
6. On every tool call, MCP validates the token and derives the caller's internal user ID.
7. The tool may access only provider connections and properties owned by that user and allowed to that MCP authorization/profile.

Acceptance criteria:

- The MCP bearer token is distinct from all provider credentials.
- The server supports token expiry/refresh and revocation according to the implemented OAuth profile.
- The application never accepts `user_id` supplied in tool input as authorization proof.
- A token for user A cannot retrieve user B's property IDs, connection records, cache entries or reports.
- Users can revoke the MCP grant without necessarily disconnecting providers, and can disconnect providers without deleting the SaaS account.

### 7.7 Natural-language reporting workflow

1. Claude interprets the question and chooses a tool.
2. Tool input is validated by a schema.
3. A deterministic query planner resolves date ranges, metrics, dimensions, filters, sort order and limit.
4. Backend verifies that the requested property belongs to the current user and is enabled for the session.
5. Provider adapter validates compatibility, calls upstream API or returns a cache hit.
6. Backend normalizes the result and includes source metadata, requested dates, actual dates, query shape, fetch time, completeness warnings and provider error details.
7. Claude interprets the structured response for the user.

### 7.8 Disconnect / revoke / delete

Users must be able to:

- Disconnect an individual property without deleting its provider grant if other properties still use it.
- Disconnect a provider connection and remove or revoke stored credentials.
- Revoke Claude/MCP access separately.
- Delete their SaaS account and have associated personal data and provider tokens removed according to the published retention policy.

Data already exported into logs/backups may follow an explicitly disclosed deletion window; don't claim immediate eradication from immutable backups unless the system actually supports it.

## 8. Functional requirements

Priority key: **P0** = must-have for MVP; **P1** = launch-following; **P2** = later.

### 8.1 Identity and access

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-001 | P0 | Support account signup/login with Google through Supabase Auth | User receives stable internal ID; basic identity sign-in alone grants no GSC/GA4 data access |
| FR-002 | P0 | Allow multiple provider identities per SaaS user | A, B and C account scenario works without email matching assumptions |
| FR-003 | P0 | Enforce per-user data isolation | Automated negative tests confirm no cross-tenant reads or writes |
| FR-004 | P0 | Support session expiry/logout | Revoked or expired app sessions cannot continue to call protected application routes |

### 8.2 Connections and properties

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-010 | P0 | Connect GSC using Google OAuth | `sites.list` succeeds and returns accessible sites |
| FR-011 | P0 | Connect GA4 using Google OAuth | Analytics property discovery works and a supported Data API check succeeds |
| FR-012 | P0 | Select/enable/disable properties | Tools can only query enabled property records owned by the user |
| FR-013 | P0 | Show connection health and reconnect action | Invalid/revoked grants are not shown as healthy |
| FR-014 | P1 | Connect Bing Webmaster using verified current REST APIs | Current auth, site discovery and at least one reporting endpoint pass live integration tests |
| FR-015 | P1 | Connect Clarity via project Data Export API token | Backend validates token; UI documents restrictions |
| FR-016 | P0 | Securely disconnect sources | Tokens are deleted/revoked as supported and cache is invalidated |

### 8.3 Report query layer

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-020 | P0 | List connected providers and selected properties | Output is filtered to current user and permitted MCP session |
| FR-021 | P0 | Query GSC performance | Supports date range, pages/queries and supported dimensions, metric selection, filters, sorting and row limits |
| FR-022 | P0 | Query GA4 reports | Supports date ranges, dimensions, metrics, filters, ordering, row limit and pagination where supported |
| FR-023 | P0 | Validate provider field compatibility | Invalid dimension/metric combinations are rejected before report execution when metadata allows validation |
| FR-024 | P0 | Return report provenance | Includes provider, property, period, timezone/date convention, fetch timestamp, cached flag and warnings |
| FR-025 | P0 | Respect provider limits | GSC row limits and incomplete-data warnings, GA4 quota handling, Clarity daily budget and date window are enforced |
| FR-026 | P1 | Query recent Clarity insights | Served from cache when possible; requests budgeted per Clarity project token |
| FR-027 | P1 | Query Bing performance | Supported reports only after REST endpoints are confirmed |
| FR-028 | P1 | Compare GSC and GA4 pages | Normalizes URLs carefully and discloses that clicks and active users are different measures |
| FR-029 | P0 | Clear error responses | Errors state provider, actionable cause and whether retry/reconnect is appropriate; no secrets exposed |

### 8.4 MCP server and OAuth

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-030 | P0 | Expose a hosted remote MCP endpoint | Claude can discover, authorize and call the endpoint with a supported remote transport |
| FR-031 | P0 | Implement authorization separate from provider OAuth | MCP tokens cannot be used as Google/Microsoft API tokens and vice versa |
| FR-032 | P0 | Use typed read-only tools | Tools accept schema-validated input and expose no arbitrary SQL/shell capability |
| FR-033 | P0 | Enforce session/property allowlist | User can only access sources and properties allowed to that MCP identity/session |
| FR-034 | P0 | Support consent/revoke/reconnect | Authorization flows are repeatable, secure and testable |
| FR-035 | P1 | Expose supported capabilities metadata | Claude can discover supported dimensions/metrics, row limits and provider restrictions |

### 8.5 Reliability and operations

| ID | Priority | Requirement | Acceptance criteria |
|---|---|---|---|
| FR-040 | P0 | Implement cache | Cache key includes user, provider, connection, property and canonical report request |
| FR-041 | P0 | Implement deadlines and retries | Timeouts bounded; retry only transient errors, using jittered backoff and retry budget |
| FR-042 | P0 | Implement provider-specific rate limit controls | No uncontrolled concurrent retries or Clarity budget overruns |
| FR-043 | P0 | Structured, redacted logging | No access tokens, refresh tokens, API keys or raw secrets in logs |
| FR-044 | P0 | Monitor provider health and tool failures | Alert thresholds and dashboards for error rate, latency and quota consumption |
| FR-045 | P0 | Automated tenant isolation tests | CI blocks release if cross-user access test fails |

## 9. Initial MCP tool contract

The product should expose a limited tool catalog rather than an unconstrained general API proxy.

### Core tools

1. `get_connection_status` — current user's provider status and last validation time.
2. `list_gsc_properties` — properties accessible through the user's connected GSC accounts.
3. `query_gsc_performance` — GSC clicks, impressions, CTR and average position.
4. `list_ga4_properties` — accessible GA4 properties.
5. `query_ga4_report` — validated GA4 report.
6. `get_clarity_insights` — recent cached/API insights, within API limits.
7. `list_bing_sites` — accessible Bing sites after endpoint verification.
8. `query_bing_performance` — supported Bing reporting queries after endpoint verification.
9. `get_supported_metrics` — provider-specific field catalog and limitations.

### Query properties

- `property_id`: provider-native ID; never trusted until ownership check passes.
- `start_date`, `end_date`: ISO `YYYY-MM-DD`, validated against source retention and freshness.
- `dimensions`: allowlisted provider fields.
- `metrics`: allowlisted provider fields.
- `filters`: typed filter objects with supported operators only.
- `order_by`: metric/dimension and direction from an allowlist.
- `limit`: bounded integer; default 25, max per tool documented and provider-appropriate.
- `page_token` or offset: exposed only where upstream provider supports pagination.

Do not offer generic endpoint URLs, raw request bodies, arbitrary header injection, arbitrary SQL, or tool inputs that accept provider access tokens.

## 10. Reporting semantics and user-facing limitations

### Search Console

- Performance data covers a rolling retention window of approximately 16 months; older data cannot be assumed available unless the user separately exported it.
- API queries use dates as defined by Google (the Search Analytics API documents dates in Pacific Time).
- Results are subject to internal data limits. A row limit and pagination do not guarantee full exhaustiveness for every query.
- Recent days may be incomplete; the date resolver should default to the most recent sufficiently complete date and return the exact dates.

### GA4

- The Data API reports GA4 data, not legacy Universal Analytics data.
- Use the property's reporting time zone where applicable.
- Validate dimensions and metrics with `getMetadata` and/or `checkCompatibility`.
- API quotas vary by method/category, project and property; capture quota information when provided.
- Reporting identity, thresholding, attribution settings and API/data model mean numbers may require contextual explanation.

### Bing Webmaster Tools

- Implement only current verified REST routes after the 31 August 2026 legacy protocol retirement date.
- Keep Bing behind a provider adapter and feature flag until live validation is complete.
- Only expose dimensions, date ranges and reports actually supported by the selected REST API.

### Microsoft Clarity

- Data Export API window: `numOfDays` 1, 2 or 3 (last 24/48/72 hours as documented).
- Maximum 10 API requests per project per day.
- Maximum three dimensions in a request.
- Maximum 1,000 rows and no pagination.
- API returns data in UTC according to the current documentation.
- Cache reports and disclose the fetch timestamp / period. The application must not promise 30-day Clarity history from this API.

## 11. UX requirements and key screens

1. **Marketing / signup:** plain product description, supported platforms, security summary, link to privacy policy/terms.
2. **Dashboard:** provider cards with Connect/Connected/Needs attention/Disconnected state; account identity used; property counts; last validation time.
3. **Provider connection flow:** provider-specific consent/instructions; clear scopes; recoverable errors.
4. **Property selector:** search/sort accessible properties, display property ID and provider, select one or more, enable/disable query access.
5. **Connection profile:** named grouping of selected connections/properties for an MCP user session. Must not act as an authentication secret by itself.
6. **Claude setup:** remote MCP URL, step-by-step directions, OAuth explanation, test connection button if technically possible.
7. **Security / data controls:** revoke Claude access, disconnect providers, remove properties, delete account, view last connection event.
8. **Limits & usage:** Clarity daily request usage, cache status, API quota issues where accessible, and reconnect prompts.

## 12. Error and recovery UX

Every failure should be categorized and actionable:

- `AUTH_EXPIRED`: reconnect provider.
- `AUTH_REVOKED`: reconnect provider and clarify that Google/Microsoft permission may have been revoked.
- `PROPERTY_NOT_ACCESSIBLE`: refresh property list or authorize the correct provider account.
- `INVALID_QUERY`: correct metric/dimension/filter combination.
- `DATE_RANGE_UNSUPPORTED`: show supported window and suggested range.
- `RATE_LIMITED`: serve cached result if acceptable, otherwise explain reset/retry timing without guessing exact reset time.
- `PROVIDER_UNAVAILABLE`: temporary failure; allow retry after bounded backoff.
- `PARTIAL_DATA`: provide returned data and exact limitation.
- `MCP_AUTH_REQUIRED`: reconnect/reauthorize Claude connector.
- `FORBIDDEN`: do not reveal existence or details of another user's property.

Error messages must not expose access tokens, client secrets, provider API keys, stack traces, internal database IDs or raw upstream response bodies that may contain sensitive data.

## 13. Security, privacy and compliance requirements

- TLS for all traffic.
- Least-privilege scopes; read-only for MVP.
- Server-side token exchange and refresh.
- Encrypt OAuth refresh tokens, access tokens where persisted, and manual API tokens using envelope encryption or an appropriate managed secret/KMS solution. Encryption key material must live outside the same database records and outside the frontend.
- Never expose provider tokens or Supabase service-role credentials to browser code or MCP tool results.
- Use Supabase RLS for user-owned records; server-side privileged operations must enforce ownership explicitly because service-role access can bypass RLS.
- Validate MCP bearer tokens using the configured OAuth/resource-server contract; verify audience/resource and issuer according to the implemented MCP authorization profile.
- OAuth `state`, PKCE where appropriate, strict redirect URI allowlists, nonce where applicable, and single-use callback state.
- Apply CSRF protection to cookie-authenticated mutations.
- Limit login and OAuth attempts; implement abuse controls and per-user/provider budgets.
- Redact email addresses or search query data from logs unless operationally required; do not log secrets.
- Establish a privacy policy covering Google data access/storage/use/sharing/retention/deletion before public launch.
- Google OAuth app verification may be required for sensitive scopes and public use. Determine exact requirements in Cloud Console; do not assume read-only means verification-free.
- Perform a security review before storing data for external customers. Check whether Google's current scope categorization and data policy create any third-party security assessment obligations.
- Provide account and credential deletion mechanisms, incident response, retention policy and customer support contact.

## 14. Dependencies and external constraints

- Google Cloud project, enabled APIs and OAuth client controlled by the product operator.
- Published, branded public website and legal pages for Google OAuth review.
- Google OAuth review and possible scope verification.
- Supabase Auth and Postgres, plus a tested OAuth 2.1/OIDC server implementation for Claude. Supabase's OAuth 2.1 Server is a current option, but verify its maturity and Claude interoperability before committing; use a dedicated issuer if needed.
- Claude plan/client that supports remote MCP custom connectors. Anthropic documentation currently lists Pro, Max, Team and Enterprise for remote custom connectors; availability may change.
- Current Bing REST documentation and live integration test account.
- Clarity administrator-generated API token for each project.
- Production hosting, secret manager/KMS, monitoring and backup plan.

## 15. Acceptance test scenarios

1. **Different Google accounts:** user signs up with Account A, connects GSC with B and GA4 with C; reports return B's GSC property and C's GA4 property.
2. **Multiple GSC properties:** one authorized account selects two GSC properties and queries each independently.
3. **No permission:** user authorizes a Google account with no accessible GSC sites; no fabricated property is shown.
4. **Provider token refresh:** expired access token refreshes server-side; refresh failure causes `Needs attention` state.
5. **Revocation:** revoke Google access and verify subsequent reports fail safely and the UI asks to reconnect.
6. **Cross-tenant denial:** user A submits user B's property ID; backend returns forbidden/not-found semantics without data leakage.
7. **GSC top pages:** query top 20 pages by clicks over a date range; verify dates, sort, row limit, property and warnings.
8. **GA4 top pages:** query top 30 pages by active users; validate metric/dimension compatibility and time-zone semantics.
9. **Cross-source comparison:** URL normalization preserves meaningful paths/query strings and the result labels GSC clicks and GA4 active users separately.
10. **Clarity quota:** simulate 10 consumed requests; repeated questions use cache and no 11th upstream request is made.
11. **Clarity long range:** request 30 days; tool returns a limitation rather than inventing historical data.
12. **Bing feature gate:** adapter remains unavailable until REST OAuth, site discovery and reporting tests pass.
13. **Claude OAuth:** connector completes OAuth, calls `get_connection_status`, and cannot use a token issued for a different audience.
14. **No secret leakage:** inspect browser bundles, API responses, tool results and logs; no tokens/secrets present.
15. **Provider timeout/429/5xx:** bounded retries and meaningful error objects are returned without crashing the MCP process.

## 16. Rollout plan

### Phase 0 — Feasibility and policy gates

- Confirm Google OAuth scope classification and verification requirements.
- Prove separate provider account grants (A/B/C account scenario).
- Prove Claude remote MCP OAuth end to end.
- Verify current Bing REST routes and a current live API call.
- Confirm Supabase OAuth server behavior and supported scope/resource semantics.

### Phase 1 — Foundation

- Supabase Auth, profiles, migrations and RLS.
- Dashboard and connection status UI.
- Secret storage/encryption path.
- Audit and structured logging baseline.

### Phase 2 — GSC and GA4

- Google OAuth callback and refresh lifecycle.
- GSC property discovery and query tool.
- GA4 property discovery, metadata/compatibility and report tool.
- Date resolver, cache, rate limits and error contract.

### Phase 3 — Remote MCP and Claude

- MCP HTTP transport and tool registry.
- OAuth authorization/resource server integration.
- Per-user connection/property authorization.
- End-to-end testing through an actual supported Claude client.

### Phase 4 — Clarity and Bing

- Clarity token management, request budget and cache-first insights.
- Bing REST adapter only after current endpoints and OAuth are tested.

### Phase 5 — Public beta

- OAuth verification, public docs/legal pages, usage limits, privacy/retention policies.
- Penetration/security review and load tests.
- Instrument onboarding, query success, latency, cache and cost.

## 17. Open decisions

1. Is the initial launch free, freemium, or invite-only? Authentication design should not depend on this decision.
2. Is a user allowed multiple named MCP connection profiles, or just one default profile for the MVP?
3. What is the maximum number of properties and report rows per user on a free tier?
4. Do we retain any query result history, or only short-lived cache entries?
5. Will we support only Claude initially, or keep the OAuth/MCP implementation client-agnostic?
6. Which production host and managed key store will be used? This should be chosen before implementing secret encryption.
7. Which current Bing REST endpoints are confirmed for required reports as of launch? No assumptions should be made until verified against current Microsoft docs and live tests.

## 18. Definition of done for MVP

MVP is done when a real external pilot user can sign in, connect GSC with a Google account different from their signup account, connect GA4 using another Google identity if needed, select properties, connect Claude using OAuth, and successfully retrieve supported reports. The implementation must include ownership checks, encryption, cache and provider-limit handling, refresh/reconnect behavior, automated isolation tests and user-facing API limitation messages. Bing must be clearly labeled as unavailable until its REST adapter is proven. Clarity must not be marketed as supporting historical windows beyond its documented API.

## 19. Primary references

- Google OAuth web-server flow and offline access: <https://developers.google.com/identity/protocols/oauth2/web-server>
- Google OAuth verification and sensitive-scope guidance: <https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification>
- Google Search Console `sites.list`: <https://developers.google.com/webmaster-tools/v1/sites/list>
- Google Search Analytics query: <https://developers.google.com/webmaster-tools/v1/searchanalytics/query>
- Google Analytics Data API overview: <https://developers.google.com/analytics/devguides/reporting/data/v1>
- GA4 Data API quotas: <https://developers.google.com/analytics/devguides/reporting/data/v1/quotas>
- GA4 metadata and compatibility: <https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties>
- Bing Webmaster API overview: <https://learn.microsoft.com/en-us/bingwebmaster/>
- Bing Webmaster OAuth 2.0: <https://learn.microsoft.com/en-us/bingwebmaster/oauth2>
- Microsoft Clarity Data Export API: <https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api>
- MCP Authorization specification: <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- Supabase OAuth 2.1 Server: <https://supabase.com/docs/guides/auth/oauth-server>
- Anthropic remote MCP connector development: <https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers>
- Anthropic remote MCP connector setup: <https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp>

---

**End of PRD**
