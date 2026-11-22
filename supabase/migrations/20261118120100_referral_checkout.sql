-- Referral codes at checkout: the customer discount, and an immutable
-- snapshot of the referral and its commission on every order that used one.
--
-- Builds on 20261118120000_sales_agents.sql and the checkout functions as
-- last changed in 20261117120100_checkout_quota_quotes_and_phone_limit.sql.
--
-- Business rules (README, "Sales agents"):
--   * One code per order. A line qualifies unless its product is on sale and
--     the agent's terms say sale items don't qualify. Lines that don't
--     qualify pay their normal (sale) price and earn no commission.
--   * Discount = discount % of the qualifying lines' total.
--     Commission = commission % of (qualifying total - discount). Delivery
--     never earns commission.
--   * Rounding (the only rule): each amount is calculated once per order in
--     whole paisa, rounded half up (private.percent_of), then shared across
--     the qualifying lines in proportion to their amounts, the leftover paisa
--     going to the lines with the largest remainders, earlier lines first on
--     a tie (private.allocate_paisa). Line shares always add up exactly.
--   * Free delivery is judged on the merchandise total AFTER the discount.
--   * The database works out every amount. The website sends only the code
--     and the discount the customer saw; any difference returns
--     quote_changed with the new quote, never an order.
--   * The order keeps a snapshot: agent, code, terms, qualifying amounts,
--     per-line discount and commission, and the commission hold policy.
--     Later changes to the agent or their terms affect new orders only.
--   * Commission is never part of a shopper-facing response.
--
-- Compatibility: an order without a code is normalised exactly as before
-- (no new keys), so its fingerprint, retries and checkout_resolve answers
-- are unchanged, and the previous website keeps working until it is
-- replaced (quote_order keeps working with three arguments).
--
-- Locking order (extends 20261117120100): 1. key, 1a. phone, 2. settings,
-- 2a. the code's agent row (FOR SHARE: its terms can't change until the
-- order commits), 3. orders, 4. products, 5. sizes, 6. global quota.

-- ---------------------------------------------------------------------------
-- Orders: the discount
-- ---------------------------------------------------------------------------

alter table public.orders add column discount_paisa bigint not null default 0;

comment on column public.orders.discount_paisa is
  'Referral discount on the merchandise (0 without a code). total = subtotal - discount + delivery.';

alter table public.orders drop constraint orders_amounts_valid;
alter table public.orders add constraint orders_amounts_valid check (
  subtotal_paisa >= 0 and delivery_paisa >= 0 and discount_paisa between 0 and subtotal_paisa
  and total_paisa = subtotal_paisa - discount_paisa + delivery_paisa
  and (collected_paisa is null or collected_paisa between 0 and total_paisa)
  and (refunded_paisa is null or (collected_paisa is not null and refunded_paisa between 1 and collected_paisa))
);

-- As in 20261031130000_guest_orders.sql, plus: the discount is fixed like
-- the other totals, and the delivery time, once recorded, never changes (the
-- commission hold counts from it; a replayed or repeated delivery event can't
-- restart or shorten it).
create or replace function private.orders_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Orders are never deleted.' using errcode = 'PT400', hint = 'append_only';
  end if;
  if (new.id, new.order_number, new.channel, new.request_key_hash, new.request_fingerprint,
      new.subtotal_paisa, new.discount_paisa, new.delivery_paisa, new.total_paisa, new.created_at)
     is distinct from
     (old.id, old.order_number, old.channel, old.request_key_hash, old.request_fingerprint,
      old.subtotal_paisa, old.discount_paisa, old.delivery_paisa, old.total_paisa, old.created_at) then
    raise exception 'An order''s number, contents and totals never change.' using errcode = 'PT400', hint = 'order_locked';
  end if;
  if old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at then
    raise exception 'An order''s delivery time never changes once recorded.' using errcode = 'PT400', hint = 'order_locked';
  end if;
  if new.status is distinct from old.status and (old.status, new.status) not in (
    ('awaiting_confirmation', 'confirmed'), ('awaiting_confirmation', 'cancelled'),
    ('confirmed', 'dispatched'), ('confirmed', 'cancelled'),
    ('dispatched', 'delivered'), ('dispatched', 'delivery_failed'),
    ('delivery_failed', 'dispatched'), ('delivery_failed', 'delivered'), ('delivery_failed', 'returned'),
    ('delivered', 'returned')
  ) then
    raise exception 'An order can''t go from % to %.', old.status, new.status using errcode = 'PT409', hint = 'bad_transition';
  end if;
  if new.payment_status is distinct from old.payment_status and (old.payment_status, new.payment_status) not in (
    ('pending', 'collected'), ('pending', 'void'), ('collected', 'settled'),
    ('collected', 'refund_due'), ('settled', 'refund_due'), ('refund_due', 'refunded')
  ) then
    raise exception 'Payment can''t go from % to %.', old.payment_status, new.payment_status
      using errcode = 'PT409', hint = 'bad_payment_transition';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The order-time snapshot
-- ---------------------------------------------------------------------------

create table public.order_referrals (
  order_id uuid primary key references public.orders (id) on delete restrict,
  agent_id uuid not null references public.sales_agents (id) on delete restrict,
  code text not null,
  -- Who the agent was at the time (the agent id is the identity; the
  -- username may change later).
  agent_username text not null,
  terms_version integer not null,
  discount_bp integer not null,
  commission_bp integer not null,
  applies_to_sale_items boolean not null,
  -- Qualifying lines' total before the discount.
  eligible_subtotal_paisa bigint not null,
  discount_paisa bigint not null,
  -- eligible_subtotal - discount: what the commission is a percentage of.
  commission_basis_paisa bigint not null,
  commission_paisa bigint not null,
  -- The commission is held this long after the recorded delivery time.
  hold_hours integer not null,
  rounding_rule text not null,
  created_at timestamptz not null default now(),

  constraint order_referrals_code_format check (code ~ '^[A-Z0-9]{3,16}$'),
  constraint order_referrals_terms_range check (discount_bp between 0 and 5000 and commission_bp between 0 and 5000),
  constraint order_referrals_amounts check (
    eligible_subtotal_paisa > 0 and discount_paisa between 0 and eligible_subtotal_paisa
    and commission_basis_paisa = eligible_subtotal_paisa - discount_paisa
    and commission_paisa between 0 and commission_basis_paisa),
  constraint order_referrals_hold_range check (hold_hours between 0 and 8760)
);

create index order_referrals_agent_idx on public.order_referrals (agent_id, created_at desc);

comment on table public.order_referrals is
  'One row per order placed with a referral code: who earns, the terms used and the amounts, fixed at placement.';

create table public.order_line_referrals (
  order_item_id uuid primary key references public.order_items (id) on delete restrict,
  order_id uuid not null references public.order_referrals (order_id) on delete restrict,
  line_no smallint not null,
  eligible boolean not null,
  line_total_paisa bigint not null,
  discount_paisa bigint not null,
  commission_paisa bigint not null,

  constraint order_line_referrals_line_key unique (order_id, line_no),
  constraint order_line_referrals_amounts check (
    discount_paisa between 0 and line_total_paisa
    and commission_paisa between 0 and line_total_paisa - discount_paisa
    and (eligible or (discount_paisa = 0 and commission_paisa = 0)))
);

comment on table public.order_line_referrals is
  'Per order line: whether it qualified, its share of the discount and of the commission (reversals are worked out per line).';

create trigger order_referrals_append_only before update or delete on public.order_referrals
  for each row execute function private.append_only();
create trigger order_referrals_no_truncate before truncate on public.order_referrals
  for each statement execute function private.append_only();
create trigger order_line_referrals_append_only before update or delete on public.order_line_referrals
  for each row execute function private.append_only();
create trigger order_line_referrals_no_truncate before truncate on public.order_line_referrals
  for each statement execute function private.append_only();

-- ---------------------------------------------------------------------------
-- Money helpers
-- ---------------------------------------------------------------------------

-- p_bp basis points (1/100 of a percent) of p_amount paisa, rounded half up
-- to a whole paisa. Exact: numeric arithmetic, no floating point.
create function private.percent_of(p_amount bigint, p_bp integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select floor((p_amount::numeric * p_bp + 5000) / 10000)::bigint;
$$;

-- Shares p_total paisa across lines in proportion to p_weights: whole paisa,
-- the leftover going to the largest remainders (earlier lines first on a
-- tie). The shares add up to p_total exactly. Zero weights get nothing.
create function private.allocate_paisa(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  weight_sum numeric;
  shares bigint[];
begin
  select coalesce(sum(w), 0) into weight_sum from unnest(p_weights) w;
  if cardinality(p_weights) = 0 then
    return '{}';
  end if;
  if weight_sum = 0 or p_total = 0 then
    return array_fill(0::bigint, array[cardinality(p_weights)]);
  end if;
  with parts as (
    select i, floor(p_total::numeric * w / weight_sum)::bigint as base, (p_total::numeric * w) % weight_sum as remainder
    from unnest(p_weights) with ordinality as u (w, i)
  ),
  leftover as (
    select p_total - sum(base) as paisa from parts
  ),
  ranked as (
    select i, base, row_number() over (order by remainder desc, i) as rank from parts
  )
  select array_agg(r.base + case when r.rank <= l.paisa then 1 else 0 end order by r.i)
  into shares
  from ranked r cross join leftover l;
  return shares;
end;
$$;

-- How long commission is held after delivery (30 days of 24 hours, counted
-- from the recorded delivery time). Saved on every referral order.
create function private.commission_hold_hours()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 720;
$$;

-- ---------------------------------------------------------------------------
-- Checkout input: the referral code and the discount the customer saw
-- ---------------------------------------------------------------------------

-- As in 20261031130000_guest_orders.sql, plus two optional fields:
--   "referral_code"  any text; normalised (private.normalize_referral_code)
--   "discount_paisa" the discount the customer saw (only with a code)
-- Without a code the result is exactly what it was before this migration.
create or replace function private.checkout_input(p_order jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  lines jsonb;
  customer jsonb := p_order -> 'customer';
  referral_code text;
  discount bigint;
  result jsonb;
begin
  if jsonb_typeof(p_order) is distinct from 'object' or jsonb_typeof(p_order -> 'lines') is distinct from 'array'
    or jsonb_typeof(customer) is distinct from 'object'
    or jsonb_array_length(p_order -> 'lines') not between 1 and 50
    or jsonb_typeof(p_order -> 'delivery_paisa') is distinct from 'number'
    or jsonb_typeof(p_order -> 'total_paisa') is distinct from 'number' then
    raise exception 'Malformed order.' using errcode = 'PT400', hint = 'invalid_order', detail = 'order';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_order -> 'lines') l
    where jsonb_typeof(l -> 'sku') is distinct from 'string'
      or char_length(l ->> 'sku') not between 1 and 64
      or jsonb_typeof(l -> 'quantity') is distinct from 'number'
      or (l ->> 'quantity') !~ '^[0-9]{1,4}$' or (l ->> 'quantity')::integer < 1
      or jsonb_typeof(l -> 'unit_price_paisa') is distinct from 'number'
      or (l ->> 'unit_price_paisa') !~ '^[0-9]{1,9}$'
  ) or (select count(distinct l ->> 'sku') from jsonb_array_elements(p_order -> 'lines') l) <> jsonb_array_length(p_order -> 'lines')
    or (p_order ->> 'delivery_paisa') !~ '^[0-9]{1,9}$' or (p_order ->> 'total_paisa') !~ '^[0-9]{1,12}$' then
    raise exception 'Malformed order lines.' using errcode = 'PT400', hint = 'invalid_order', detail = 'lines';
  end if;
  if (customer ->> 'phone') is null or (customer ->> 'phone') !~ '^\+923[0-9]{9}$' then
    raise exception 'Invalid phone.' using errcode = 'PT400', hint = 'invalid_order', detail = 'phone';
  end if;

  if jsonb_typeof(p_order -> 'referral_code') not in ('string', 'null')
    or char_length(p_order ->> 'referral_code') > 64 then
    raise exception 'Malformed referral code.' using errcode = 'PT400', hint = 'invalid_order', detail = 'referral_code';
  end if;
  referral_code := private.normalize_referral_code(p_order ->> 'referral_code');
  if p_order ? 'discount_paisa' and jsonb_typeof(p_order -> 'discount_paisa') <> 'null' then
    if jsonb_typeof(p_order -> 'discount_paisa') <> 'number' or (p_order ->> 'discount_paisa') !~ '^[0-9]{1,12}$' then
      raise exception 'Malformed discount.' using errcode = 'PT400', hint = 'invalid_order', detail = 'discount';
    end if;
    discount := (p_order ->> 'discount_paisa')::bigint;
  end if;
  if referral_code is null and coalesce(discount, 0) <> 0 then
    raise exception 'A discount needs a referral code.' using errcode = 'PT400', hint = 'invalid_order', detail = 'discount';
  end if;

  select jsonb_agg(jsonb_build_object(
           'sku', l ->> 'sku', 'quantity', (l ->> 'quantity')::integer,
           'unit_price_paisa', (l ->> 'unit_price_paisa')::integer) order by l ->> 'sku')
  into lines
  from jsonb_array_elements(p_order -> 'lines') l;

  result := jsonb_build_object(
    'lines', lines,
    'delivery_paisa', (p_order ->> 'delivery_paisa')::bigint,
    'total_paisa', (p_order ->> 'total_paisa')::bigint,
    'customer', jsonb_build_object(
      'name', private.clean_text(customer ->> 'name', 2, 80, 'name'),
      'phone', customer ->> 'phone',
      'city', private.clean_text(customer ->> 'city', 2, 60, 'city'),
      'address', private.clean_text(customer ->> 'address', 10, 300, 'address'),
      'landmark', private.clean_text(customer ->> 'landmark', 0, 100, 'landmark'),
      'note', private.clean_text(customer ->> 'note', 0, 200, 'note')
    )
  );
  if referral_code is not null then
    result := result || jsonb_build_object('referral_code', referral_code, 'discount_paisa', coalesce(discount, 0));
  end if;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Quotes with a referral code
-- ---------------------------------------------------------------------------

-- Replaced (one more argument): the old four-argument version would make
-- calls with four arguments ambiguous.
drop function private.checkout_quote(jsonb, text, public.shop_settings, boolean);

-- As in 20261117120100, plus the referral code. New fields:
--   lines[].referral_eligible  true/false while a code applies, else null
--   lines[].discount_paisa     the line's share of the discount
--   discount_paisa, merchandise_paisa (subtotal - discount)
--   referral  null without a code, else {code, status, discount_bp,
--             applies_to_sale_items}; status is ok | invalid (no such code,
--             or malformed) | disabled | no_eligible_items. Nothing about
--             the agent, and no commission.
-- total = subtotal - discount + delivery; free delivery is judged on
-- merchandise_paisa. "exact" also needs the code (if any) to apply.
create function private.checkout_quote(
  p_lines jsonb, p_city text, p_settings public.shop_settings, p_online boolean default true, p_referral_code text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  raw_lines jsonb;
  result_lines jsonb;
  subtotal bigint;
  buyable integer;
  delivery_status text;
  delivery bigint := 0;
  city_row public.delivery_cities;
  city_name text := nullif(btrim(coalesce(p_city, '')), '');
  v_code text := left(private.normalize_referral_code(p_referral_code), 32);
  agent public.sales_agents;
  referral jsonb;
  referral_ok boolean := false;
  eligible_total bigint := 0;
  discount bigint := 0;
  shares bigint[];
begin
  with requested as (
    select l ->> 'sku' as sku, (l ->> 'quantity')::integer as quantity, (l ->> 'unit_price_paisa')::integer as seen_price, n
    from jsonb_array_elements(p_lines) with ordinality as x (l, n)
  ),
  live as (
    select r.*, x.variant_id, x.size_eu, x.name, x.brand, x.item_status, x.condition, x.price_paisa, x.regular_price_paisa,
      x.on_sale,
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
        coalesce(p.sale_price_paisa, p.price_paisa) as price_paisa, p.price_paisa as regular_price_paisa,
        p.sale_price_paisa is not null as on_sale
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
      'seen_price_paisa', j.seen_price,
      -- Internal, removed below.
      '_total', case when not j.gone and j.allowed > 0 then j.allowed::bigint * j.price_paisa else 0 end,
      '_on_sale', coalesce(j.on_sale, false)
    ) order by j.n),
    coalesce(sum(j.allowed::bigint * j.price_paisa) filter (where not j.gone and j.allowed > 0), 0),
    count(*) filter (where not j.gone and j.allowed > 0)
  into raw_lines, subtotal, buyable
  from judged j;
  raw_lines := coalesce(raw_lines, '[]'::jsonb);

  -- The referral code, if any.
  if v_code is not null then
    if private.is_referral_code(v_code) then
      select * into agent from public.sales_agents a where a.code = v_code;
    end if;
    if agent.id is null then
      referral := jsonb_build_object('code', v_code, 'status', 'invalid');
    elsif not agent.code_enabled then
      referral := jsonb_build_object('code', v_code, 'status', 'disabled');
    else
      select coalesce(sum((l ->> '_total')::bigint), 0) into eligible_total
      from jsonb_array_elements(raw_lines) l
      where agent.applies_to_sale_items or not (l ->> '_on_sale')::boolean;
      referral := jsonb_build_object('code', v_code,
        'status', case when eligible_total > 0 then 'ok' else 'no_eligible_items' end,
        'discount_bp', agent.discount_bp, 'applies_to_sale_items', agent.applies_to_sale_items);
      if eligible_total > 0 then
        referral_ok := true;
        discount := private.percent_of(eligible_total, agent.discount_bp);
        select private.allocate_paisa(discount, array_agg(
                 case when agent.applies_to_sale_items or not (l ->> '_on_sale')::boolean then (l ->> '_total')::bigint else 0 end
                 order by i))
        into shares
        from jsonb_array_elements(raw_lines) with ordinality as e (l, i);
      end if;
    end if;
  end if;

  select coalesce(jsonb_agg(
    (l - '_total' - '_on_sale') || jsonb_build_object(
      'referral_eligible', case when referral_ok then agent.applies_to_sale_items or not (l ->> '_on_sale')::boolean end,
      'discount_paisa', case when referral_ok then shares[i] else 0 end)
    order by i), '[]'::jsonb)
  into result_lines
  from jsonb_array_elements(raw_lines) with ordinality as e (l, i);

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
      -- Free delivery: judged on what the customer pays for the goods, after the discount.
      if buyable = 0 or (p_settings.free_delivery_enabled and subtotal - discount >= p_settings.free_delivery_min_paisa) then
        delivery := 0;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'lines', result_lines,
    'subtotal_paisa', subtotal,
    'discount_paisa', discount,
    'merchandise_paisa', subtotal - discount,
    'referral', referral,
    'delivery_status', delivery_status,
    'delivery_paisa', delivery,
    'total_paisa', subtotal - discount + delivery,
    'free_delivery_min_paisa', case when p_settings.free_delivery_enabled then p_settings.free_delivery_min_paisa end,
    'orders_open', p_settings.orders_open,
    'exact', delivery_status = 'ok' and (v_code is null or referral_ok) and not exists (
      select 1 from jsonb_array_elements(result_lines) l
      where l ->> 'status' <> 'ok' or (l ->> 'price_changed')::boolean
    )
  );
end;
$$;

-- Replaced (one more, optional argument). The previous website calls it with
-- three named arguments, which still works.
drop function public.quote_order(text, jsonb, text);

create function public.quote_order(p_gateway_key text, p_lines jsonb, p_city text, p_referral_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.shop_settings;
  normalised jsonb;
begin
  perform private.require_gateway(p_gateway_key);
  if char_length(p_referral_code) > 64 then
    raise exception 'Malformed referral code.' using errcode = 'PT400', hint = 'invalid_order', detail = 'referral_code';
  end if;
  normalised := private.checkout_input(jsonb_build_object(
    'lines', p_lines, 'delivery_paisa', 0, 'total_paisa', 0,
    'customer', jsonb_build_object('name', 'Quote', 'phone', '+923000000000', 'city', 'Quote',
      'address', 'Quote only, not an order')));
  select * into s from public.shop_settings;
  return private.checkout_quote(normalised -> 'lines', p_city, s, true, p_referral_code);
end;
$$;

-- ---------------------------------------------------------------------------
-- What the customer sees of their order: now with the discount (never the
-- commission)
-- ---------------------------------------------------------------------------

create or replace function private.customer_order_view(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'order_number', o.order_number,
    'status', o.status,
    'payment_status', o.payment_status,
    'placed_at', o.created_at,
    'hold_expires_at', o.hold_expires_at,
    'first_name', split_part(o.customer_name, ' ', 1),
    'phone_last_digits', right(o.customer_phone, 3),
    'city', o.city,
    'courier', o.courier,
    'tracking_number', o.tracking_number,
    'subtotal_paisa', o.subtotal_paisa,
    'discount_paisa', o.discount_paisa,
    'referral_code', (select r.code from public.order_referrals r where r.order_id = o.id),
    'delivery_paisa', o.delivery_paisa,
    'total_paisa', o.total_paisa,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'name', oi.product_name, 'brand', oi.brand, 'size_eu', oi.size_eu, 'item_status', oi.item_status,
        'condition', oi.condition, 'quantity', oi.quantity, 'unit_price_paisa', oi.unit_price_paisa,
        'line_total_paisa', oi.line_total_paisa,
        'discount_paisa', coalesce((select lr.discount_paisa from public.order_line_referrals lr where lr.order_item_id = oi.id), 0))
        order by oi.line_no)
      from public.order_items oi where oi.order_id = o.id
    )
  )
  from public.orders o
  where o.id = p_order_id;
$$;

-- ---------------------------------------------------------------------------
-- Placing an order with a code
-- ---------------------------------------------------------------------------

-- Saves the referral snapshot of a new order (called by place_cod_order
-- with everything locked, after the order's items are inserted).
create function private.record_order_referral(p_order_id uuid, p_agent public.sales_agents, p_quote jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  eligible_total bigint;
  discount_total bigint;
  discount bigint := (p_quote ->> 'discount_paisa')::bigint;
  nets bigint[];
  commission bigint;
  commission_shares bigint[];
begin
  -- Per line, from the order's own items (line_no = the quote line's position).
  select coalesce(sum(oi.line_total_paisa) filter (where (q.l ->> 'referral_eligible')::boolean), 0),
         coalesce(sum((q.l ->> 'discount_paisa')::bigint), 0),
         array_agg(case when (q.l ->> 'referral_eligible')::boolean
                        then oi.line_total_paisa - (q.l ->> 'discount_paisa')::bigint else 0 end order by oi.line_no)
  into eligible_total, discount_total, nets
  from public.order_items oi
  join jsonb_array_elements(p_quote -> 'lines') with ordinality as q (l, n) on q.n = oi.line_no
  where oi.order_id = p_order_id;
  if eligible_total <= 0 or discount_total <> discount then
    raise exception 'Referral amounts don''t add up.' using errcode = 'XX000';
  end if;

  commission := private.percent_of(eligible_total - discount, p_agent.commission_bp);
  commission_shares := private.allocate_paisa(commission, nets);

  insert into public.order_referrals (order_id, agent_id, code, agent_username, terms_version, discount_bp, commission_bp,
    applies_to_sale_items, eligible_subtotal_paisa, discount_paisa, commission_basis_paisa, commission_paisa, hold_hours,
    rounding_rule)
  values (p_order_id, p_agent.id, p_agent.code, p_agent.username, p_agent.terms_version, p_agent.discount_bp,
    p_agent.commission_bp, p_agent.applies_to_sale_items, eligible_total, discount, eligible_total - discount, commission,
    private.commission_hold_hours(), 'half_up_per_order_then_largest_remainder_per_line');

  insert into public.order_line_referrals (order_item_id, order_id, line_no, eligible, line_total_paisa, discount_paisa, commission_paisa)
  select oi.id, p_order_id, oi.line_no, (q.l ->> 'referral_eligible')::boolean, oi.line_total_paisa,
    (q.l ->> 'discount_paisa')::bigint, commission_shares[oi.line_no]
  from public.order_items oi
  join jsonb_array_elements(p_quote -> 'lines') with ordinality as q (l, n) on q.n = oi.line_no
  where oi.order_id = p_order_id;
end;
$$;

-- As in 20261117120100, plus the referral code (2a: its agent row is locked
-- FOR SHARE before the quote, so its terms are the ones saved). The discount
-- the customer saw must equal the database's, like the delivery fee and
-- total; otherwise quote_changed. New result: none (the existing results
-- cover a code that no longer applies: quote_changed, with the reason in
-- quote.referral.status).
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
  v_code text;
  agent public.sales_agents;
begin
  perform private.require_gateway(p_gateway_key);
  request_hash := private.checkout_key_hash(p_request_key);
  normalised := private.checkout_input(p_order);
  fingerprint := private.fingerprint(normalised);
  v_code := normalised ->> 'referral_code';

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

  -- 2a. The code's agent: its terms stay as they are until this order commits.
  if v_code is not null and private.is_referral_code(v_code) then
    select * into agent from public.sales_agents a where a.code = v_code for share;
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
  quote := private.checkout_quote(normalised -> 'lines', normalised -> 'customer' ->> 'city', s, true, v_code);
  if not (quote ->> 'exact')::boolean
    or (quote ->> 'delivery_paisa')::bigint <> (normalised ->> 'delivery_paisa')::bigint
    or (quote ->> 'discount_paisa')::bigint <> coalesce((normalised ->> 'discount_paisa')::bigint, 0)
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
    subtotal_paisa, discount_paisa, delivery_paisa, total_paisa, hold_expires_at
  )
  values (
    'KO-' || nextval('public.order_number_seq'), 'online', 'awaiting_confirmation', 'pending', request_hash, fingerprint,
    normalised -> 'customer' ->> 'name', normalised -> 'customer' ->> 'phone', normalised -> 'customer' ->> 'city',
    normalised -> 'customer' ->> 'address', normalised -> 'customer' ->> 'landmark', normalised -> 'customer' ->> 'note',
    (quote ->> 'subtotal_paisa')::bigint, (quote ->> 'discount_paisa')::bigint, (quote ->> 'delivery_paisa')::bigint,
    (quote ->> 'total_paisa')::bigint, now() + make_interval(mins => s.hold_minutes)
  )
  returning * into new_order;

  perform private.insert_order_items(new_order.id, normalised -> 'lines');
  for item in select * from public.order_items where order_id = new_order.id order by variant_id loop
    perform private.inventory_apply(item.variant_id, -item.quantity, item.quantity, 'order_reserve',
      'reserve:' || item.id, new_order.id, item.id);
  end loop;

  if v_code is not null then
    perform private.record_order_referral(new_order.id, agent, quote);
  end if;

  insert into public.order_events (order_id, kind, to_status, to_payment, actor)
  values (new_order.id, 'placed', 'awaiting_confirmation', 'pending', 'customer');

  return jsonb_build_object('result', 'placed', 'order', private.customer_order_view(new_order.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

alter table public.order_referrals enable row level security;
alter table public.order_line_referrals enable row level security;
-- Commission is never readable through the API directly: admins and agents
-- read it through functions (20261118120200_commission_accounting.sql).
revoke all on table public.order_referrals, public.order_line_referrals from public, anon, authenticated;

revoke execute on function
  private.percent_of(bigint, integer),
  private.allocate_paisa(bigint, bigint[]),
  private.commission_hold_hours(),
  private.checkout_quote(jsonb, text, public.shop_settings, boolean, text),
  private.record_order_referral(uuid, public.sales_agents, jsonb)
  from public, anon, authenticated;

revoke execute on function public.quote_order(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.quote_order(text, jsonb, text, text) to anon;
