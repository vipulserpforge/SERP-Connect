-- Row Level Security and privileges.
--
-- Two layers, both required:
--   1. GRANTs decide which tables/columns a role can touch at all.
--   2. RLS policies decide which rows an allowed role can see or change.
-- Supabase grants broad default privileges to anon/authenticated on new tables, so we
-- revoke everything first and grant back only what the browser-facing roles need.
-- Server code (service role / direct DB connection) additionally filters by user_id in
-- every query; see the Repository contract in packages/db.

alter table public.profiles enable row level security;
alter table public.provider_connections enable row level security;
alter table public.provider_secrets enable row level security;
alter table public.properties enable row level security;
alter table public.mcp_connection_profiles enable row level security;
alter table public.mcp_profile_properties enable row level security;
alter table public.report_cache enable row level security;
alter table public.provider_request_budgets enable row level security;
alter table public.audit_events enable row level security;

-- Start from zero for the browser-facing roles. The anon role gets nothing, ever.
revoke all on table
  public.profiles,
  public.provider_connections,
  public.provider_secrets,
  public.properties,
  public.mcp_connection_profiles,
  public.mcp_profile_properties,
  public.report_cache,
  public.provider_request_budgets,
  public.audit_events
from anon, authenticated;

-- ---------------------------------------------------------------------------
-- profiles: read and rename own profile. Rows are created by the signup trigger.
-- ---------------------------------------------------------------------------
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

create policy profiles_select_own on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- provider_connections: read-only for the browser. Connections, scopes and status are
-- written by trusted server code after a verified OAuth callback, so a user cannot
-- forge a "connected" state or edit granted scopes from the client.
-- ---------------------------------------------------------------------------
grant select (
  id, user_id, provider, provider_account_id, account_label, status,
  granted_scopes, last_validated_at, last_error_code, created_at, updated_at
) on public.provider_connections to authenticated;

create policy provider_connections_select_own on public.provider_connections
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- provider_secrets, report_cache, provider_request_budgets: RLS enabled, no policies and no
-- grants for anon/authenticated => unreachable from the Data API. Only server roles use them.

-- ---------------------------------------------------------------------------
-- properties: users can see their properties and flip the MCP allowlist switch.
-- ---------------------------------------------------------------------------
grant select on public.properties to authenticated;
grant update (enabled_for_mcp) on public.properties to authenticated;

create policy properties_select_own on public.properties
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy properties_update_own on public.properties
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- MCP profiles and their property allowlists: full management of own rows.
-- Composite foreign keys additionally block pointing at someone else's property.
-- ---------------------------------------------------------------------------
grant select, insert, delete on public.mcp_connection_profiles to authenticated;
grant update (name, status) on public.mcp_connection_profiles to authenticated;

create policy mcp_profiles_select_own on public.mcp_connection_profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy mcp_profiles_insert_own on public.mcp_connection_profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy mcp_profiles_update_own on public.mcp_connection_profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy mcp_profiles_delete_own on public.mcp_connection_profiles
  for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, delete on public.mcp_profile_properties to authenticated;

create policy mcp_profile_properties_select_own on public.mcp_profile_properties
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy mcp_profile_properties_insert_own on public.mcp_profile_properties
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy mcp_profile_properties_delete_own on public.mcp_profile_properties
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- audit_events: users may read their own activity; only the server writes it.
-- ---------------------------------------------------------------------------
grant select (id, user_id, event_type, provider, connection_id, created_at) on public.audit_events to authenticated;

create policy audit_events_select_own on public.audit_events
  for select to authenticated
  using ((select auth.uid()) = user_id);
