-- Bing Webmaster Tools connections.
--
-- * provider_connections.auth_method records HOW a connection authenticates ("oauth" or "api_key"), so the API client
--   never has to guess and never silently falls back from one to the other. Null for Google and Clarity.
-- * oauth_states now serves Bing too. Microsoft documents no PKCE for this flow, so there is no verifier to store
--   (code_verifier_enc becomes optional). connection_id binds a reconnect attempt to the connection it is meant for.

alter table public.provider_connections
  add column auth_method text check (auth_method is null or auth_method in ('oauth', 'api_key'));

alter table public.oauth_states
  drop constraint oauth_states_product_check;
alter table public.oauth_states
  add constraint oauth_states_product_check check (product in ('gsc', 'ga4', 'bing'));
alter table public.oauth_states
  alter column code_verifier_enc drop not null;
alter table public.oauth_states
  add column connection_id uuid;

-- The browser may read the auth method (it is shown on the connection card). Nothing else changes.
grant select (auth_method) on public.provider_connections to authenticated;
