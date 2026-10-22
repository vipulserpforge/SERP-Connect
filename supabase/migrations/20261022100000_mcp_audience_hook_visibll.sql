-- The MCP server moved to https://mcp.visibll.in. Re-create the Custom Access Token Hook with the new audience.
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
    claims := jsonb_set(claims, '{aud}', to_jsonb('https://mcp.visibll.in/mcp'::text));
    event := jsonb_set(event, '{claims}', claims);
  end if;
  return event;
end;
$$;
