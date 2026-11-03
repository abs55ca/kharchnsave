-- Label names and light-up soles: storage rules, who can read the label
-- name, and that saving them never touches stock.
--
-- Run after supabase/migrations/20261101120000_label_names_and_light_up.sql,
-- as the database owner (the Supabase SQL editor runs as postgres).
-- Everything happens in one transaction that is ROLLED BACK: the test users,
-- memberships and products are never kept, and real data is not touched.
-- Whether a label name fits the printed label is checked by the app
-- (lib/labels/name-fit.ts), not here.
--
-- Result: the script completes without an error only if every test passed.
-- The first failure stops it with "FAIL <test>: <reason>".

begin;

create schema lu_tests;

create function lu_tests.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL %: %', label, detail;
  end if;
  raise notice 'PASS %', label;
end;
$$;

create function lu_tests.returns(label text, query text, expected text)
returns void language plpgsql as $$
declare
  actual text;
begin
  execute query into actual;
  perform lu_tests.check(label, coalesce(actual, '') = expected,
    format('expected [%s], got [%s]', expected, coalesce(actual, '')));
end;
$$;

-- Requires `statement` to fail with SQLSTATE `expected_state` and, if given,
-- the named constraint.
create function lu_tests.throws(label text, statement text, expected_state text, expected_constraint text default null)
returns void language plpgsql as $$
declare
  got_state text;
  got_constraint text;
  got_message text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics got_state = returned_sqlstate, got_constraint = constraint_name, got_message = message_text;
  end;
  if got_state is null then
    raise exception 'FAIL %: statement succeeded but should have been rejected', label;
  end if;
  if got_state <> expected_state or (expected_constraint is not null and expected_constraint is distinct from got_constraint) then
    raise exception 'FAIL %: expected % %, got % % (%)', label, expected_state, coalesce(expected_constraint, ''),
      got_state, coalesce(got_constraint, ''), got_message;
  end if;
  raise notice 'PASS %', label;
end;
$$;

-- Product details as the admin form sends them, with `extra` merged in.
create function lu_tests.fields(item_code text, slug text, extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object(
    'item_code', item_code, 'slug', slug, 'name', 'Kids Navy and Grey Double-Strap Sports Trainers',
    'brand', 'Testbrand', 'department', 'kids', 'styles', jsonb_build_array('sneakers'), 'item_status', 'new',
    'condition', 'new', 'condition_notes', '[]'::jsonb, 'colour', 'Navy', 'description', 'Test description',
    'price_paisa', 250000) || extra;
$$;

create function lu_tests.p(key text) returns uuid language sql as $$
  select current_setting('lu.' || key)::uuid;
$$;

create function lu_tests.v(key text) returns integer language sql as $$
  select p.version from public.products p where p.id = lu_tests.p(key);
$$;

-- Sizes as a form opened just now sends them (stock and inventory version as loaded).
create function lu_tests.form(product uuid) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('size', v.size_eu, 'stock', v.stock,
    'stock_was', v.stock, 'inventory_version', v.inventory_version) order by v.size_eu), '[]'::jsonb)
  from public.product_variants v where v.product_id = product;
$$;

-- Stock, held pairs and inventory versions of a product's sizes, and its ledger rows.
create function lu_tests.inventory(product uuid) returns text language sql as $$
  select string_agg(trim_scale(v.size_eu) || ':' || v.stock || '/' || v.reserved || '/v' || v.inventory_version, ' ' order by v.size_eu)
    || ' ledger ' || (select count(*) from public.stock_movements m join public.product_variants x on x.id = m.variant_id
                      where x.product_id = product)
  from public.product_variants v where v.product_id = product;
$$;

grant usage on schema lu_tests to anon, authenticated;
grant execute on all functions in schema lu_tests to anon, authenticated;

-- New sizes take barcode serial numbers, which a rollback doesn't return:
-- remember the counter, to put it back at the end.
select set_config('lu.serial_last', last_value::text, true), set_config('lu.serial_called', is_called::text, true)
from public.barcode_serial;

-- ---------------------------------------------------------------------------
-- Test users (A is an admin, B is signed in but not an admin) and a
-- published product created by the owner, as existing products were
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('a1a1a1a1-0000-4000-8000-00000000000a', 'lu-admin-a@test.invalid'),
  ('b1b1b1b1-0000-4000-8000-00000000000b', 'lu-user-b@test.invalid');
insert into public.admin_members (user_id) values ('a1a1a1a1-0000-4000-8000-00000000000a');

insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa)
values ('TEST-LU-OLD', 'test-lu-old', 'Existing pair', 'Testbrand', 'women', '{sneakers}', 'preloved', 'good', 'Grey', 'Test', 100000);
select set_config('lu.old', (select id::text from public.products where item_code = 'TEST-LU-OLD'), true);
insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
values (lu_tests.p('old'), 'preloved', 'TEST-LU-OLD-38', 38, 1);
insert into public.product_images (product_id, sort_order, src, alt, width, height)
values (lu_tests.p('old'), 0, '/images/test/lu.jpg', 'Test photo', 800, 800);
update public.products set publication_status = 'published', listed_at = current_date where id = lu_tests.p('old');

-- ---------------------------------------------------------------------------
-- Existing products
-- ---------------------------------------------------------------------------

select lu_tests.returns('existing: no label name, and light-up soles "not recorded" (null, not No)',
  $q$ select coalesce(label_name, 'null') || ' / ' || coalesce(light_up::text, 'null') || ' / '
          || coalesce(light_up_condition, 'null') || ' / ' || coalesce(light_up_activation, 'null')
      from public.products where id = lu_tests.p('old') $q$,
  'null / null / null / null');

-- ---------------------------------------------------------------------------
-- Visitors: the label name is private; the light-up details are public
-- ---------------------------------------------------------------------------

select lu_tests.returns('anon has no read access to label_name, and still reads the shop''s columns',
  $q$ select has_column_privilege('anon', 'public.products', 'label_name', 'SELECT')::text || ' / '
          || has_column_privilege('anon', 'public.products', 'light_up_condition', 'SELECT')::text || ' / '
          || has_column_privilege('anon', 'public.products', 'price_paisa', 'SELECT')::text || ' / '
          || has_table_privilege('anon', 'public.products', 'SELECT')::text $q$,
  'false / true / true / false');

set local role anon;
select lu_tests.returns('anon: reads a published product with the catalogue''s columns, light-up included',
  $q$ select name || ' / ' || coalesce(light_up::text, 'not recorded')
      from public.products where id = lu_tests.p('old') $q$, 'Existing pair / not recorded');
select lu_tests.returns('anon: can still count products',
  $q$ select (count(*) > 0)::text from public.products $q$, 'true');
select lu_tests.throws('anon: cannot read label names',
  $q$ select label_name from public.products limit 1 $q$, '42501');
select lu_tests.throws('anon: cannot read label names with "select *" either',
  $q$ select * from public.products limit 1 $q$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Rules on the stored values (as the owner, so only the constraints apply)
-- ---------------------------------------------------------------------------

select lu_tests.throws('light-up Yes needs a condition',
  $q$ update public.products set light_up = true where id = lu_tests.p('old') $q$, '23514', 'products_light_up_condition_matches');
select lu_tests.throws('a condition needs light-up Yes (not No)',
  $q$ update public.products set light_up = false, light_up_condition = 'both_work' where id = lu_tests.p('old') $q$,
  '23514', 'products_light_up_condition_matches');
select lu_tests.throws('a condition needs light-up Yes (not "not recorded")',
  $q$ update public.products set light_up_condition = 'both_work' where id = lu_tests.p('old') $q$,
  '23514', 'products_light_up_condition_matches');
select lu_tests.throws('only the four conditions',
  $q$ update public.products set light_up = true, light_up_condition = 'mostly' where id = lu_tests.p('old') $q$,
  '23514', 'products_light_up_condition_valid');
select lu_tests.throws('an activation description needs light-up Yes',
  $q$ update public.products set light_up = false, light_up_activation = 'Flashes' where id = lu_tests.p('old') $q$,
  '23514', 'products_light_up_activation_valid');
select lu_tests.throws('an activation description is at most 120 characters',
  $q$ update public.products set light_up = true, light_up_condition = 'both_work', light_up_activation = repeat('x', 121)
      where id = lu_tests.p('old') $q$, '23514', 'products_light_up_activation_valid');
select lu_tests.throws('a label name has no control characters',
  $q$ update public.products set label_name = 'Shoe' || chr(7) where id = lu_tests.p('old') $q$, '23514', 'products_label_name_valid');
select lu_tests.throws('a label name has no line breaks',
  $q$ update public.products set label_name = 'Two' || chr(10) || 'lines' where id = lu_tests.p('old') $q$, '23514', 'products_label_name_valid');
select lu_tests.throws('a label name isn''t blank or padded',
  $q$ update public.products set label_name = ' Shoe' where id = lu_tests.p('old') $q$, '23514', 'products_label_name_valid');
select lu_tests.throws('a label name is at most 60 characters',
  $q$ update public.products set label_name = repeat('x', 61) where id = lu_tests.p('old') $q$, '23514', 'products_label_name_valid');
select lu_tests.returns('a confirmed No is stored as false, distinct from not recorded',
  $q$ with changed as (update public.products set light_up = false where id = lu_tests.p('old') returning light_up)
      select light_up::text from changed $q$, 'false');
update public.products set light_up = null where id = lu_tests.p('old');

-- ---------------------------------------------------------------------------
-- Signed in, not an admin
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1b1b1b1-0000-4000-8000-00000000000b", "role": "authenticated", "aal": "aal2"}', true);
select lu_tests.throws('user B: cannot create a product with a label name',
  $q$ select public.admin_create_product(lu_tests.fields('TEST-LU-X', 'test-lu-x', '{"label_name": "X"}'), '[{"size": 30, "stock": 1}]') $q$,
  '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Admin A (aal2): creating and saving
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a1a1a1a1-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal2"}', true);

select set_config('lu.kids', public.admin_create_product(
  lu_tests.fields('TEST-LU-KIDS', 'test-lu-kids',
    '{"label_name": "Navy/Grey Trainers", "light_up": true, "light_up_condition": "not_checked", "light_up_activation": "Soles flash when walking."}'),
  '[{"size": 30, "stock": 3}, {"size": 31, "stock": 2}]') ->> 'id', true);
select lu_tests.returns('create: saves the label name and light-up details; the product name is untouched',
  $q$ select name || ' / ' || label_name || ' / ' || light_up || ' / ' || light_up_condition || ' / ' || light_up_activation
      from public.products where id = lu_tests.p('kids') $q$,
  'Kids Navy and Grey Double-Strap Sports Trainers / Navy/Grey Trainers / true / not_checked / Soles flash when walking.');

select set_config('lu.plain', public.admin_create_product(lu_tests.fields('TEST-LU-PLAIN', 'test-lu-plain'),
  '[{"size": 32, "stock": 1}]') ->> 'id', true);
select lu_tests.returns('create: without the new fields, nothing is recorded (no label name, light-up not recorded)',
  $q$ select coalesce(label_name, 'null') || ' / ' || coalesce(light_up::text, 'null')
      from public.products where id = lu_tests.p('plain') $q$, 'null / null');

select lu_tests.throws('admin: can''t change the label name directly, only through the save function',
  $q$ update public.products set label_name = 'Direct' where id = lu_tests.p('kids') $q$, '42501');
select lu_tests.throws('admin: can''t change light-up details directly either',
  $q$ update public.products set light_up = false, light_up_condition = null, light_up_activation = null
      where id = lu_tests.p('kids') $q$, '42501');
reset role;

-- Pairs held for an order on size 30 (as an order would), to show they're untouched.
update public.product_variants set stock = stock - 1, reserved = reserved + 1
where product_id = lu_tests.p('kids') and size_eu = 30;
select set_config('lu.inventory', lu_tests.inventory(lu_tests.p('kids')), true);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a1a1a1a1-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal2"}', true);
select set_config('lu.opened', lu_tests.v('kids')::text, true);
select set_config('lu.form', lu_tests.form(lu_tests.p('kids'))::text, true);

select public.admin_save_product(lu_tests.p('kids'), current_setting('lu.opened')::integer,
  lu_tests.fields('TEST-LU-KIDS', 'test-lu-kids',
    '{"label_name": "Light-up Trainers", "light_up": true, "light_up_condition": "both_work", "light_up_activation": null}'),
  current_setting('lu.form')::jsonb, '[]');
select lu_tests.returns('save: label name and light-up details change, the activation can be cleared',
  $q$ select label_name || ' / ' || light_up_condition || ' / ' || coalesce(light_up_activation, 'null')
      from public.products where id = lu_tests.p('kids') $q$, 'Light-up Trainers / both_work / null');
select lu_tests.returns('save: the product version goes up (conflict protection still works)',
  $q$ select (lu_tests.v('kids') = current_setting('lu.opened')::integer + 1)::text $q$, 'true');
select lu_tests.returns('save: stock, held pairs, inventory versions and the ledger are untouched',
  $q$ select lu_tests.inventory(lu_tests.p('kids')) $q$, current_setting('lu.inventory'));
select lu_tests.throws('save: the old version is refused, as before',
  $q$ select public.admin_save_product(lu_tests.p('kids'), current_setting('lu.opened')::integer,
        lu_tests.fields('TEST-LU-KIDS', 'test-lu-kids', '{"label_name": "Late"}'), current_setting('lu.form')::jsonb, '[]') $q$,
  'PT409');

-- A save from a caller that doesn't know the new fields keeps them.
select public.admin_save_product(lu_tests.p('kids'), lu_tests.v('kids'),
  lu_tests.fields('TEST-LU-KIDS', 'test-lu-kids') || '{"description": "Older caller"}', lu_tests.form(lu_tests.p('kids')), '[]');
select lu_tests.returns('save without the new fields: label name and light-up details are kept',
  $q$ select description || ' / ' || label_name || ' / ' || light_up_condition from public.products where id = lu_tests.p('kids') $q$,
  'Older caller / Light-up Trainers / both_work');

-- Back to "not recorded" and no label name.
select public.admin_save_product(lu_tests.p('kids'), lu_tests.v('kids'),
  lu_tests.fields('TEST-LU-KIDS', 'test-lu-kids', '{"label_name": null, "light_up": null, "light_up_condition": null, "light_up_activation": null}'),
  lu_tests.form(lu_tests.p('kids')), '[]');
select lu_tests.returns('save: the label name and light-up answer can be cleared',
  $q$ select coalesce(label_name, 'null') || ' / ' || coalesce(light_up::text, 'null') from public.products where id = lu_tests.p('kids') $q$,
  'null / null');
select lu_tests.throws('save: light-up Yes without a condition is refused',
  $q$ select public.admin_save_product(lu_tests.p('kids'), lu_tests.v('kids'),
        lu_tests.fields('TEST-LU-KIDS', 'test-lu-kids', '{"light_up": true}'), lu_tests.form(lu_tests.p('kids')), '[]') $q$,
  '23514', 'products_light_up_condition_matches');
select lu_tests.returns('the refused save changed nothing',
  $q$ select coalesce(light_up::text, 'null') from public.products where id = lu_tests.p('kids') $q$, 'null');

-- Labels: the scan and label lookup returns the label name.
select public.admin_save_product(lu_tests.p('kids'), lu_tests.v('kids'),
  lu_tests.fields('TEST-LU-KIDS', 'test-lu-kids', '{"label_name": "Navy/Grey Trainers"}'), lu_tests.form(lu_tests.p('kids')), '[]');
select lu_tests.returns('labels: admin_scan_product returns the label name and the full name',
  $q$ select (public.admin_scan_product(lu_tests.p('kids'), null) ->> 'label_name') || ' / '
          || (public.admin_scan_product(lu_tests.p('kids'), null) ->> 'name') $q$,
  'Navy/Grey Trainers / Kids Navy and Grey Double-Strap Sports Trainers');
select lu_tests.returns('labels: barcodes and SKUs are unchanged by these saves',
  $q$ select string_agg(v.sku || '=' || (b.barcode is not null), ' ' order by v.size_eu)
      from public.product_variants v left join public.variant_barcodes b on b.variant_id = v.id
      where v.product_id = lu_tests.p('kids') $q$,
  'TEST-LU-KIDS-30=true TEST-LU-KIDS-31=true');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b1b1b1b1-0000-4000-8000-00000000000b", "role": "authenticated", "aal": "aal2"}', true);
select lu_tests.returns('user B (aal2): admin_scan_product returns nothing, label name included',
  $q$ select coalesce(public.admin_scan_product(lu_tests.p('kids'), null)::text, 'null') $q$, 'null');
reset role;

select lu_tests.check('ALL LABEL NAME AND LIGHT-UP TESTS PASSED', true);

select setval('public.barcode_serial', current_setting('lu.serial_last')::bigint, current_setting('lu.serial_called')::boolean);

rollback;
