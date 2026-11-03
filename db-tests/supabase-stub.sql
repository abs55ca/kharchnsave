-- Minimal stand-ins for the parts of Supabase the migrations rely on, for
-- plain PostgreSQL (db-tests on a local server, never a Supabase project):
-- the API roles, auth.uid()/auth.jwt() reading request.jwt.claims the way
-- PostgREST sets it, auth.users, storage.objects and Supabase's default
-- privileges in the public schema. NOT Supabase itself; Auth, Storage and the
-- HTTP API are not simulated.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end;
$$;

create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
grant usage on schema auth to anon, authenticated;
grant execute on all functions in schema auth to anon, authenticated;

create schema storage;
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, delete on storage.objects to anon, authenticated;

grant usage on schema public to anon, authenticated;

-- Like Supabase's rls_auto_enable(): a platform event-trigger function in
-- public, SECURITY DEFINER with search_path = pg_catalog (not ours).
create function public.rls_auto_enable() returns event_trigger
  language plpgsql security definer set search_path = pg_catalog
  as $$ begin end; $$;

-- Supabase's default privileges for objects created in public.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
