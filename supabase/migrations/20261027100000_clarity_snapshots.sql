-- Microsoft Clarity: saved history of every live pull.
--
-- Clarity only ever returns the last 1-3 days and has no history. Each live pull is kept here with the time it was pulled,
-- so a later question can compare today with earlier pulls. Server-only: RLS enabled, no policy, no browser grants.
-- Rows are removed with the user or the connection (privacy first), and the application prunes pulls older than 90 days.

create table public.clarity_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  connection_id uuid not null references public.provider_connections (id) on delete cascade,
  -- The project as the app identifies it (the property's external id).
  project_key text not null check (char_length(project_key) between 1 and 200),
  num_of_days smallint not null check (num_of_days between 1 and 3),
  dimensions text[] not null default '{}',
  -- Stable text form of the dimensions ("Source|Medium"), used to find pulls of the same shape.
  dimensions_key text not null default '',
  pulled_at timestamptz not null,
  row_count integer not null check (row_count >= 0),
  -- The provider's normalized result (rows and metric blocks). Never contains the token.
  payload jsonb not null
);

create index clarity_snapshots_lookup_idx
  on public.clarity_snapshots (user_id, project_key, dimensions_key, pulled_at desc);
create index clarity_snapshots_connection_idx on public.clarity_snapshots (connection_id);

alter table public.clarity_snapshots enable row level security;
revoke all on table public.clarity_snapshots from anon, authenticated;
