-- Single-use OAuth attempts for provider connect flows (Google first).
--
-- Server-only: RLS is enabled with no policies and no grants for anon/authenticated, so the table
-- is unreachable from the Data API. Only the state HASH is stored, so a read of this table cannot be
-- replayed against the callback. The PKCE verifier is stored encrypted (envelope encryption, same
-- scheme as provider_secrets) and the row is bound to the user who started the flow.

create table public.oauth_states (
  state_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  product text not null check (product in ('gsc', 'ga4')),
  code_verifier_enc jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index oauth_states_user_idx on public.oauth_states (user_id);
create index oauth_states_expires_idx on public.oauth_states (expires_at);

alter table public.oauth_states enable row level security;
revoke all on table public.oauth_states from anon, authenticated;
