-- Custom Access Token Hook: bind OAuth access tokens to the MCP server (audience binding).
--
-- Supabase puts aud = 'authenticated' in every token and has no RFC 8707 "resource" support. The MCP server must not
-- accept a token that was issued for something else, so tokens issued to an OAuth client (Claude) get
-- aud = the MCP URL. Only tokens that carry a client_id are changed: ordinary website sessions keep
-- aud = 'authenticated', so the dashboard, RLS and the Supabase API are unaffected.
--
-- The hook is registered in the Supabase Dashboard (Authentication > Hooks), not in SQL.
-- The audience below must equal MCP_RESOURCE_AUDIENCE of the MCP server.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  claims jsonb := event->'claims';
begin
  if claims ? 'client_id' and coalesce(claims->>'client_id', '') <> '' then
    claims := jsonb_set(claims, '{aud}', to_jsonb('https://mcp.serpforge.io/mcp'::text));
    event := jsonb_set(event, '{claims}', claims);
  end if;
  return event;
end;
$$;

-- Only Supabase Auth may run the hook; it must not be callable through the public API.
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
