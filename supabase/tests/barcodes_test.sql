-- Barcode tests: format, assignment, uniqueness, immutability, access (RLS)
-- and the read-only scan lookup.
--
-- Run after supabase/migrations/20261029200000_variant_barcodes.sql, as the
-- database owner (the Supabase SQL editor runs as postgres).
-- Everything happens in one transaction that is ROLLED BACK: the test users,
-- memberships, products and barcodes are never kept, and real data is not
-- touched. The one thing a rollback can't undo is the barcode serial counter
-- (Postgres sequences ignore transactions); the script puts it back where it
-- found it at the end. Test barcodes are never committed, so their numbers
-- were never issued to anything.
--
-- Signed-in users are simulated the way Supabase's API does it: switch to the
-- `authenticated` role and set request.jwt.claims. "aal1" is a password-only
-- session, "aal2" one that completed two-step verification.
--
-- Result: the script completes without an error only if every test passed.
-- The first failure stops it with "FAIL <test>: <reason>".

begin;

create schema bc_tests;

create function bc_tests.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL %: %', label, detail;
  end if;
  raise notice 'PASS %', label;
end;
$$;

create function bc_tests.returns(label text, query text, expected text)
returns void language plpgsql as $$
declare
  actual text;
begin
  execute query into actual;
  perform bc_tests.check(label, coalesce(actual, '') = expected,
    format('expected [%s], got [%s]', expected, coalesce(actual, '')));
end;
$$;

-- Requires `statement` to fail with SQLSTATE `expected_state` and, if given,
-- the named constraint (or the hint the functions use).
create function bc_tests.throws(label text, statement text, expected_state text, expected_detail text default null)
returns void language plpgsql as $$
declare
  got_state text;
  got_constraint text;
  got_hint text;
  got_message text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics
      got_state = returned_sqlstate,
      got_constraint = constraint_name,
      got_hint = pg_exception_hint,
      got_message = message_text;
  end;
  if got_state is null then
    raise exception 'FAIL %: statement succeeded but should have been rejected', label;
  end if;
  if got_state <> expected_state
    or (expected_detail is not null and expected_detail is distinct from got_constraint
        and expected_detail is distinct from got_hint) then
    raise exception 'FAIL %: expected % %, got % %/% (%)', label, expected_state,
      coalesce(expected_detail, ''), got_state, coalesce(got_constraint, ''), coalesce(got_hint, ''), got_message;
  end if;
  raise notice 'PASS %', label;
end;
$$;

-- Product details as the admin form sends them (prices in paisa).
create function bc_tests.fields(item_code text, slug text, item_status text default 'preloved')
returns jsonb language sql as $$
  select jsonb_build_object(
    'item_code', item_code, 'slug', slug, 'name', 'Test barcode pair', 'brand', 'Testbrand',
    'department', case when item_status = 'new' then 'kids' else 'men' end,
    'styles', jsonb_build_array('sneakers'), 'item_status', item_status,
    'condition', case when item_status = 'new' then 'new' else 'good' end,
    'condition_notes', '[]'::jsonb, 'colour', 'Black',
    'description', 'Test description', 'price_paisa', 500000);
$$;

create function bc_tests.p(key text) returns uuid language sql as $$
  select current_setting('bc.' || key)::uuid;
$$;

create function bc_tests.v(key text) returns integer language sql as $$
  select p.version from public.products p where p.id = bc_tests.p(key);
$$;

-- The barcode of a product's size, as the caller can see it.
create function bc_tests.code(key text, size numeric) returns text language sql as $$
  select b.barcode
  from public.variant_barcodes b
  join public.product_variants v on v.id = b.variant_id
  where v.product_id = bc_tests.p(key) and v.size_eu = size;
$$;

-- Everything a lookup could conceivably change, as one value.
create function bc_tests.fingerprint() returns text language sql as $$
  select md5(
    coalesce((select string_agg(v.id || ':' || v.stock || ':' || v.sku || ':' || v.updated_at, '|' order by v.id) from public.product_variants v), '')
    || '#' || coalesce((select string_agg(p.id || ':' || p.version || ':' || p.publication_status, '|' order by p.id) from public.products p), '')
    || '#' || coalesce((select string_agg(b.barcode || ':' || coalesce(b.variant_id::text, '-'), '|' order by b.barcode) from public.variant_barcodes b), '')
  );
$$;

grant usage on schema bc_tests to anon, authenticated;
grant execute on all functions in schema bc_tests to anon, authenticated;

-- Remember the serial counter, to put it back at the end.
select set_config('bc.serial_last', last_value::text, true), set_config('bc.serial_called', is_called::text, true)
from public.barcode_serial;

-- Test users: A is an admin, B is signed in but not an admin.
insert into auth.users (id, email) values
  ('a1a1a1a1-0000-4000-8000-0000000000a1', 'bc-admin-a@test.invalid'),
  ('b1b1b1b1-0000-4000-8000-0000000000b1', 'bc-user-b@test.invalid');
insert into public.admin_members (user_id) values ('a1a1a1a1-0000-4000-8000-0000000000a1');

-- ---------------------------------------------------------------------------
-- Format and check digit (same vectors as lib/barcodes/code.test.ts)
-- ---------------------------------------------------------------------------

select bc_tests.returns('Damm check digit of 572 is 4',
  $q$ select public.barcode_check_digit('572')::text $q$, '4');
select bc_tests.returns('serial numbers format as U + 7 digits + check digit',
  $q$ select string_agg(public.format_barcode(n), ',' order by n) from unnest(array[1, 2, 14, 1234567, 9999999]) n $q$,
  'U00000013,U00000021,U00000149,U12345671,U99999992');
select bc_tests.returns('valid barcodes pass the check',
  $q$ select bool_and(public.is_valid_barcode(b))::text from unnest(array['U00000013', 'U12345671', 'U99999992']) b $q$, 'true');
select bc_tests.returns('typos, swapped digits and wrong shapes fail the check',
  $q$ select string_agg(b, ',') from unnest(array[
        'U00000014', 'U00000031', 'U21345671', 'U12345617', 'u00000013', 'U0000013', 'U000000130', 'X00000013', '', null]) b
      where public.is_valid_barcode(b) $q$, '');

-- ---------------------------------------------------------------------------
-- Set-up and access rules
-- ---------------------------------------------------------------------------

select bc_tests.returns('RLS is enabled on variant_barcodes',
  $q$ select relrowsecurity::text from pg_class where oid = 'public.variant_barcodes'::regclass $q$, 'true');
select bc_tests.returns('the only policy is SELECT for verified admins',
  $q$ select string_agg(policyname || ' ' || cmd || ' ' || array_to_string(roles, ','), '; ')
      from pg_policies where schemaname = 'public' and tablename = 'variant_barcodes' $q$,
  'Verified admins can read barcodes SELECT authenticated');
select bc_tests.returns('anon has no access to barcodes at all',
  $q$ select string_agg(p, ', ') from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      where has_table_privilege('anon', 'public.variant_barcodes', p) $q$, '');
select bc_tests.returns('signed-in users can only SELECT (RLS limits that to verified admins)',
  $q$ select string_agg(p, ', ') from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      where has_table_privilege('authenticated', 'public.variant_barcodes', p)
         or (p in ('INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege('authenticated', 'public.variant_barcodes', p)) $q$, '');
select bc_tests.returns('API roles cannot use the serial counter',
  $q$ select string_agg(r || ' ' || p, ', ') from unnest(array['anon', 'authenticated']) r, unnest(array['USAGE', 'SELECT', 'UPDATE']) p
      where has_sequence_privilege(r, 'public.barcode_serial', p) $q$, '');
select bc_tests.returns('API roles cannot execute the barcode helpers or triggers',
  $q$ select string_agg(r || ' ' || f, ', ') from unnest(array['anon', 'authenticated']) r,
        unnest(array['public.barcode_check_digit(text)', 'public.format_barcode(integer)', 'public.is_valid_barcode(text)',
                     'public.issue_variant_barcode()', 'public.variant_barcodes_guard()']) f
      where has_function_privilege(r, f, 'EXECUTE') $q$, '');
select bc_tests.returns('anon cannot execute the scan lookup',
  $q$ select string_agg(f, ', ') from unnest(array['public.admin_scan_lookup(text)', 'public.admin_scan_product(uuid, uuid)']) f
      where has_function_privilege('anon', f, 'EXECUTE') $q$, '');
select bc_tests.returns('the scan lookup is STABLE (it cannot write) and runs with the caller''s rights',
  $q$ select string_agg(proname || ' ' || provolatile::text || ' ' || prosecdef, ', ' order by proname) from pg_proc
      where oid in ('public.admin_scan_lookup(text)'::regprocedure, 'public.admin_scan_product(uuid, uuid)'::regprocedure) $q$,
  'admin_scan_lookup s false, admin_scan_product s false');
-- Our migrations never create event-trigger functions; Supabase's platform
-- adds some to public (e.g. rls_auto_enable(), with search_path = pg_catalog).
-- Every other SECURITY DEFINER function there, including any we add later,
-- must use an empty search_path; Supabase's only need a fixed one.
select bc_tests.returns('every SECURITY DEFINER function in public (other than event triggers) has a fixed, empty search_path',
  $q$ select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and p.prorettype <> 'event_trigger'::regtype
        and not coalesce('search_path=""' = any(p.proconfig), false) $q$, '');
select bc_tests.returns('our SECURITY DEFINER functions are all covered by that check',
  $q$ select string_agg(p.oid::regprocedure::text || ' ' || p.prosecdef || ' ' || (p.prorettype = 'event_trigger'::regtype), ', ' order by p.proname)
      from pg_proc p
      where p.oid in ('public.product_variants_guard()'::regprocedure, 'public.check_published_product_complete()'::regprocedure,
                      'public.issue_variant_barcode()'::regprocedure) $q$,
  'check_published_product_complete() true false, issue_variant_barcode() true false, product_variants_guard() true false');
select bc_tests.returns('SECURITY DEFINER event-trigger functions in public have a fixed search_path',
  $q$ select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and p.prorettype = 'event_trigger'::regtype
        and not exists (select 1 from unnest(p.proconfig) c where c like 'search\_path=%') $q$, '');
select bc_tests.returns('barcodes are not part of the storefront tables',
  $q$ select string_agg(table_name || '.' || column_name, ', ') from information_schema.columns
      where table_schema = 'public' and table_name in ('products', 'product_variants', 'product_images')
        and column_name like '%barcode%' $q$, '');

-- ---------------------------------------------------------------------------
-- Existing sizes (backfill)
-- ---------------------------------------------------------------------------

select bc_tests.returns('every existing size has exactly one barcode',
  $q$ select count(*)::text from public.product_variants v
      where (select count(*) from public.variant_barcodes b where b.variant_id = v.id) <> 1 $q$, '0');
select bc_tests.returns('every barcode is valid',
  $q$ select count(*)::text from public.variant_barcodes where not public.is_valid_barcode(barcode) $q$, '0');
select bc_tests.returns('the counter is past every issued barcode',
  $q$ select (coalesce(max(substr(barcode, 2, 7)::integer), 0) <= (select last_value from public.barcode_serial))::text
      from public.variant_barcodes $q$, 'true');

-- ---------------------------------------------------------------------------
-- Visitors and signed-in non-admins
-- ---------------------------------------------------------------------------

set local role anon;
select bc_tests.throws('anon: cannot read barcodes', $q$ select count(*) from public.variant_barcodes $q$, '42501');
select bc_tests.throws('anon: cannot look up barcodes', $q$ select public.admin_scan_lookup('U00000013') $q$, '42501');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1b1b1b1-0000-4000-8000-0000000000b1", "role": "authenticated", "aal": "aal2"}', true);
select bc_tests.returns('user B (aal2): sees no barcodes', $q$ select count(*)::text from public.variant_barcodes $q$, '0');
select bc_tests.throws('user B: cannot look up barcodes', $q$ select public.admin_scan_lookup('U00000013') $q$, '42501');
select bc_tests.returns('user B: the product helper returns nothing',
  $q$ select coalesce(public.admin_scan_product((select id from public.products limit 1), null)::text, 'null') $q$, 'null');
select bc_tests.throws('user B: cannot add barcodes',
  $q$ insert into public.variant_barcodes (barcode, sku_at_issue, size_eu) values ('U00000021', 'X', 40) $q$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Admin A with two-step verification (aal2): new sizes get barcodes
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a1a1a1a1-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal2"}', true);

select set_config('bc.pl',
  public.admin_create_product(bc_tests.fields('TEST-BC-PL', 'test-bc-preloved'), '[{"size": 42, "stock": 1}]') ->> 'id', true);
select set_config('bc.new',
  public.admin_create_product(bc_tests.fields('TEST-BC-NEW', 'test-bc-new', 'new'),
    '[{"size": 30, "stock": 5}, {"size": 31, "stock": 0}, {"size": 32, "stock": 2}]') ->> 'id', true);

select bc_tests.returns('create: every new size (drafts too) gets a valid barcode',
  $q$ select count(*) || '/' || count(b.barcode) || '/' || bool_and(coalesce(b.barcode ~ '^U[0-9]{8}$', false))
      from public.product_variants v left join public.variant_barcodes b on b.variant_id = v.id
      where v.product_id in (bc_tests.p('pl'), bc_tests.p('new')) $q$, '4/4/true');
select bc_tests.returns('create: the barcodes are distinct',
  $q$ select count(distinct b.barcode)::text from public.variant_barcodes b
      join public.product_variants v on v.id = b.variant_id where v.product_id in (bc_tests.p('pl'), bc_tests.p('new')) $q$, '4');
select bc_tests.returns('create: the register records product and SKU',
  $q$ select b.product_id = bc_tests.p('pl') and b.sku_at_issue = 'TEST-BC-PL-42' and b.size_eu = 42
      from public.variant_barcodes b where b.barcode = bc_tests.code('pl', 42) $q$, 'true');

select set_config('bc.code_pl', bc_tests.code('pl', 42), true);
select set_config('bc.code_30', bc_tests.code('new', 30), true);
select set_config('bc.code_31', bc_tests.code('new', 31), true);

select bc_tests.throws('admin: cannot add a barcode directly',
  $q$ insert into public.variant_barcodes (barcode, sku_at_issue, size_eu) values ('U00000021', 'X', 40) $q$, '42501');
select bc_tests.throws('admin: cannot change a barcode directly',
  $q$ update public.variant_barcodes set barcode = 'U00000021' where barcode = current_setting('bc.code_pl') $q$, '42501');
select bc_tests.throws('admin: cannot delete a barcode directly',
  $q$ delete from public.variant_barcodes where barcode = current_setting('bc.code_pl') $q$, '42501');
select bc_tests.throws('admin: an item code can''t look like a barcode',
  $q$ select public.admin_create_product(bc_tests.fields('U00000013', 'test-bc-shaped'), '[{"size": 42, "stock": 1}]') $q$,
  '23514', 'products_item_code_not_barcode');

-- ---------------------------------------------------------------------------
-- Barcodes never change, and removed sizes' barcodes are never reused
-- ---------------------------------------------------------------------------

select public.admin_save_product(bc_tests.p('new'), bc_tests.v('new'),
  bc_tests.fields('TEST-BC-NEW2', 'test-bc-new', 'new'),
  '[{"size": 30, "stock": 7}, {"size": 31, "stock": 0}, {"size": 32, "stock": 2}]', '[]');
select bc_tests.returns('draft edit: new item code, SKUs and stock, same barcodes',
  $q$ select string_agg(v.sku || '=' || v.stock, ',' order by v.size_eu) || ' ' ||
        (bc_tests.code('new', 30) = current_setting('bc.code_30') and bc_tests.code('new', 31) = current_setting('bc.code_31'))
      from public.product_variants v where v.product_id = bc_tests.p('new') $q$,
  'TEST-BC-NEW2-30=7,TEST-BC-NEW2-31=0,TEST-BC-NEW2-32=2 true');

select public.admin_save_product(bc_tests.p('new'), bc_tests.v('new'),
  bc_tests.fields('TEST-BC-NEW2', 'test-bc-new', 'new'),
  '[{"size": 30, "stock": 7}, {"size": 32, "stock": 2}]', '[]');
select bc_tests.returns('removed draft size: its barcode is kept, retired (no size)',
  $q$ select (variant_id is null) || ' ' || (product_id = bc_tests.p('new')) || ' ' || sku_at_issue || ' ' || size_eu
      from public.variant_barcodes where barcode = current_setting('bc.code_31') $q$, 'true true TEST-BC-NEW-31 31.0');

select public.admin_save_product(bc_tests.p('new'), bc_tests.v('new'),
  bc_tests.fields('TEST-BC-NEW2', 'test-bc-new', 'new'),
  '[{"size": 30, "stock": 7}, {"size": 31, "stock": 4}, {"size": 32, "stock": 2}]', '[]');
select bc_tests.returns('re-added size: gets a new barcode, never the retired one',
  $q$ select (bc_tests.code('new', 31) is not null and bc_tests.code('new', 31) <> current_setting('bc.code_31'))::text $q$, 'true');

-- Publish, archive and restore keep the barcode.
select set_config('bc.img', gen_random_uuid()::text, true);
select public.admin_add_product_image(bc_tests.p('pl'), bc_tests.v('pl'), bc_tests.p('img'),
  bc_tests.p('pl') || '/' || bc_tests.p('img') || '.webp', 1200, 900, 'Side view');
select public.admin_set_publication_status(bc_tests.p('pl'), bc_tests.v('pl'), 'published');
select public.admin_set_publication_status(bc_tests.p('pl'), bc_tests.v('pl'), 'archived');
select bc_tests.returns('archived: same barcode',
  $q$ select (bc_tests.code('pl', 42) = current_setting('bc.code_pl'))::text $q$, 'true');
select public.admin_set_publication_status(bc_tests.p('pl'), bc_tests.v('pl'), 'draft');
select bc_tests.returns('restored: same barcode',
  $q$ select (bc_tests.code('pl', 42) = current_setting('bc.code_pl'))::text $q$, 'true');
select public.admin_set_publication_status(bc_tests.p('pl'), bc_tests.v('pl'), 'published');
select bc_tests.throws('published: sizes still can''t be removed (so neither can their barcodes)',
  $q$ delete from public.product_variants where product_id = bc_tests.p('pl') $q$, 'PT400', 'variant_locked');

-- ---------------------------------------------------------------------------
-- Scan lookup
-- ---------------------------------------------------------------------------

select set_config('bc.before', bc_tests.fingerprint(), true);

select bc_tests.returns('lookup: a barcode finds its size, with price, stock and status',
  $q$ select r ->> 'kind' || ' ' || (r ->> 'matched_by') || ' ' || (r -> 'product' ->> 'item_code') || ' '
        || (r -> 'product' ->> 'publication_status') || ' ' || (r -> 'product' ->> 'price_paisa') || ' '
        || jsonb_array_length(r -> 'product' -> 'units') || ' '
        || ((r -> 'product' -> 'units' -> 0 ->> 'size_eu')::numeric)::text || ' ' || (r -> 'product' -> 'units' -> 0 ->> 'stock')
        || ' ' || (r -> 'product' -> 'photo' ->> 'id' = current_setting('bc.img'))
      from (select public.admin_scan_lookup(current_setting('bc.code_pl')) r) x $q$,
  'unit barcode TEST-BC-PL published 500000 1 42.0 1 true');
select bc_tests.returns('lookup: lowercase and spaces are ignored',
  $q$ select public.admin_scan_lookup(' ' || lower(substr(current_setting('bc.code_30'), 1, 4)) || ' ' || substr(current_setting('bc.code_30'), 5))
        -> 'product' -> 'units' -> 0 ->> 'barcode' = current_setting('bc.code_30') $q$, 'true');
select bc_tests.returns('lookup: a draft''s size is found, and says it is a draft',
  $q$ select public.admin_scan_lookup(current_setting('bc.code_30')) -> 'product' ->> 'publication_status' $q$, 'draft');
select bc_tests.returns('lookup: a retired barcode says which size it was',
  $q$ select r ->> 'kind' || ' ' || (r ->> 'size_eu') || ' ' || (r ->> 'sku') || ' ' || (r -> 'product' ->> 'item_code')
      from (select public.admin_scan_lookup(current_setting('bc.code_31')) r) x $q$, 'retired 31.0 TEST-BC-NEW-31 TEST-BC-NEW2');
select bc_tests.returns('lookup: an item code lists every size with its barcode',
  $q$ select r ->> 'kind' || ' ' || (r ->> 'matched_by') || ' ' || jsonb_array_length(r -> 'product' -> 'units') || ' '
        || (select bool_and(u ->> 'barcode' is not null) from jsonb_array_elements(r -> 'product' -> 'units') u)
      from (select public.admin_scan_lookup('test-bc-new2') r) x $q$, 'product item_code 3 true');
select bc_tests.returns('lookup: an exact SKU finds that size',
  $q$ select r ->> 'kind' || ' ' || (r ->> 'matched_by') || ' ' || (r -> 'product' -> 'units' -> 0 ->> 'sku')
      from (select public.admin_scan_lookup('TEST-BC-NEW2-32') r) x $q$, 'unit sku TEST-BC-NEW2-32');
select bc_tests.returns('lookup: an unknown code is not found',
  $q$ select string_agg(public.admin_scan_lookup(c) ->> 'kind', ',') from unnest(array['U99999992', '4006381333931', '', 'TEST-BC']) c $q$,
  'not_found,not_found,not_found,not_found');
select bc_tests.returns('lookup: changes nothing (sizes, stock, products, barcodes)',
  $q$ select (bc_tests.fingerprint() = current_setting('bc.before'))::text $q$, 'true');

-- Archived and sold out are reported as they are.
select public.admin_save_product(bc_tests.p('pl'), bc_tests.v('pl'), bc_tests.fields('TEST-BC-PL', 'test-bc-preloved'),
  '[{"size": 42, "stock": 0}]', jsonb_build_array(jsonb_build_object('id', bc_tests.p('img'), 'alt', 'Side view')));
select public.admin_set_publication_status(bc_tests.p('pl'), bc_tests.v('pl'), 'archived');
select bc_tests.returns('lookup: archived and out of stock',
  $q$ select (r -> 'product' ->> 'publication_status') || ' ' || (r -> 'product' -> 'units' -> 0 ->> 'stock')
      from (select public.admin_scan_lookup(current_setting('bc.code_pl')) r) x $q$, 'archived 0');
reset role;

-- A password-only session sees and finds nothing.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a1a1a1a1-0000-4000-8000-0000000000a1", "role": "authenticated", "aal": "aal1"}', true);
select bc_tests.returns('admin A (aal1): sees no barcodes', $q$ select count(*)::text from public.variant_barcodes $q$, '0');
select bc_tests.throws('admin A (aal1): cannot look up barcodes',
  $q$ select public.admin_scan_lookup(current_setting('bc.code_pl')) $q$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- The owner can't change or reuse barcodes either
-- ---------------------------------------------------------------------------

select bc_tests.throws('owner: cannot change a barcode',
  $q$ update public.variant_barcodes set barcode = 'U00000021' where barcode = current_setting('bc.code_pl') $q$, 'PT400', 'barcode_locked');
select bc_tests.throws('owner: cannot move a barcode to another size',
  $q$ update public.variant_barcodes set variant_id = (select id from public.product_variants where sku = 'TEST-BC-NEW2-32')
      where barcode = current_setting('bc.code_31') $q$, 'PT400', 'barcode_locked');
select bc_tests.throws('owner: cannot delete a barcode',
  $q$ delete from public.variant_barcodes where barcode = current_setting('bc.code_31') $q$, 'PT400', 'barcode_locked');
select bc_tests.throws('owner: cannot truncate the register',
  $q$ truncate public.variant_barcodes $q$, 'PT400', 'barcode_locked');
select bc_tests.throws('owner: cannot issue a barcode twice',
  $q$ insert into public.variant_barcodes (barcode, sku_at_issue, size_eu) values (current_setting('bc.code_31'), 'X', 40) $q$,
  '23505', 'variant_barcodes_pkey');
select bc_tests.throws('owner: cannot store an invalid barcode',
  $q$ insert into public.variant_barcodes (barcode, sku_at_issue, size_eu) values ('U00000014', 'X', 40) $q$,
  '23514', 'variant_barcodes_barcode_valid');

-- Even with the counter wound back, a new size gets a barcode never issued before.
select set_config('bc.count_before', (select count(*) from public.variant_barcodes)::text, true);
select setval('public.barcode_serial', 1, false);
insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
values (bc_tests.p('new'), 'new', 'TEST-BC-NEW2-33', 33, 1);
select bc_tests.returns('counter wound back: the new size still gets a fresh, unused barcode',
  $q$ select (select count(*) from public.variant_barcodes)::bigint - current_setting('bc.count_before')::bigint || ' '
        || (select count(*) from public.variant_barcodes b join public.product_variants v on v.id = b.variant_id
            where v.sku = 'TEST-BC-NEW2-33') $q$, '1 1');

-- Put the counter back where it was (sequences ignore the rollback below).
select setval('public.barcode_serial', current_setting('bc.serial_last')::bigint, current_setting('bc.serial_called')::boolean);

select bc_tests.check('ALL BARCODE TESTS PASSED', true);

rollback;
