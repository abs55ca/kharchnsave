-- Admin membership tests: who can see and change public.admin_members.
--
-- Run after supabase/migrations/20261027200000_create_admin_members.sql, as
-- the database owner (the Supabase SQL editor runs as postgres). Everything
-- happens in one transaction that is ROLLED BACK: the three test users and
-- their memberships are never kept, and real users are not touched.
--
-- Signed-in users are simulated the way Supabase's API does it: switch to the
-- `authenticated` role and set request.jwt.claims, which auth.uid() reads.
--
-- Result: the script completes without an error only if every test passed.
-- The first failure stops it with "FAIL <test>: <reason>".

begin;

create schema admin_tests;

create function admin_tests.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL %: %', label, detail;
  end if;
  raise notice 'PASS %', label;
end;
$$;

create function admin_tests.returns(label text, query text, expected text)
returns void language plpgsql as $$
declare
  actual text;
begin
  execute query into actual;
  perform admin_tests.check(label, coalesce(actual, '') = expected,
    format('expected [%s], got [%s]', expected, coalesce(actual, '')));
end;
$$;

create function admin_tests.affects(label text, statement text, expected integer)
returns void language plpgsql as $$
declare
  actual integer;
begin
  execute statement;
  get diagnostics actual = row_count;
  perform admin_tests.check(label, actual = expected,
    format('expected %s row(s) changed, got %s', expected, actual));
end;
$$;

create function admin_tests.throws(
  label text, statement text, expected_state text, expected_constraint text default null
)
returns void language plpgsql as $$
declare
  got_state text;
  got_constraint text;
  got_message text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics
      got_state = returned_sqlstate,
      got_constraint = constraint_name,
      got_message = message_text;
  end;
  if got_state is null then
    raise exception 'FAIL %: statement succeeded but should have been rejected', label;
  end if;
  if got_state <> expected_state
    or (expected_constraint is not null and got_constraint is distinct from expected_constraint) then
    raise exception 'FAIL %: expected % %, got % % (%)', label, expected_state,
      coalesce(expected_constraint, ''), got_state, coalesce(got_constraint, ''), got_message;
  end if;
  raise notice 'PASS %', label;
end;
$$;

grant usage on schema admin_tests to anon, authenticated;
grant execute on all functions in schema admin_tests to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Test users: A and C are admins, B is signed in but not an admin
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('a0a0a0a0-0000-4000-8000-00000000000a', 'admin-a@test.invalid'),
  ('b0b0b0b0-0000-4000-8000-00000000000b', 'user-b@test.invalid'),
  ('c0c0c0c0-0000-4000-8000-00000000000c', 'admin-c@test.invalid');

insert into public.admin_members (user_id) values
  ('a0a0a0a0-0000-4000-8000-00000000000a'),
  ('c0c0c0c0-0000-4000-8000-00000000000c');

select admin_tests.returns('setup: the owner sees both test memberships',
  $q$ select count(*)::text from public.admin_members
      where user_id in ('a0a0a0a0-0000-4000-8000-00000000000a', 'c0c0c0c0-0000-4000-8000-00000000000c') $q$, '2');

-- ---------------------------------------------------------------------------
-- Security set-up
-- ---------------------------------------------------------------------------

select admin_tests.returns('RLS is enabled on admin_members',
  $q$ select relrowsecurity::text from pg_class where oid = 'public.admin_members'::regclass $q$, 'true');

select admin_tests.returns('visitors (anon) have no privileges at all',
  $q$ select string_agg(p, ', ' order by p)
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      where has_table_privilege('anon', 'public.admin_members', p)
         or (p in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege('anon', 'public.admin_members', p)) $q$, '');

select admin_tests.returns('signed-in users can SELECT',
  $q$ select has_table_privilege('authenticated', 'public.admin_members', 'SELECT')::text $q$, 'true');

select admin_tests.returns('signed-in users have no write privileges',
  $q$ select string_agg(p, ', ' order by p)
      from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      where has_table_privilege('authenticated', 'public.admin_members', p)
         or (p in ('INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege('authenticated', 'public.admin_members', p)) $q$, '');

select admin_tests.returns('the only policy is SELECT for authenticated',
  $q$ select string_agg(policyname || ' ' || cmd || ' ' || array_to_string(roles, '+'), ', ')
      from pg_policies where schemaname = 'public' and tablename = 'admin_members' $q$,
  'Users can see their own admin membership SELECT authenticated');

-- Catalogue write access for verified admins (membership + aal2) is added by
-- 20261029120000_admin_product_management.sql and tested in
-- product_management_test.sql. Visitors still can't write at all.
select admin_tests.returns('catalogue tables are still read-only for anon',
  $q$ select string_agg(t || ' ' || p, ', ')
      from unnest(array['public.products', 'public.product_variants', 'public.product_images']) t,
           unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      where has_table_privilege('anon', t, p) $q$, '');

-- ---------------------------------------------------------------------------
-- What each kind of user can see and do
-- ---------------------------------------------------------------------------

create function admin_tests.as_admin_a()
returns void language plpgsql as $$
begin
  perform admin_tests.check('admin A: auth.uid() is A',
    auth.uid() = 'a0a0a0a0-0000-4000-8000-00000000000a', coalesce(auth.uid()::text, 'null'));
  -- Positive check first, so the "can't see" checks below mean something.
  perform admin_tests.returns('admin A: sees exactly their own membership',
    $q$ select string_agg(user_id::text, ',') from public.admin_members $q$,
    'a0a0a0a0-0000-4000-8000-00000000000a');
  perform admin_tests.returns('admin A: cannot see admin C''s membership',
    $q$ select count(*)::text from public.admin_members where user_id = 'c0c0c0c0-0000-4000-8000-00000000000c' $q$, '0');
  perform admin_tests.throws('admin A: cannot add another admin',
    $q$ insert into public.admin_members (user_id) values ('b0b0b0b0-0000-4000-8000-00000000000b') $q$, '42501');
  perform admin_tests.throws('admin A: cannot remove admin C',
    $q$ delete from public.admin_members where user_id = 'c0c0c0c0-0000-4000-8000-00000000000c' $q$, '42501');
end;
$$;

create function admin_tests.as_user_b()
returns void language plpgsql as $$
begin
  perform admin_tests.check('user B: auth.uid() is B',
    auth.uid() = 'b0b0b0b0-0000-4000-8000-00000000000b', coalesce(auth.uid()::text, 'null'));
  perform admin_tests.returns('user B (signed in, not admin): sees no memberships',
    $q$ select count(*)::text from public.admin_members $q$, '0');
  perform admin_tests.throws('user B: cannot make themselves an admin',
    $q$ insert into public.admin_members (user_id) values ('b0b0b0b0-0000-4000-8000-00000000000b') $q$, '42501');
  perform admin_tests.throws('user B: cannot take over an admin''s row',
    $q$ update public.admin_members set user_id = 'b0b0b0b0-0000-4000-8000-00000000000b'
        where user_id = 'a0a0a0a0-0000-4000-8000-00000000000a' $q$, '42501');
  perform admin_tests.throws('user B: cannot delete memberships',
    $q$ delete from public.admin_members $q$, '42501');
  perform admin_tests.throws('user B: cannot truncate memberships',
    $q$ truncate public.admin_members $q$, '42501');
end;
$$;

create function admin_tests.as_no_subject()
returns void language plpgsql as $$
begin
  perform admin_tests.returns('authenticated role without a user id: sees nothing',
    $q$ select count(*)::text from public.admin_members $q$, '0');
end;
$$;

create function admin_tests.as_anon()
returns void language plpgsql as $$
begin
  perform admin_tests.throws('visitor (anon): cannot read memberships',
    $q$ select count(*) from public.admin_members $q$, '42501');
  perform admin_tests.throws('visitor (anon): cannot add a membership',
    $q$ insert into public.admin_members (user_id) values ('b0b0b0b0-0000-4000-8000-00000000000b') $q$, '42501');
end;
$$;

grant execute on all functions in schema admin_tests to anon, authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub": "a0a0a0a0-0000-4000-8000-00000000000a", "role": "authenticated"}';
select admin_tests.as_admin_a();
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub": "b0b0b0b0-0000-4000-8000-00000000000b", "role": "authenticated"}';
select admin_tests.as_user_b();
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role": "authenticated"}';
select admin_tests.as_no_subject();
reset role;

set local role anon;
set local request.jwt.claims = '{"role": "anon"}';
select admin_tests.as_anon();
reset role;

-- ---------------------------------------------------------------------------
-- Defence in depth: even if write privileges were granted by mistake, there
-- are no write policies, so a user still couldn't grant themselves access.
-- ---------------------------------------------------------------------------

grant insert, update, delete on public.admin_members to authenticated;

create function admin_tests.rls_blocks_self_grant()
returns void language plpgsql as $$
begin
  perform admin_tests.throws('user B + accidental grant: RLS still blocks self-insert',
    $q$ insert into public.admin_members (user_id) values ('b0b0b0b0-0000-4000-8000-00000000000b') $q$, '42501');
  perform admin_tests.affects('user B + accidental grant: RLS lets no membership be changed',
    $q$ update public.admin_members set user_id = 'b0b0b0b0-0000-4000-8000-00000000000b' $q$, 0);
  perform admin_tests.affects('user B + accidental grant: RLS lets no membership be deleted',
    $q$ delete from public.admin_members $q$, 0);
end;
$$;

grant execute on function admin_tests.rls_blocks_self_grant() to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub": "b0b0b0b0-0000-4000-8000-00000000000b", "role": "authenticated"}';
select admin_tests.rls_blocks_self_grant();
reset role;

revoke insert, update, delete on public.admin_members from authenticated;

select admin_tests.returns('memberships unchanged after every blocked attempt (A and C only)',
  $q$ select string_agg(user_id::text, ',' order by user_id) from public.admin_members
      where user_id::text like '_0_0_0_0-0000-4000-8000-%' $q$,
  'a0a0a0a0-0000-4000-8000-00000000000a,c0c0c0c0-0000-4000-8000-00000000000c');

-- ---------------------------------------------------------------------------
-- Data rules
-- ---------------------------------------------------------------------------

select admin_tests.throws('membership must belong to an existing Auth user',
  $q$ insert into public.admin_members (user_id) values ('d0d0d0d0-0000-4000-8000-00000000000d') $q$,
  '23503', 'admin_members_user_id_fkey');

select admin_tests.throws('a user can only be listed once',
  $q$ insert into public.admin_members (user_id) values ('a0a0a0a0-0000-4000-8000-00000000000a') $q$,
  '23505', 'admin_members_pkey');

delete from auth.users where id = 'c0c0c0c0-0000-4000-8000-00000000000c';
select admin_tests.returns('deleting an Auth user removes their admin membership',
  $q$ select count(*)::text from public.admin_members where user_id = 'c0c0c0c0-0000-4000-8000-00000000000c' $q$, '0');

select admin_tests.check('ALL ADMIN MEMBERSHIP TESTS PASSED', true);

rollback;
