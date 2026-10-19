-- Microsoft Clarity: durable, concurrency-safe request reservations.
--
-- Clarity's Data Export API allows 10 requests per project per day. provider_request_budgets already holds the
-- per-day counter; this migration adds a ledger so each reserved request is tracked until it completes, plus two
-- functions that change the counter and the ledger in ONE statement (no read-then-write race between instances).
--
-- The ledger is server-only: RLS enabled, no policy, no grants for anon/authenticated.

create table public.provider_request_reservations (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('gsc', 'ga4', 'bing', 'clarity')),
  -- Keyed fingerprint of the credential (never the credential): the quota group.
  project_key text not null check (char_length(project_key) between 1 and 200),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Kept (set null) when the connection is removed, so quota accounting survives a disconnect/reconnect.
  connection_id uuid references public.provider_connections (id) on delete set null,
  period_start date not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'succeeded', 'failed', 'provider_limited')),
  http_status integer,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index provider_request_reservations_project_idx
  on public.provider_request_reservations (provider, project_key, period_start);
create index provider_request_reservations_user_idx
  on public.provider_request_reservations (user_id, created_at desc);
create index provider_request_reservations_connection_idx
  on public.provider_request_reservations (connection_id);

alter table public.provider_request_reservations enable row level security;
revoke all on table public.provider_request_reservations from anon, authenticated;

-- Atomically takes one unit of the budget and records the reservation. Returns no row when the budget is used up.
-- A single statement: the counter upsert and the ledger insert commit together.
create or replace function private.reserve_provider_request(
  p_provider text,
  p_project_key text,
  p_period date,
  p_limit integer,
  p_user_id uuid,
  p_connection_id uuid
)
returns table (reservation_id uuid, used integer)
language sql
set search_path = ''
as $$
  with taken as (
    insert into public.provider_request_budgets as b (provider, project_key, period_start, request_count)
    values (p_provider, p_project_key, p_period, 1)
    on conflict (provider, project_key, period_start)
    do update set request_count = b.request_count + 1, updated_at = now()
    where b.request_count < p_limit
    returning b.request_count
  ), logged as (
    insert into public.provider_request_reservations (provider, project_key, user_id, connection_id, period_start)
    select p_provider, p_project_key, p_user_id, p_connection_id, p_period from taken
    returning id
  )
  select logged.id, taken.request_count from logged, taken;
$$;

-- After the provider answers 429, the local budget for that window is treated as spent (we cannot know the provider's
-- exact reset), so no further requests are made until the next window.
create or replace function private.exhaust_provider_budget(
  p_provider text,
  p_project_key text,
  p_period date,
  p_limit integer
)
returns void
language sql
set search_path = ''
as $$
  insert into public.provider_request_budgets as b (provider, project_key, period_start, request_count)
  values (p_provider, p_project_key, p_period, p_limit)
  on conflict (provider, project_key, period_start)
  do update set request_count = greatest(b.request_count, p_limit), updated_at = now();
$$;

revoke all on function private.reserve_provider_request(text, text, date, integer, uuid, uuid) from public, anon, authenticated;
revoke all on function private.exhaust_provider_budget(text, text, date, integer) from public, anon, authenticated;
