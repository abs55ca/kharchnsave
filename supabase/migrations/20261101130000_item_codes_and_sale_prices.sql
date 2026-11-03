-- Automatic item codes and sale prices.
--
-- 1. Automatic item codes. "Automatically generate item code" on the Add
--    Product form sends {"auto_item_code": true}; admin_create_product then
--    assigns the next ITEM-000001, ITEM-000002, ... from its own sequence
--    (private.item_code_seq): never a row count or MAX + 1, never the
--    barcode sequence. A number some product already uses (e.g. typed in
--    by hand before) is skipped; the existing unique constraint on item_code
--    is the last guard. Typed item codes can't take the ITEM-<digits> form,
--    except a product keeping the one it has. The code is assigned once:
--    afterwards it behaves like any item code (editable while the product
--    has never been published, fixed once it has; SKUs follow it as before).
--    Existing item codes, SKUs and barcodes are untouched.
--
-- 2. Sale prices. products.price_paisa stays the regular price.
--    products.sale_price_paisa (optional) is the sale price: above zero and
--    strictly below the regular price (a constraint, so every writer obeys
--    it). Customers pay coalesce(sale_price_paisa, price_paisa): the live
--    checkout quote (and so the free-delivery threshold, quote_changed when
--    a sale starts, changes or ends after the customer saw the price, and
--    in-store sales) and the order-item snapshot both use it. Orders already
--    placed keep the prices they were placed at (order_items are snapshots).
--    Visitors can read sale_price_paisa (added to their column list).
--
-- Builds on every earlier migration. Adding a nullable column rewrites no
-- rows and fires no triggers: versions, stock, held stock, inventory
-- versions and barcodes are untouched. The replaced functions keep their
-- signatures, so their grants stay as they are.

-- ---------------------------------------------------------------------------
-- Item codes
-- ---------------------------------------------------------------------------

-- Private: API roles have no access to this schema (20261031120000_inventory_ledger.sql).
create sequence private.item_code_seq as bigint minvalue 1 start 1 no cycle;
revoke all on sequence private.item_code_seq from public, anon, authenticated;

comment on sequence private.item_code_seq is
  'Automatic item codes (ITEM-000001, ...). Separate from the barcode sequence; numbers are never reused.';

-- The next automatic item code nobody uses yet. nextval is safe under
-- concurrency (each call gets its own number, even if its transaction rolls
-- back); a number already taken is skipped.
create function private.next_item_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  candidate text;
begin
  loop
    candidate := 'ITEM-' || lpad(nextval('private.item_code_seq')::text, 6, '0');
    exit when not exists (select 1 from public.products p where p.item_code = candidate);
  end loop;
  return candidate;
end;
$$;

-- Typed item codes can't take the automatic form, except the one the product
-- already has (p_current).
create function private.require_manual_item_code(p_code text, p_current text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_code ~ '^ITEM-[0-9]+$' and p_code is distinct from p_current then
    raise exception 'Item codes like ITEM-000123 are assigned automatically.'
      using errcode = 'PT400', hint = 'item_code_reserved';
  end if;
end;
$$;

revoke execute on function private.next_item_code(), private.require_manual_item_code(text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Sale prices
-- ---------------------------------------------------------------------------

alter table public.products
  add column sale_price_paisa integer,
  add constraint products_sale_price_valid check (
    sale_price_paisa is null or (sale_price_paisa > 0 and sale_price_paisa < price_paisa)
  );

comment on column public.products.price_paisa is
  'Regular price in paisa (integer: 850000 = Rs. 8,500). Customers pay sale_price_paisa instead while there is one.';
comment on column public.products.sale_price_paisa is
  'Optional sale price in paisa: above zero, below price_paisa. Null: no sale. The discount shown is calculated, never stored.';

-- ---------------------------------------------------------------------------
-- Admin product functions: the same as in
-- 20261101120000_label_names_and_light_up.sql plus automatic item codes and
-- the sale price
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_product(p_fields jsonb, p_sizes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_product public.products;
  code text;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_fields) is distinct from 'object' or jsonb_typeof(p_sizes) is distinct from 'array' then
    raise exception 'Malformed product data.' using errcode = 'PT400';
  end if;

  -- An automatic item code is assigned here, once; a typed one is checked.
  if coalesce((p_fields ->> 'auto_item_code')::boolean, false) then
    code := private.next_item_code();
  else
    code := p_fields ->> 'item_code';
    perform private.require_manual_item_code(code, null);
  end if;

  insert into public.products (
    item_code, slug, name, brand, department, styles, item_status, condition,
    condition_notes, colour, description, price_paisa, publication_status,
    label_name, light_up, light_up_condition, light_up_activation, sale_price_paisa
  )
  values (
    code,
    p_fields ->> 'slug',
    p_fields ->> 'name',
    p_fields ->> 'brand',
    p_fields ->> 'department',
    coalesce(array(select jsonb_array_elements_text(p_fields -> 'styles')), '{}'),
    p_fields ->> 'item_status',
    p_fields ->> 'condition',
    coalesce(array(select jsonb_array_elements_text(p_fields -> 'condition_notes')), '{}'),
    p_fields ->> 'colour',
    coalesce(p_fields ->> 'description', ''),
    (p_fields ->> 'price_paisa')::integer,
    'draft',
    nullif(p_fields ->> 'label_name', ''),
    (p_fields ->> 'light_up')::boolean,
    p_fields ->> 'light_up_condition',
    nullif(p_fields ->> 'light_up_activation', ''),
    (p_fields ->> 'sale_price_paisa')::integer
  )
  returning * into new_product;

  -- The ledger trigger records each new size's stock ("size_added").
  insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
  select new_product.id, new_product.item_status,
         public.catalogue_sku(new_product.item_code, (s ->> 'size')::numeric),
         (s ->> 'size')::numeric, (s ->> 'stock')::integer
  from jsonb_array_elements(p_sizes) s;

  set constraints all immediate;
  return jsonb_build_object('id', new_product.id, 'version', new_product.version, 'item_code', new_product.item_code);
end;
$$;

create or replace function public.admin_save_product(
  p_product_id uuid,
  p_expected_version integer,
  p_fields jsonb,
  p_sizes jsonb,
  p_images jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_product public.products;
  target_status text := p_fields ->> 'item_status';
  new_version integer;
  removed_paths text[];
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_fields) is distinct from 'object'
    or jsonb_typeof(p_sizes) is distinct from 'array'
    or jsonb_typeof(p_images) is distinct from 'array' then
    raise exception 'Malformed product data.' using errcode = 'PT400';
  end if;

  -- Locks: the product, then its sizes (the order every function uses).
  current_product := public.admin_lock_product(p_product_id, p_expected_version);
  -- Keeping the product's own automatic code is fine; taking another one isn't.
  perform private.require_manual_item_code(p_fields ->> 'item_code', current_product.item_code);
  perform 1 from public.product_variants where product_id = p_product_id order by id for update;

  -- Photos named in p_images must already belong to this product.
  if exists (
    select 1 from jsonb_array_elements(p_images) i
    where not exists (
      select 1 from public.product_images pi
      where pi.product_id = p_product_id and pi.id::text = i ->> 'id'
    )
  ) or (select count(distinct i ->> 'id') from jsonb_array_elements(p_images) i) <> jsonb_array_length(p_images) then
    raise exception 'The photo list doesn''t match this product. Reload and try again.'
      using errcode = 'PT409', hint = 'photos_changed';
  end if;

  -- Sizes no longer listed (blocked by a trigger once the product has been
  -- published). A size holding pairs for orders can't be removed.
  if exists (
    select 1 from public.product_variants v
    where v.product_id = p_product_id and v.reserved > 0
      and v.size_eu not in (select (s ->> 'size')::numeric from jsonb_array_elements(p_sizes) s)
  ) then
    raise exception 'A size with pairs held for orders can''t be removed.'
      using errcode = 'PT409', hint = 'size_has_orders';
  end if;
  delete from public.product_variants v
  where v.product_id = p_product_id
    and v.size_eu not in (select (s ->> 'size')::numeric from jsonb_array_elements(p_sizes) s);

  -- Changing to pre-loved: lower the stock first (pre-loved allows 0 or 1).
  if target_status = 'preloved' then
    perform private.apply_size_stock(p_product_id, p_sizes);
  end if;

  update public.products set
    item_code = p_fields ->> 'item_code',
    slug = p_fields ->> 'slug',
    name = p_fields ->> 'name',
    brand = p_fields ->> 'brand',
    department = p_fields ->> 'department',
    styles = coalesce(array(select jsonb_array_elements_text(p_fields -> 'styles')), '{}'),
    item_status = target_status,
    condition = p_fields ->> 'condition',
    condition_notes = coalesce(array(select jsonb_array_elements_text(p_fields -> 'condition_notes')), '{}'),
    colour = p_fields ->> 'colour',
    description = coalesce(p_fields ->> 'description', ''),
    price_paisa = (p_fields ->> 'price_paisa')::integer,
    -- Left out of p_fields (an older caller): kept as they are.
    label_name = case when p_fields ? 'label_name' then nullif(p_fields ->> 'label_name', '') else label_name end,
    light_up = case when p_fields ? 'light_up' then (p_fields ->> 'light_up')::boolean else light_up end,
    light_up_condition = case when p_fields ? 'light_up' then p_fields ->> 'light_up_condition' else light_up_condition end,
    light_up_activation = case when p_fields ? 'light_up' then nullif(p_fields ->> 'light_up_activation', '') else light_up_activation end,
    sale_price_paisa = case when p_fields ? 'sale_price_paisa' then (p_fields ->> 'sale_price_paisa')::integer else sale_price_paisa end
  where id = p_product_id
  returning version into new_version;

  -- Changing to (or staying) new: change the product first, then the stock.
  if target_status is distinct from 'preloved' then
    perform private.apply_size_stock(p_product_id, p_sizes);
  end if;

  -- A draft that has never been published may still change its item code;
  -- its SKUs follow (the trigger refuses this once it has been published).
  update public.product_variants v
  set sku = public.catalogue_sku(p_fields ->> 'item_code', v.size_eu)
  where v.product_id = p_product_id
    and v.sku <> public.catalogue_sku(p_fields ->> 'item_code', v.size_eu)
    and current_product.item_code is distinct from p_fields ->> 'item_code';

  -- New sizes; the ledger trigger records their stock ("size_added").
  insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
  select p_product_id, target_status,
         public.catalogue_sku(p_fields ->> 'item_code', (s ->> 'size')::numeric),
         (s ->> 'size')::numeric, (s ->> 'stock')::integer
  from jsonb_array_elements(p_sizes) s
  where not exists (
    select 1 from public.product_variants v
    where v.product_id = p_product_id and v.size_eu = (s ->> 'size')::numeric
  );

  -- Photos: remove the ones left out, then apply the new order and details.
  with removed as (
    delete from public.product_images pi
    where pi.product_id = p_product_id
      and pi.id::text not in (select i ->> 'id' from jsonb_array_elements(p_images) i)
    returning pi.storage_path
  )
  select coalesce(array_agg(storage_path) filter (where storage_path is not null), '{}')
  into removed_paths from removed;

  -- Two steps so the (product, position) uniqueness holds throughout.
  update public.product_images set sort_order = sort_order + 1000
  where product_id = p_product_id;

  update public.product_images pi set
    sort_order = i.position - 1,
    alt = i.item ->> 'alt',
    shows_defect = coalesce((i.item ->> 'shows_defect')::boolean, false)
  from jsonb_array_elements(p_images) with ordinality as i (item, position)
  where pi.product_id = p_product_id and pi.id::text = i.item ->> 'id';

  set constraints all immediate;
  return jsonb_build_object('version', new_version, 'removed_paths', to_jsonb(removed_paths));
end;
$$;

-- ---------------------------------------------------------------------------
-- What customers pay: the same as in 20261031130000_guest_orders.sql, but
-- charging the sale price when there is one. The quote also reports the
-- regular price (regular_price_paisa), for display only.
-- ---------------------------------------------------------------------------

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
    select r.*, v.id as variant_id, v.size_eu, p.name, p.brand, p.item_status, p.condition,
      coalesce(p.sale_price_paisa, p.price_paisa) as price_paisa, p.price_paisa as regular_price_paisa,
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

create or replace function private.insert_order_items(p_order_id uuid, p_lines jsonb)
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
         p.item_status, p.condition, v.size_eu, coalesce(p.sale_price_paisa, p.price_paisa), (x.l ->> 'quantity')::integer
  from jsonb_array_elements(p_lines) with ordinality as x (l, n)
  join public.product_variants v on v.sku = x.l ->> 'sku'
  join public.products p on p.id = v.product_id;
$$;

-- ---------------------------------------------------------------------------
-- Scan lookups: the same as in 20261101120000_label_names_and_light_up.sql,
-- plus the sale price (the price to charge at the counter)
-- ---------------------------------------------------------------------------

create or replace function public.admin_scan_product(p_product_id uuid, p_variant_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id,
    'item_code', p.item_code,
    'name', p.name,
    'label_name', p.label_name,
    'brand', p.brand,
    'colour', p.colour,
    'item_status', p.item_status,
    'publication_status', p.publication_status,
    'price_paisa', p.price_paisa,
    'sale_price_paisa', p.sale_price_paisa,
    'photo', (
      select jsonb_build_object('id', i.id, 'src', i.src, 'storage_path', i.storage_path, 'alt', i.alt)
      from public.product_images i
      where i.product_id = p.id
      order by i.sort_order
      limit 1
    ),
    'units', coalesce((
      select jsonb_agg(
        jsonb_build_object('variant_id', v.id, 'sku', v.sku, 'size_eu', v.size_eu, 'stock', v.stock, 'barcode', b.barcode)
        order by v.size_eu
      )
      from public.product_variants v
      left join public.variant_barcodes b on b.variant_id = v.id
      where v.product_id = p.id and (p_variant_id is null or v.id = p_variant_id)
    ), '[]'::jsonb)
  )
  from public.products p
  where p.id = p_product_id
    and (select public.is_catalogue_admin());
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

-- Visitors read products column by column (20261101120000_label_names_and_light_up.sql):
-- the sale price joins their list. Nobody writes it directly: it isn't in the
-- column grants for direct updates, so only the admin functions above set it.
grant select (sale_price_paisa) on table public.products to anon;
