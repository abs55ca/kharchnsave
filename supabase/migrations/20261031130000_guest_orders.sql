-- Guest cash-on-delivery orders, admin order management, in-store sales
-- (database only) and the shop settings they depend on.
--
-- Builds on 20261031120000_inventory_ledger.sql. Ordering stays OFF
-- (shop_settings.orders_open = false) and can't be switched on until every
-- required setting has a value.
--
-- Trust boundary: the website calls the guest functions with the publishable
-- key, as the anon role, and every guest function requires the checkout
-- gateway secret, whose SHA-256 hash the owner stores in
-- private.checkout_gateway_keys. Calls made directly against the API without
-- it are refused before anything is read or locked. Everything that protects
-- stock, prices and order status is enforced here, not on the website.
--
-- Access afterwards (least privilege):
--   * anon: EXECUTE on exactly five functions (checkout_register_attempt,
--     quote_order, checkout_resolve, place_cod_order, get_customer_order),
--     each requiring the gateway secret. No table access.
--   * authenticated: table SELECT on the order tables and settings, with RLS
--     returning rows only to verified admins (member + aal2); EXECUTE on the
--     admin_* functions, which refuse anyone else. No direct writes.
--   * private.*: no access for any API role.
--
-- Locking order (every operation takes locks in this order, never upwards):
--   1. the request key (transaction advisory lock)
--   2. shop_settings (FOR SHARE to read settings, FOR UPDATE to change them)
--   3. orders (FOR UPDATE, by id; the expiry job skips locked ones)
--   4. products (FOR SHARE to sell or release; admin edits lock FOR UPDATE)
--   5. product_variants (FOR UPDATE, by id)
-- then inserts (orders, items, events, ledger), whose unique keys reject
-- duplicates.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table public.shop_settings (
  id boolean primary key default true,
  version integer not null default 1,
  -- Off until switched on by a verified admin, and only once everything
  -- below that is required has a value (see shop_settings_ready_to_open).
  orders_open boolean not null default false,
  -- null = not decided yet
  delivery_area_mode text,
  standard_delivery_fee_paisa integer,
  free_delivery_enabled boolean,
  -- Inclusive minimum item subtotal for free delivery, in paisa.
  free_delivery_min_paisa integer,
  hold_minutes integer,
  max_lines_per_order integer,
  max_units_per_order integer,
  max_units_per_line integer,
  max_open_orders_per_phone integer,
  place_attempts_per_ip_10min integer,
  place_attempts_per_ip_day integer,
  lookups_per_ip_10min integer,
  quotes_per_ip_10min integer,
  orders_per_minute_global integer,
  in_store_sells_unpublished boolean,
  updated_at timestamptz not null default now(),
  updated_by uuid,

  constraint shop_settings_single_row check (id),
  constraint shop_settings_version_positive check (version > 0),
  constraint shop_settings_delivery_area_mode_valid check (delivery_area_mode in ('nationwide', 'selected')),
  constraint shop_settings_fee_range check (standard_delivery_fee_paisa between 0 and 10000000),
  constraint shop_settings_free_min_range check (free_delivery_min_paisa between 1 and 100000000),
  constraint shop_settings_free_delivery_complete check (free_delivery_enabled is not true or free_delivery_min_paisa is not null),
  constraint shop_settings_hold_range check (hold_minutes between 15 and 10080),
  constraint shop_settings_lines_range check (max_lines_per_order between 1 and 50),
  constraint shop_settings_units_range check (max_units_per_order between 1 and 200),
  constraint shop_settings_line_units_range check (max_units_per_line between 1 and 100),
  constraint shop_settings_phone_range check (max_open_orders_per_phone between 1 and 20),
  constraint shop_settings_ip_10min_range check (place_attempts_per_ip_10min between 1 and 1000),
  constraint shop_settings_ip_day_range check (place_attempts_per_ip_day between 1 and 10000),
  constraint shop_settings_lookups_range check (lookups_per_ip_10min between 1 and 1000),
  constraint shop_settings_quotes_range check (quotes_per_ip_10min between 1 and 10000),
  constraint shop_settings_global_range check (orders_per_minute_global between 1 and 10000),
  constraint shop_settings_ready_to_open check (
    not orders_open or (
      delivery_area_mode is not null and standard_delivery_fee_paisa is not null
      and free_delivery_enabled is not null and hold_minutes is not null
      and max_lines_per_order is not null and max_units_per_order is not null
      and max_units_per_line is not null and max_open_orders_per_phone is not null
      and place_attempts_per_ip_10min is not null and place_attempts_per_ip_day is not null
      and lookups_per_ip_10min is not null and quotes_per_ip_10min is not null
      and orders_per_minute_global is not null
    )
  )
);

comment on table public.shop_settings is
  'One row. Ordering, delivery and limit settings; null means not decided yet. Changed by verified admins through admin_update_shop_settings.';
comment on column public.shop_settings.free_delivery_min_paisa is
  'Inclusive minimum item subtotal (paisa) for free delivery, e.g. 499901 for "above Rs. 4,999" or 500000 for "Rs. 5,000 and above".';

-- Confirmed by the owner: standard delivery Rs. 300 and a 24-hour hold.
-- Everything else stays undecided (null) and ordering stays off.
insert into public.shop_settings (standard_delivery_fee_paisa, hold_minutes) values (30000, 1440);

create table public.delivery_cities (
  city text primary key,
  city_key text generated always as (lower(btrim(city))) stored,
  active boolean not null default true,
  -- null = the standard fee
  fee_paisa integer,
  created_at timestamptz not null default now(),

  constraint delivery_cities_city_key_key unique (city_key),
  constraint delivery_cities_city_valid check (btrim(city) <> '' and char_length(city) <= 60 and city !~ '[[:cntrl:]]'),
  constraint delivery_cities_fee_range check (fee_paisa between 0 and 10000000)
);

comment on table public.delivery_cities is
  'Cities served when delivery_area_mode = selected; a fee here overrides the standard fee in either mode.';

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

create sequence public.order_number_seq as bigint start with 100001 minvalue 100001 no cycle;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null,
  channel text not null,
  status text not null,
  payment_status text not null,
  -- SHA-256 of the checkout key (online) or of "in_store:<request id>".
  -- The key itself is never stored; it is the customer's private order link.
  request_key_hash bytea not null,
  -- SHA-256 of the normalised order contents; the same key with different
  -- contents is refused.
  request_fingerprint bytea not null,
  customer_name text,
  customer_phone text,
  city text,
  address text,
  landmark text,
  delivery_note text,
  subtotal_paisa bigint not null,
  delivery_paisa bigint not null,
  total_paisa bigint not null,
  hold_expires_at timestamptz,
  courier text,
  tracking_number text,
  cancel_reason text,
  collected_paisa bigint,
  refunded_paisa bigint,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1,

  constraint orders_order_number_key unique (order_number),
  constraint orders_request_key_hash_key unique (request_key_hash),
  constraint orders_hashes_length check (octet_length(request_key_hash) = 32 and octet_length(request_fingerprint) = 32),
  constraint orders_channel_valid check (channel in ('online', 'in_store')),
  constraint orders_status_valid check (
    (channel = 'online' and status in (
      'awaiting_confirmation', 'confirmed', 'dispatched', 'delivery_failed', 'delivered', 'returned', 'cancelled'))
    or (channel = 'in_store' and status = 'completed')
  ),
  constraint orders_payment_status_valid check (payment_status in ('pending', 'collected', 'settled', 'refund_due', 'refunded', 'void')),
  -- Delivery and payment together. A failed delivery that may be retried
  -- keeps payment "pending"; nothing is voided until the order is closed
  -- without collection (cancelled, or returned before any payment).
  constraint orders_payment_matches_status check (
    case status
      when 'awaiting_confirmation' then payment_status = 'pending'
      when 'confirmed' then payment_status = 'pending'
      when 'dispatched' then payment_status = 'pending'
      when 'delivery_failed' then payment_status = 'pending'
      when 'delivered' then payment_status in ('pending', 'collected', 'settled')
      when 'returned' then payment_status in ('void', 'refund_due', 'refunded')
      when 'cancelled' then payment_status = 'void'
      when 'completed' then payment_status in ('collected', 'settled')
      else false
    end
  ),
  constraint orders_online_customer check (
    channel <> 'online' or (customer_name is not null and customer_phone is not null and city is not null and address is not null)
  ),
  constraint orders_phone_format check (customer_phone is null or customer_phone ~ '^\+923[0-9]{9}$'),
  constraint orders_customer_lengths check (
    (customer_name is null or char_length(customer_name) between 2 and 80)
    and (city is null or char_length(city) between 2 and 60)
    and (address is null or char_length(address) between 10 and 300)
    and (landmark is null or char_length(landmark) <= 100)
    and (delivery_note is null or char_length(delivery_note) <= 200)
    and (courier is null or char_length(courier) between 1 and 60)
    and (tracking_number is null or char_length(tracking_number) between 1 and 60)
    and (cancel_reason is null or char_length(cancel_reason) <= 40)
  ),
  constraint orders_amounts_valid check (
    subtotal_paisa >= 0 and delivery_paisa >= 0 and total_paisa = subtotal_paisa + delivery_paisa
    and (collected_paisa is null or collected_paisa between 0 and total_paisa)
    and (refunded_paisa is null or (collected_paisa is not null and refunded_paisa between 1 and collected_paisa))
  ),
  constraint orders_hold_only_while_awaiting check ((status = 'awaiting_confirmation') = (hold_expires_at is not null)),
  constraint orders_version_positive check (version > 0)
);

create index orders_status_created_idx on public.orders (status, created_at desc);
create index orders_hold_expiry_idx on public.orders (hold_expires_at) where status = 'awaiting_confirmation';
create index orders_open_phone_idx on public.orders (customer_phone) where status = 'awaiting_confirmation';

comment on table public.orders is
  'Online COD orders and in-store sales. Changed only through the order functions; never deleted.';
comment on column public.orders.payment_status is
  'What staff have recorded about money (pending, collected, settled, refund_due, refunded, void). The app never moves money.';

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  line_no smallint not null,
  -- Restrict: a size that has been sold can't be deleted.
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  -- Snapshot at the time of sale; later catalogue edits never change it.
  product_id uuid not null,
  item_code text not null,
  sku text not null,
  product_name text not null,
  brand text not null,
  colour text not null,
  item_status text not null,
  condition text not null,
  size_eu numeric(3, 1) not null,
  unit_price_paisa integer not null,
  quantity integer not null,
  line_total_paisa bigint generated always as (unit_price_paisa::bigint * quantity) stored,

  constraint order_items_line_key unique (order_id, line_no),
  constraint order_items_variant_once_key unique (order_id, variant_id),
  constraint order_items_quantity_valid check (quantity between 1 and 9999),
  constraint order_items_price_valid check (unit_price_paisa between 0 and 100000000)
);

create index order_items_variant_idx on public.order_items (variant_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete restrict,
  kind text not null,
  from_status text,
  to_status text,
  from_payment text,
  to_payment text,
  actor text not null,
  actor_user_id uuid,
  -- The admin action's request id: a retry of the same action is recognised
  -- and not applied twice.
  request_id uuid,
  note text,
  details jsonb,
  created_at timestamptz not null default now(),

  constraint order_events_request_key unique (order_id, request_id),
  constraint order_events_kind_valid check (kind in (
    'placed', 'confirmed', 'cancelled', 'expired', 'dispatched', 'redispatched', 'delivered',
    'delivery_failed', 'returned', 'payment_collected', 'payment_settled', 'refund_recorded', 'note', 'sale'
  )),
  constraint order_events_actor_valid check (actor in ('customer', 'admin', 'system')),
  constraint order_events_note_length check (note is null or char_length(note) <= 1000)
);

create index order_events_order_idx on public.order_events (order_id, id);

create table public.order_return_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  order_item_id uuid not null references public.order_items (id) on delete restrict,
  quantity integer not null,
  outcome text not null,
  note text,
  request_id uuid not null,
  actor_user_id uuid,
  created_at timestamptz not null default now(),

  constraint order_return_lines_request_key unique (request_id, order_item_id, outcome),
  constraint order_return_lines_quantity_valid check (quantity between 1 and 9999),
  constraint order_return_lines_outcome_valid check (outcome in ('restock', 'write_off')),
  constraint order_return_lines_note_length check (note is null or char_length(note) <= 500)
);

-- The ledger can now point at orders, items and return lines.
alter table public.stock_movements
  add constraint stock_movements_order_fkey foreign key (order_id) references public.orders (id),
  add constraint stock_movements_order_item_fkey foreign key (order_item_id) references public.order_items (id),
  add constraint stock_movements_return_line_fkey foreign key (return_line_id) references public.order_return_lines (id);

create index stock_movements_order_idx on public.stock_movements (order_id) where order_id is not null;

-- ---------------------------------------------------------------------------
-- Private tables: gateway secret, abandoned checkout keys, rate limits, job health
-- ---------------------------------------------------------------------------

create table private.checkout_gateway_keys (
  key_hash bytea primary key,
  label text not null,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint checkout_gateway_keys_hash_length check (octet_length(key_hash) = 32),
  constraint checkout_gateway_keys_label_length check (char_length(label) between 1 and 60)
);

comment on table private.checkout_gateway_keys is
  'SHA-256 hashes of the website''s checkout gateway secret. Add the new hash, deploy, then set retired_at on the old one.';

-- A checkout key the customer's browser gave up on (after changing the cart).
-- No order can ever be placed with it afterwards.
create table private.checkout_abandoned_keys (
  key_hash bytea primary key,
  created_at timestamptz not null default now()
);

create table private.rate_limit_buckets (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null,
  primary key (bucket, window_start)
);

create table private.job_heartbeats (
  job text primary key,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  last_released integer not null default 0
);

revoke all on table private.checkout_gateway_keys, private.checkout_abandoned_keys,
  private.rate_limit_buckets, private.job_heartbeats from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

create trigger order_events_append_only before update or delete on public.order_events
  for each row execute function private.append_only();
create trigger order_events_no_truncate before truncate on public.order_events
  for each statement execute function private.append_only();
create trigger order_items_append_only before update or delete on public.order_items
  for each row execute function private.append_only();
create trigger order_items_no_truncate before truncate on public.order_items
  for each statement execute function private.append_only();
create trigger order_return_lines_append_only before update or delete on public.order_return_lines
  for each row execute function private.append_only();
create trigger order_return_lines_no_truncate before truncate on public.order_return_lines
  for each statement execute function private.append_only();
create trigger orders_no_truncate before truncate on public.orders
  for each statement execute function private.append_only();

-- Allowed changes of an order: the status and payment graphs, fixed facts,
-- and the version counter.
create function private.orders_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Orders are never deleted.' using errcode = 'PT400', hint = 'append_only';
  end if;
  if (new.id, new.order_number, new.channel, new.request_key_hash, new.request_fingerprint,
      new.subtotal_paisa, new.delivery_paisa, new.total_paisa, new.created_at)
     is distinct from
     (old.id, old.order_number, old.channel, old.request_key_hash, old.request_fingerprint,
      old.subtotal_paisa, old.delivery_paisa, old.total_paisa, old.created_at) then
    raise exception 'An order''s number, contents and totals never change.' using errcode = 'PT400', hint = 'order_locked';
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

create trigger orders_guard before update or delete on public.orders
  for each row execute function private.orders_guard();

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- The website's gateway secret, checked before anything else.
create function private.require_gateway(p_key text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_key is null or char_length(p_key) not between 32 and 200 or not exists (
    select 1 from private.checkout_gateway_keys k
    where k.key_hash = sha256(convert_to(p_key, 'UTF8')) and k.retired_at is null
  ) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
end;
$$;

-- A checkout key is 32 random bytes from the customer's browser, base64url
-- (43 characters). Returns its SHA-256.
create function private.checkout_key_hash(p_key text)
returns bytea
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'Malformed checkout key.' using errcode = 'PT400', hint = 'invalid_key';
  end if;
  return sha256(convert_to(p_key, 'UTF8'));
end;
$$;

-- Serialises everything done with one key (level 1 of the locking order).
create function private.lock_key(p_hash bytea)
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(('x' || encode(substring(p_hash from 1 for 8), 'hex'))::bit(64)::bigint);
$$;

create function private.clean_text(p_value text, p_min integer, p_max integer, p_field text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  cleaned text := nullif(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g'), '');
begin
  if cleaned is null then
    if p_min > 0 then
      raise exception 'Missing %.', p_field using errcode = 'PT400', hint = 'invalid_order', detail = p_field;
    end if;
    return null;
  end if;
  if char_length(cleaned) not between greatest(p_min, 1) and p_max or cleaned ~ '[[:cntrl:]]' then
    raise exception 'Invalid %.', p_field using errcode = 'PT400', hint = 'invalid_order', detail = p_field;
  end if;
  return cleaned;
end;
$$;

-- Validates an online order request and returns it normalised (lines sorted
-- by SKU), so equal orders have equal fingerprints.
--   {"lines": [{"sku": "...", "quantity": 1, "unit_price_paisa": 245000}],
--    "delivery_paisa": 30000, "total_paisa": 275000,
--    "customer": {"name", "phone": "+923001234567", "city", "address", "landmark", "note"}}
create function private.checkout_input(p_order jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  lines jsonb;
  customer jsonb := p_order -> 'customer';
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

  select jsonb_agg(jsonb_build_object(
           'sku', l ->> 'sku', 'quantity', (l ->> 'quantity')::integer,
           'unit_price_paisa', (l ->> 'unit_price_paisa')::integer) order by l ->> 'sku')
  into lines
  from jsonb_array_elements(p_order -> 'lines') l;

  return jsonb_build_object(
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
end;
$$;

create function private.fingerprint(p_value jsonb)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select sha256(convert_to(p_value::text, 'UTF8'));
$$;

-- Live prices and availability for a set of lines [{sku, quantity,
-- unit_price_paisa}], and the delivery fee. Pairs held by unconfirmed orders
-- whose hold has expired count as available (they are released before any
-- sale). p_online: only published products are for sale online.
create function private.checkout_quote(p_lines jsonb, p_city text, p_settings public.shop_settings, p_online boolean default true)
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
    select r.*, v.id as variant_id, v.size_eu, p.name, p.brand, p.item_status, p.condition, p.price_paisa,
      case
        when v.id is null then 0
        when p_online and p.publication_status <> 'published' then 0
        else v.stock + coalesce((
          select sum(oi.quantity)::integer from public.order_items oi
          join public.orders o on o.id = oi.order_id
          where oi.variant_id = v.id and o.status = 'awaiting_confirmation' and o.hold_expires_at <= now()
        ), 0)
      end as available,
      v.id is null or (p_online and p.publication_status <> 'published') as gone
    from requested r
    left join public.product_variants v on v.sku = r.sku
    left join public.products p on p.id = v.product_id
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

-- Locks the products (shared) and sizes (for update) behind a set of sizes,
-- in id order: levels 4 and 5 of the locking order.
create function private.lock_inventory(p_variant_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.products p
  where p.id in (select v.product_id from public.product_variants v where v.id = any(p_variant_ids))
  order by p.id
  for share;
  perform 1 from public.product_variants v
  where v.id = any(p_variant_ids)
  order by v.id
  for update;
end;
$$;

-- Before selling these sizes: locks the unconfirmed orders on them whose hold
-- has expired, then the products and sizes of both, in the locking order.
-- Returns the expired orders' ids, for the caller to release.
--
-- It WAITS for an expired order another transaction holds (the expiry job, an
-- admin confirming or cancelling it) rather than skipping it: a skipped order
-- would still hold its pairs while the quote counted them as available. When
-- the other transaction commits, the order is re-checked (it may be released
-- or confirmed by then). Waiting here can't deadlock: this caller holds no
-- product or size locks yet, and everyone takes orders before those.
create function private.lock_for_sale(p_variant_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired uuid[];
begin
  select coalesce(array_agg(id order by id), '{}') into expired from (
    select o.id from public.orders o
    where o.status = 'awaiting_confirmation' and o.hold_expires_at <= now()
      and exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.variant_id = any(p_variant_ids))
    order by o.id
    for update
  ) x;
  perform private.lock_inventory(p_variant_ids || coalesce(
    (select array_agg(oi.variant_id) from public.order_items oi where oi.order_id = any(expired)), '{}'));
  return expired;
end;
$$;

-- Releases every held pair of an unconfirmed or confirmed order and cancels
-- it, all in one go. Returns false (and changes nothing) if the order is no
-- longer open. Locks the order, then its products and sizes.
create function private.release_order(
  p_order_id uuid,
  p_expired boolean,
  p_actor text,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_reason text,
  p_note text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_order public.orders;
  item public.order_items;
begin
  select * into current_order from public.orders where id = p_order_id for update;
  if not found or current_order.status not in ('awaiting_confirmation', 'confirmed') then
    return false;
  end if;
  perform private.lock_inventory(array(select oi.variant_id from public.order_items oi where oi.order_id = p_order_id));

  for item in select * from public.order_items where order_id = p_order_id order by variant_id loop
    perform private.inventory_apply(item.variant_id, item.quantity, -item.quantity, 'order_release',
      'release:' || item.id, current_order.id, item.id);
  end loop;

  update public.orders set
    status = 'cancelled', payment_status = 'void', hold_expires_at = null,
    closed_at = now(), cancel_reason = p_reason
  where id = p_order_id;

  insert into public.order_events (order_id, kind, from_status, to_status, from_payment, to_payment,
    actor, actor_user_id, request_id, note, details)
  values (p_order_id, case when p_expired then 'expired' else 'cancelled' end, current_order.status, 'cancelled',
    current_order.payment_status, 'void', p_actor, p_actor_user_id, p_request_id, p_note,
    jsonb_build_object('reason', p_reason));
  return true;
end;
$$;

-- Releases expired holds: the scheduled job (pg_cron, every minute) and the
-- admin "release expired holds now" button. Up to p_limit orders per run;
-- each order is released whole, or not at all.
--
-- Failure reporting survives a rolled-back run: the work happens inside an
-- inner block (a subtransaction); if it fails, only that work is undone and
-- the failure is still written to private.job_heartbeats by the outer block,
-- which commits. A run that is killed outright leaves last_succeeded_at
-- stale, which admin_order_health reports.
create function private.expire_order_holds(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  started timestamptz := clock_timestamp();
  ids uuid[];
  expired_id uuid;
  released integer := 0;
  failures integer := 0;
  first_error text;
begin
  insert into private.job_heartbeats (job, last_started_at) values ('expire_order_holds', started)
  on conflict (job) do update set last_started_at = excluded.last_started_at;

  begin
    select coalesce(array_agg(id order by id), '{}') into ids from (
      select o.id from public.orders o
      where o.status = 'awaiting_confirmation' and o.hold_expires_at <= now()
      order by o.id
      limit greatest(coalesce(p_limit, 50), 1)
      for update skip locked
    ) x;
    perform private.lock_inventory(array(select oi.variant_id from public.order_items oi where oi.order_id = any(ids)));

    foreach expired_id in array ids loop
      begin
        if private.release_order(expired_id, true, 'system', null, null, 'hold_expired', null) then
          released := released + 1;
        end if;
      exception when others then
        failures := failures + 1;
        first_error := coalesce(first_error, sqlstate || ' ' || left(sqlerrm, 200));
      end;
    end loop;

    -- Housekeeping.
    delete from private.rate_limit_buckets where window_start < now() - interval '2 days';
    delete from private.checkout_abandoned_keys where created_at < now() - interval '30 days';
  exception when others then
    failures := failures + 1;
    first_error := coalesce(first_error, sqlstate || ' ' || left(sqlerrm, 200));
  end;

  update private.job_heartbeats set
    last_finished_at = clock_timestamp(),
    last_succeeded_at = case when failures = 0 then clock_timestamp() else last_succeeded_at end,
    last_failed_at = case when failures > 0 then clock_timestamp() else last_failed_at end,
    last_error = case when failures > 0 then first_error else last_error end,
    consecutive_failures = case when failures > 0 then consecutive_failures + 1 else 0 end,
    last_released = released
  where job = 'expire_order_holds';

  return jsonb_build_object('released', released, 'failed', failures);
end;
$$;

-- Counts one hit in a fixed window; true while within the limit.
create function private.rate_limit_hit(p_bucket text, p_window interval, p_limit integer)
returns boolean
language sql
security definer
set search_path = ''
as $$
  insert into private.rate_limit_buckets as b (bucket, window_start, hits)
  values (p_bucket, date_bin(p_window, now(), timestamptz '2000-01-01 00:00:00+00'), 1)
  on conflict (bucket, window_start) do update set hits = b.hits + 1
  returning hits <= p_limit;
$$;

-- What a customer may see of their order: no address, a masked phone number
-- and their first name only.
create function private.customer_order_view(p_order_id uuid)
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
    'delivery_paisa', o.delivery_paisa,
    'total_paisa', o.total_paisa,
    'items', (
      select jsonb_agg(jsonb_build_object(
        'name', oi.product_name, 'brand', oi.brand, 'size_eu', oi.size_eu, 'item_status', oi.item_status,
        'condition', oi.condition, 'quantity', oi.quantity, 'unit_price_paisa', oi.unit_price_paisa,
        'line_total_paisa', oi.line_total_paisa) order by oi.line_no)
      from public.order_items oi where oi.order_id = o.id
    )
  )
  from public.orders o
  where o.id = p_order_id;
$$;

-- Inserts an order's items as a snapshot of the (locked) catalogue rows.
create function private.insert_order_items(p_order_id uuid, p_lines jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.order_items (
    order_id, line_no, variant_id, product_id, item_code, sku, product_name, brand, colour,
    item_status, condition, size_eu, unit_price_paisa, quantity
  )
  select p_order_id, x.n, v.id, p.id, p.item_code, v.sku, p.name, p.brand, p.colour,
         p.item_status, p.condition, v.size_eu, p.price_paisa, (x.l ->> 'quantity')::integer
  from jsonb_array_elements(p_lines) with ordinality as x (l, n)
  join public.product_variants v on v.sku = x.l ->> 'sku'
  join public.products p on p.id = v.product_id;
$$;

-- ---------------------------------------------------------------------------
-- Guest functions (anon, gateway secret required)
-- ---------------------------------------------------------------------------

-- Counts a checkout attempt, an order lookup or a price quote against the rate limits, in
-- its own transaction (so refused attempts still count). p_client is
-- "ip:<64 hex>", an HMAC of the visitor's IP made by the website, or null when
-- the website can't determine a trustworthy IP (one shared, strict bucket).
create function public.checkout_register_attempt(p_gateway_key text, p_client text, p_kind text)
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
    if s.place_attempts_per_ip_10min is null or s.place_attempts_per_ip_day is null or s.orders_per_minute_global is null then
      return jsonb_build_object('allowed', false, 'reason', 'not_configured');
    end if;
    allowed := private.rate_limit_hit('place:10m:' || client, interval '10 minutes', s.place_attempts_per_ip_10min);
    allowed := private.rate_limit_hit('place:1d:' || client, interval '1 day', s.place_attempts_per_ip_day) and allowed;
    allowed := private.rate_limit_hit('place:1m:global', interval '1 minute', s.orders_per_minute_global) and allowed;
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

-- Live prices, availability and delivery for the checkout page. Read-only.
create function public.quote_order(p_gateway_key text, p_lines jsonb, p_city text)
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
  normalised := private.checkout_input(jsonb_build_object(
    'lines', p_lines, 'delivery_paisa', 0, 'total_paisa', 0,
    'customer', jsonb_build_object('name', 'Quote', 'phone', '+923000000000', 'city', 'Quote',
      'address', 'Quote only, not an order')));
  select * into s from public.shop_settings;
  return private.checkout_quote(normalised -> 'lines', p_city, s);
end;
$$;

-- Settles what happened to a checkout key, waiting for any request with the
-- same key that is still running:
--   placed     an order exists ("matches" compares p_order, if given)
--   abandoned  the key was given up; no order can be placed with it
--   none       no order yet. With p_abandon, the key is given up now, so a
--              late or repeated request can never place an order with it.
create function public.checkout_resolve(p_gateway_key text, p_request_key text, p_order jsonb default null, p_abandon boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  request_hash bytea;
  existing public.orders;
begin
  perform private.require_gateway(p_gateway_key);
  request_hash := private.checkout_key_hash(p_request_key);
  perform private.lock_key(request_hash);

  select * into existing from public.orders o where o.request_key_hash = request_hash and o.channel = 'online';
  if found then
    return jsonb_build_object('state', 'placed',
      'matches', case when p_order is null then null
                      else existing.request_fingerprint = private.fingerprint(private.checkout_input(p_order)) end,
      'order', private.customer_order_view(existing.id));
  end if;
  if exists (select 1 from private.checkout_abandoned_keys a where a.key_hash = request_hash) then
    return jsonb_build_object('state', 'abandoned');
  end if;
  if coalesce(p_abandon, false) then
    insert into private.checkout_abandoned_keys (key_hash) values (request_hash);
    return jsonb_build_object('state', 'abandoned');
  end if;
  return jsonb_build_object('state', 'none');
end;
$$;

-- Places a cash-on-delivery order, all or nothing. Prices, availability,
-- delivery and totals are recalculated here from the locked catalogue rows;
-- the request only says what the customer saw, so a difference returns
-- "quote_changed" with the new quote instead of an order.
--
-- Results: placed | existing (same key, same contents: the earlier order) |
-- mismatch (same key, different contents) | abandoned | closed | limits |
-- phone_limit | quote_changed.
create function public.place_cod_order(p_gateway_key text, p_request_key text, p_order jsonb)
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
      where o.status = 'awaiting_confirmation' and o.customer_phone = normalised -> 'customer' ->> 'phone') >= s.max_open_orders_per_phone then
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

-- The customer's own order, by its private key. Null if there is none.
create function public.get_customer_order(p_gateway_key text, p_request_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_id uuid;
begin
  perform private.require_gateway(p_gateway_key);
  select o.id into found_id from public.orders o
  where o.request_key_hash = private.checkout_key_hash(p_request_key) and o.channel = 'online';
  return case when found_id is null then null else private.customer_order_view(found_id) end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin functions (authenticated; each refuses anyone but a verified admin)
-- ---------------------------------------------------------------------------

-- Locks an order for an admin action. Returns null if this request was
-- already applied (a retry); otherwise checks the version the admin saw.
create function private.admin_order_lock(p_order_id uuid, p_expected_version integer, p_request_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_order public.orders;
begin
  perform public.admin_require_catalogue_admin();
  if p_order_id is null or p_request_id is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  select * into current_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.order_events e where e.order_id = p_order_id and e.request_id = p_request_id) then
    return null;
  end if;
  if p_expected_version is distinct from current_order.version then
    raise exception 'This order was changed somewhere else since you opened it.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;
  return current_order;
end;
$$;

create function private.admin_result(p_order_id uuid, p_result text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('result', p_result, 'id', o.id, 'version', o.version, 'status', o.status,
    'payment_status', o.payment_status)
  from public.orders o where o.id = p_order_id;
$$;

create function public.admin_confirm_order(p_order_id uuid, p_expected_version integer, p_request_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_order public.orders := private.admin_order_lock(p_order_id, p_expected_version, p_request_id);
begin
  if current_order is null then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  if current_order.status <> 'awaiting_confirmation' then
    raise exception 'Only an order awaiting confirmation can be confirmed.' using errcode = 'PT409', hint = 'bad_transition';
  end if;
  -- Too late: the hold has run out. Release it now (kept), and say so.
  if current_order.hold_expires_at <= now() then
    perform private.release_order(p_order_id, true, 'system', null, null, 'hold_expired', null);
    return private.admin_result(p_order_id, 'expired');
  end if;
  update public.orders set status = 'confirmed', hold_expires_at = null, confirmed_at = now() where id = p_order_id;
  insert into public.order_events (order_id, kind, from_status, to_status, actor, actor_user_id, request_id, note)
  values (p_order_id, 'confirmed', 'awaiting_confirmation', 'confirmed', 'admin', (select auth.uid()), p_request_id,
    private.clean_text(p_note, 0, 1000, 'note'));
  return private.admin_result(p_order_id, 'done');
end;
$$;

create function public.admin_cancel_order(p_order_id uuid, p_expected_version integer, p_request_id uuid, p_reason text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_order public.orders := private.admin_order_lock(p_order_id, p_expected_version, p_request_id);
begin
  if current_order is null then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  if p_reason is null or p_reason not in ('customer_request', 'unreachable', 'spam', 'out_of_stock', 'other') then
    raise exception 'Choose a reason.' using errcode = 'PT400', hint = 'invalid_reason';
  end if;
  if current_order.status not in ('awaiting_confirmation', 'confirmed') then
    raise exception 'A dispatched order can''t be cancelled; record a failed delivery and receive the return.'
      using errcode = 'PT409', hint = 'bad_transition';
  end if;
  perform private.release_order(p_order_id, false, 'admin', (select auth.uid()), p_request_id, p_reason,
    private.clean_text(p_note, 0, 1000, 'note'));
  return private.admin_result(p_order_id, 'done');
end;
$$;

create function public.admin_dispatch_order(
  p_order_id uuid, p_expected_version integer, p_request_id uuid, p_courier text, p_tracking_number text, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_order public.orders := private.admin_order_lock(p_order_id, p_expected_version, p_request_id);
  item public.order_items;
  new_courier text;
  new_tracking text;
begin
  if current_order is null then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  new_courier := private.clean_text(p_courier, 1, 60, 'courier');
  new_tracking := private.clean_text(p_tracking_number, 0, 60, 'tracking number');

  if current_order.status = 'confirmed' then
    -- The parcel leaves the shop: its pairs stop being held.
    perform private.lock_inventory(array(select oi.variant_id from public.order_items oi where oi.order_id = p_order_id));
    for item in select * from public.order_items where order_id = p_order_id order by variant_id loop
      perform private.inventory_apply(item.variant_id, 0, -item.quantity, 'order_dispatch',
        'dispatch:' || item.id, p_order_id, item.id);
    end loop;
  elsif current_order.status <> 'delivery_failed' then
    raise exception 'Only a confirmed order (or a failed delivery being retried) can be dispatched.'
      using errcode = 'PT409', hint = 'bad_transition';
  end if;

  update public.orders set status = 'dispatched', courier = new_courier,
    tracking_number = new_tracking, dispatched_at = now()
  where id = p_order_id;
  insert into public.order_events (order_id, kind, from_status, to_status, actor, actor_user_id, request_id, note, details)
  values (p_order_id, case when current_order.status = 'confirmed' then 'dispatched' else 'redispatched' end,
    current_order.status, 'dispatched', 'admin', (select auth.uid()), p_request_id,
    private.clean_text(p_note, 0, 1000, 'note'), jsonb_build_object('courier', new_courier, 'tracking_number', new_tracking));
  return private.admin_result(p_order_id, 'done');
end;
$$;

-- Delivered. With p_cash_collected, the courier collected the full total (COD).
create function public.admin_mark_delivered(
  p_order_id uuid, p_expected_version integer, p_request_id uuid, p_cash_collected boolean, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_order public.orders := private.admin_order_lock(p_order_id, p_expected_version, p_request_id);
  collected boolean := coalesce(p_cash_collected, false);
begin
  if current_order is null then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  if current_order.status not in ('dispatched', 'delivery_failed') then
    raise exception 'Only a dispatched order can be marked delivered.' using errcode = 'PT409', hint = 'bad_transition';
  end if;
  update public.orders set status = 'delivered', delivered_at = now(),
    payment_status = case when collected then 'collected' else payment_status end,
    collected_paisa = case when collected then total_paisa else collected_paisa end
  where id = p_order_id;
  insert into public.order_events (order_id, kind, from_status, to_status, from_payment, to_payment,
    actor, actor_user_id, request_id, note)
  values (p_order_id, 'delivered', current_order.status, 'delivered', current_order.payment_status,
    case when collected then 'collected' else current_order.payment_status end,
    'admin', (select auth.uid()), p_request_id, private.clean_text(p_note, 0, 1000, 'note'));
  return private.admin_result(p_order_id, 'done');
end;
$$;

-- The courier couldn't deliver. Payment stays pending: the delivery may be
-- retried (dispatch again) or the parcel comes back (receive return).
create function public.admin_mark_delivery_failed(p_order_id uuid, p_expected_version integer, p_request_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_order public.orders := private.admin_order_lock(p_order_id, p_expected_version, p_request_id);
begin
  if current_order is null then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  if current_order.status <> 'dispatched' then
    raise exception 'Only a dispatched order can fail delivery.' using errcode = 'PT409', hint = 'bad_transition';
  end if;
  update public.orders set status = 'delivery_failed' where id = p_order_id;
  insert into public.order_events (order_id, kind, from_status, to_status, actor, actor_user_id, request_id, note)
  values (p_order_id, 'delivery_failed', 'dispatched', 'delivery_failed', 'admin', (select auth.uid()), p_request_id,
    private.clean_text(p_note, 0, 1000, 'note'));
  return private.admin_result(p_order_id, 'done');
end;
$$;

-- The whole parcel is back at the shop and checked. p_lines covers every
-- item: [{"order_item_id": "...", "restock": 1, "write_off": 0}]. Restocked
-- pairs become available again; written-off pairs are recorded only.
create function public.admin_receive_return(
  p_order_id uuid, p_expected_version integer, p_request_id uuid, p_lines jsonb, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_order public.orders := private.admin_order_lock(p_order_id, p_expected_version, p_request_id);
  item public.order_items;
  submitted jsonb;
  restock integer;
  write_off integer;
  line_id uuid;
  new_payment text;
begin
  if current_order is null then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  if current_order.status not in ('delivery_failed', 'delivered') then
    raise exception 'Only a failed or delivered order can be returned.' using errcode = 'PT409', hint = 'bad_transition';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array'
    or jsonb_array_length(p_lines) <> (select count(*) from public.order_items where order_id = p_order_id) then
    raise exception 'Account for every item in the parcel.' using errcode = 'PT400', hint = 'invalid_return';
  end if;

  perform private.lock_inventory(array(select oi.variant_id from public.order_items oi where oi.order_id = p_order_id));
  for item in select * from public.order_items where order_id = p_order_id order by line_no loop
    select l into submitted from jsonb_array_elements(p_lines) l where l ->> 'order_item_id' = item.id::text limit 1;
    if submitted is null or coalesce(submitted ->> 'restock', '') !~ '^[0-9]{1,4}$'
      or coalesce(submitted ->> 'write_off', '') !~ '^[0-9]{1,4}$' then
      raise exception 'Account for every item in the parcel.' using errcode = 'PT400', hint = 'invalid_return';
    end if;
    restock := (submitted ->> 'restock')::integer;
    write_off := (submitted ->> 'write_off')::integer;
    if restock + write_off <> item.quantity then
      raise exception 'Restocked and written-off pairs must add up to the quantity sold.'
        using errcode = 'PT400', hint = 'invalid_return';
    end if;
    if restock > 0 then
      insert into public.order_return_lines (order_id, order_item_id, quantity, outcome, request_id, actor_user_id)
      values (p_order_id, item.id, restock, 'restock', p_request_id, (select auth.uid()))
      returning id into line_id;
      perform private.inventory_apply(item.variant_id, restock, 0, 'return_restock', 'restock:' || line_id,
        p_order_id, item.id, line_id);
    end if;
    if write_off > 0 then
      insert into public.order_return_lines (order_id, order_item_id, quantity, outcome, request_id, actor_user_id)
      values (p_order_id, item.id, write_off, 'write_off', p_request_id, (select auth.uid()))
      returning id into line_id;
      perform private.inventory_apply(item.variant_id, 0, 0, 'return_write_off', 'writeoff:' || line_id,
        p_order_id, item.id, line_id, write_off || ' written off');
    end if;
  end loop;

  new_payment := case current_order.payment_status when 'pending' then 'void' else 'refund_due' end;
  update public.orders set status = 'returned', payment_status = new_payment, closed_at = now() where id = p_order_id;
  insert into public.order_events (order_id, kind, from_status, to_status, from_payment, to_payment,
    actor, actor_user_id, request_id, note, details)
  values (p_order_id, 'returned', current_order.status, 'returned', current_order.payment_status, new_payment,
    'admin', (select auth.uid()), p_request_id, private.clean_text(p_note, 0, 1000, 'note'), p_lines);
  return private.admin_result(p_order_id, 'done');
end;
$$;

-- Records money that changed hands outside the app:
--   collected  the customer paid (delivered order; the full total)
--   settled    the courier paid the shop (reference)
--   refunded   a refund was made (returned order; amount up to what was collected)
create function public.admin_record_payment(
  p_order_id uuid, p_expected_version integer, p_request_id uuid, p_action text,
  p_amount_paisa bigint, p_reference text default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_order public.orders := private.admin_order_lock(p_order_id, p_expected_version, p_request_id);
  next_payment text;
  reference text := private.clean_text(p_reference, 0, 100, 'reference');
begin
  if current_order is null then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  if p_action = 'collected' and current_order.payment_status = 'pending' and current_order.status = 'delivered' then
    if p_amount_paisa is distinct from current_order.total_paisa then
      raise exception 'Cash on delivery collects the full total.' using errcode = 'PT400', hint = 'invalid_amount';
    end if;
    next_payment := 'collected';
    update public.orders set payment_status = next_payment, collected_paisa = p_amount_paisa where id = p_order_id;
  elsif p_action = 'settled' and current_order.payment_status = 'collected' and current_order.status = 'delivered' then
    next_payment := 'settled';
    update public.orders set payment_status = next_payment where id = p_order_id;
  elsif p_action = 'refunded' and current_order.payment_status = 'refund_due' then
    if p_amount_paisa is null or p_amount_paisa < 1 or p_amount_paisa > current_order.collected_paisa then
      raise exception 'A refund is between Rs. 0.01 and the amount collected.' using errcode = 'PT400', hint = 'invalid_amount';
    end if;
    next_payment := 'refunded';
    update public.orders set payment_status = next_payment, refunded_paisa = p_amount_paisa where id = p_order_id;
  else
    raise exception 'That payment record doesn''t fit this order''s state.' using errcode = 'PT409', hint = 'bad_payment_transition';
  end if;
  insert into public.order_events (order_id, kind, from_payment, to_payment, actor, actor_user_id, request_id, note, details)
  values (p_order_id,
    case p_action when 'collected' then 'payment_collected' when 'settled' then 'payment_settled' else 'refund_recorded' end,
    current_order.payment_status, next_payment, 'admin', (select auth.uid()), p_request_id,
    private.clean_text(p_note, 0, 1000, 'note'),
    jsonb_build_object('amount_paisa', p_amount_paisa, 'reference', reference));
  return private.admin_result(p_order_id, 'done');
end;
$$;

create function public.admin_add_order_note(p_order_id uuid, p_request_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
begin
  perform public.admin_require_catalogue_admin();
  if p_order_id is null or p_request_id is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  -- A note doesn't depend on the order's version; it is added to whatever is current.
  perform 1 from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'PT404';
  end if;
  if exists (select 1 from public.order_events e where e.order_id = p_order_id and e.request_id = p_request_id) then
    return private.admin_result(p_order_id, 'replayed');
  end if;
  insert into public.order_events (order_id, kind, actor, actor_user_id, request_id, note)
  values (p_order_id, 'note', 'admin', (select auth.uid()), p_request_id, private.clean_text(p_note, 1, 1000, 'note'));
  return private.admin_result(p_order_id, 'done');
end;
$$;

-- An in-store sale (no screens yet). Same stock rules as online orders.
-- p_lines: [{"sku": "...", "quantity": 1, "unit_price_paisa": 245000}] at the
-- prices on the label; a different current price returns quote_changed.
create function public.admin_record_in_store_sale(p_request_id uuid, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  normalised jsonb;
  request_hash bytea;
  fingerprint bytea;
  existing public.orders;
  s public.shop_settings;
  variant_ids uuid[];
  expired uuid[];
  expired_id uuid;
  quote jsonb;
  new_order public.orders;
  item public.order_items;
begin
  perform public.admin_require_catalogue_admin();
  if p_request_id is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  normalised := private.checkout_input(jsonb_build_object(
    'lines', p_lines, 'delivery_paisa', 0, 'total_paisa', 0,
    'customer', jsonb_build_object('name', 'In store', 'phone', '+923000000000', 'city', 'In store',
      'address', 'Sold in the shop')));
  request_hash := sha256(convert_to('in_store:' || p_request_id, 'UTF8'));
  fingerprint := private.fingerprint(normalised -> 'lines');

  perform private.lock_key(request_hash);
  select * into existing from public.orders o where o.request_key_hash = request_hash;
  if found then
    if existing.request_fingerprint = fingerprint then
      return jsonb_build_object('result', 'existing', 'id', existing.id, 'order_number', existing.order_number);
    end if;
    return jsonb_build_object('result', 'mismatch');
  end if;

  select * into s from public.shop_settings for share;
  select coalesce(array_agg(v.id), '{}') into variant_ids
  from public.product_variants v
  where v.sku in (select l ->> 'sku' from jsonb_array_elements(normalised -> 'lines') l);
  expired := private.lock_for_sale(variant_ids);
  foreach expired_id in array expired loop
    perform private.release_order(expired_id, true, 'system', null, null, 'hold_expired', null);
  end loop;

  -- Unpublished products: only if the owner has decided they may be sold in
  -- the shop (undecided = refused).
  if exists (
    select 1 from public.product_variants v join public.products p on p.id = v.product_id
    where v.id = any(variant_ids) and p.publication_status <> 'published'
  ) and s.in_store_sells_unpublished is not true then
    raise exception 'Unpublished products can''t be sold in the shop (not decided yet).'
      using errcode = 'PT409', hint = 'in_store_unpublished';
  end if;

  quote := private.checkout_quote(normalised -> 'lines', null, s, false);
  if exists (
    select 1 from jsonb_array_elements(quote -> 'lines') l
    where l ->> 'status' <> 'ok' or (l ->> 'price_changed')::boolean
  ) then
    return jsonb_build_object('result', 'quote_changed', 'quote', quote);
  end if;

  insert into public.orders (
    order_number, channel, status, payment_status, request_key_hash, request_fingerprint,
    subtotal_paisa, delivery_paisa, total_paisa, collected_paisa, closed_at
  )
  values (
    'KO-' || nextval('public.order_number_seq'), 'in_store', 'completed', 'collected', request_hash, fingerprint,
    (quote ->> 'subtotal_paisa')::bigint, 0, (quote ->> 'subtotal_paisa')::bigint, (quote ->> 'subtotal_paisa')::bigint, now()
  )
  returning * into new_order;

  perform private.insert_order_items(new_order.id, normalised -> 'lines');
  for item in select * from public.order_items where order_id = new_order.id order by variant_id loop
    perform private.inventory_apply(item.variant_id, -item.quantity, 0, 'in_store_sale',
      'sale:' || item.id, new_order.id, item.id);
  end loop;

  insert into public.order_events (order_id, kind, to_status, to_payment, actor, actor_user_id, request_id)
  values (new_order.id, 'sale', 'completed', 'collected', 'admin', (select auth.uid()), p_request_id);
  return jsonb_build_object('result', 'placed', 'id', new_order.id, 'order_number', new_order.order_number);
end;
$$;

-- Settings. p_settings has every setting (null = not decided). Ordering can
-- only be switched on once the required ones are set (table constraint).
create function public.admin_update_shop_settings(p_expected_version integer, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_settings public.shop_settings;
  updated public.shop_settings;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_settings) is distinct from 'object' then
    raise exception 'Malformed settings.' using errcode = 'PT400';
  end if;
  select * into current_settings from public.shop_settings for update;
  if p_expected_version is distinct from current_settings.version then
    raise exception 'The settings were changed somewhere else since you opened them.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;
  update public.shop_settings set
    version = version + 1,
    orders_open = coalesce((p_settings ->> 'orders_open')::boolean, false),
    delivery_area_mode = p_settings ->> 'delivery_area_mode',
    standard_delivery_fee_paisa = (p_settings ->> 'standard_delivery_fee_paisa')::integer,
    free_delivery_enabled = (p_settings ->> 'free_delivery_enabled')::boolean,
    free_delivery_min_paisa = (p_settings ->> 'free_delivery_min_paisa')::integer,
    hold_minutes = (p_settings ->> 'hold_minutes')::integer,
    max_lines_per_order = (p_settings ->> 'max_lines_per_order')::integer,
    max_units_per_order = (p_settings ->> 'max_units_per_order')::integer,
    max_units_per_line = (p_settings ->> 'max_units_per_line')::integer,
    max_open_orders_per_phone = (p_settings ->> 'max_open_orders_per_phone')::integer,
    place_attempts_per_ip_10min = (p_settings ->> 'place_attempts_per_ip_10min')::integer,
    place_attempts_per_ip_day = (p_settings ->> 'place_attempts_per_ip_day')::integer,
    lookups_per_ip_10min = (p_settings ->> 'lookups_per_ip_10min')::integer,
    quotes_per_ip_10min = (p_settings ->> 'quotes_per_ip_10min')::integer,
    orders_per_minute_global = (p_settings ->> 'orders_per_minute_global')::integer,
    in_store_sells_unpublished = (p_settings ->> 'in_store_sells_unpublished')::boolean,
    updated_at = now(),
    updated_by = (select auth.uid())
  returning * into updated;
  return to_jsonb(updated);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'A setting has an invalid value.' using errcode = 'PT400', hint = 'invalid_settings';
end;
$$;

-- Replaces the delivery city list: [{"city": "Lahore", "active": true, "fee_paisa": null}].
create function public.admin_save_delivery_cities(p_expected_version integer, p_cities jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  new_version integer;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_cities) is distinct from 'array' or jsonb_array_length(p_cities) > 500 then
    raise exception 'Malformed city list.' using errcode = 'PT400';
  end if;
  -- The settings row is the lock for everything delivery-related.
  update public.shop_settings set version = version + 1, updated_at = now(), updated_by = (select auth.uid())
  where version = p_expected_version
  returning version into new_version;
  if new_version is null then
    raise exception 'The settings were changed somewhere else since you opened them.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;
  delete from public.delivery_cities;
  insert into public.delivery_cities (city, active, fee_paisa)
  select private.clean_text(c ->> 'city', 2, 60, 'city'), coalesce((c ->> 'active')::boolean, true), (c ->> 'fee_paisa')::integer
  from jsonb_array_elements(p_cities) c;
  return new_version;
end;
$$;

create function public.admin_expire_holds_now()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return private.expire_order_holds(200);
end;
$$;

-- Health of the hold-expiry job, for the admin warning banner.
create function public.admin_order_health()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  beat private.job_heartbeats;
  scheduled text := 'unknown';
  overdue integer;
  oldest_minutes integer;
  job_count integer;
begin
  perform public.admin_require_catalogue_admin();
  select * into beat from private.job_heartbeats where job = 'expire_order_holds';
  select count(*), floor(extract(epoch from now() - min(hold_expires_at)) / 60)::integer
  into overdue, oldest_minutes
  from public.orders where status = 'awaiting_confirmation' and hold_expires_at <= now();
  if to_regclass('cron.job') is null then
    scheduled := 'no_scheduler';
  else
    begin
      -- Exactly one active job should run the expiry (more would only queue behind each other).
      execute $q$ select count(*)::integer from cron.job where command like '%private.expire_order_holds%' and active $q$
        into job_count;
      scheduled := case job_count when 0 then 'not_scheduled' when 1 then 'scheduled' else 'duplicate' end;
    exception when others then
      scheduled := 'unknown';
    end;
  end if;
  return jsonb_build_object(
    'scheduled', scheduled,
    'last_started_at', beat.last_started_at,
    'last_succeeded_at', beat.last_succeeded_at,
    'last_failed_at', beat.last_failed_at,
    'last_error', beat.last_error,
    'consecutive_failures', coalesce(beat.consecutive_failures, 0),
    'overdue_holds', overdue,
    'oldest_overdue_minutes', oldest_minutes,
    'now', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

alter table public.shop_settings enable row level security;
alter table public.delivery_cities enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
alter table public.order_return_lines enable row level security;

-- Supabase grants API roles full access to new tables by default. Reset:
-- no access for visitors; signed-in users may SELECT, and RLS returns rows
-- only to verified admins. No role writes these tables directly.
revoke all on table public.shop_settings, public.delivery_cities, public.orders, public.order_items,
  public.order_events, public.order_return_lines from public, anon, authenticated;
grant select on table public.shop_settings, public.delivery_cities, public.orders, public.order_items,
  public.order_events, public.order_return_lines to authenticated;
revoke all on sequence public.order_number_seq from public, anon, authenticated;

create policy "Verified admins can read settings" on public.shop_settings
  for select to authenticated using ((select public.is_catalogue_admin()));
create policy "Verified admins can read delivery cities" on public.delivery_cities
  for select to authenticated using ((select public.is_catalogue_admin()));
create policy "Verified admins can read orders" on public.orders
  for select to authenticated using ((select public.is_catalogue_admin()));
create policy "Verified admins can read order items" on public.order_items
  for select to authenticated using ((select public.is_catalogue_admin()));
create policy "Verified admins can read order history" on public.order_events
  for select to authenticated using ((select public.is_catalogue_admin()));
create policy "Verified admins can read returns" on public.order_return_lines
  for select to authenticated using ((select public.is_catalogue_admin()));

-- Internal functions: no API role may execute them (the schema is closed too).
revoke execute on function
  private.orders_guard(),
  private.require_gateway(text),
  private.checkout_key_hash(text),
  private.lock_key(bytea),
  private.clean_text(text, integer, integer, text),
  private.checkout_input(jsonb),
  private.fingerprint(jsonb),
  private.checkout_quote(jsonb, text, public.shop_settings, boolean),
  private.lock_inventory(uuid[]),
  private.lock_for_sale(uuid[]),
  private.release_order(uuid, boolean, text, uuid, uuid, text, text),
  private.expire_order_holds(integer),
  private.rate_limit_hit(text, interval, integer),
  private.customer_order_view(uuid),
  private.insert_order_items(uuid, jsonb),
  private.admin_order_lock(uuid, integer, uuid),
  private.admin_result(uuid, text)
  from public, anon, authenticated;

-- Guest functions: the website, as anon, with the gateway secret.
revoke execute on function
  public.checkout_register_attempt(text, text, text),
  public.quote_order(text, jsonb, text),
  public.checkout_resolve(text, text, jsonb, boolean),
  public.place_cod_order(text, text, jsonb),
  public.get_customer_order(text, text)
  from public, anon, authenticated;
grant execute on function
  public.checkout_register_attempt(text, text, text),
  public.quote_order(text, jsonb, text),
  public.checkout_resolve(text, text, jsonb, boolean),
  public.place_cod_order(text, text, jsonb),
  public.get_customer_order(text, text)
  to anon;

-- Admin functions: signed-in users may call them; each refuses anyone who
-- isn't a verified admin.
revoke execute on function
  public.admin_confirm_order(uuid, integer, uuid, text),
  public.admin_cancel_order(uuid, integer, uuid, text, text),
  public.admin_dispatch_order(uuid, integer, uuid, text, text, text),
  public.admin_mark_delivered(uuid, integer, uuid, boolean, text),
  public.admin_mark_delivery_failed(uuid, integer, uuid, text),
  public.admin_receive_return(uuid, integer, uuid, jsonb, text),
  public.admin_record_payment(uuid, integer, uuid, text, bigint, text, text),
  public.admin_add_order_note(uuid, uuid, text),
  public.admin_record_in_store_sale(uuid, jsonb),
  public.admin_update_shop_settings(integer, jsonb),
  public.admin_save_delivery_cities(integer, jsonb),
  public.admin_expire_holds_now(),
  public.admin_order_health()
  from public, anon;
grant execute on function
  public.admin_confirm_order(uuid, integer, uuid, text),
  public.admin_cancel_order(uuid, integer, uuid, text, text),
  public.admin_dispatch_order(uuid, integer, uuid, text, text, text),
  public.admin_mark_delivered(uuid, integer, uuid, boolean, text),
  public.admin_mark_delivery_failed(uuid, integer, uuid, text),
  public.admin_receive_return(uuid, integer, uuid, jsonb, text),
  public.admin_record_payment(uuid, integer, uuid, text, bigint, text, text),
  public.admin_add_order_note(uuid, uuid, text),
  public.admin_record_in_store_sale(uuid, jsonb),
  public.admin_update_shop_settings(integer, jsonb),
  public.admin_save_delivery_cities(integer, jsonb),
  public.admin_expire_holds_now(),
  public.admin_order_health()
  to authenticated;
