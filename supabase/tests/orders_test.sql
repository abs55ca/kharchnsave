-- Orders, stock and checkout tests: permissions, the gateway secret, guest
-- checkout (quotes, placing, retries, abandoned keys, limits), hold expiry
-- (including failure reporting and all-or-nothing release), admin order
-- actions with the delivery and payment transitions, returns, in-store sales,
-- stale stock edits, rate limits and stock-ledger reconciliation.
--
-- Run after supabase/migrations/20261031120000_inventory_ledger.sql and
-- 20261031130000_guest_orders.sql, as the database owner (the Supabase SQL
-- editor runs as postgres).
-- Everything happens in one transaction that is ROLLED BACK: the test
-- products, orders, settings, users and gateway key are never kept. The two
-- counters a rollback can't undo (barcode serial and order number) are put
-- back where they were at the end.
--
-- These tests run one step at a time. Simultaneous purchases and other races
-- are tested with real parallel connections in db-tests/ (npm run test:db).
--
-- Result: the script completes without an error only if every test passed.
-- The first failure stops it with "FAIL <test>: <reason>".

begin;

create schema ord_tests;

create function ord_tests.check(label text, ok boolean, detail text default '')
returns void language plpgsql as $$
begin
  if ok is not true then
    raise exception 'FAIL %: %', label, detail;
  end if;
  raise notice 'PASS %', label;
end;
$$;

create function ord_tests.returns(label text, query text, expected text)
returns void language plpgsql as $$
declare
  actual text;
begin
  execute query into actual;
  perform ord_tests.check(label, coalesce(actual, '') = expected,
    format('expected [%s], got [%s]', expected, coalesce(actual, '')));
end;
$$;

create function ord_tests.throws(label text, statement text, expected_state text, expected_detail text default null)
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

-- The test gateway secret (its hash is added below, inside this transaction).
create function ord_tests.gw() returns text language sql as $$
  select 'ord-tests-gateway-secret-not-a-real-one-0001'::text;
$$;

-- A checkout key: 43 base64url characters.
create function ord_tests.key(n integer) returns text language sql as $$
  select rpad('ordtest' || lpad(n::text, 4, '0'), 43, 'k');
$$;

create function ord_tests.order_json(lines jsonb, delivery bigint, total bigint, phone text default '+923001234567')
returns jsonb language sql as $$
  select jsonb_build_object('lines', lines, 'delivery_paisa', delivery, 'total_paisa', total,
    'customer', jsonb_build_object('name', 'Test Customer', 'phone', phone, 'city', 'Lahore',
      'address', 'House 1, Street 2, Test Town', 'landmark', 'Near the test park', 'note', null));
$$;

create function ord_tests.line(sku text, quantity integer, price integer) returns jsonb language sql as $$
  select jsonb_build_object('sku', sku, 'quantity', quantity, 'unit_price_paisa', price);
$$;

create function ord_tests.place(n integer, lines jsonb, delivery bigint, total bigint, phone text default '+923001234567')
returns jsonb language sql as $$
  select public.place_cod_order(ord_tests.gw(), ord_tests.key(n), ord_tests.order_json(lines, delivery, total, phone));
$$;

create function ord_tests.order_id(n integer) returns uuid language sql as $$
  select id from public.orders where request_key_hash = sha256(convert_to(ord_tests.key(n), 'UTF8'));
$$;

create function ord_tests.ver(n integer) returns integer language sql as $$
  select version from public.orders where id = ord_tests.order_id(n);
$$;

create function ord_tests.stock(sku text) returns text language sql as $$
  select stock || '/' || reserved from public.product_variants where product_variants.sku = stock.sku;
$$;

create function ord_tests.req(n integer) returns uuid language sql as $$
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid;
$$;

create function ord_tests.as_admin(aal text default 'aal2') returns void language sql as $$
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', 'd0d0d0d0-0000-4000-8000-00000000000d', 'role', 'authenticated', 'aal', aal)::text, true);
$$;

grant usage on schema ord_tests to anon, authenticated;
grant execute on all functions in schema ord_tests to anon, authenticated;

-- Remember the counters, to put them back at the end.
select set_config('ord.serial_last', last_value::text, true), set_config('ord.serial_called', is_called::text, true)
from public.barcode_serial;
select set_config('ord.order_last', last_value::text, true), set_config('ord.order_called', is_called::text, true)
from public.order_number_seq;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

select ord_tests.returns('anon can execute exactly the five guest functions in public',
  $q$ select string_agg(p.proname, ', ' order by p.proname) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prorettype <> 'event_trigger'::regtype
        and has_function_privilege('anon', p.oid, 'EXECUTE') $q$,
  'checkout_register_attempt, checkout_resolve, get_customer_order, place_cod_order, quote_order');

select ord_tests.returns('API roles can''t use the private schema or run anything in it',
  $q$ select coalesce(string_agg(r || ' ' || x, ', '), '') from unnest(array['anon', 'authenticated']) r,
        lateral (
          select 'usage' as x where has_schema_privilege(r, 'private', 'USAGE')
          union all
          select p.proname from pg_proc p where p.pronamespace = 'private'::regnamespace
            and has_function_privilege(r, p.oid, 'EXECUTE')
          union all
          select c.relname from pg_class c where c.relnamespace = 'private'::regnamespace and c.relkind = 'r'
            and has_table_privilege(r, c.oid, 'SELECT,INSERT,UPDATE,DELETE')
        ) t $q$, '');

select ord_tests.returns('order tables: anon has nothing; authenticated may only SELECT (RLS limits it to verified admins)',
  $q$ select coalesce(string_agg(r || ' ' || t || ' ' || p, ', ' order by r, t, p), '')
      from unnest(array['anon', 'authenticated']) r,
           unnest(array['public.orders', 'public.order_items', 'public.order_events', 'public.order_return_lines',
                        'public.shop_settings', 'public.delivery_cities', 'public.stock_movements']) t,
           unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
      where has_table_privilege(r, t, p) and not (r = 'authenticated' and p = 'SELECT') $q$, '');

select ord_tests.returns('sizes: no direct writes for API roles; anon can''t read held stock',
  $q$ select coalesce(string_agg(x, ', '), '') from (values
        (has_table_privilege('authenticated', 'public.product_variants', 'INSERT'), 'insert'),
        (has_table_privilege('authenticated', 'public.product_variants', 'UPDATE'), 'update'),
        (has_table_privilege('authenticated', 'public.product_variants', 'DELETE'), 'delete'),
        (has_column_privilege('authenticated', 'public.product_variants', 'stock', 'UPDATE'), 'update stock'),
        (has_column_privilege('authenticated', 'public.product_variants', 'reserved', 'UPDATE'), 'update reserved'),
        (has_column_privilege('anon', 'public.product_variants', 'reserved', 'SELECT'), 'anon reads reserved'),
        (has_column_privilege('anon', 'public.product_variants', 'inventory_version', 'SELECT'), 'anon reads version')
      ) t(granted, x) where granted $q$, '');

select ord_tests.returns('the order-number sequence is closed to API roles',
  $q$ select coalesce(string_agg(r, ', '), '') from unnest(array['anon', 'authenticated']) r
      where has_sequence_privilege(r, 'public.order_number_seq', 'USAGE,SELECT,UPDATE') $q$, '');

select ord_tests.returns('new SECURITY DEFINER functions (public and private) have an empty search_path',
  $q$ select coalesce(string_agg(p.oid::regprocedure::text, ', '), '') from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
        and p.prorettype <> 'event_trigger'::regtype
        and not coalesce('search_path=""' = any(p.proconfig), false) $q$, '');

-- ---------------------------------------------------------------------------
-- Set-up: users, products, gateway key, settings
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values ('d0d0d0d0-0000-4000-8000-00000000000d', 'orders-admin@test.invalid');
insert into public.admin_members (user_id) values ('d0d0d0d0-0000-4000-8000-00000000000d');

insert into public.products (item_code, slug, name, brand, department, styles, item_status, condition,
  colour, description, price_paisa, publication_status, listed_at)
values
  ('TEST-ORD-PL', 'test-ord-preloved', 'Test pre-loved pair', 'Testbrand', 'men', '{sneakers}', 'preloved', 'good', 'Black', 'Test', 245000, 'published', current_date),
  ('TEST-ORD-NEW', 'test-ord-new', 'Test new style', 'Testbrand', 'kids', '{sneakers}', 'new', 'new', 'Blue', 'Test', 150000, 'published', current_date),
  ('TEST-ORD-DRAFT', 'test-ord-draft', 'Test draft pair', 'Testbrand', 'women', '{heels}', 'preloved', 'good', 'Red', 'Test', 100000, 'draft', null);
insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
select p.id, p.item_status, s.sku, s.size, s.stock
from (values ('TEST-ORD-PL', 'TEST-ORD-PL-42', 42, 1), ('TEST-ORD-NEW', 'TEST-ORD-NEW-20', 20, 5),
             ('TEST-ORD-NEW', 'TEST-ORD-NEW-21', 21, 2), ('TEST-ORD-DRAFT', 'TEST-ORD-DRAFT-40', 40, 1)) s(code, sku, size, stock)
join public.products p on p.item_code = s.code;
insert into public.product_images (product_id, src, alt, width, height)
select id, '/images/test.jpg', 'Test photo', 800, 800 from public.products where item_code like 'TEST-ORD-%';

select ord_tests.returns('new sizes are in the ledger (size_added)',
  $q$ select string_agg(sku || ' ' || available_delta || ' ' || reason, ', ' order by sku) from public.stock_movements
      where sku like 'TEST-ORD-%' $q$,
  'TEST-ORD-DRAFT-40 1 size_added, TEST-ORD-NEW-20 5 size_added, TEST-ORD-NEW-21 2 size_added, TEST-ORD-PL-42 1 size_added');

insert into private.checkout_gateway_keys (key_hash, label) values (sha256(convert_to(ord_tests.gw(), 'UTF8')), 'ord_tests');

select ord_tests.throws('settings: ordering can''t be switched on before everything is decided',
  $q$ update public.shop_settings set orders_open = true $q$, '23514', 'shop_settings_ready_to_open');
select ord_tests.returns('settings: the confirmed values (Rs. 300, 24 hours) are there and ordering is off',
  $q$ select standard_delivery_fee_paisa || ' ' || hold_minutes || ' ' || orders_open from public.shop_settings $q$, '30000 1440 false');

-- ---------------------------------------------------------------------------
-- The gateway secret
-- ---------------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '', true);
select ord_tests.throws('no gateway secret: quote refused', $q$ select public.quote_order(null, '[]', 'Lahore') $q$, '42501');
select ord_tests.throws('wrong gateway secret: placing refused',
  $q$ select public.place_cod_order('wrong-secret-wrong-secret-wrong-secret', ord_tests.key(1), '{}') $q$, '42501');
select ord_tests.throws('no gateway secret: lookups refused',
  $q$ select public.get_customer_order(null, ord_tests.key(1)) $q$, '42501');
select ord_tests.throws('no gateway secret: resolve refused',
  $q$ select public.checkout_resolve('', ord_tests.key(1)) $q$, '42501');
select ord_tests.throws('no gateway secret: rate-limit registration refused',
  $q$ select public.checkout_register_attempt(null, null, 'place') $q$, '42501');
select ord_tests.throws('anon can''t read orders directly', $q$ select count(*) from public.orders $q$, '42501');
select ord_tests.throws('anon can''t read settings directly', $q$ select count(*) from public.shop_settings $q$, '42501');

select ord_tests.returns('quote while undecided: delivery not configured, ordering closed',
  $q$ select (q ->> 'delivery_status') || ' ' || (q ->> 'orders_open')
      from (select public.quote_order(ord_tests.gw(), jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 'Lahore') q) x $q$,
  'not_configured false');
select ord_tests.returns('placing while ordering is off: closed',
  $q$ select ord_tests.place(1, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000) ->> 'result' $q$,
  'closed');
reset role;

-- TEST VALUES ONLY (not the shop's): nationwide, free delivery from Rs. 5,000,
-- small limits so the tests can reach them.
update public.shop_settings set delivery_area_mode = 'nationwide', free_delivery_enabled = true,
  free_delivery_min_paisa = 500000, max_lines_per_order = 5, max_units_per_order = 6, max_units_per_line = 4,
  max_open_orders_per_phone = 2, place_attempts_per_ip_10min = 2, place_attempts_per_ip_day = 10,
  lookups_per_ip_10min = 3, quotes_per_ip_10min = 2, orders_per_minute_global = 100, orders_open = true;

-- ---------------------------------------------------------------------------
-- Guest checkout
-- ---------------------------------------------------------------------------

set local role anon;
select set_config('request.jwt.claims', '', true);

select ord_tests.returns('quote: live price, Rs. 300 delivery below the threshold, exact',
  $q$ select (q ->> 'subtotal_paisa') || ' ' || (q ->> 'delivery_paisa') || ' ' || (q ->> 'total_paisa') || ' ' || (q ->> 'exact')
      from (select public.quote_order(ord_tests.gw(), jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 'Lahore') q) x $q$,
  '245000 30000 275000 true');
select ord_tests.returns('quote: a changed price, an unpublished product and too many are reported per line',
  $q$ select string_agg((l ->> 'sku') || '=' || (l ->> 'status') || '/' || (l ->> 'price_changed') || '/' || (l ->> 'allowed_quantity'), ' ' order by l ->> 'sku')
      from jsonb_array_elements((public.quote_order(ord_tests.gw(), jsonb_build_array(
        ord_tests.line('TEST-ORD-PL-42', 1, 200000), ord_tests.line('TEST-ORD-DRAFT-40', 1, 100000),
        ord_tests.line('TEST-ORD-NEW-21', 3, 150000), ord_tests.line('NO-SUCH-SKU', 1, 100)), 'Lahore')) -> 'lines') l $q$,
  'NO-SUCH-SKU=unavailable/false/0 TEST-ORD-DRAFT-40=unavailable/false/0 TEST-ORD-NEW-21=reduced/false/2 TEST-ORD-PL-42=ok/true/1');

select ord_tests.returns('place: the last pre-loved pair',
  $q$ select ord_tests.place(1, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000) ->> 'result' $q$,
  'placed');
select ord_tests.returns('place: same key, same contents (a retry) returns the same order, nothing new',
  $q$ select (r ->> 'result') || ' ' || (r -> 'order' ->> 'total_paisa')
      from (select ord_tests.place(1, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000) r) x $q$,
  'existing 275000');
select ord_tests.returns('place: same key, different contents is refused (mismatch), not accepted',
  $q$ select ord_tests.place(1, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000, '+923009999999') ->> 'result' $q$,
  'mismatch');
select ord_tests.returns('place: someone else, the same pair: quote changed (sold out), no order',
  $q$ select (r ->> 'result') || ' ' || (r -> 'quote' -> 'lines' -> 0 ->> 'status')
      from (select ord_tests.place(2, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000, '+923002222222') r) x $q$,
  'quote_changed sold_out');
select ord_tests.returns('place: a price the customer didn''t see is never charged',
  $q$ select ord_tests.place(3, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 140000)), 30000, 170000, '+923003333333') ->> 'result' $q$,
  'quote_changed');
select ord_tests.returns('place: a total the customer didn''t see is never charged',
  $q$ select ord_tests.place(3, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 150000)), 0, 150000, '+923003333333') ->> 'result' $q$,
  'quote_changed');
select ord_tests.returns('place: unpublished products can''t be ordered online',
  $q$ select ord_tests.place(4, jsonb_build_array(ord_tests.line('TEST-ORD-DRAFT-40', 1, 100000)), 30000, 130000, '+923004444444') ->> 'result' $q$,
  'quote_changed');
select ord_tests.returns('place: more than the per-line limit',
  $q$ select ord_tests.place(5, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 5, 150000)), 0, 750000, '+923005555555') ->> 'result' $q$,
  'limits');
select ord_tests.returns('place: several sizes; free delivery at the threshold',
  $q$ select (r ->> 'result') || ' ' || (r -> 'order' ->> 'delivery_paisa') || ' ' || (r -> 'order' ->> 'total_paisa')
      from (select ord_tests.place(6, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 2, 150000), ord_tests.line('TEST-ORD-NEW-21', 2, 150000)), 0, 600000, '+923006666666') r) x $q$,
  'placed 0 600000');
select ord_tests.returns('place: a second open order on one phone number is allowed (limit 2)',
  $q$ select ord_tests.place(7, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 150000)), 30000, 180000) ->> 'result' $q$,
  'placed');
select ord_tests.returns('place: a third open order on the same phone number is refused',
  $q$ select ord_tests.place(8, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 150000)), 30000, 180000) ->> 'result' $q$,
  'phone_limit');
select ord_tests.throws('place: malformed phone number',
  $q$ select ord_tests.place(9, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 150000)), 30000, 180000, '03001234567') $q$,
  'PT400', 'invalid_order');
select ord_tests.throws('place: malformed key',
  $q$ select public.place_cod_order(ord_tests.gw(), 'short', ord_tests.order_json('[]', 0, 0)) $q$, 'PT400', 'invalid_key');

select ord_tests.returns('resolve: an unknown key is "none" and stays usable',
  $q$ select public.checkout_resolve(ord_tests.gw(), ord_tests.key(10)) ->> 'state' $q$, 'none');
select ord_tests.returns('resolve: abandoning a key',
  $q$ select public.checkout_resolve(ord_tests.gw(), ord_tests.key(10), null, true) ->> 'state' $q$, 'abandoned');
select ord_tests.returns('place: an abandoned key can never place an order',
  $q$ select ord_tests.place(10, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 150000)), 30000, 180000, '+923001010101') ->> 'result' $q$,
  'abandoned');
select ord_tests.returns('resolve: an order''s key reports the order and whether the contents match',
  $q$ select (r ->> 'state') || ' ' || (r ->> 'matches')
      from (select public.checkout_resolve(ord_tests.gw(), ord_tests.key(1),
              ord_tests.order_json(jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000)) r) x $q$,
  'placed true');
select ord_tests.returns('resolve: abandoning a key that has an order keeps the order',
  $q$ select public.checkout_resolve(ord_tests.gw(), ord_tests.key(1), null, true) ->> 'state' $q$, 'placed');
select ord_tests.returns('customer view: masked phone, first name, no address',
  $q$ select (v ->> 'phone_last_digits') || ' ' || (v ->> 'first_name') || ' ' || (v ? 'address') || ' ' || (v ->> 'status')
      from (select public.get_customer_order(ord_tests.gw(), ord_tests.key(1)) v) x $q$,
  '567 Test false awaiting_confirmation');
select ord_tests.returns('customer view: a key without an order shows nothing',
  $q$ select coalesce(public.get_customer_order(ord_tests.gw(), ord_tests.key(99))::text, 'null') $q$, 'null');

select ord_tests.returns('rate limits: two attempts allowed, the third refused (test limit 2 per 10 minutes)',
  $q$ select string_agg((public.checkout_register_attempt(ord_tests.gw(), 'ip:' || repeat('a', 64), 'place') ->> 'allowed'), ',')
      from generate_series(1, 3) $q$, 'true,true,false');
select ord_tests.returns('rate limits: price quotes have their own limit per connection (test limit 2)',
  $q$ select string_agg((public.checkout_register_attempt(ord_tests.gw(), 'ip:' || repeat('c', 64), 'quote') ->> 'allowed'), ',')
      from generate_series(1, 3) $q$, 'true,true,false');
select ord_tests.returns('rate limits: visitors without a known IP share one bucket',
  $q$ select string_agg((public.checkout_register_attempt(ord_tests.gw(), null, 'quote') ->> 'allowed'), ',')
      from generate_series(1, 3) $q$, 'true,true,false');
select ord_tests.throws('rate limits: unknown kinds are refused',
  $q$ select public.checkout_register_attempt(ord_tests.gw(), null, 'other') $q$, 'PT400');
select ord_tests.returns('rate limits: another visitor isn''t affected',
  $q$ select public.checkout_register_attempt(ord_tests.gw(), 'ip:' || repeat('b', 64), 'place') ->> 'allowed' $q$, 'true');
reset role;

select ord_tests.returns('stock after the orders: available/held',
  $q$ select ord_tests.stock('TEST-ORD-PL-42') || ' ' || ord_tests.stock('TEST-ORD-NEW-20') || ' ' || ord_tests.stock('TEST-ORD-NEW-21') $q$,
  '0/1 2/3 0/2');
select ord_tests.returns('orders hold for 24 hours',
  $q$ select (hold_expires_at - created_at = interval '24 hours')::text from public.orders where id = ord_tests.order_id(1) $q$, 'true');
select ord_tests.returns('order items keep a snapshot of the catalogue',
  $q$ select string_agg(sku || ' ' || product_name || ' ' || unit_price_paisa || 'x' || quantity, ', ' order by line_no)
      from public.order_items where order_id = ord_tests.order_id(6) $q$,
  'TEST-ORD-NEW-20 Test new style 150000x2, TEST-ORD-NEW-21 Test new style 150000x2');
update public.products set name = 'Renamed', price_paisa = 999900 where item_code = 'TEST-ORD-NEW';
select ord_tests.returns('later catalogue edits don''t change an order',
  $q$ select string_agg(product_name || ' ' || unit_price_paisa, ', ') from public.order_items where order_id = ord_tests.order_id(6) $q$,
  'Test new style 150000, Test new style 150000');
update public.products set name = 'Test new style', price_paisa = 150000 where item_code = 'TEST-ORD-NEW';

-- ---------------------------------------------------------------------------
-- Hold expiry
-- ---------------------------------------------------------------------------

update public.orders set hold_expires_at = now() - interval '1 minute' where id = ord_tests.order_id(1);
set local role anon;
select ord_tests.returns('quote: a pair whose hold has expired counts as available',
  $q$ select public.quote_order(ord_tests.gw(), jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 'Lahore') -> 'lines' -> 0 ->> 'status' $q$,
  'ok');
reset role;
select ord_tests.returns('expiry job: releases the expired order',
  $q$ select private.expire_order_holds() ->> 'released' $q$, '1');
select ord_tests.returns('expired order: cancelled, payment void, pair available again',
  $q$ select status || ' ' || payment_status || ' ' || cancel_reason || ' ' || ord_tests.stock('TEST-ORD-PL-42')
      from public.orders where id = ord_tests.order_id(1) $q$, 'cancelled void hold_expired 1/0');
select ord_tests.returns('expiry job: success recorded',
  $q$ select (consecutive_failures = 0 and last_succeeded_at is not null and last_error is null)::text
      from private.job_heartbeats where job = 'expire_order_holds' $q$, 'true');
select ord_tests.returns('expiry job: nothing left to release; running it again changes nothing',
  $q$ select private.expire_order_holds() ->> 'released' $q$, '0');

-- A two-item order whose release fails on its second item: neither item is
-- released, and the failure is still recorded.
update public.orders set hold_expires_at = now() - interval '1 minute' where id = ord_tests.order_id(6);
create function ord_tests.fail_second_release() returns trigger language plpgsql as $$
begin
  if new.event_key = 'release:' || (select id from public.order_items where order_id = ord_tests.order_id(6) and line_no = 2) then
    raise exception 'injected failure';
  end if;
  return new;
end;
$$;
create trigger ord_tests_fail_release before insert on public.stock_movements
  for each row execute function ord_tests.fail_second_release();
select set_config('ord.succeeded_before', (select last_succeeded_at::text from private.job_heartbeats where job = 'expire_order_holds'), true);
select ord_tests.returns('expiry job: a failing release is reported, not hidden',
  $q$ select (r ->> 'released') || ' ' || (r ->> 'failed') from (select private.expire_order_holds() r) x $q$, '0 1');
select ord_tests.returns('failed release: the order and both items are untouched (all or nothing)',
  $q$ select status || ' ' || ord_tests.stock('TEST-ORD-NEW-20') || ' ' || ord_tests.stock('TEST-ORD-NEW-21') || ' ' ||
        (select count(*) from public.stock_movements where order_id = ord_tests.order_id(6) and reason = 'order_release')
      from public.orders where id = ord_tests.order_id(6) $q$, 'awaiting_confirmation 2/3 0/2 0');
select ord_tests.returns('failed release: the failure survived the rolled-back work (heartbeat)',
  $q$ select consecutive_failures || ' ' || (last_error like 'P0001 injected failure%') || ' ' ||
        (last_succeeded_at::text = current_setting('ord.succeeded_before'))
      from private.job_heartbeats where job = 'expire_order_holds' $q$, '1 true true');
drop trigger ord_tests_fail_release on public.stock_movements;
select set_config('ord.next_run', private.expire_order_holds() ->> 'released', true);
select ord_tests.returns('expiry job: next run releases the whole order and clears the failure count',
  $q$ select current_setting('ord.next_run') || ' ' || ord_tests.stock('TEST-ORD-NEW-20') || ' ' ||
        ord_tests.stock('TEST-ORD-NEW-21') || ' ' ||
        (select consecutive_failures from private.job_heartbeats where job = 'expire_order_holds') $q$,
  '1 4/1 2/0 0');
select ord_tests.returns('each item was released exactly once',
  $q$ select count(*)::text from public.stock_movements where order_id = ord_tests.order_id(6) and reason = 'order_release' $q$, '2');

-- An expired order is also released when the next order needs its pair.
set local role anon;
select ord_tests.returns('place: pair for order A',
  $q$ select ord_tests.place(11, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000, '+923001111111') ->> 'result' $q$, 'placed');
reset role;
update public.orders set hold_expires_at = now() - interval '1 minute' where id = ord_tests.order_id(11);
set local role anon;
select ord_tests.returns('place: the next customer gets the pair once A''s hold has expired (no job needed)',
  $q$ select ord_tests.place(12, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000, '+923001212121') ->> 'result' $q$, 'placed');
reset role;
select ord_tests.returns('order A was released (expired) in the same transaction',
  $q$ select status || ' ' || cancel_reason || ' ' || ord_tests.stock('TEST-ORD-PL-42') from public.orders where id = ord_tests.order_id(11) $q$,
  'cancelled hold_expired 0/1');

-- ---------------------------------------------------------------------------
-- Admin actions, delivery and payment
-- ---------------------------------------------------------------------------

set local role authenticated;
select ord_tests.as_admin('aal1');
select ord_tests.returns('password-only admin: sees no orders', $q$ select count(*)::text from public.orders $q$, '0');
select ord_tests.throws('password-only admin: can''t confirm',
  $q$ select public.admin_confirm_order(ord_tests.order_id(12), 1, ord_tests.req(1)) $q$, '42501');
select ord_tests.as_admin();
select ord_tests.returns('verified admin: sees orders', $q$ select (count(*) > 0)::text from public.orders $q$, 'true');
select ord_tests.throws('admin: can''t change orders directly',
  $q$ update public.orders set status = 'confirmed' where id = ord_tests.order_id(12) $q$, '42501');
select ord_tests.throws('admin: can''t write the ledger directly',
  $q$ insert into public.stock_movements (variant_id, sku, available_delta, reserved_delta, available_after, reserved_after, reason, event_key)
      values (gen_random_uuid(), 'X', 1, 0, 1, 0, 'owner_adjust', 'x') $q$, '42501');
select ord_tests.throws('admin: a stale order version is refused',
  $q$ select public.admin_confirm_order(ord_tests.order_id(12), 999, ord_tests.req(2)) $q$, 'PT409', 'version_conflict');

-- Order 12 (the pre-loved pair): confirm, dispatch, failed, retried, delivered, settled.
select ord_tests.returns('confirm',
  $q$ select public.admin_confirm_order(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(3)) ->> 'status' $q$, 'confirmed');
select ord_tests.returns('confirm: the same request again is recognised, not applied twice',
  $q$ select public.admin_confirm_order(ord_tests.order_id(12), 1, ord_tests.req(3)) ->> 'result' $q$, 'replayed');
select ord_tests.returns('dispatch: held pairs leave the shop',
  $q$ select (public.admin_dispatch_order(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(4), 'TCS', 'TEST-TRACK-1') ->> 'status')
        || ' ' || ord_tests.stock('TEST-ORD-PL-42') $q$, 'dispatched 0/0');
select ord_tests.throws('a dispatched order can''t be cancelled',
  $q$ select public.admin_cancel_order(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(5), 'customer_request') $q$,
  'PT409', 'bad_transition');
select ord_tests.returns('delivery failed: payment stays pending (the delivery may be retried)',
  $q$ select (r ->> 'status') || ' ' || (r ->> 'payment_status')
      from (select public.admin_mark_delivery_failed(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(6), 'Not home') r) x $q$,
  'delivery_failed pending');
select ord_tests.returns('retry the delivery: dispatched again, no second stock movement',
  $q$ select (public.admin_dispatch_order(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(7), 'TCS', 'TEST-TRACK-2') ->> 'status') || ' ' ||
        (select count(*) from public.stock_movements where order_id = ord_tests.order_id(12) and reason = 'order_dispatch') $q$,
  'dispatched 1');
select ord_tests.returns('delivered with cash collected',
  $q$ select (r ->> 'status') || ' ' || (r ->> 'payment_status')
      from (select public.admin_mark_delivered(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(8), true) r) x $q$,
  'delivered collected');
select ord_tests.returns('collected: the full total',
  $q$ select collected_paisa::text from public.orders where id = ord_tests.order_id(12) $q$, '275000');
select ord_tests.returns('courier remittance recorded: settled',
  $q$ select public.admin_record_payment(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(9), 'settled', null, 'TCS-REMIT-1') ->> 'payment_status' $q$,
  'settled');
select ord_tests.throws('a delivered order can''t be marked failed',
  $q$ select public.admin_mark_delivery_failed(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(10)) $q$, 'PT409', 'bad_transition');

-- Order 12 comes back after delivery: one pair restocked; refund due, then refunded.
select ord_tests.throws('return: every pair must be accounted for',
  $q$ select public.admin_receive_return(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(11),
        jsonb_build_array(jsonb_build_object('order_item_id', (select id from public.order_items where order_id = ord_tests.order_id(12)),
          'restock', 0, 'write_off', 0))) $q$, 'PT400', 'invalid_return');
select ord_tests.returns('return after delivery: restocked, refund due',
  $q$ select (r ->> 'status') || ' ' || (r ->> 'payment_status') || ' ' || ord_tests.stock('TEST-ORD-PL-42')
      from (select public.admin_receive_return(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(12),
        jsonb_build_array(jsonb_build_object('order_item_id', (select id from public.order_items where order_id = ord_tests.order_id(12)),
          'restock', 1, 'write_off', 0))) r) x $q$,
  'returned refund_due 1/0');
select ord_tests.returns('return: the same request again restocks nothing more',
  $q$ select (public.admin_receive_return(ord_tests.order_id(12), 1, ord_tests.req(12), '[]') ->> 'result') || ' ' || ord_tests.stock('TEST-ORD-PL-42') $q$,
  'replayed 1/0');
select ord_tests.throws('refund above what was collected is refused',
  $q$ select public.admin_record_payment(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(13), 'refunded', 999999) $q$,
  'PT400', 'invalid_amount');
select ord_tests.returns('refund recorded (made outside the app)',
  $q$ select public.admin_record_payment(ord_tests.order_id(12), ord_tests.ver(12), ord_tests.req(14), 'refunded', 245000, 'CASH-1') ->> 'payment_status' $q$,
  'refunded');

-- Order 7 (one new pair): confirm, cancel; cancelling again restores nothing.
select ord_tests.returns('cancel an unconfirmed order: pair released',
  $q$ select (public.admin_cancel_order(ord_tests.order_id(7), ord_tests.ver(7), ord_tests.req(15), 'customer_request') ->> 'status')
        || ' ' || ord_tests.stock('TEST-ORD-NEW-20') $q$, 'cancelled 5/0');
select ord_tests.returns('cancel: the same request again is recognised',
  $q$ select public.admin_cancel_order(ord_tests.order_id(7), 1, ord_tests.req(15), 'customer_request') ->> 'result' $q$, 'replayed');
select ord_tests.throws('cancel: a new request on a cancelled order is refused',
  $q$ select public.admin_cancel_order(ord_tests.order_id(7), ord_tests.ver(7), ord_tests.req(16), 'customer_request') $q$,
  'PT409', 'bad_transition');
select ord_tests.returns('cancel: the pair was released exactly once',
  $q$ select ord_tests.stock('TEST-ORD-NEW-20') || ' ' ||
        (select count(*) from public.stock_movements where order_id = ord_tests.order_id(7) and reason = 'order_release') $q$, '5/0 1');

-- A failed delivery that comes back unpaid: payment void only then.
reset role;
set local role anon;
select ord_tests.returns('place: two new pairs',
  $q$ select ord_tests.place(13, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-21', 2, 150000)), 30000, 330000, '+923001313131') ->> 'result' $q$, 'placed');
reset role;
set local role authenticated;
select ord_tests.as_admin();
select public.admin_confirm_order(ord_tests.order_id(13), ord_tests.ver(13), ord_tests.req(17));
select public.admin_dispatch_order(ord_tests.order_id(13), ord_tests.ver(13), ord_tests.req(18), 'TCS', null);
select public.admin_mark_delivery_failed(ord_tests.order_id(13), ord_tests.ver(13), ord_tests.req(19));
select ord_tests.returns('returned without payment: payment void',
  $q$ select (r ->> 'payment_status')
      from (select public.admin_receive_return(ord_tests.order_id(13), ord_tests.ver(13), ord_tests.req(20),
        jsonb_build_array(jsonb_build_object('order_item_id', (select id from public.order_items where order_id = ord_tests.order_id(13)),
          'restock', 1, 'write_off', 1))) r) x $q$,
  'void');
select ord_tests.returns('returned: one pair restocked, one written off (recorded, not restocked)',
  $q$ select ord_tests.stock('TEST-ORD-NEW-21') || ' ' ||
        (select string_agg(reason || ':' || available_delta, ',' order by reason) from public.stock_movements
         where order_id = ord_tests.order_id(13) and reason like 'return%') $q$,
  '1/0 return_restock:1,return_write_off:0');
select ord_tests.throws('payment can''t be recorded on a voided order',
  $q$ select public.admin_record_payment(ord_tests.order_id(13), ord_tests.ver(13), ord_tests.req(21), 'collected', 330000) $q$,
  'PT409', 'bad_payment_transition');
select ord_tests.returns('notes can be added at any time, once per request',
  $q$ select (public.admin_add_order_note(ord_tests.order_id(13), ord_tests.req(22), 'Customer called') ->> 'result') || ' ' ||
        (public.admin_add_order_note(ord_tests.order_id(13), ord_tests.req(22), 'Customer called') ->> 'result') $q$, 'done replayed');

-- ---------------------------------------------------------------------------
-- A failed delivery retried: place → confirm → dispatch → failed → dispatch
-- again (twice) → delivered. Stock and held pairs change once, for the
-- original shipment only; retries move nothing.
-- ---------------------------------------------------------------------------

reset role;
select set_config('ord.retry_before', ord_tests.stock('TEST-ORD-NEW-20'), true);
set local role anon;
select ord_tests.returns('retry: place two pairs',
  $q$ select ord_tests.place(16, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 2, 150000)), 30000, 330000, '+923001616161') ->> 'result' $q$, 'placed');
reset role;
-- Available, held, and this order's ledger rows by reason.
create function ord_tests.retry_state() returns text language sql as $$
  select ord_tests.stock('TEST-ORD-NEW-20') || ' ' || coalesce((
    select string_agg(reason || ':' || n || '(' || a || '/' || r || ')', ',' order by reason) from (
      select reason, count(*) n, sum(available_delta) a, sum(reserved_delta) r
      from public.stock_movements where order_id = ord_tests.order_id(16) group by reason) x), '');
$$;
grant execute on function ord_tests.retry_state() to authenticated;
select ord_tests.returns('retry: placed — two pairs held',
  $q$ select ord_tests.retry_state() $q$,
  (split_part(current_setting('ord.retry_before'), '/', 1)::int - 2) || '/2 order_reserve:1(-2/2)');
set local role authenticated;
select ord_tests.as_admin();
select public.admin_confirm_order(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(60));
select ord_tests.returns('retry: dispatched — the held pairs leave, once',
  $q$ select (public.admin_dispatch_order(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(61), 'TCS', 'TRY-1') ->> 'status') $q$,
  'dispatched');
select set_config('ord.after_dispatch', ord_tests.retry_state(), true);
select ord_tests.returns('retry: after dispatch',
  $q$ select ord_tests.retry_state() $q$,
  (split_part(current_setting('ord.retry_before'), '/', 1)::int - 2) || '/0 order_dispatch:1(0/-2),order_reserve:1(-2/2)');
select ord_tests.returns('retry: delivery failed — payment pending, stock untouched',
  $q$ select (public.admin_mark_delivery_failed(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(62), 'Not home') ->> 'payment_status')
        || ' ' || (ord_tests.retry_state() = current_setting('ord.after_dispatch')) $q$, 'pending true');
select ord_tests.throws('retry: a failed delivery can''t be cancelled (the parcel is out)',
  $q$ select public.admin_cancel_order(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(63), 'customer_request') $q$,
  'PT409', 'bad_transition');
select ord_tests.returns('retry: dispatched again — no new stock movement, held stays at 0',
  $q$ select (public.admin_dispatch_order(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(64), 'TCS', 'TRY-2') ->> 'status') $q$,
  'dispatched');
select ord_tests.returns('retry: after the second dispatch the stock is exactly as after the first',
  $q$ select (ord_tests.retry_state() = current_setting('ord.after_dispatch'))::text $q$, 'true');
select public.admin_mark_delivery_failed(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(65), 'Not home again');
select public.admin_dispatch_order(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(66), 'TCS', 'TRY-3');
select ord_tests.returns('retry: a third attempt still moves nothing',
  $q$ select (ord_tests.retry_state() = current_setting('ord.after_dispatch'))::text || ' ' ||
        (select count(*) from public.order_events where order_id = ord_tests.order_id(16) and kind = 'redispatched') $q$, 'true 2');
select ord_tests.returns('retry: delivered with cash collected',
  $q$ select (r ->> 'status') || ' ' || (r ->> 'payment_status')
      from (select public.admin_mark_delivered(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(67), true) r) x $q$,
  'delivered collected');
select ord_tests.returns('retry: delivery recorded no stock movement either',
  $q$ select (ord_tests.retry_state() = current_setting('ord.after_dispatch'))::text $q$, 'true');
select ord_tests.returns('retry: courier remittance recorded',
  $q$ select public.admin_record_payment(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(68), 'settled', null, 'TCS-REMIT-2') ->> 'payment_status' $q$,
  'settled');
select ord_tests.throws('retry: a delivered order can''t be dispatched again',
  $q$ select public.admin_dispatch_order(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(69), 'TCS', null) $q$, 'PT409', 'bad_transition');
select ord_tests.returns('retry: returned after delivery — both pairs restocked once, refund due',
  $q$ select (r ->> 'payment_status')
      from (select public.admin_receive_return(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(70),
        jsonb_build_array(jsonb_build_object('order_item_id', (select id from public.order_items where order_id = ord_tests.order_id(16)),
          'restock', 2, 'write_off', 0))) r) x $q$, 'refund_due');
select ord_tests.returns('retry: back to the stock before the order, every movement once',
  $q$ select ord_tests.retry_state() $q$,
  current_setting('ord.retry_before') || ' order_dispatch:1(0/-2),order_reserve:1(-2/2),return_restock:1(2/0)');
select ord_tests.returns('retry: refund recorded',
  $q$ select public.admin_record_payment(ord_tests.order_id(16), ord_tests.ver(16), ord_tests.req(71), 'refunded', 330000, 'CASH-2') ->> 'payment_status' $q$,
  'refunded');

-- ---------------------------------------------------------------------------
-- In-store sales (same stock rules)
-- ---------------------------------------------------------------------------

select ord_tests.returns('in store: sells the pre-loved pair (cash collected)',
  $q$ select (public.admin_record_in_store_sale(ord_tests.req(30), jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000))) ->> 'result')
        || ' ' || ord_tests.stock('TEST-ORD-PL-42') $q$, 'placed 0/0');
select ord_tests.returns('in store: the same sale again is recognised',
  $q$ select public.admin_record_in_store_sale(ord_tests.req(30), jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000))) ->> 'result' $q$,
  'existing');
select ord_tests.returns('in store: the same request id with other contents is refused',
  $q$ select public.admin_record_in_store_sale(ord_tests.req(30), jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 150000))) ->> 'result' $q$,
  'mismatch');
select ord_tests.throws('in store: unpublished products are refused while that is undecided',
  $q$ select public.admin_record_in_store_sale(ord_tests.req(31), jsonb_build_array(ord_tests.line('TEST-ORD-DRAFT-40', 1, 100000))) $q$,
  'PT409', 'in_store_unpublished');
reset role;
set local role anon;
select ord_tests.returns('online after the in-store sale: sold out',
  $q$ select ord_tests.place(14, jsonb_build_array(ord_tests.line('TEST-ORD-PL-42', 1, 245000)), 30000, 275000, '+923001414141') -> 'quote' -> 'lines' -> 0 ->> 'status' $q$,
  'sold_out');
reset role;

-- ---------------------------------------------------------------------------
-- Stock edits by admins: inventory version
-- ---------------------------------------------------------------------------

set local role authenticated;
select ord_tests.as_admin();
select set_config('ord.v0', (select inventory_version::text from public.product_variants where sku = 'TEST-ORD-NEW-20'), true);
select set_config('ord.s0', (select stock::text from public.product_variants where sku = 'TEST-ORD-NEW-20'), true);
select set_config('ord.size_id', (select id::text from public.product_variants where sku = 'TEST-ORD-NEW-20'), true);
select ord_tests.returns('adjust stock with the current version',
  $q$ select public.admin_adjust_stock(current_setting('ord.size_id')::uuid, current_setting('ord.v0')::bigint, 4, ord_tests.req(40)) ->> 'stock' $q$, '4');
select ord_tests.returns('adjust: the same request again changes nothing',
  $q$ select (r ->> 'applied') || ' ' || (r ->> 'stock') from (select public.admin_adjust_stock(current_setting('ord.size_id')::uuid,
        current_setting('ord.v0')::bigint, 4, ord_tests.req(40)) r) x $q$, 'false 4');
select public.admin_adjust_stock(current_setting('ord.size_id')::uuid,
  (select inventory_version from public.product_variants where sku = 'TEST-ORD-NEW-20'), current_setting('ord.s0')::integer, ord_tests.req(41));
select ord_tests.throws('adjust: stock back at its old value but changed in between (A-B-A) is still a conflict',
  $q$ select public.admin_adjust_stock(current_setting('ord.size_id')::uuid, current_setting('ord.v0')::bigint, 3, ord_tests.req(42)) $q$,
  'PT409', 'stock_changed');

-- The product form, opened before an order arrived.
select set_config('ord.form', (select jsonb_agg(jsonb_build_object('size', size_eu, 'stock', stock, 'stock_was', stock,
  'inventory_version', inventory_version) order by size_eu)::text
  from public.product_variants where sku like 'TEST-ORD-NEW-%'), true);
select set_config('ord.pv', (select version::text from public.products where item_code = 'TEST-ORD-NEW'), true);
reset role;
set local role anon;
select ord_tests.place(15, jsonb_build_array(ord_tests.line('TEST-ORD-NEW-20', 1, 150000)), 30000, 180000, '+923001515151') ->> 'result';
reset role;
set local role authenticated;
select ord_tests.as_admin();
select set_config('ord.after_order', ord_tests.stock('TEST-ORD-NEW-20'), true);
select public.admin_save_product((select id from public.products where item_code = 'TEST-ORD-NEW'), current_setting('ord.pv')::integer,
  jsonb_build_object('item_code', 'TEST-ORD-NEW', 'slug', 'test-ord-new', 'name', 'Test new style', 'brand', 'Testbrand',
    'department', 'kids', 'styles', jsonb_build_array('sneakers'), 'item_status', 'new', 'condition', 'new',
    'condition_notes', '[]'::jsonb, 'colour', 'Blue', 'description', 'A new description', 'price_paisa', 150000),
  current_setting('ord.form')::jsonb,
  (select jsonb_agg(jsonb_build_object('id', id, 'alt', alt)) from public.product_images
   where product_id = (select id from public.products where item_code = 'TEST-ORD-NEW')));
select ord_tests.returns('saving only the description doesn''t overwrite stock an order changed',
  $q$ select (ord_tests.stock('TEST-ORD-NEW-20') = current_setting('ord.after_order'))::text $q$, 'true');
select ord_tests.throws('changing stock from a form opened before the order is refused',
  $q$ select public.admin_save_product((select id from public.products where item_code = 'TEST-ORD-NEW'),
        (select version from public.products where item_code = 'TEST-ORD-NEW'),
        jsonb_build_object('item_code', 'TEST-ORD-NEW', 'slug', 'test-ord-new', 'name', 'Test new style', 'brand', 'Testbrand',
          'department', 'kids', 'styles', jsonb_build_array('sneakers'), 'item_status', 'new', 'condition', 'new',
          'condition_notes', '[]'::jsonb, 'colour', 'Blue', 'description', 'A new description', 'price_paisa', 150000),
        (select jsonb_agg(case when (e ->> 'size')::numeric = 20 then e || '{"stock": 9}' else e end)
         from jsonb_array_elements(current_setting('ord.form')::jsonb) e),
        (select jsonb_agg(jsonb_build_object('id', id, 'alt', alt)) from public.product_images
         where product_id = (select id from public.products where item_code = 'TEST-ORD-NEW'))) $q$,
  'PT409', 'stock_changed');
select ord_tests.throws('admin: held stock can''t be changed directly',
  $q$ update public.product_variants set reserved = 0 where sku = 'TEST-ORD-NEW-20' $q$, '42501');

-- Scanning stays read-only.
select set_config('ord.ledger_count', (select count(*)::text from public.stock_movements), true);
select public.admin_scan_lookup('TEST-ORD-NEW-20');
select ord_tests.returns('a barcode or SKU lookup writes nothing to the ledger',
  $q$ select ((select count(*) from public.stock_movements)::text = current_setting('ord.ledger_count'))::text $q$, 'true');
reset role;

-- ---------------------------------------------------------------------------
-- Ledger reconciliation (available and held separately)
-- ---------------------------------------------------------------------------

select ord_tests.returns('ledger: available stock = sum of available changes, for every size',
  $q$ select coalesce(string_agg(v.sku, ', '), '') from public.product_variants v
      where v.stock <> coalesce((select sum(m.available_delta) from public.stock_movements m where m.variant_id = v.id), 0) $q$, '');
select ord_tests.returns('ledger: held stock = sum of held changes, for every size',
  $q$ select coalesce(string_agg(v.sku, ', '), '') from public.product_variants v
      where v.reserved <> coalesce((select sum(m.reserved_delta) from public.stock_movements m where m.variant_id = v.id), 0) $q$, '');
select ord_tests.returns('ledger: held stock = pairs on open orders not yet dispatched',
  $q$ select coalesce(string_agg(v.sku, ', '), '') from public.product_variants v
      where v.reserved <> coalesce((select sum(oi.quantity) from public.order_items oi join public.orders o on o.id = oi.order_id
                                    where oi.variant_id = v.id and o.status in ('awaiting_confirmation', 'confirmed')), 0) $q$, '');
select ord_tests.throws('ledger rows can''t be changed', $q$ update public.stock_movements set note = 'x' $q$, 'PT400', 'append_only');
select ord_tests.throws('orders can''t be deleted', $q$ delete from public.orders where id = ord_tests.order_id(6) $q$, 'PT400', 'append_only');

-- ---------------------------------------------------------------------------
-- Put the counters back, and roll everything back
-- ---------------------------------------------------------------------------

select setval('public.barcode_serial', current_setting('ord.serial_last')::bigint, current_setting('ord.serial_called')::boolean);
select setval('public.order_number_seq', current_setting('ord.order_last')::bigint, current_setting('ord.order_called')::boolean);

rollback;
