-- Product management tests: who can manage products, the publishing rules,
-- stable identifiers and conflict detection.
--
-- Run after supabase/migrations/20261029120000_admin_product_management.sql,
-- as the database owner (the Supabase SQL editor runs as postgres).
-- Everything happens in one transaction that is ROLLED BACK: the test users,
-- memberships and products are never kept, and real data is not touched.
-- Storage access is not tested here (that needs the Storage API); see README.
--
-- Signed-in users are simulated the way Supabase's API does it: switch to the
-- `authenticated` role and set request.jwt.claims (read by auth.uid() and
-- auth.jwt()). "aal1" is a password-only session, "aal2" one that completed
-- two-step verification.
--
-- Result: the script completes without an error only if every test passed.
-- The first failure stops it with "FAIL <test>: <reason>".

begin;

create schema pm_tests;

create function pm_tests.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL %: %', label, detail;
  end if;
  raise notice 'PASS %', label;
end;
$$;

create function pm_tests.returns(label text, query text, expected text)
returns void language plpgsql as $$
declare
  actual text;
begin
  execute query into actual;
  perform pm_tests.check(label, coalesce(actual, '') = expected,
    format('expected [%s], got [%s]', expected, coalesce(actual, '')));
end;
$$;

-- Requires `statement` to fail with SQLSTATE `expected_state` and, if given,
-- the named constraint (or the hint the admin functions use).
create function pm_tests.throws(label text, statement text, expected_state text, expected_detail text default null)
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

-- Requires `statement` to be refused (42501) or to change no rows.
create function pm_tests.refused(label text, statement text)
returns void language plpgsql as $$
declare
  changed integer;
begin
  begin
    execute statement;
    get diagnostics changed = row_count;
  exception when insufficient_privilege then
    raise notice 'PASS %', label;
    return;
  end;
  perform pm_tests.check(label, changed = 0, format('%s row(s) changed', changed));
end;
$$;

-- Product details as the admin form sends them (prices in paisa).
create function pm_tests.fields(item_code text, slug text, item_status text default 'preloved',
  price_paisa integer default 500000, condition text default 'good')
returns jsonb language sql as $$
  select jsonb_build_object(
    'item_code', item_code, 'slug', slug, 'name', 'Test pm pair', 'brand', 'Testbrand',
    'department', case when item_status = 'new' then 'kids' else 'men' end,
    'styles', jsonb_build_array('sneakers'), 'item_status', item_status,
    'condition', case when item_status = 'new' then 'new' else condition end,
    'condition_notes', jsonb_build_array('Light creasing'), 'colour', 'Black',
    'description', 'Test description', 'price_paisa', price_paisa);
$$;

create function pm_tests.p(key text) returns uuid language sql as $$
  select current_setting('pm.' || key)::uuid;
$$;

create function pm_tests.v(key text) returns integer language sql as $$
  select p.version from public.products p where p.id = pm_tests.p(key);
$$;

-- Sizes as the admin form sends them when it was opened just now: each
-- existing size carries the stock and inventory version the form loaded
-- (20261031120000_inventory_ledger.sql). Read with the caller's own access.
create function pm_tests.form(product uuid, sizes jsonb) returns jsonb language sql as $$
  select coalesce(jsonb_agg(
    case when v.id is null then s
         else s || jsonb_build_object('stock_was', v.stock, 'inventory_version', v.inventory_version) end
    order by n), '[]'::jsonb)
  from jsonb_array_elements(sizes) with ordinality as x (s, n)
  left join public.product_variants v on v.product_id = product and v.size_eu = (s ->> 'size')::numeric;
$$;

grant usage on schema pm_tests to anon, authenticated;
grant execute on all functions in schema pm_tests to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Test users (A and C are admins, B is signed in but not an admin) and a
-- draft product created by the owner
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values
  ('a0a0a0a0-0000-4000-8000-00000000000a', 'admin-a@test.invalid'),
  ('b0b0b0b0-0000-4000-8000-00000000000b', 'user-b@test.invalid'),
  ('c0c0c0c0-0000-4000-8000-00000000000c', 'admin-c@test.invalid');
insert into public.admin_members (user_id) values
  ('a0a0a0a0-0000-4000-8000-00000000000a'),
  ('c0c0c0c0-0000-4000-8000-00000000000c');

insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa)
values ('TEST-PM-OWNER', 'test-pm-owner-draft', 'Owner draft', 'Testbrand', 'men', '{sneakers}', 'preloved', 'good', 'Grey', 'Test', 100000);

-- ---------------------------------------------------------------------------
-- Set-up
-- ---------------------------------------------------------------------------

select pm_tests.returns('anon cannot execute any admin function',
  $q$ select string_agg(f, ', ') from unnest(array[
        'public.is_catalogue_admin()',
        'public.admin_create_product(jsonb, jsonb)',
        'public.admin_save_product(uuid, integer, jsonb, jsonb, jsonb)',
        'public.admin_add_product_image(uuid, integer, uuid, text, integer, integer, text)',
        'public.admin_set_publication_status(uuid, integer, text)']) f
      where has_function_privilege('anon', f, 'EXECUTE') $q$, '');

select pm_tests.returns('API roles cannot execute the trigger functions',
  $q$ select string_agg(r || ' ' || f, ', ') from unnest(array['anon', 'authenticated']) r,
        unnest(array['public.products_guard_update()', 'public.product_variants_guard()',
                     'public.check_published_product_complete()']) f
      where has_function_privilege(r, f, 'EXECUTE') $q$, '');

select pm_tests.returns('nobody but the owner can delete products, change IDs or versions, or set photo URLs',
  $q$ select string_agg(x, ', ') from (values
        (has_table_privilege('authenticated', 'public.products', 'DELETE'), 'delete products'),
        (has_column_privilege('authenticated', 'public.products', 'id', 'UPDATE'), 'update products.id'),
        (has_column_privilege('authenticated', 'public.products', 'version', 'UPDATE'), 'update products.version'),
        (has_column_privilege('authenticated', 'public.product_images', 'src', 'INSERT'), 'insert product_images.src'),
        (has_column_privilege('authenticated', 'public.product_images', 'storage_path', 'UPDATE'), 'update product_images.storage_path'),
        (has_column_privilege('authenticated', 'public.product_variants', 'product_id', 'UPDATE'), 'update product_variants.product_id')
      ) t(granted, x) where granted $q$, '');

select pm_tests.returns('admin memberships are still owner-only',
  $q$ select string_agg(r || ' ' || p, ', ') from unnest(array['anon', 'authenticated']) r,
        unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      where has_table_privilege(r, 'public.admin_members', p) $q$, '');

-- ---------------------------------------------------------------------------
-- Visitors
-- ---------------------------------------------------------------------------

set local role anon;
select pm_tests.throws('anon: cannot call admin_create_product',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-X', 'test-pm-x'), '[{"size": 42, "stock": 1}]') $q$, '42501');
select pm_tests.returns('anon: cannot see the owner''s draft',
  $q$ select count(*)::text from public.products where slug = 'test-pm-owner-draft' $q$, '0');
-- Every product in the database, not only the test's (real products may exist).
select pm_tests.returns('anon: cannot see any draft or archived product',
  $q$ select count(*)::text from public.products where publication_status <> 'published' $q$, '0');
reset role;

-- ---------------------------------------------------------------------------
-- Signed in, not an admin (even with two-step verification)
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "b0b0b0b0-0000-4000-8000-00000000000b", "role": "authenticated", "aal": "aal2"}', true);
select pm_tests.returns('user B (aal2): is not a catalogue admin',
  $q$ select public.is_catalogue_admin()::text $q$, 'false');
select pm_tests.throws('user B: cannot create products through the function',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-X', 'test-pm-x'), '[{"size": 42, "stock": 1}]') $q$, '42501');
select pm_tests.throws('user B: cannot insert a product directly',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-PM-X', 'test-pm-x', 'X', 'X', 'men', 'preloved', 'good', 'Black', 100) $q$, '42501');
select pm_tests.returns('user B: cannot see drafts',
  $q$ select count(*)::text from public.products where slug = 'test-pm-owner-draft' $q$, '0');
select pm_tests.refused('user B: cannot change a draft',
  $q$ update public.products set name = 'Hacked' where slug = 'test-pm-owner-draft' $q$);
select pm_tests.throws('user B: cannot publish a draft',
  $q$ select public.admin_set_publication_status(
        (select id from public.products where slug = 'test-pm-owner-draft'), 1, 'published') $q$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Admin A with a password-only session (aal1)
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a0a0a0a0-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}', true);
select pm_tests.returns('admin A (aal1): is not a catalogue admin yet',
  $q$ select public.is_catalogue_admin()::text $q$, 'false');
select pm_tests.returns('admin A (aal1): cannot see drafts',
  $q$ select count(*)::text from public.products where slug = 'test-pm-owner-draft' $q$, '0');
select pm_tests.refused('admin A (aal1): cannot change a draft',
  $q$ update public.products set name = 'Hacked' where slug = 'test-pm-owner-draft' $q$);
select pm_tests.throws('admin A (aal1): cannot create products',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-X', 'test-pm-x'), '[{"size": 42, "stock": 1}]') $q$, '42501');
select pm_tests.throws('admin A (aal1): cannot insert a product directly',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-PM-X', 'test-pm-x', 'X', 'X', 'men', 'preloved', 'good', 'Black', 100) $q$, '42501');
reset role;

-- ---------------------------------------------------------------------------
-- Admin A with two-step verification (aal2)
-- ---------------------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a0a0a0a0-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal2"}', true);

select pm_tests.returns('admin A (aal2): is a catalogue admin',
  $q$ select public.is_catalogue_admin()::text $q$, 'true');
select pm_tests.returns('admin A (aal2): sees drafts',
  $q$ select count(*)::text from public.products where slug = 'test-pm-owner-draft' $q$, '1');

-- Creating
select set_config('pm.pl',
  public.admin_create_product(pm_tests.fields('TEST-PM-PL', 'test-pm-preloved'), '[{"size": 42.5, "stock": 1}]') ->> 'id', true);
select pm_tests.returns('create: a new product is a draft at version 1',
  $q$ select publication_status || ' v' || version from public.products where id = pm_tests.p('pl') $q$, 'draft v1');
select pm_tests.returns('create: the SKU is <item code>-<size>',
  $q$ select string_agg(sku, ',') from public.product_variants where product_id = pm_tests.p('pl') $q$, 'TEST-PM-PL-42.5');
select pm_tests.throws('create: a pre-loved pair has only one size',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-2', 'test-pm-two'), '[{"size": 42, "stock": 1}, {"size": 43, "stock": 1}]') $q$,
  '23505', 'product_variants_one_per_preloved_product');
select pm_tests.throws('create: a pre-loved pair has stock 0 or 1',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-3', 'test-pm-three'), '[{"size": 42, "stock": 2}]') $q$,
  '23514', 'product_variants_preloved_stock');
select pm_tests.throws('create: item codes are unique',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-PL', 'test-pm-other'), '[{"size": 42, "stock": 1}]') $q$,
  '23505', 'products_item_code_key');
select pm_tests.throws('create: slugs are unique',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-4', 'test-pm-preloved'), '[{"size": 42, "stock": 1}]') $q$,
  '23505', 'products_slug_key');
select pm_tests.throws('create: prices can''t be negative',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-5', 'test-pm-five', 'preloved', -1), '[{"size": 42, "stock": 1}]') $q$,
  '23514', 'products_price_not_negative');
select pm_tests.throws('create: an impossible size is refused',
  $q$ select public.admin_create_product(pm_tests.fields('TEST-PM-6', 'test-pm-six'), '[{"size": 42.3, "stock": 1}]') $q$,
  '23514', 'product_variants_size_valid');
select pm_tests.throws('create: products can''t be inserted already published',
  $q$ insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, description, price_paisa, publication_status, listed_at)
      values ('TEST-PM-7', 'test-pm-seven', 'X', 'X', 'men', '{sneakers}', 'preloved', 'good', 'Black', 'X', 100, 'published', current_date) $q$,
  '42501');

-- New kids' shoes: several sizes, any non-negative whole stock
select set_config('pm.kids',
  public.admin_create_product(pm_tests.fields('TEST-PM-K', 'test-pm-kids', 'new', 250000),
    '[{"size": 19, "stock": 3}, {"size": 20, "stock": 0}, {"size": 21.5, "stock": 12}]') ->> 'id', true);
select pm_tests.returns('kids: several sizes with their own stock',
  $q$ select string_agg(sku || '=' || stock, ',' order by size_eu) from public.product_variants where product_id = pm_tests.p('kids') $q$,
  'TEST-PM-K-19=3,TEST-PM-K-20=0,TEST-PM-K-21.5=12');
select pm_tests.throws('kids: negative stock is refused',
  $q$ select public.admin_save_product(pm_tests.p('kids'), pm_tests.v('kids'), pm_tests.fields('TEST-PM-K', 'test-pm-kids', 'new', 250000),
        pm_tests.form(pm_tests.p('kids'), '[{"size": 19, "stock": -1}]'), '[]') $q$, '23514', 'product_variants_stock_not_negative');
select pm_tests.throws('kids: can''t become pre-loved while it has several sizes',
  $q$ select public.admin_save_product(pm_tests.p('kids'), pm_tests.v('kids'), pm_tests.fields('TEST-PM-K', 'test-pm-kids', 'preloved', 250000),
        pm_tests.form(pm_tests.p('kids'), '[{"size": 19, "stock": 1}, {"size": 20, "stock": 0}]'), '[]') $q$, '23505', 'product_variants_one_per_preloved_product');
select public.admin_save_product(pm_tests.p('kids'), pm_tests.v('kids'), pm_tests.fields('TEST-PM-KX', 'test-pm-kids', 'new', 250000),
  pm_tests.form(pm_tests.p('kids'), '[{"size": 19, "stock": 4}, {"size": 22, "stock": 1}]'), '[]');
select pm_tests.returns('kids: a never-published draft can change its item code and sizes; SKUs follow',
  $q$ select string_agg(sku || '=' || stock, ',' order by size_eu) from public.product_variants where product_id = pm_tests.p('kids') $q$,
  'TEST-PM-KX-19=4,TEST-PM-KX-22=1');
select pm_tests.returns('kids: changing it into a single pre-loved pair works when it has one size',
  $q$ select (public.admin_save_product(pm_tests.p('kids'), pm_tests.v('kids'), pm_tests.fields('TEST-PM-KX', 'test-pm-kids', 'preloved', 250000),
        pm_tests.form(pm_tests.p('kids'), '[{"size": 19, "stock": 1}]'), '[]') ->> 'version') $q$, '3');

-- Photos (the Storage object itself is uploaded through the Storage API first)
select pm_tests.throws('photos: the object must be in the product''s own folder',
  $q$ select public.admin_add_product_image(pm_tests.p('pl'), pm_tests.v('pl'), gen_random_uuid(),
        pm_tests.p('kids') || '/' || gen_random_uuid() || '.webp', 1200, 1200, 'Side view') $q$,
  '23514', 'product_images_storage_path_in_product_folder');
select pm_tests.throws('photos: only <uuid>/<uuid>.webp paths',
  $q$ select public.admin_add_product_image(pm_tests.p('pl'), pm_tests.v('pl'), gen_random_uuid(),
        pm_tests.p('pl') || '/../evil.svg', 1200, 1200, 'Side view') $q$,
  '23514', 'product_images_storage_path_format');
select pm_tests.throws('photos: alt text is required',
  $q$ select public.admin_add_product_image(pm_tests.p('pl'), pm_tests.v('pl'), gen_random_uuid(),
        pm_tests.p('pl') || '/' || gen_random_uuid() || '.webp', 1200, 1200, ' ') $q$,
  '23514', 'product_images_alt_not_blank');
select set_config('pm.img1', gen_random_uuid()::text, true);
select set_config('pm.img2', gen_random_uuid()::text, true);
select pm_tests.returns('photos: recording an upload bumps the version',
  $q$ select public.admin_add_product_image(pm_tests.p('pl'), 1, pm_tests.p('img1'),
        pm_tests.p('pl') || '/' || pm_tests.p('img1') || '.webp', 1200, 900, 'Side view')::text $q$, '2');
select pm_tests.throws('photos: recording an upload against an old version is a conflict',
  $q$ select public.admin_add_product_image(pm_tests.p('pl'), 1, gen_random_uuid(),
        pm_tests.p('pl') || '/' || gen_random_uuid() || '.webp', 1200, 900, 'Side view') $q$, 'PT409', 'version_conflict');
select public.admin_add_product_image(pm_tests.p('pl'), 2, pm_tests.p('img2'),
  pm_tests.p('pl') || '/' || pm_tests.p('img2') || '.webp', 1200, 900, 'Sole close-up');
select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL', 'test-pm-preloved'),
  pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'),
  jsonb_build_array(
    jsonb_build_object('id', pm_tests.p('img2'), 'alt', 'Scuff on the sole', 'shows_defect', true),
    jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'Side view', 'shows_defect', false)));
select pm_tests.returns('photos: saving reorders them and marks defect photos',
  $q$ select string_agg(alt || ':' || sort_order || ':' || shows_defect, ',' order by sort_order)
      from public.product_images where product_id = pm_tests.p('pl') $q$,
  'Scuff on the sole:0:true,Side view:1:false');
select pm_tests.throws('photos: a photo of another product can''t be named in a save',
  $q$ select public.admin_save_product(pm_tests.p('kids'), pm_tests.v('kids'), pm_tests.fields('TEST-PM-KX', 'test-pm-kids', 'preloved', 250000),
        pm_tests.form(pm_tests.p('kids'), '[{"size": 19, "stock": 1}]'), jsonb_build_array(jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'x'))) $q$,
  'PT409', 'photos_changed');

-- Publishing rules
select pm_tests.throws('publish: a product without photos can''t be published',
  $q$ select public.admin_set_publication_status(pm_tests.p('kids'), pm_tests.v('kids'), 'published') $q$,
  '23514', 'products_published_needs_photo');
select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL', 'test-pm-preloved', 'preloved', 0),
  pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'),
  jsonb_build_array(jsonb_build_object('id', pm_tests.p('img2'), 'alt', 'Scuff on the sole', 'shows_defect', true),
                    jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'Side view')));
select pm_tests.throws('publish: the price must be positive',
  $q$ select public.admin_set_publication_status(pm_tests.p('pl'), pm_tests.v('pl'), 'published') $q$,
  '23514', 'products_published_price_positive');
select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL', 'test-pm-preloved'),
  pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'),
  jsonb_build_array(jsonb_build_object('id', pm_tests.p('img2'), 'alt', 'Scuff on the sole', 'shows_defect', true),
                    jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'Side view')));
select pm_tests.throws('publish: an old version is a conflict',
  $q$ select public.admin_set_publication_status(pm_tests.p('pl'), pm_tests.v('pl') - 1, 'published') $q$, 'PT409', 'version_conflict');
select public.admin_set_publication_status(pm_tests.p('pl'), pm_tests.v('pl'), 'published');
select pm_tests.returns('publish: it is published with today''s listing date',
  $q$ select publication_status || ' ' || (listed_at = current_date) from public.products where id = pm_tests.p('pl') $q$, 'published true');

-- Stable identifiers once published
select pm_tests.throws('published: the item code is locked',
  $q$ select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL2', 'test-pm-preloved'),
        pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'), jsonb_build_array(jsonb_build_object('id', pm_tests.p('img2'), 'alt', 'a'), jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'b'))) $q$,
  'PT400', 'item_code_locked');
select pm_tests.throws('published: sizes can''t be removed (SKUs are never reused)',
  $q$ select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL', 'test-pm-preloved'),
        pm_tests.form(pm_tests.p('pl'), '[{"size": 43, "stock": 1}]'), jsonb_build_array(jsonb_build_object('id', pm_tests.p('img2'), 'alt', 'a'), jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'b'))) $q$,
  'PT400', 'variant_locked');
select pm_tests.throws('published: the last photo can''t be removed',
  $q$ select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL', 'test-pm-preloved'),
        pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'), '[]') $q$,
  '23514', 'products_published_needs_photo');
-- Admins have no direct write access to sizes (20261031120000_inventory_ledger.sql).
select pm_tests.throws('published: an SKU can''t be edited directly',
  $q$ update public.product_variants set sku = 'TEST-OTHER-1' where product_id = pm_tests.p('pl') $q$, '42501');
select pm_tests.returns('published: removing one photo returns its Storage path for clean-up',
  $q$ select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL', 'test-pm-preloved'),
        pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 0}]'), jsonb_build_array(jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'Side view'))) -> 'removed_paths' ->> 0 $q$,
  pm_tests.p('pl') || '/' || pm_tests.p('img2') || '.webp');
select pm_tests.returns('published: zero stock is allowed (sold out) and it stays published',
  $q$ select publication_status || ' ' || (select stock from public.product_variants where product_id = pm_tests.p('pl'))
      from public.products where id = pm_tests.p('pl') $q$, 'published 0');
select pm_tests.throws('published: products can''t be deleted',
  $q$ delete from public.products where id = pm_tests.p('pl') $q$, '42501');
select pm_tests.throws('published: the version can''t be set directly',
  $q$ update public.products set version = 1 where id = pm_tests.p('pl') $q$, '42501');
reset role;

-- What the public sees of it
set local role anon;
select pm_tests.returns('anon: sees the published product, its size and photo',
  $q$ select (select count(*) from public.products where slug = 'test-pm-preloved')
          || '/' || (select count(*) from public.product_variants where sku = 'TEST-PM-PL-42.5')
          || '/' || (select count(*) from public.product_images where storage_path like '%' || current_setting('pm.img1') || '%') $q$, '1/1/1');
select pm_tests.returns('anon: still sees no drafts',
  $q$ select count(*)::text from public.products where slug in ('test-pm-kids', 'test-pm-owner-draft') $q$, '0');
reset role;

-- Conflicting saves: admins A and C both opened the same version
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "c0c0c0c0-0000-4000-8000-00000000000c", "role": "authenticated", "aal": "aal2"}', true);
select set_config('pm.opened', pm_tests.v('pl')::text, true);
select public.admin_save_product(pm_tests.p('pl'), current_setting('pm.opened')::integer, pm_tests.fields('TEST-PM-PL', 'test-pm-preloved', 'preloved', 450000),
  pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'), jsonb_build_array(jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'Side view')));
select set_config('request.jwt.claims', '{"sub": "a0a0a0a0-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal2"}', true);
select pm_tests.throws('conflict: the second save of the same version is refused',
  $q$ select public.admin_save_product(pm_tests.p('pl'), current_setting('pm.opened')::integer, pm_tests.fields('TEST-PM-PL', 'test-pm-preloved', 'preloved', 400000),
        pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'), jsonb_build_array(jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'Side view'))) $q$,
  'PT409', 'version_conflict');
select pm_tests.returns('conflict: the first save is kept',
  $q$ select price_paisa::text from public.products where id = pm_tests.p('pl') $q$, '450000');

-- Unpublish, archive and restore
select public.admin_set_publication_status(pm_tests.p('pl'), pm_tests.v('pl'), 'draft');
reset role;
set local role anon;
select pm_tests.returns('unpublished: hidden from the public again (product, size and photo)',
  $q$ select (select count(*) from public.products where slug = 'test-pm-preloved')
          || '/' || (select count(*) from public.product_variants where sku = 'TEST-PM-PL-42.5')
          || '/' || (select count(*) from public.product_images where storage_path like '%' || current_setting('pm.img1') || '%') $q$, '0/0/0');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a0a0a0a0-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal2"}', true);
select pm_tests.throws('unpublished: the item code stays locked (it was published once)',
  $q$ select public.admin_save_product(pm_tests.p('pl'), pm_tests.v('pl'), pm_tests.fields('TEST-PM-PL2', 'test-pm-preloved'),
        pm_tests.form(pm_tests.p('pl'), '[{"size": 42.5, "stock": 1}]'), jsonb_build_array(jsonb_build_object('id', pm_tests.p('img1'), 'alt', 'Side view'))) $q$,
  'PT400', 'item_code_locked');
select public.admin_set_publication_status(pm_tests.p('pl'), pm_tests.v('pl'), 'archived');
select pm_tests.throws('archived: can''t go straight back to published',
  $q$ select public.admin_set_publication_status(pm_tests.p('pl'), pm_tests.v('pl'), 'published') $q$, 'PT400', 'bad_transition');
select public.admin_set_publication_status(pm_tests.p('pl'), pm_tests.v('pl'), 'draft');
select pm_tests.returns('archived: can be restored as a draft, keeping its listing date',
  $q$ select publication_status || ' ' || (listed_at is not null) from public.products where id = pm_tests.p('pl') $q$, 'draft true');
reset role;

-- A password-only session still can't touch anything the admin made
set local role authenticated;
select set_config('request.jwt.claims', '{"sub": "a0a0a0a0-0000-4000-8000-00000000000a", "role": "authenticated", "aal": "aal1"}', true);
select pm_tests.returns('admin A (aal1): sees none of the test drafts, sizes or photos',
  $q$ select (select count(*) from public.products where id in (pm_tests.p('pl'), pm_tests.p('kids')) or slug = 'test-pm-owner-draft')
          || '/' || (select count(*) from public.product_variants where product_id in (pm_tests.p('pl'), pm_tests.p('kids')))
          || '/' || (select count(*) from public.product_images where product_id in (pm_tests.p('pl'), pm_tests.p('kids'))) $q$, '0/0/0');
-- Every product in the database, not only the test's (real products may exist).
select pm_tests.returns('admin A (aal1): sees no draft or archived product at all',
  $q$ select count(*)::text from public.products where publication_status <> 'published' $q$, '0');
select pm_tests.throws('admin A (aal1): can''t publish',
  $q$ select public.admin_set_publication_status(pm_tests.p('pl'), 1, 'published') $q$, '42501');
reset role;

select pm_tests.check('ALL PRODUCT MANAGEMENT TESTS PASSED', true);

rollback;
