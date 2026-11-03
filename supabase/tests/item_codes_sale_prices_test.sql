-- Automatic item codes and sale prices: code assignment and collisions,
-- existing codes, the sale price rules, and that checkout, in-store sales and
-- free delivery charge the sale price while historical orders keep theirs.
--
-- Run after supabase/migrations/20261101130000_item_codes_and_sale_prices.sql,
-- as the database owner (the Supabase SQL editor runs as postgres).
-- Everything happens in one transaction that is ROLLED BACK; the counters a
-- rollback doesn't undo (item codes, barcodes, order numbers) are put back.
-- Concurrent code assignment is tested in db-tests/concurrency.test.ts.
--
-- Result: the script completes without an error only if every test passed.
-- The first failure stops it with "FAIL <test>: <reason>".

begin;

create schema sp_tests;

create function sp_tests.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL %: %', label, detail;
  end if;
  raise notice 'PASS %', label;
end;
$$;

create function sp_tests.returns(label text, query text, expected text)
returns void language plpgsql as $$
declare
  actual text;
begin
  execute query into actual;
  perform sp_tests.check(label, coalesce(actual, '') = expected,
    format('expected [%s], got [%s]', expected, coalesce(actual, '')));
end;
$$;

-- Requires `statement` to fail with SQLSTATE `expected_state` and, if given,
-- the named constraint or hint.
create function sp_tests.throws(label text, statement text, expected_state text, expected_detail text default null)
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
    get stacked diagnostics got_state = returned_sqlstate, got_constraint = constraint_name,
      got_hint = pg_exception_hint, got_message = message_text;
  end;
  if got_state is null then
    raise exception 'FAIL %: statement succeeded but should have been rejected', label;
  end if;
  if got_state <> expected_state
    or (expected_detail is not null and expected_detail is distinct from got_constraint and expected_detail is distinct from got_hint) then
    raise exception 'FAIL %: expected % %, got % %/% (%)', label, expected_state, coalesce(expected_detail, ''),
      got_state, coalesce(got_constraint, ''), coalesce(got_hint, ''), got_message;
  end if;
  raise notice 'PASS %', label;
end;
$$;

create function sp_tests.gw() returns text language sql as $$
  select 'sp-tests-gateway-secret-not-a-real-one-00001'::text;
$$;

create function sp_tests.key(n integer) returns text language sql as $$
  select rpad('sptest' || lpad(n::text, 4, '0'), 43, 'k');
$$;

create function sp_tests.line(sku text, quantity integer, price integer) returns jsonb language sql as $$
  select jsonb_build_object('sku', sku, 'quantity', quantity, 'unit_price_paisa', price);
$$;

create function sp_tests.place(n integer, lines jsonb, delivery bigint, total bigint)
returns jsonb language sql as $$
  select public.place_cod_order(sp_tests.gw(), sp_tests.key(n), jsonb_build_object(
    'lines', lines, 'delivery_paisa', delivery, 'total_paisa', total,
    'customer', jsonb_build_object('name', 'Test Customer', 'phone', '+92300' || lpad(n::text, 7, '0'), 'city', 'Lahore',
      'address', 'House 1, Street 2, Test Town', 'landmark', null, 'note', null)));
$$;

create function sp_tests.quote(lines jsonb) returns jsonb language sql as $$
  select public.quote_order(sp_tests.gw(), lines, 'Lahore');
$$;

create function sp_tests.order_id(n integer) returns uuid language sql as $$
  select id from public.orders where request_key_hash = sha256(convert_to(sp_tests.key(n), 'UTF8'));
$$;

-- Product details as the admin form sends them, with `extra` merged in.
create function sp_tests.fields(item_code text, slug text, extra jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object(
    'item_code', item_code, 'slug', slug, 'name', 'Sale test trainers', 'brand', 'Testbrand', 'department', 'kids',
    'styles', jsonb_build_array('sneakers'), 'item_status', 'new', 'condition', 'new', 'condition_notes', '[]'::jsonb,
    'colour', 'Navy', 'description', 'Test description', 'price_paisa', 300000) || extra;
$$;

-- Sizes as a form opened just now sends them.
create function sp_tests.form(product uuid) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('size', v.size_eu, 'stock', v.stock,
    'stock_was', v.stock, 'inventory_version', v.inventory_version) order by v.size_eu), '[]'::jsonb)
  from public.product_variants v where v.product_id = product;
$$;

-- The photos to keep, as the admin form sends them.
create function sp_tests.images(product uuid) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'alt', i.alt, 'shows_defect', i.shows_defect) order by i.sort_order), '[]'::jsonb)
  from public.product_images i where i.product_id = product;
$$;

create function sp_tests.pid(code text) returns uuid language sql as $$
  select id from public.products where item_code = code;
$$;

create function sp_tests.ver(code text) returns integer language sql as $$
  select version from public.products where item_code = code;
$$;

-- The item code the next automatic assignment would try first.
create function sp_tests.next_code() returns text language sql as $$
  select 'ITEM-' || lpad((case when is_called then last_value + 1 else last_value end)::text, 6, '0')
  from private.item_code_seq;
$$;

create function sp_tests.as_admin() returns void language sql as $$
  select set_config('request.jwt.claims',
    '{"sub": "e1e1e1e1-0000-4000-8000-00000000000e", "role": "authenticated", "aal": "aal2"}', true);
$$;

grant usage on schema sp_tests to anon, authenticated;
grant execute on all functions in schema sp_tests to anon, authenticated;

-- Counters a rollback doesn't undo: remember them, to put them back at the end.
select set_config('sp.item_last', last_value::text, true), set_config('sp.item_called', is_called::text, true)
from private.item_code_seq;
select set_config('sp.serial_last', last_value::text, true), set_config('sp.serial_called', is_called::text, true)
from public.barcode_serial;
select set_config('sp.order_last', last_value::text, true), set_config('sp.order_called', is_called::text, true)
from public.order_number_seq;

-- ---------------------------------------------------------------------------
-- Set-up: an admin, a gateway key, test settings and an existing product
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values ('e1e1e1e1-0000-4000-8000-00000000000e', 'sp-admin@test.invalid');
insert into public.admin_members (user_id) values ('e1e1e1e1-0000-4000-8000-00000000000e');
insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to(sp_tests.gw(), 'UTF8')), 'sp_tests');

-- TEST VALUES ONLY (not the shop's): Rs. 300 delivery, free from Rs. 5,000.
update public.shop_settings set delivery_area_mode = 'nationwide', standard_delivery_fee_paisa = 30000,
  free_delivery_enabled = true, free_delivery_min_paisa = 500000, max_lines_per_order = 10, max_units_per_order = 20,
  max_units_per_line = 10, max_open_orders_per_phone = 5, place_attempts_per_ip_10min = 100, place_attempts_per_ip_day = 1000,
  lookups_per_ip_10min = 100, quotes_per_ip_10min = 100, orders_per_minute_global = 1000, orders_open = true,
  in_store_sells_unpublished = false;

-- An existing product, as created before automatic codes (by the owner).
insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
  colour, description, price_paisa, publication_status, listed_at)
values ('TEST-SP-OLD', 'test-sp-old', 'Existing style', 'Testbrand', 'kids', '{sneakers}', 'new', 'new', 'Red', 'Test', 200000,
  'published', current_date);
insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
select id, 'new', 'TEST-SP-OLD-30', 30, 5 from public.products where item_code = 'TEST-SP-OLD';
insert into public.product_images (product_id, src, alt, width, height)
select id, '/images/test.jpg', 'Test photo', 800, 800 from public.products where item_code = 'TEST-SP-OLD';
select set_config('sp.old_barcode',
  (select b.barcode from public.variant_barcodes b join public.product_variants v on v.id = b.variant_id where v.sku = 'TEST-SP-OLD-30'), true);

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

select sp_tests.returns('API roles can''t use the item-code sequence or its functions',
  $q$ select coalesce(string_agg(x, ', '), '') from (values
        (has_sequence_privilege('anon', 'private.item_code_seq', 'USAGE,SELECT,UPDATE'), 'anon sequence'),
        (has_sequence_privilege('authenticated', 'private.item_code_seq', 'USAGE,SELECT,UPDATE'), 'authenticated sequence'),
        (has_function_privilege('anon', 'private.next_item_code()', 'EXECUTE'), 'anon next_item_code'),
        (has_function_privilege('authenticated', 'private.next_item_code()', 'EXECUTE'), 'authenticated next_item_code')
      ) t(granted, x) where granted $q$, '');
select sp_tests.returns('anon can read the sale price (and still not the label name); nobody updates it directly',
  $q$ select has_column_privilege('anon', 'public.products', 'sale_price_paisa', 'SELECT')::text || ' / '
          || has_column_privilege('anon', 'public.products', 'label_name', 'SELECT')::text || ' / '
          || has_column_privilege('authenticated', 'public.products', 'sale_price_paisa', 'UPDATE')::text || ' / '
          || has_column_privilege('anon', 'public.products', 'sale_price_paisa', 'UPDATE')::text $q$,
  'true / false / false / false');

-- ---------------------------------------------------------------------------
-- Automatic item codes
-- ---------------------------------------------------------------------------

-- As the owner: API roles can't read the sequence.
select set_config('sp.expected', sp_tests.next_code(), true);

set local role authenticated;
select sp_tests.as_admin();
select set_config('sp.auto1', public.admin_create_product(
  sp_tests.fields(null, 'test-sp-auto-1', '{"auto_item_code": true}'), '[{"size": 30, "stock": 2}, {"size": 31, "stock": 1}]') ->> 'item_code', true);
select sp_tests.returns('auto: the first code is the next number, as ITEM-nnnnnn',
  $q$ select current_setting('sp.auto1') ~ '^ITEM-[0-9]{6}$' and current_setting('sp.auto1') = current_setting('sp.expected') $q$, 'true');
select sp_tests.returns('auto: its sizes'' SKUs follow the assigned code, and each size has its own barcode',
  $q$ select string_agg((v.sku = current_setting('sp.auto1') || '-' || trim_scale(v.size_eu) and b.barcode ~ '^KNS[0-9]{8}$')::text, ',' order by v.size_eu)
      from public.product_variants v join public.variant_barcodes b on b.variant_id = v.id
      where v.product_id = sp_tests.pid(current_setting('sp.auto1')) $q$, 'true,true');
select sp_tests.returns('auto: the item code is in its own namespace, never barcode-like',
  $q$ select (current_setting('sp.auto1') !~ '^(KN[S5]|U)[0-9]')::text $q$, 'true');

select set_config('sp.auto2', public.admin_create_product(
  sp_tests.fields('IGNORED-WHEN-AUTO', 'test-sp-auto-2', '{"auto_item_code": true}'), '[{"size": 32, "stock": 1}]') ->> 'item_code', true);
select sp_tests.returns('auto: a second product gets a different, later code (any typed code is ignored)',
  $q$ select (current_setting('sp.auto2') ~ '^ITEM-[0-9]{6}$' and current_setting('sp.auto2') > current_setting('sp.auto1'))::text $q$, 'true');
reset role;

-- A code typed in by hand (here by the owner, who isn't checked) that the sequence would reach next.
select set_config('sp.taken', sp_tests.next_code(), true);
insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition, colour, price_paisa)
values (current_setting('sp.taken'), 'test-sp-taken', 'Hand-typed code', 'Testbrand', 'kids', '{}', 'new', 'new', 'Red', 100000);

set local role authenticated;
select sp_tests.as_admin();
select set_config('sp.auto3', public.admin_create_product(
  sp_tests.fields(null, 'test-sp-auto-3', '{"auto_item_code": true}'), '[{"size": 33, "stock": 1}]') ->> 'item_code', true);
select sp_tests.returns('auto: a number already used by another product is skipped, not duplicated',
  $q$ select (current_setting('sp.auto3') <> current_setting('sp.taken') and current_setting('sp.auto3') > current_setting('sp.taken'))::text
          || ' / ' || (select count(*) from public.products where item_code = current_setting('sp.taken')) $q$, 'true / 1');

select sp_tests.throws('manual: a typed code can''t take the automatic form',
  $q$ select public.admin_create_product(sp_tests.fields('ITEM-999999', 'test-sp-manual-x'), '[{"size": 30, "stock": 1}]') $q$,
  'PT400', 'item_code_reserved');
select sp_tests.returns('manual: other typed codes work as before',
  $q$ select public.admin_create_product(sp_tests.fields('TEST-SP-MANUAL', 'test-sp-manual'), '[{"size": 30, "stock": 1}]') ->> 'item_code' $q$,
  'TEST-SP-MANUAL');
select sp_tests.throws('manual: an existing code is still refused (unique)',
  $q$ select public.admin_create_product(sp_tests.fields('TEST-SP-MANUAL', 'test-sp-manual-2'), '[{"size": 30, "stock": 1}]') $q$,
  '23505', 'products_item_code_key');

-- Saving keeps the code; taking a different automatic code is refused.
select set_config('sp.skus', (select string_agg(sku, ',' order by sku) from public.product_variants
  where product_id = sp_tests.pid(current_setting('sp.auto1'))), true);
select public.admin_save_product(sp_tests.pid(current_setting('sp.auto1')), sp_tests.ver(current_setting('sp.auto1')),
  sp_tests.fields(current_setting('sp.auto1'), 'test-sp-auto-1', '{"description": "Saved again"}'),
  sp_tests.form(sp_tests.pid(current_setting('sp.auto1'))), '[]');
select sp_tests.returns('save: the assigned code and its SKUs stay as they are',
  $q$ select (select description from public.products where item_code = current_setting('sp.auto1')) || ' / '
          || ((select string_agg(sku, ',' order by sku) from public.product_variants
               where product_id = sp_tests.pid(current_setting('sp.auto1'))) = current_setting('sp.skus'))::text $q$,
  'Saved again / true');
select sp_tests.throws('save: changing it to another automatic-looking code is refused',
  $q$ select public.admin_save_product(sp_tests.pid(current_setting('sp.auto1')), sp_tests.ver(current_setting('sp.auto1')),
        sp_tests.fields(current_setting('sp.auto2'), 'test-sp-auto-1'), sp_tests.form(sp_tests.pid(current_setting('sp.auto1'))), '[]') $q$,
  'PT400', 'item_code_reserved');
select sp_tests.returns('save: "auto_item_code" on a save changes nothing',
  $q$ select (public.admin_save_product(sp_tests.pid('TEST-SP-MANUAL'), sp_tests.ver('TEST-SP-MANUAL'),
        sp_tests.fields('TEST-SP-MANUAL', 'test-sp-manual', '{"auto_item_code": true}'), sp_tests.form(sp_tests.pid('TEST-SP-MANUAL')), '[]')
        is not null)::text || ' / ' || (select count(*) from public.products where item_code = 'TEST-SP-MANUAL') $q$, 'true / 1');
reset role;

select sp_tests.returns('existing product: item code, SKU and barcode unchanged',
  $q$ select p.item_code || ' ' || v.sku || ' ' || (b.barcode = current_setting('sp.old_barcode'))
      from public.products p join public.product_variants v on v.product_id = p.id join public.variant_barcodes b on b.variant_id = v.id
      where p.slug = 'test-sp-old' $q$, 'TEST-SP-OLD TEST-SP-OLD-30 true');
select sp_tests.throws('published products: the item code is still locked',
  $q$ update public.products set item_code = 'TEST-SP-OLD-2' where slug = 'test-sp-old' $q$, 'PT400', 'item_code_locked');

-- ---------------------------------------------------------------------------
-- Sale price rules
-- ---------------------------------------------------------------------------

select sp_tests.throws('sale: must be below the regular price (equal is refused)',
  $q$ update public.products set sale_price_paisa = 200000 where slug = 'test-sp-old' $q$, '23514', 'products_sale_price_valid');
select sp_tests.throws('sale: can''t be above the regular price',
  $q$ update public.products set sale_price_paisa = 250000 where slug = 'test-sp-old' $q$, '23514', 'products_sale_price_valid');
select sp_tests.throws('sale: must be above zero',
  $q$ update public.products set sale_price_paisa = 0 where slug = 'test-sp-old' $q$, '23514', 'products_sale_price_valid');
select sp_tests.throws('sale: lowering the regular price below the sale price is refused',
  $q$ update public.products set sale_price_paisa = 150000, price_paisa = 140000 where slug = 'test-sp-old' $q$,
  '23514', 'products_sale_price_valid');

set local role authenticated;
select sp_tests.as_admin();
select sp_tests.throws('sale: admins can''t set it directly, only through the save function',
  $q$ update public.products set sale_price_paisa = 100000 where slug = 'test-sp-old' $q$, '42501');
select sp_tests.throws('sale: a save that makes the sale invalid (regular price lowered) is refused',
  $q$ select public.admin_save_product(sp_tests.pid(current_setting('sp.auto1')), sp_tests.ver(current_setting('sp.auto1')),
        sp_tests.fields(current_setting('sp.auto1'), 'test-sp-auto-1', '{"sale_price_paisa": 240000, "price_paisa": 200000}'),
        sp_tests.form(sp_tests.pid(current_setting('sp.auto1'))), '[]') $q$,
  '23514', 'products_sale_price_valid');
reset role;

-- The existing product goes on sale: Rs. 2,000 → Rs. 1,600 (stock 5, so it can be ordered).
select set_config('sp.inventory', (select stock || '/' || reserved || '/v' || inventory_version from public.product_variants where sku = 'TEST-SP-OLD-30'), true);
set local role authenticated;
select sp_tests.as_admin();
select public.admin_save_product(sp_tests.pid('TEST-SP-OLD'), sp_tests.ver('TEST-SP-OLD'),
  sp_tests.fields('TEST-SP-OLD', 'test-sp-old', '{"name": "Existing style", "colour": "Red", "description": "Test", "price_paisa": 200000, "sale_price_paisa": 160000}'),
  sp_tests.form(sp_tests.pid('TEST-SP-OLD')), sp_tests.images(sp_tests.pid('TEST-SP-OLD')));
reset role;
select sp_tests.returns('sale: saved through the admin function; stock, held pairs and inventory version untouched',
  $q$ select p.price_paisa || '/' || p.sale_price_paisa || ' ' || (v.stock || '/' || v.reserved || '/v' || v.inventory_version = current_setting('sp.inventory'))
      from public.products p join public.product_variants v on v.product_id = p.id where p.slug = 'test-sp-old' $q$,
  '200000/160000 true');

-- ---------------------------------------------------------------------------
-- Checkout charges the sale price
-- ---------------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '', true);

select sp_tests.returns('anon reads both prices of a product on sale',
  $q$ select price_paisa || '/' || sale_price_paisa from public.products where slug = 'test-sp-old' $q$, '200000/160000');
select sp_tests.returns('quote: the sale price, with the regular price for display; the old price is a change',
  $q$ select (l ->> 'unit_price_paisa') || ' ' || (l ->> 'regular_price_paisa') || ' ' || (l ->> 'price_changed')
      from jsonb_array_elements((sp_tests.quote(jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 1, 200000)))) -> 'lines') l $q$,
  '160000 200000 true');
select sp_tests.returns('free delivery uses the discounted subtotal: 3 × Rs. 1,600 = Rs. 4,800 pays delivery (3 × Rs. 2,000 wouldn''t)',
  $q$ select (q ->> 'subtotal_paisa') || ' ' || (q ->> 'delivery_paisa') || ' ' || (q ->> 'total_paisa') || ' ' || (q ->> 'exact')
      from (select sp_tests.quote(jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 3, 160000))) q) x $q$,
  '480000 30000 510000 true');
select sp_tests.returns('free delivery: 4 × Rs. 1,600 = Rs. 6,400 reaches the threshold',
  $q$ select (q ->> 'subtotal_paisa') || ' ' || (q ->> 'delivery_paisa')
      from (select sp_tests.quote(jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 4, 160000))) q) x $q$,
  '640000 0');

select sp_tests.returns('place: the customer saw the regular price, the sale started since: quote changed, no order',
  $q$ select (r ->> 'result') || ' ' || (r -> 'quote' -> 'lines' -> 0 ->> 'unit_price_paisa')
      from (select sp_tests.place(1, jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 1, 200000)), 30000, 230000) r) x $q$,
  'quote_changed 160000');
select sp_tests.returns('place: at the sale price the customer accepted, the order is placed',
  $q$ select (r ->> 'result') || ' ' || (r -> 'order' ->> 'subtotal_paisa') || ' ' || (r -> 'order' ->> 'delivery_paisa') || ' ' || (r -> 'order' ->> 'total_paisa')
      from (select sp_tests.place(2, jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 2, 160000)), 30000, 350000) r) x $q$,
  'placed 320000 30000 350000');
reset role;

select sp_tests.returns('order: its items are charged (and kept) at the sale price; two pairs held',
  $q$ select oi.unit_price_paisa || ' x' || oi.quantity || ' = ' || oi.line_total_paisa || ' / ' ||
        (select stock || '/' || reserved from public.product_variants where sku = 'TEST-SP-OLD-30')
      from public.order_items oi where oi.order_id = sp_tests.order_id(2) $q$, '160000 x2 = 320000 / 3/2');

-- The sale price changes (Rs. 1,600 → Rs. 1,500) between a quote and the order.
set local role authenticated;
select sp_tests.as_admin();
select public.admin_save_product(sp_tests.pid('TEST-SP-OLD'), sp_tests.ver('TEST-SP-OLD'),
  sp_tests.fields('TEST-SP-OLD', 'test-sp-old', '{"name": "Existing style", "colour": "Red", "description": "Test", "price_paisa": 200000, "sale_price_paisa": 150000}'),
  sp_tests.form(sp_tests.pid('TEST-SP-OLD')), sp_tests.images(sp_tests.pid('TEST-SP-OLD')));
reset role;
set local role anon;
select set_config('request.jwt.claims', '', true);
select sp_tests.returns('place: a changed sale price is a quote change, never charged unseen',
  $q$ select (r ->> 'result') || ' ' || (r -> 'quote' -> 'lines' -> 0 ->> 'unit_price_paisa')
      from (select sp_tests.place(3, jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 1, 160000)), 30000, 190000) r) x $q$,
  'quote_changed 150000');
select sp_tests.returns('retry: the placed order''s key and contents return that order at its original prices',
  $q$ select (r ->> 'result') || ' ' || (r -> 'order' ->> 'total_paisa')
      from (select sp_tests.place(2, jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 2, 160000)), 30000, 350000) r) x $q$,
  'existing 350000');
select sp_tests.returns('retry: the same key at the new price is refused (mismatch), not re-priced',
  $q$ select sp_tests.place(2, jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 2, 150000)), 30000, 330000) ->> 'result' $q$,
  'mismatch');
reset role;

-- The sale ends.
set local role authenticated;
select sp_tests.as_admin();
select public.admin_save_product(sp_tests.pid('TEST-SP-OLD'), sp_tests.ver('TEST-SP-OLD'),
  sp_tests.fields('TEST-SP-OLD', 'test-sp-old', '{"name": "Existing style", "colour": "Red", "description": "Test", "price_paisa": 200000, "sale_price_paisa": null}'),
  sp_tests.form(sp_tests.pid('TEST-SP-OLD')), sp_tests.images(sp_tests.pid('TEST-SP-OLD')));
reset role;
select sp_tests.returns('sale ended: the sale price is cleared',
  $q$ select coalesce(sale_price_paisa::text, 'null') from public.products where slug = 'test-sp-old' $q$, 'null');
set local role anon;
select set_config('request.jwt.claims', '', true);
select sp_tests.returns('sale ended: checkout charges the regular price again; the sale price is now a change',
  $q$ select (l ->> 'unit_price_paisa') || ' ' || (l ->> 'price_changed')
      from jsonb_array_elements((sp_tests.quote(jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 1, 150000)))) -> 'lines') l $q$,
  '200000 true');
reset role;
select sp_tests.returns('history: the earlier order keeps its prices and totals',
  $q$ select o.subtotal_paisa || ' ' || o.delivery_paisa || ' ' || o.total_paisa || ' / ' || oi.unit_price_paisa
      from public.orders o join public.order_items oi on oi.order_id = o.id where o.id = sp_tests.order_id(2) $q$,
  '320000 30000 350000 / 160000');

-- In the shop: on sale again at Rs. 1,800.
set local role authenticated;
select sp_tests.as_admin();
select public.admin_save_product(sp_tests.pid('TEST-SP-OLD'), sp_tests.ver('TEST-SP-OLD'),
  sp_tests.fields('TEST-SP-OLD', 'test-sp-old', '{"name": "Existing style", "colour": "Red", "description": "Test", "price_paisa": 200000, "sale_price_paisa": 180000}'),
  sp_tests.form(sp_tests.pid('TEST-SP-OLD')), sp_tests.images(sp_tests.pid('TEST-SP-OLD')));
select sp_tests.returns('in store: the regular price is a quote change while on sale',
  $q$ select public.admin_record_in_store_sale('00000000-0000-4000-8000-0000000000a1',
        jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 1, 200000))) ->> 'result' $q$, 'quote_changed');
select set_config('sp.sale', public.admin_record_in_store_sale('00000000-0000-4000-8000-0000000000a2',
  jsonb_build_array(sp_tests.line('TEST-SP-OLD-30', 1, 180000)))::text, true);
select sp_tests.returns('in store: sold at the sale price',
  $q$ select (current_setting('sp.sale')::jsonb ->> 'result') || ' ' || o.total_paisa || ' ' || oi.unit_price_paisa
      from public.orders o join public.order_items oi on oi.order_id = o.id
      where o.id = (current_setting('sp.sale')::jsonb ->> 'id')::uuid $q$, 'placed 180000 180000');
reset role;

select sp_tests.returns('ledger still reconciles for the test size',
  $q$ select (v.stock = (select sum(available_delta) from public.stock_movements m where m.variant_id = v.id)
          and v.reserved = (select sum(reserved_delta) from public.stock_movements m where m.variant_id = v.id))::text
      from public.product_variants v where v.sku = 'TEST-SP-OLD-30' $q$, 'true');

select sp_tests.check('ALL ITEM CODE AND SALE PRICE TESTS PASSED', true);

-- ---------------------------------------------------------------------------
-- Put the counters back, and roll everything back
-- ---------------------------------------------------------------------------

select setval('private.item_code_seq', current_setting('sp.item_last')::bigint, current_setting('sp.item_called')::boolean);
select setval('public.barcode_serial', current_setting('sp.serial_last')::bigint, current_setting('sp.serial_called')::boolean);
select setval('public.order_number_seq', current_setting('sp.order_last')::bigint, current_setting('sp.order_called')::boolean);

rollback;
