-- Checkout hardening: the global order quota, unpublished products in quotes,
-- and the per-phone open-order limit under concurrency.
--
-- 1. Global order quota. checkout_register_attempt('place') used to charge
--    the per-connection buckets AND the shop-wide "orders per minute" bucket
--    for every attempt, before Turnstile, even when the per-connection limit
--    had already refused it. One visitor's refused or bot attempts could use up
--    the whole shop's quota and lock everyone else out. Now:
--      * checkout_register_attempt('place') charges only the visitor's own
--        buckets, and stops at the first one that refuses (the daily bucket
--        isn't charged for an attempt the 10-minute bucket refused);
--      * place_cod_order takes one slot of the global quota at the very end,
--        after the key, the settings, the limits, the phone limit and the
--        exact quote have all passed, in the same transaction as the order
--        (so a rolled-back order never counts). Retries that return the
--        existing order, refused orders and attempts that fail Turnstile (never
--        reach place_cod_order) don't count. When the quota is full the result
--        is "busy" and nothing is ordered.
-- 2. Online quotes say nothing about a SKU that isn't for sale online. A
--    draft or archived product's line used to carry its name, brand, size,
--    condition and (sale) price, with status "unavailable". Now such a line is
--    identical to one for a SKU that doesn't exist. In-store quotes
--    (p_online = false, verified admins only) are unchanged.
-- 3. Per-phone limit. place_cod_order counted the phone's open orders without
--    any lock, so simultaneous orders with different checkout keys all saw
--    the same count. It now takes a transaction advisory lock on the phone
--    number before counting and keeps it until commit. Orders whose hold has
--    already expired no longer count (they can't be confirmed: they are
--    released by the next order on their sizes or by the expiry job).
--
-- Locking order (extends 20261031130000_guest_orders.sql; nothing waits upwards):
--   1. the request key (advisory)          1a. the phone number (advisory, place_cod_order only)
--   2. shop_settings   3. orders   4. products   5. product_variants
--   6. the global quota row (private.rate_limit_buckets), last, held until commit.
-- Customers with different phone numbers never wait for each other's phone
-- lock; everyone still meets at step 6 for the length of the final insert.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Serialises order placement for one phone number (level 1a of the locking
-- order). A different lock space from lock_key (two-integer form).
create function private.lock_phone(p_phone text)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(20261117,
    ('x' || encode(substring(sha256(convert_to(p_phone, 'UTF8')) from 1 for 4), 'hex'))::bit(32)::integer);
$$;

-- Takes one slot of a fixed-window quota, only if one is left. Unlike
-- rate_limit_hit, a refusal doesn't count. The row stays locked until the
-- caller's transaction ends, so a rolled-back caller gives its slot back.
create function private.take_quota_slot(p_bucket text, p_window interval, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  taken integer;
begin
  insert into private.rate_limit_buckets as b (bucket, window_start, hits)
  values (p_bucket, date_bin(p_window, now(), timestamptz '2000-01-01 00:00:00+00'), 1)
  on conflict (bucket, window_start) do update set hits = b.hits + 1 where b.hits < p_limit
  returning hits into taken;
  return taken is not null and taken <= p_limit;
end;
$$;

revoke execute on function private.lock_phone(text), private.take_quota_slot(text, interval, integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Per-visitor attempt limits only
-- ---------------------------------------------------------------------------

create or replace function public.checkout_register_attempt(p_gateway_key text, p_client text, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  s public.shop_settings;
  client text := coalesce(p_client, 'ip:unknown');
  allowed boolean := true;
begin
  perform private.require_gateway(p_gateway_key);
  if p_kind not in ('place', 'lookup', 'quote') or (p_client is not null and p_client !~ '^ip:[0-9a-f]{64}$') then
    raise exception 'Malformed attempt.' using errcode = 'PT400';
  end if;
  select * into s from public.shop_settings;

  if p_kind = 'place' then
    -- The global quota is taken by place_cod_order, once per new order.
    if s.place_attempts_per_ip_10min is null or s.place_attempts_per_ip_day is null or s.orders_per_minute_global is null then
      return jsonb_build_object('allowed', false, 'reason', 'not_configured');
    end if;
    allowed := private.rate_limit_hit('place:10m:' || client, interval '10 minutes', s.place_attempts_per_ip_10min)
      and private.rate_limit_hit('place:1d:' || client, interval '1 day', s.place_attempts_per_ip_day);
  elsif p_kind = 'quote' then
    if s.quotes_per_ip_10min is null then
      return jsonb_build_object('allowed', false, 'reason', 'not_configured');
    end if;
    allowed := private.rate_limit_hit('quote:10m:' || client, interval '10 minutes', s.quotes_per_ip_10min);
  else
    if s.lookups_per_ip_10min is null then
      return jsonb_build_object('allowed', false, 'reason', 'not_configured');
    end if;
    allowed := private.rate_limit_hit('lookup:10m:' || client, interval '10 minutes', s.lookups_per_ip_10min);
  end if;
  return jsonb_build_object('allowed', allowed, 'reason', case when allowed then 'ok' else 'rate_limited' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Quotes: a line that isn't for sale online carries no product details
-- ---------------------------------------------------------------------------

-- As in 20261101130000_item_codes_and_sale_prices.sql, except that the size
-- and its product are looked up together, and only if the product may be
-- sold here: online, published products only. Any other SKU (a draft, an
-- archived product, a typo) finds nothing, so its line is the same either way.
create or replace function private.checkout_quote(p_lines jsonb, p_city text, p_settings public.shop_settings, p_online boolean default true)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result_lines jsonb;
  subtotal bigint;
  buyable integer;
  delivery_status text;
  delivery bigint := 0;
  city_row public.delivery_cities;
  city_name text := nullif(btrim(coalesce(p_city, '')), '');
begin
  with requested as (
    select l ->> 'sku' as sku, (l ->> 'quantity')::integer as quantity, (l ->> 'unit_price_paisa')::integer as seen_price, n
    from jsonb_array_elements(p_lines) with ordinality as x (l, n)
  ),
  live as (
    select r.*, x.variant_id, x.size_eu, x.name, x.brand, x.item_status, x.condition, x.price_paisa, x.regular_price_paisa,
      case
        when x.variant_id is null then 0
        else x.stock + coalesce((
          select sum(oi.quantity)::integer from public.order_items oi
          join public.orders o on o.id = oi.order_id
          where oi.variant_id = x.variant_id and o.status = 'awaiting_confirmation' and o.hold_expires_at <= now()
        ), 0)
      end as available,
      x.variant_id is null as gone
    from requested r
    left join lateral (
      select v.id as variant_id, v.size_eu, v.stock, p.name, p.brand, p.item_status, p.condition,
        coalesce(p.sale_price_paisa, p.price_paisa) as price_paisa, p.price_paisa as regular_price_paisa
      from public.product_variants v
      join public.products p on p.id = v.product_id
      where v.sku = r.sku and (not p_online or p.publication_status = 'published')
    ) x on true
  ),
  judged as (
    select l.*,
      least(l.quantity, l.available, coalesce(case when p_online then p_settings.max_units_per_line end, l.quantity)) as allowed
    from live l
  )
  select
    jsonb_agg(jsonb_build_object(
      'sku', j.sku,
      'status', case when j.gone then 'unavailable' when j.available = 0 then 'sold_out'
                     when j.allowed < j.quantity then 'reduced' else 'ok' end,
      'name', j.name, 'brand', j.brand, 'size_eu', j.size_eu, 'item_status', j.item_status, 'condition', j.condition,
      'quantity', j.quantity, 'allowed_quantity', case when j.gone then 0 else j.allowed end,
      'available', j.available,
      'unit_price_paisa', j.price_paisa,
      'regular_price_paisa', j.regular_price_paisa,
      'price_changed', not j.gone and j.price_paisa is distinct from j.seen_price,
      'seen_price_paisa', j.seen_price
    ) order by j.n),
    coalesce(sum(j.allowed::bigint * j.price_paisa) filter (where not j.gone and j.allowed > 0), 0),
    count(*) filter (where not j.gone and j.allowed > 0)
  into result_lines, subtotal, buyable
  from judged j;

  if p_settings.delivery_area_mode is null or p_settings.standard_delivery_fee_paisa is null
    or p_settings.free_delivery_enabled is null then
    delivery_status := 'not_configured';
  elsif city_name is null then
    delivery_status := 'city_required';
  else
    select * into city_row from public.delivery_cities c where c.city_key = lower(city_name) and c.active;
    if p_settings.delivery_area_mode = 'selected' and city_row.city is null then
      delivery_status := 'not_served';
    else
      delivery_status := 'ok';
      delivery := coalesce(city_row.fee_paisa, p_settings.standard_delivery_fee_paisa);
      if buyable = 0 or (p_settings.free_delivery_enabled and subtotal >= p_settings.free_delivery_min_paisa) then
        delivery := 0;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'lines', coalesce(result_lines, '[]'::jsonb),
    'subtotal_paisa', subtotal,
    'delivery_status', delivery_status,
    'delivery_paisa', delivery,
    'total_paisa', subtotal + delivery,
    'free_delivery_min_paisa', case when p_settings.free_delivery_enabled then p_settings.free_delivery_min_paisa end,
    'orders_open', p_settings.orders_open,
    'exact', delivery_status = 'ok' and not exists (
      select 1 from jsonb_array_elements(coalesce(result_lines, '[]'::jsonb)) l
      where l ->> 'status' <> 'ok' or (l ->> 'price_changed')::boolean
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 1 and 3. Placing an order: phone lock, then the global quota last
-- ---------------------------------------------------------------------------

-- As in 20261031130000_guest_orders.sql, with the phone lock (1a) before the
-- open-order count, expired holds left out of that count, and the global
-- quota taken last. New result: busy (the shop-wide quota for this minute is
-- used up; nothing was ordered, the same key can be sent again).
create or replace function public.place_cod_order(p_gateway_key text, p_request_key text, p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  normalised jsonb;
  fingerprint bytea;
  request_hash bytea;
  existing public.orders;
  s public.shop_settings;
  variant_ids uuid[];
  expired uuid[];
  expired_id uuid;
  quote jsonb;
  new_order public.orders;
  item public.order_items;
  total_units integer;
begin
  perform private.require_gateway(p_gateway_key);
  request_hash := private.checkout_key_hash(p_request_key);
  normalised := private.checkout_input(p_order);
  fingerprint := private.fingerprint(normalised);

  -- 1. The key.
  perform private.lock_key(request_hash);
  select * into existing from public.orders o where o.request_key_hash = request_hash;
  if found then
    if existing.channel = 'online' and existing.request_fingerprint = fingerprint then
      return jsonb_build_object('result', 'existing', 'order', private.customer_order_view(existing.id));
    end if;
    return jsonb_build_object('result', 'mismatch');
  end if;
  if exists (select 1 from private.checkout_abandoned_keys a where a.key_hash = request_hash) then
    return jsonb_build_object('result', 'abandoned');
  end if;

  -- 1a. The phone number: one placement at a time per phone, until commit.
  perform private.lock_phone(normalised -> 'customer' ->> 'phone');

  -- 2. Settings (shared: a settings change waits for orders in progress).
  select * into s from public.shop_settings for share;
  if not s.orders_open then
    return jsonb_build_object('result', 'closed');
  end if;
  select sum((l ->> 'quantity')::integer) into total_units from jsonb_array_elements(normalised -> 'lines') l;
  if jsonb_array_length(normalised -> 'lines') > s.max_lines_per_order or total_units > s.max_units_per_order
    or exists (select 1 from jsonb_array_elements(normalised -> 'lines') l where (l ->> 'quantity')::integer > s.max_units_per_line) then
    return jsonb_build_object('result', 'limits', 'max_lines', s.max_lines_per_order,
      'max_units', s.max_units_per_order, 'max_units_per_line', s.max_units_per_line);
  end if;
  if (select count(*) from public.orders o
      where o.status = 'awaiting_confirmation' and o.hold_expires_at > now()
        and o.customer_phone = normalised -> 'customer' ->> 'phone') >= s.max_open_orders_per_phone then
    return jsonb_build_object('result', 'phone_limit');
  end if;

  -- 3-5. Expired orders on these sizes, then products and sizes.
  select coalesce(array_agg(v.id), '{}') into variant_ids
  from public.product_variants v
  where v.sku in (select l ->> 'sku' from jsonb_array_elements(normalised -> 'lines') l);
  expired := private.lock_for_sale(variant_ids);
  foreach expired_id in array expired loop
    perform private.release_order(expired_id, true, 'system', null, null, 'hold_expired', null);
  end loop;

  -- Everything is locked: this quote is what the order will be.
  quote := private.checkout_quote(normalised -> 'lines', normalised -> 'customer' ->> 'city', s);
  if not (quote ->> 'exact')::boolean
    or (quote ->> 'delivery_paisa')::bigint <> (normalised ->> 'delivery_paisa')::bigint
    or (quote ->> 'total_paisa')::bigint <> (normalised ->> 'total_paisa')::bigint then
    return jsonb_build_object('result', 'quote_changed', 'quote', quote);
  end if;

  -- 6. The shop-wide quota: one slot per new order, taken last.
  if not private.take_quota_slot('place:1m:global', interval '1 minute', s.orders_per_minute_global) then
    return jsonb_build_object('result', 'busy');
  end if;

  insert into public.orders (
    order_number, channel, status, payment_status, request_key_hash, request_fingerprint,
    customer_name, customer_phone, city, address, landmark, delivery_note,
    subtotal_paisa, delivery_paisa, total_paisa, hold_expires_at
  )
  values (
    'KO-' || nextval('public.order_number_seq'), 'online', 'awaiting_confirmation', 'pending', request_hash, fingerprint,
    normalised -> 'customer' ->> 'name', normalised -> 'customer' ->> 'phone', normalised -> 'customer' ->> 'city',
    normalised -> 'customer' ->> 'address', normalised -> 'customer' ->> 'landmark', normalised -> 'customer' ->> 'note',
    (quote ->> 'subtotal_paisa')::bigint, (quote ->> 'delivery_paisa')::bigint, (quote ->> 'total_paisa')::bigint,
    now() + make_interval(mins => s.hold_minutes)
  )
  returning * into new_order;

  perform private.insert_order_items(new_order.id, normalised -> 'lines');
  for item in select * from public.order_items where order_id = new_order.id order by variant_id loop
    perform private.inventory_apply(item.variant_id, -item.quantity, item.quantity, 'order_reserve',
      'reserve:' || item.id, new_order.id, item.id);
  end loop;

  insert into public.order_events (order_id, kind, to_status, to_payment, actor)
  values (new_order.id, 'placed', 'awaiting_confirmation', 'pending', 'customer');

  return jsonb_build_object('result', 'placed', 'order', private.customer_order_view(new_order.id));
end;
$$;
