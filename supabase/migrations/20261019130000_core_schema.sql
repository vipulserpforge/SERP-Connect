-- Core schema for the SEO Analytics MCP Connector.
--
-- Identity model (PRD section 1): the SaaS identity is auth.users.id. Provider
-- accounts (Google account B for GSC, account C for GA4, ...) live in
-- provider_connections and are NEVER matched to the SaaS user by email.
--
-- Ownership model: every user-owned table carries user_id. Cross-table links use
-- composite foreign keys (id, user_id) so the database itself rejects a row that
-- points at another tenant's connection, property or profile.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Keeps updated_at honest without relying on application code.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: one row per SaaS user
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- provider_connections: one row per provider grant (Google account, Clarity project token, ...)
-- ---------------------------------------------------------------------------
create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google', 'bing', 'clarity')),
  -- Stable external subject (e.g. Google "sub"). Email is display data only.
  provider_account_id text,
  -- Masked label for the UI; never used for identity or authorization.
  account_label text,
  status text not null default 'pending'
    check (status in ('connected', 'needs_attention', 'revoked', 'disconnected', 'pending')),
  granted_scopes text[] not null default '{}',
  credential_version integer not null default 1,
  last_validated_at timestamptz,
  -- Safe, normalized error code only (never raw upstream text).
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of composite foreign keys that must stay inside one tenant.
  constraint provider_connections_id_user_key unique (id, user_id)
);

-- The same external account cannot be connected twice by the same user.
create unique index provider_connections_user_account_key
  on public.provider_connections (user_id, provider, provider_account_id)
  where provider_account_id is not null;
create index provider_connections_user_provider_status_idx
  on public.provider_connections (user_id, provider, status);

create trigger provider_connections_set_updated_at
  before update on public.provider_connections
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- provider_secrets: encrypted credentials. Server-only (no client grants, see RLS migration).
-- Columns mirror the EncryptedSecret type in @serp/secrets; all values are base64 text.
-- ---------------------------------------------------------------------------
create table public.provider_secrets (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null unique references public.provider_connections (id) on delete cascade,
  ciphertext text not null,
  nonce text not null,
  auth_tag text not null,
  wrapped_dek text not null,
  key_version text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

-- ---------------------------------------------------------------------------
-- properties: provider-native properties a user may query
-- ---------------------------------------------------------------------------
create table public.properties (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  connection_id uuid not null,
  provider text not null check (provider in ('gsc', 'ga4', 'bing', 'clarity')),
  -- Provider-native key, e.g. "sc-domain:example.com", GA4 numeric id, Clarity project id.
  external_property_id text not null,
  display_name text not null,
  property_type text,
  timezone text,
  enabled_for_mcp boolean not null default true,
  last_discovered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint properties_id_user_key unique (id, user_id),
  -- A property can only hang off a connection owned by the same user.
  constraint properties_connection_owner_fk
    foreign key (connection_id, user_id)
    references public.provider_connections (id, user_id) on delete cascade,
  constraint properties_connection_external_key unique (connection_id, provider, external_property_id)
);

create index properties_user_provider_enabled_idx
  on public.properties (user_id, provider, enabled_for_mcp);
create index properties_connection_user_idx
  on public.properties (connection_id, user_id);

create trigger properties_set_updated_at
  before update on public.properties
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- mcp_connection_profiles: named allowlists for MCP sessions. The profile id is NOT a secret.
-- ---------------------------------------------------------------------------
create table public.mcp_connection_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mcp_connection_profiles_id_user_key unique (id, user_id),
  constraint mcp_connection_profiles_user_name_key unique (user_id, name)
);

create trigger mcp_connection_profiles_set_updated_at
  before update on public.mcp_connection_profiles
  for each row execute function private.set_updated_at();

create table public.mcp_profile_properties (
  profile_id uuid not null,
  property_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, property_id),
  -- Both sides must belong to the same user; the DB rejects cross-tenant joins.
  constraint mcp_profile_properties_profile_fk
    foreign key (profile_id, user_id)
    references public.mcp_connection_profiles (id, user_id) on delete cascade,
  constraint mcp_profile_properties_property_fk
    foreign key (property_id, user_id)
    references public.properties (id, user_id) on delete cascade
);

create index mcp_profile_properties_property_idx on public.mcp_profile_properties (property_id);
create index mcp_profile_properties_user_idx on public.mcp_profile_properties (user_id);

-- ---------------------------------------------------------------------------
-- report_cache: server-only, partitioned by user/provider/connection/property
-- ---------------------------------------------------------------------------
create table public.report_cache (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('gsc', 'ga4', 'bing', 'clarity')),
  connection_id uuid not null,
  property_id uuid not null,
  canonical_query_hash text not null,
  -- Redacted, normalized query parameters. Never credentials.
  query_metadata jsonb not null default '{}'::jsonb,
  result_payload jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  row_count integer,
  warnings jsonb not null default '[]'::jsonb,
  constraint report_cache_connection_owner_fk
    foreign key (connection_id, user_id)
    references public.provider_connections (id, user_id) on delete cascade,
  constraint report_cache_property_owner_fk
    foreign key (property_id, user_id)
    references public.properties (id, user_id) on delete cascade,
  constraint report_cache_key unique (user_id, provider, connection_id, property_id, canonical_query_hash)
);

create index report_cache_expires_at_idx on public.report_cache (expires_at);
create index report_cache_property_idx on public.report_cache (property_id, user_id);
create index report_cache_connection_idx on public.report_cache (connection_id, user_id);

-- ---------------------------------------------------------------------------
-- provider_request_budgets: atomic per-project daily budgets (Clarity: 10/day)
-- ---------------------------------------------------------------------------
create table public.provider_request_budgets (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('gsc', 'ga4', 'bing', 'clarity')),
  -- External project identifier, so two SaaS users sharing one Clarity project share one budget.
  project_key text not null,
  period_start date not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  constraint provider_request_budgets_key unique (provider, project_key, period_start)
);

-- ---------------------------------------------------------------------------
-- audit_events: redacted account activity. Never tokens, codes or report bodies.
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 80),
  provider text,
  connection_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create index audit_events_user_created_idx on public.audit_events (user_id, created_at desc);
create index audit_events_connection_idx on public.audit_events (connection_id);
