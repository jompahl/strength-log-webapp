begin;
create extension if not exists supabase_vault with schema vault;

create or replace function public.server_get_integration(p_user_id uuid, p_provider text)
returns jsonb language sql set search_path = '' as $$
  select pg_catalog.jsonb_build_object('secret', s.decrypted_secret, 'meta', i.meta)
  from public.user_integrations i
  join vault.decrypted_secrets s on s.id = i.secret_id
  where i.user_id = p_user_id and i.provider = p_provider and p_provider = 'openrouter';
$$;

create or replace function public.server_set_integration(p_user_id uuid, p_provider text, p_secret text, p_meta jsonb)
returns void language plpgsql set search_path = '' as $$
declare sid uuid;
begin
  if p_user_id is null or p_provider is distinct from 'openrouter' or nullif(p_secret, '') is null then
    raise exception 'Invalid integration';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':openrouter', 0));
  select secret_id into sid from public.user_integrations where user_id = p_user_id and provider = p_provider;
  if sid is null then
    sid := vault.create_secret(p_secret);
    insert into public.user_integrations(user_id, provider, secret_id, meta) values (p_user_id, p_provider, sid, p_meta);
  else
    perform vault.update_secret(sid, p_secret);
    update public.user_integrations set meta = p_meta, updated_at = now() where user_id = p_user_id and provider = p_provider;
  end if;
end;
$$;

create or replace function public.server_delete_integration(p_user_id uuid, p_provider text)
returns void language plpgsql set search_path = '' as $$
declare sid uuid;
begin
  if p_user_id is null or p_provider is distinct from 'openrouter' then
    raise exception 'Invalid integration';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':openrouter', 0));
  delete from public.user_integrations where user_id = p_user_id and provider = p_provider returning secret_id into sid;
  delete from vault.secrets where id = sid;
end;
$$;

revoke all on function public.server_get_integration(uuid, text),
  public.server_set_integration(uuid, text, text, jsonb),
  public.server_delete_integration(uuid, text) from public, anon, authenticated;
grant execute on function public.server_get_integration(uuid, text),
  public.server_set_integration(uuid, text, text, jsonb),
  public.server_delete_integration(uuid, text) to service_role;
grant select, insert, update, delete on public.user_integrations to service_role;
notify pgrst, 'reload schema';
commit;
