-- Catalogue database tests: constraints, and read/write permissions for the
-- public (anon) and signed-in (authenticated) roles.
--
-- Run after the migration, as the database owner (the Supabase SQL editor runs
-- as postgres). Everything happens in one transaction that is ROLLED BACK at
-- the end, so test rows are never kept and existing data is not touched.
--
-- Result: the script completes without an error only if every test passed.
-- The first failing test stops it with "FAIL <test>: <reason>". Passing tests
-- raise "PASS <test>" notices where the client shows them.
--
-- Visibility tests first prove that the role CAN see the published test rows,
-- so an empty result is never mistaken for a pass.

begin;

-- ---------------------------------------------------------------------------
-- Helpers (created inside the transaction, so they disappear with it)
-- ---------------------------------------------------------------------------

create schema catalogue_tests;

create function catalogue_tests.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL %: %', label, detail;
  end if;
  raise notice 'PASS %', label;
end;
$$;

-- Requires `query` (a single-value SELECT) to return `expected`. NULL reads as ''.
create function catalogue_tests.returns(label text, query text, expected text)
returns void language plpgsql as $$
declare
  actual text;
begin
  execute query into actual;
  perform catalogue_tests.check(label, coalesce(actual, '') = expected,
    format('expected [%s], got [%s]', expected, coalesce(actual, '')));
end;
$$;

-- Requires `statement` to change exactly `expected` rows.
create function catalogue_tests.affects(label text, statement text, expected integer)
returns void language plpgsql as $$
declare
  actual integer;
begin
  execute statement;
  get diagnostics actual = row_count;
  perform catalogue_tests.check(label, actual = expected,
    format('expected %s row(s) changed, got %s', expected, actual));
end;
$$;

-- Requires `statement` to be refused (insufficient privilege or row-level
-- security, SQLSTATE 42501) or to change no rows at all.
create function catalogue_tests.refused(label text, statement text)
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
  perform catalogue_tests.check(label, changed = 0, format('%s row(s) changed', changed));
end;
$$;

-- Requires `statement` to fail with SQLSTATE `expected_state` (and, if given,
-- the named constraint or index).
create function catalogue_tests.throws(
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

grant usage on schema catalogue_tests to anon, authenticated;
grant execute on all functions in schema catalogue_tests to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Test data (slugs start with test-, codes and SKUs with TEST-)
--
-- The database may also hold real products, including an admin's own
-- "test-..." listings, so checks never select test rows by those prefixes.
-- They use the IDs recorded in catalogue_tests.fixtures (products this script
-- created), or exact slugs and SKUs. Visibility checks additionally cover
-- every product in the database.
-- ---------------------------------------------------------------------------

create table catalogue_tests.fixtures (id uuid primary key);
grant select on catalogue_tests.fixtures to anon, authenticated;

with created as (
insert into public.products
  (item_code, slug, name, brand, department, styles, item_status, condition, colour, price_paisa, publication_status, listed_at, description)
values
  ('TEST-PUB-PL', 'test-published-preloved', 'Test pair', 'Testbrand', 'men', '{sneakers}', 'preloved', 'good', 'Black', 500000, 'published', '2026-10-01', 'Test description'),
  ('TEST-PUB-NEW', 'test-published-new', 'Test kids style', 'Testbrand', 'kids', '{casual}', 'new', 'new', 'Red', 250000, 'published', '2026-10-01', 'Test description'),
  ('TEST-DRAFT', 'test-draft', 'Test draft', 'Testbrand', 'women', '{heels}', 'preloved', 'excellent', 'Ivory', 700000, 'draft', null, 'Test description'),
  ('TEST-ARCHIVED', 'test-archived', 'Test archived', 'Testbrand', 'kids', '{boots}', 'new', 'new', 'Brown', 300000, 'archived', '2026-09-01', 'Test description'),
  -- Helpers for the constraint tests below; drafts, so they never affect visibility counts.
  ('TEST-PL-EMPTY', 'test-preloved-empty', 'Test pair, no size yet', 'Testbrand', 'men', '{}', 'preloved', 'good', 'Grey', 100000, 'draft', null, 'Test description'),
  ('TEST-NEW-TWO', 'test-new-two-sizes', 'Test two sizes', 'Testbrand', 'kids', '{}', 'new', 'new', 'Blue', 100000, 'draft', null, 'Test description'),
  ('TEST-NEW-THREE', 'test-new-stock-three', 'Test three in stock', 'Testbrand', 'kids', '{}', 'new', 'new', 'Pink', 100000, 'draft', null, 'Test description'),
  ('TEST-NEW-ONE', 'test-new-single', 'Test single pair', 'Testbrand', 'kids', '{}', 'new', 'new', 'Green', 100000, 'draft', null, 'Test description')
returning id
)
insert into catalogue_tests.fixtures select id from created;

insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
select p.id, p.item_status, v.sku, v.size_eu, v.stock
from (
  values
    ('test-published-preloved', 'TEST-PUB-PL-42', 42::numeric, 1),
    ('test-published-new', 'TEST-PUB-NEW-20', 20, 5),
    ('test-published-new', 'TEST-PUB-NEW-21', 21, 0),
    ('test-published-new', 'TEST-PUB-NEW-21.5', 21.5, 2),
    ('test-draft', 'TEST-DRAFT-38', 38, 1),
    ('test-archived', 'TEST-ARCHIVED-25', 25, 2),
    ('test-new-two-sizes', 'TEST-NEW-TWO-30', 30, 1),
    ('test-new-two-sizes', 'TEST-NEW-TWO-31', 31, 1),
    ('test-new-stock-three', 'TEST-NEW-THREE-28', 28, 3),
    ('test-new-single', 'TEST-NEW-ONE-27', 27, 1)
) as v (slug, sku, size_eu, stock)
join public.products p on p.slug = v.slug;

insert into public.product_images (product_id, sort_order, src, alt, width, height, focus, shows_defect)
select p.id, i.sort_order, i.src, i.alt, 800, 800, i.focus, i.shows_defect
from (
  values
    ('test-published-preloved', 0, '/images/test/published-preloved.jpg', 'Test pair, side view', '50% 50%', false),
    ('test-published-preloved', 1, '/images/test/published-preloved-defect.jpg', 'Close-up of a scuff on the toe', null, true),
    ('test-published-new', 0, '/images/test/published-new.jpg', 'Test kids style', null::text, false),
    ('test-draft', 0, '/images/test/draft.jpg', 'Test draft', null, false),
    ('test-archived', 0, '/images/test/archived.jpg', 'Test archived', null, false)
) as i (slug, sort_order, src, alt, focus, shows_defect)
join public.products p on p.slug = i.slug;

-- The owner sees every test row, including the hidden ones; later "hidden"
-- checks are meaningful because these rows are known to exist.
select catalogue_tests.returns('setup: 8 test products exist',
  $q$ select count(*)::text from public.products where id in (select id from catalogue_tests.fixtures) $q$, '8');
select catalogue_tests.returns('setup: 10 test variants exist',
  $q$ select count(*)::text from public.product_variants where product_id in (select id from catalogue_tests.fixtures) $q$, '10');
select catalogue_tests.returns('setup: 5 test images exist',
  $q$ select count(*)::text from public.product_images where product_id in (select id from catalogue_tests.fixtures) $q$, '5');

-- ---------------------------------------------------------------------------
-- Product constraints
-- ---------------------------------------------------------------------------

select catalogue_tests.throws('negative price is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-X1', 'test-x1', 'X', 'X', 'men', 'preloved', 'good', 'Black', -1) $q$,
  '23514', 'products_price_not_negative');

select catalogue_tests.throws('price cannot be updated to a negative value',
  $q$ update public.products set price_paisa = -100 where slug = 'test-published-preloved' $q$,
  '23514', 'products_price_not_negative');

select catalogue_tests.throws('blank name is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-X2', 'test-x2', '  ', 'X', 'men', 'preloved', 'good', 'Black', 100) $q$,
  '23514', 'products_name_not_blank');

select catalogue_tests.throws('unknown department is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-X3', 'test-x3', 'X', 'X', 'unisex', 'preloved', 'good', 'Black', 100) $q$,
  '23514', 'products_department_valid');

select catalogue_tests.throws('unknown style is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, price_paisa)
      values ('TEST-X4', 'test-x4', 'X', 'X', 'men', '{sneakers,slippers}', 'preloved', 'good', 'Black', 100) $q$,
  '23514', 'products_styles_valid');

select catalogue_tests.throws('empty style entry is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, price_paisa)
      values ('TEST-X5', 'test-x5', 'X', 'X', 'men', array[null]::text[], 'preloved', 'good', 'Black', 100) $q$,
  '23514', 'products_styles_valid');

select catalogue_tests.throws('unknown publication status is rejected',
  $q$ update public.products set publication_status = 'hidden' where slug = 'test-draft' $q$,
  '23514', 'products_publication_status_valid');

select catalogue_tests.throws('unknown item status is rejected',
  $q$ update public.products set item_status = 'used' where slug = 'test-draft' $q$,
  '23514', 'products_item_status_valid');

select catalogue_tests.throws('pre-loved product cannot be graded "new"',
  $q$ update public.products set condition = 'new' where slug = 'test-published-preloved' $q$,
  '23514', 'products_condition_matches_item_status');

select catalogue_tests.throws('new product must be graded "new"',
  $q$ update public.products set condition = 'excellent' where slug = 'test-published-new' $q$,
  '23514', 'products_condition_matches_item_status');

select catalogue_tests.throws('published product needs a listing date',
  $q$ update public.products set publication_status = 'published' where slug = 'test-draft' $q$,
  '23514', 'products_published_needs_listing_date');

select catalogue_tests.throws('duplicate slug is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-X6', 'test-draft', 'X', 'X', 'men', 'preloved', 'good', 'Black', 100) $q$,
  '23505', 'products_slug_key');

select catalogue_tests.throws('duplicate item code is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-DRAFT', 'test-x7', 'X', 'X', 'men', 'preloved', 'good', 'Black', 100) $q$,
  '23505', 'products_item_code_key');

select catalogue_tests.throws('badly formatted slug is rejected',
  $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa)
      values ('TEST-X8', 'Test Slug!', 'X', 'X', 'men', 'preloved', 'good', 'Black', 100) $q$,
  '23514', 'products_slug_format');

-- ---------------------------------------------------------------------------
-- Variant constraints
-- ---------------------------------------------------------------------------

select catalogue_tests.throws('size below EU 15 is rejected',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, 'TEST-V1', 10, 1 from public.products where slug = 'test-published-new' $q$,
  '23514', 'product_variants_size_valid');

select catalogue_tests.throws('size above EU 50 is rejected',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, 'TEST-V2', 51, 1 from public.products where slug = 'test-published-new' $q$,
  '23514', 'product_variants_size_valid');

select catalogue_tests.throws('size that is not whole or half is rejected',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, 'TEST-V3', 22.3, 1 from public.products where slug = 'test-published-new' $q$,
  '23514', 'product_variants_size_valid');

select catalogue_tests.returns('half sizes are accepted',
  $q$ select size_eu::text from public.product_variants where sku = 'TEST-PUB-NEW-21.5' $q$, '21.5');

select catalogue_tests.throws('negative stock is rejected',
  $q$ update public.product_variants set stock = -1 where sku = 'TEST-PUB-NEW-20' $q$,
  '23514', 'product_variants_stock_not_negative');

select catalogue_tests.throws('duplicate SKU is rejected',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, 'TEST-PUB-NEW-20', 22, 1 from public.products where slug = 'test-published-new' $q$,
  '23505', 'product_variants_sku_key');

select catalogue_tests.throws('same size twice on one product is rejected',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, 'TEST-V4', 20, 1 from public.products where slug = 'test-published-new' $q$,
  '23505', 'product_variants_one_size_per_product');

select catalogue_tests.returns('new kids'' product holds several sizes with stock above 1',
  $q$ select count(*) || ' sizes, max stock ' || max(stock) from public.product_variants v
      join public.products p on p.id = v.product_id where p.slug = 'test-published-new' $q$,
  '3 sizes, max stock 5');

-- ---------------------------------------------------------------------------
-- Pre-loved rules: one variant, stock 0 or 1, also enforced on updates
-- ---------------------------------------------------------------------------

select catalogue_tests.throws('pre-loved product cannot get a second size',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, 'TEST-V5', 43, 1 from public.products where slug = 'test-published-preloved' $q$,
  '23505', 'product_variants_one_per_preloved_product');

select catalogue_tests.throws('pre-loved size cannot be inserted with stock 2',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, item_status, 'TEST-V6', 40, 2 from public.products where slug = 'test-preloved-empty' $q$,
  '23514', 'product_variants_preloved_stock');

select catalogue_tests.throws('pre-loved stock cannot be updated to 2',
  $q$ update public.product_variants set stock = 2 where sku = 'TEST-PUB-PL-42' $q$,
  '23514', 'product_variants_preloved_stock');

select catalogue_tests.affects('pre-loved pair can be marked sold (stock 0)',
  $q$ update public.product_variants set stock = 0 where sku = 'TEST-PUB-PL-42' $q$, 1);
select catalogue_tests.affects('pre-loved pair can be restocked to 1',
  $q$ update public.product_variants set stock = 1 where sku = 'TEST-PUB-PL-42' $q$, 1);

select catalogue_tests.throws('variant cannot claim a different item status than its product',
  $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
      select id, 'new', 'TEST-V7', 40, 5 from public.products where slug = 'test-preloved-empty' $q$,
  '23503', 'product_variants_product_fkey');

select catalogue_tests.throws('a pre-loved size cannot be relabelled "new" to dodge the rules',
  $q$ update public.product_variants set item_status = 'new' where sku = 'TEST-PUB-PL-42' $q$,
  '23503', 'product_variants_product_fkey');

select catalogue_tests.throws('new product with two sizes cannot become pre-loved',
  $q$ update public.products set item_status = 'preloved', condition = 'good' where slug = 'test-new-two-sizes' $q$,
  '23505', 'product_variants_one_per_preloved_product');

select catalogue_tests.throws('new product with stock 3 cannot become pre-loved',
  $q$ update public.products set item_status = 'preloved', condition = 'good' where slug = 'test-new-stock-three' $q$,
  '23514', 'product_variants_preloved_stock');

select catalogue_tests.throws('a size cannot be moved onto a pre-loved product that already has one',
  $q$ update public.product_variants
      set (product_id, item_status) = (select id, item_status from public.products where slug = 'test-published-preloved')
      where sku = 'TEST-NEW-TWO-30' $q$,
  '23505', 'product_variants_one_per_preloved_product');

select catalogue_tests.affects('new product with one pair in stock can become pre-loved',
  $q$ update public.products set item_status = 'preloved', condition = 'good' where slug = 'test-new-single' $q$, 1);
select catalogue_tests.returns('its size follows the product''s new status',
  $q$ select item_status from public.product_variants where sku = 'TEST-NEW-ONE-27' $q$, 'preloved');

-- ---------------------------------------------------------------------------
-- Image constraints
-- ---------------------------------------------------------------------------

select catalogue_tests.throws('image with zero width is rejected',
  $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height)
      select id, 5, '/images/test/x.jpg', 'X', 0, 800 from public.products where slug = 'test-published-new' $q$,
  '23514', 'product_images_dimensions_positive');

select catalogue_tests.throws('image without alt text is rejected',
  $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height)
      select id, 5, '/images/test/x.jpg', ' ', 800, 800 from public.products where slug = 'test-published-new' $q$,
  '23514', 'product_images_alt_not_blank');

select catalogue_tests.throws('image source must be a site path or https URL',
  $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height)
      select id, 5, 'javascript:alert(1)', 'X', 800, 800 from public.products where slug = 'test-published-new' $q$,
  '23514', 'product_images_src_valid');

select catalogue_tests.throws('crop focus must look like "50% 50%"',
  $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height, focus)
      select id, 5, '/images/test/x.jpg', 'X', 800, 800, 'center' from public.products where slug = 'test-published-new' $q$,
  '23514', 'product_images_focus_format');

select catalogue_tests.throws('two images cannot share a display position',
  $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height)
      select id, 0, '/images/test/x.jpg', 'X', 800, 800 from public.products where slug = 'test-published-new' $q$,
  '23505', 'product_images_sort_order_key');

select catalogue_tests.throws('image must belong to an existing product',
  $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height)
      values ('00000000-0000-0000-0000-000000000000', 0, '/images/test/x.jpg', 'X', 800, 800) $q$,
  '23503', 'product_images_product_id_fkey');

-- ---------------------------------------------------------------------------
-- Housekeeping behaviour
-- ---------------------------------------------------------------------------

update public.products set updated_at = '2000-01-01' where slug = 'test-draft';
select catalogue_tests.returns('updated_at is refreshed on every update',
  $q$ select (updated_at > '2000-01-02')::text from public.products where slug = 'test-draft' $q$, 'true');

delete from public.products where slug = 'test-new-stock-three';
select catalogue_tests.returns('deleting a product removes its sizes',
  $q$ select count(*)::text from public.product_variants where sku = 'TEST-NEW-THREE-28' $q$, '0');

-- ---------------------------------------------------------------------------
-- Security set-up
-- ---------------------------------------------------------------------------

select catalogue_tests.returns('RLS is enabled on all three tables',
  $q$ select count(*)::text from pg_class
      where oid in ('public.products'::regclass, 'public.product_variants'::regclass, 'public.product_images'::regclass)
        and relrowsecurity $q$, '3');

select catalogue_tests.returns('anon and authenticated can SELECT all three tables',
  $q$ select string_agg(r || ' ' || t, ', ' order by r, t)
      from unnest(array['anon', 'authenticated']) r,
           unnest(array['public.products', 'public.product_variants', 'public.product_images']) t
      where not has_table_privilege(r, t, 'SELECT') $q$, '');

select catalogue_tests.returns('anon has no write privileges at all',
  $q$ select string_agg(t || ' ' || p, ', ' order by t, p)
      from unnest(array['public.products', 'public.product_variants', 'public.product_images']) t,
           unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      where has_table_privilege('anon', t, p)
         or (p in ('INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege('anon', t, p)) $q$, '');

-- Signed-in users hold the column grants that verified admins write through
-- (20261029120000_admin_product_management.sql); RLS limits them to verified
-- admins, which product_management_test.sql checks in detail.
select catalogue_tests.returns('authenticated can never delete or truncate products, or use REFERENCES/TRIGGER',
  $q$ select string_agg(t || ' ' || p, ', ' order by t, p)
      from unnest(array['public.products', 'public.product_variants', 'public.product_images']) t,
           unnest(array['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      where (has_table_privilege('authenticated', t, p) or (p = 'REFERENCES' and has_any_column_privilege('authenticated', t, p)))
        and not (p = 'DELETE' and t in ('public.product_variants', 'public.product_images')) $q$, '');

select catalogue_tests.returns('anon policies are SELECT-only; every write policy requires a verified admin',
  $q$ select string_agg(tablename || ': ' || policyname, ', ')
      from pg_policies
      where schemaname = 'public'
        and tablename in ('products', 'product_variants', 'product_images')
        and (
          (cmd <> 'SELECT' and (roles <> array['authenticated']::name[]
            or coalesce(qual, '') || coalesce(with_check, '') not like '%is_catalogue_admin()%'))
          or not roles <@ array['anon', 'authenticated']::name[]
        ) $q$, '');

select catalogue_tests.returns('API roles cannot execute the updated_at trigger function',
  $q$ select string_agg(r, ', ') from unnest(array['anon', 'authenticated']) r
      where has_function_privilege(r, 'public.set_updated_at()', 'EXECUTE') $q$, '');

-- ---------------------------------------------------------------------------
-- What the public sees and can do (run once as anon, once as authenticated)
-- ---------------------------------------------------------------------------

-- Every product that must be hidden: this script's drafts and archived
-- products AND any others in the database. Taken as the owner, who sees all.
create table catalogue_tests.unpublished as
  select id from public.products where publication_status <> 'published';
grant select on catalogue_tests.unpublished to anon, authenticated;

select catalogue_tests.returns('setup: the hidden set includes the test''s 5 remaining drafts and archived products',
  $q$ select count(*)::text from catalogue_tests.unpublished where id in (select id from catalogue_tests.fixtures) $q$, '5');

create function catalogue_tests.public_access(expected_role text)
returns void language plpgsql as $$
declare
  r text := expected_role;
begin
  perform catalogue_tests.check(r || ': running as ' || r, current_user = r, 'current_user is ' || current_user);

  -- Positive checks first: published rows must be visible.
  perform catalogue_tests.returns(r || ': sees exactly the published test products',
    $q$ select string_agg(slug, ',' order by slug) from public.products where id in (select id from catalogue_tests.fixtures) $q$,
    'test-published-new,test-published-preloved');
  perform catalogue_tests.returns(r || ': sees exactly the sizes of published products',
    $q$ select string_agg(sku, ',' order by sku) from public.product_variants
        where product_id in (select id from catalogue_tests.fixtures) $q$,
    'TEST-PUB-NEW-20,TEST-PUB-NEW-21,TEST-PUB-NEW-21.5,TEST-PUB-PL-42');
  perform catalogue_tests.returns(r || ': sees exactly the images of published products, defect photo included',
    $q$ select string_agg(src || case when shows_defect then ' (defect)' else '' end, ',' order by src)
        from public.product_images where product_id in (select id from catalogue_tests.fixtures) $q$,
    '/images/test/published-new.jpg,/images/test/published-preloved-defect.jpg (defect),/images/test/published-preloved.jpg');

  -- Hidden rows, known to exist from the setup checks.
  perform catalogue_tests.returns(r || ': draft and archived products are hidden',
    $q$ select count(*)::text from public.products where slug in ('test-draft', 'test-archived') $q$, '0');
  perform catalogue_tests.returns(r || ': their sizes are hidden even when asked for by SKU',
    $q$ select count(*)::text from public.product_variants where sku in ('TEST-DRAFT-38', 'TEST-ARCHIVED-25') $q$, '0');
  perform catalogue_tests.returns(r || ': their images are hidden',
    $q$ select count(*)::text from public.product_images
        where src in ('/images/test/draft.jpg', '/images/test/archived.jpg') $q$, '0');
  perform catalogue_tests.returns(r || ': helper drafts are hidden too',
    $q$ select count(*)::text from public.products
        where id in (select id from catalogue_tests.fixtures) and publication_status <> 'published' $q$, '0');
  -- Every product in the database, not only the test's.
  perform catalogue_tests.returns(r || ': no draft or archived product is visible at all',
    $q$ select count(*)::text from public.products where publication_status <> 'published' $q$, '0');
  perform catalogue_tests.returns(r || ': no size of any draft or archived product is visible',
    $q$ select count(*)::text from public.product_variants where product_id in (select id from catalogue_tests.unpublished) $q$, '0');
  perform catalogue_tests.returns(r || ': no image of any draft or archived product is visible',
    $q$ select count(*)::text from public.product_images where product_id in (select id from catalogue_tests.unpublished) $q$, '0');

  -- Writes are refused (by privileges for anon; by privileges or row-level
  -- security for signed-in users who aren't verified admins) or change nothing.
  perform catalogue_tests.refused(r || ': cannot insert products',
    $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa, publication_status, listed_at)
        values ('TEST-HACK', 'test-hack', 'X', 'X', 'men', 'preloved', 'good', 'Black', 100, 'published', '2026-10-01') $q$);
  perform catalogue_tests.refused(r || ': cannot update products',
    $q$ update public.products set price_paisa = 1 where slug = 'test-published-preloved' $q$);
  perform catalogue_tests.refused(r || ': cannot delete products',
    $q$ delete from public.products where slug = 'test-published-preloved' $q$);
  perform catalogue_tests.refused(r || ': cannot truncate products',
    $q$ truncate public.products cascade $q$);
  perform catalogue_tests.refused(r || ': cannot insert sizes',
    $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
        select id, item_status, 'TEST-HACK-22', 22, 9 from public.products where slug = 'test-published-new' $q$);
  perform catalogue_tests.refused(r || ': cannot change stock',
    $q$ update public.product_variants set stock = 99 where sku = 'TEST-PUB-NEW-20' $q$);
  perform catalogue_tests.refused(r || ': cannot delete sizes',
    $q$ delete from public.product_variants where sku = 'TEST-PUB-NEW-20' $q$);
  perform catalogue_tests.refused(r || ': cannot insert images',
    $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height)
        select id, 9, '/images/test/hack.jpg', 'X', 800, 800 from public.products where slug = 'test-published-new' $q$);
  perform catalogue_tests.refused(r || ': cannot update images',
    $q$ update public.product_images set alt = 'X' where src = '/images/test/published-new.jpg' $q$);
  perform catalogue_tests.refused(r || ': cannot delete images',
    $q$ delete from public.product_images where src = '/images/test/published-new.jpg' $q$);
end;
$$;

grant execute on function catalogue_tests.public_access(text) to anon, authenticated;

set local role anon;
select catalogue_tests.public_access('anon');
reset role;

set local role authenticated;
select catalogue_tests.public_access('authenticated');
reset role;

-- ---------------------------------------------------------------------------
-- Defence in depth: even if write privileges were granted by mistake, no
-- write policy lets anyone but a verified admin change anything.
-- ---------------------------------------------------------------------------

grant insert, update, delete on public.products, public.product_variants, public.product_images
  to anon, authenticated;

create function catalogue_tests.rls_blocks_writes(expected_role text)
returns void language plpgsql as $$
declare
  r text := expected_role;
begin
  perform catalogue_tests.throws(r || ' + accidental grant: RLS still blocks inserting products',
    $q$ insert into public.products (item_code, slug, name, brand, department, item_status, condition, colour, price_paisa, publication_status, listed_at)
        values ('TEST-HACK2', 'test-hack2', 'X', 'X', 'men', 'preloved', 'good', 'Black', 100, 'published', '2026-10-01') $q$,
    '42501');
  perform catalogue_tests.affects(r || ' + accidental grant: RLS lets no product be updated',
    $q$ update public.products set price_paisa = 1 where slug = 'test-published-preloved' $q$, 0);
  perform catalogue_tests.affects(r || ' + accidental grant: RLS lets no product be deleted',
    $q$ delete from public.products where slug like 'test-%' $q$, 0);
  perform catalogue_tests.throws(r || ' + accidental grant: RLS still blocks inserting sizes',
    $q$ insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
        select id, item_status, 'TEST-HACK2-22', 22, 9 from public.products where slug = 'test-published-new' $q$,
    '42501');
  perform catalogue_tests.affects(r || ' + accidental grant: RLS lets no stock be changed',
    $q$ update public.product_variants set stock = 99 where sku like 'TEST-%' $q$, 0);
  perform catalogue_tests.affects(r || ' + accidental grant: RLS lets no size be deleted',
    $q$ delete from public.product_variants where sku like 'TEST-%' $q$, 0);
  perform catalogue_tests.throws(r || ' + accidental grant: RLS still blocks inserting images',
    $q$ insert into public.product_images (product_id, sort_order, src, alt, width, height)
        select id, 9, '/images/test/hack.jpg', 'X', 800, 800 from public.products where slug = 'test-published-new' $q$,
    '42501');
  perform catalogue_tests.affects(r || ' + accidental grant: RLS lets no image be changed',
    $q$ update public.product_images set alt = 'X' where src like '/images/test/%' $q$, 0);
  perform catalogue_tests.affects(r || ' + accidental grant: RLS lets no image be deleted',
    $q$ delete from public.product_images where src like '/images/test/%' $q$, 0);
end;
$$;

grant execute on function catalogue_tests.rls_blocks_writes(text) to anon, authenticated;

set local role anon;
select catalogue_tests.rls_blocks_writes('anon');
reset role;

set local role authenticated;
select catalogue_tests.rls_blocks_writes('authenticated');
reset role;

select catalogue_tests.returns('nothing was changed by the blocked writes',
  $q$ select (select price_paisa from public.products where slug = 'test-published-preloved')
          || ' / ' || (select stock from public.product_variants where sku = 'TEST-PUB-NEW-20')
          || ' / ' || (select count(*) from public.product_images where product_id in (select id from catalogue_tests.fixtures)) $q$,
  '500000 / 5 / 5');

select catalogue_tests.check('ALL CATALOGUE TESTS PASSED', true);

rollback;
