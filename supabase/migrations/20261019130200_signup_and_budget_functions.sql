-- Functions kept in the non-exposed "private" schema so they are not reachable via the Data API.

-- Create a profile whenever a SaaS user signs up. Idempotent, so duplicate callbacks are safe.
-- SECURITY DEFINER is required here because the trigger runs as the auth system role and must
-- write to public.profiles; it takes no user input and lives outside the exposed schema.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Atomically consume one unit of a provider's daily budget. A single INSERT ... ON CONFLICT
-- statement means concurrent callers cannot read-then-write past the limit.
-- Returns the new count, or no row when the limit has already been reached.
create or replace function private.consume_provider_budget(
  p_provider text,
  p_project_key text,
  p_period date,
  p_limit integer
)
returns table (used integer)
language sql
set search_path = ''
as $$
  insert into public.provider_request_budgets as b (provider, project_key, period_start, request_count)
  values (p_provider, p_project_key, p_period, 1)
  on conflict (provider, project_key, period_start)
  do update set request_count = b.request_count + 1, updated_at = now()
  where b.request_count < p_limit
  returning b.request_count;
$$;

revoke all on function private.consume_provider_budget(text, text, date, integer) from public, anon, authenticated;
