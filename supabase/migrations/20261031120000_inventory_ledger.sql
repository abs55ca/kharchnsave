-- Inventory foundation for orders and in-store sales: held stock, an
-- inventory version per size, an add-only stock ledger with opening balances,
-- and stock changes only through approved database functions.
--
-- Builds on every earlier migration. Existing sizes keep their stock; each
-- one gets an "opening_balance" ledger row equal to its current stock.
--
-- Meaning of the stock columns afterwards:
--   stock     pairs available to sell now (what the shop shows; unchanged)
--   reserved  pairs held for online orders that haven't been dispatched
--   on the shelf = stock + reserved
--
-- Who can do what afterwards:
--
-- * Visitors (anon): read published sizes as before, but only the columns the
--   storefront uses. reserved and inventory_version are not visible to them.
-- * Verified admins: can no longer insert, update or delete sizes directly
--   through the API. admin_create_product, admin_save_product and
--   admin_adjust_stock are the only ways. They check for a verified admin
--   first. A size's stock is written only when the admin changed it, and
--   only if nobody else changed it since the form was opened
--   (inventory_version), so saving a description never overwrites stock.
-- * The database owner (SQL Editor, seeds): may still edit sizes directly;
--   every change is recorded in the ledger (reason "owner_adjust").
--
-- Every change to stock or reserved, from any source, is written to
-- public.stock_movements by a trigger, so the ledger is complete by
-- construction: for every size, stock = sum(available_delta) and
-- reserved = sum(reserved_delta).

-- ---------------------------------------------------------------------------
-- Internal schema: helpers and private tables, not reachable through the API
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- Functions are executable by PUBLIC by default; never in this schema.
alter default privileges in schema private revoke execute on functions from public;

comment on schema private is
  'Internal helpers and private tables. Not exposed through the API; API roles have no access.';

-- ---------------------------------------------------------------------------
-- New columns and rules on sizes
-- ---------------------------------------------------------------------------

-- Adding columns with defaults doesn't fire update triggers or touch rows.
alter table public.product_variants
  add column reserved integer not null default 0,
  add column inventory_version bigint not null default 1,
  add constraint product_variants_reserved_not_negative check (reserved >= 0),
  add constraint product_variants_reserved_maximum check (reserved <= 9999),
  add constraint product_variants_inventory_version_positive check (inventory_version > 0);

-- A pre-loved pair is unique: available and held together are at most 1.
alter table public.product_variants
  drop constraint product_variants_preloved_stock,
  add constraint product_variants_preloved_stock check (item_status <> 'preloved' or stock + reserved <= 1);

comment on column public.product_variants.stock is
  'Pairs available to sell now (shown in the shop). Changed only through the inventory functions.';
comment on column public.product_variants.reserved is
  'Pairs held for online orders that have not been dispatched. On the shelf = stock + reserved.';
comment on column public.product_variants.inventory_version is
  'Increases on every change to stock or reserved; admin stock edits must name the version they saw.';

-- ---------------------------------------------------------------------------
-- The stock ledger
-- ---------------------------------------------------------------------------

create table public.stock_movements (
  id bigint generated always as identity primary key,
  -- No foreign key: the history outlives a removed (never-published) size.
  variant_id uuid not null,
  sku text not null,
  available_delta integer not null,
  reserved_delta integer not null,
  available_after integer not null,
  reserved_after integer not null,
  reason text not null,
  -- What the movement is for, e.g. "reserve:<order item id>". Unique, so the
  -- same event can never be applied twice.
  event_key text not null,
  order_id uuid,
  order_item_id uuid,
  return_line_id uuid,
  actor_user_id uuid,
  note text,
  created_at timestamptz not null default now(),

  constraint stock_movements_event_key_key unique (event_key),
  constraint stock_movements_event_key_length check (char_length(event_key) between 1 and 200),
  constraint stock_movements_after_not_negative check (available_after >= 0 and reserved_after >= 0),
  constraint stock_movements_note_length check (note is null or char_length(note) <= 500),
  constraint stock_movements_reason_valid check (reason in (
    'opening_balance', 'size_added', 'size_removed', 'admin_set', 'owner_adjust',
    'order_reserve', 'order_release', 'order_dispatch', 'return_restock', 'return_write_off',
    'in_store_sale'
  ))
);

create index stock_movements_variant_idx on public.stock_movements (variant_id, id);

comment on table public.stock_movements is
  'Add-only log of every change to product_variants.stock (available) and .reserved (held).';

-- Opening balances: one row per existing size, equal to its current stock.
-- (Nothing can be reserved yet: there are no orders before this migration.)
insert into public.stock_movements (
  variant_id, sku, available_delta, reserved_delta, available_after, reserved_after, reason, event_key, note
)
select v.id, v.sku, v.stock, 0, v.stock, 0, 'opening_balance', 'opening:' || v.id, 'Stock when the ledger started'
from public.product_variants v;

-- Add-only: rows can't be changed or removed, even by mistake.
create function private.append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows can''t be changed or removed.', tg_table_name
    using errcode = 'PT400', hint = 'append_only';
end;
$$;

create trigger stock_movements_append_only
  before update or delete on public.stock_movements
  for each row execute function private.append_only();

create trigger stock_movements_no_truncate
  before truncate on public.stock_movements
  for each statement execute function private.append_only();

-- ---------------------------------------------------------------------------
-- Inventory version and automatic ledger rows
-- ---------------------------------------------------------------------------

create function private.product_variants_inventory_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.inventory_version := 1;
  elsif new.stock is distinct from old.stock or new.reserved is distinct from old.reserved then
    new.inventory_version := old.inventory_version + 1;
  else
    new.inventory_version := old.inventory_version;
  end if;
  return new;
end;
$$;

create trigger product_variants_inventory_version
  before insert or update on public.product_variants
  for each row execute function private.product_variants_inventory_version();

-- Writes the ledger row for every change to stock or reserved. The inventory
-- functions describe the change (reason, event key, order) in the
-- transaction-local setting private.stock_movement just before they update;
-- any other change (the owner editing a size directly) is recorded with a
-- default reason.
create function private.product_variants_record_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ctx jsonb := nullif(current_setting('private.stock_movement', true), '')::jsonb;
  available_change integer;
  reserved_change integer;
  size_row public.product_variants;
begin
  if tg_op = 'INSERT' then
    size_row := new;
    available_change := new.stock;
    reserved_change := new.reserved;
  elsif tg_op = 'UPDATE' then
    size_row := new;
    available_change := new.stock - old.stock;
    reserved_change := new.reserved - old.reserved;
    if available_change = 0 and reserved_change = 0 then
      return null;
    end if;
  else
    size_row := old;
    available_change := -old.stock;
    reserved_change := -old.reserved;
  end if;

  insert into public.stock_movements (
    variant_id, sku, available_delta, reserved_delta, available_after, reserved_after,
    reason, event_key, order_id, order_item_id, return_line_id, actor_user_id, note
  )
  values (
    size_row.id, size_row.sku, available_change, reserved_change,
    case when tg_op = 'DELETE' then 0 else size_row.stock end,
    case when tg_op = 'DELETE' then 0 else size_row.reserved end,
    coalesce(ctx ->> 'reason',
      case tg_op when 'INSERT' then 'size_added' when 'DELETE' then 'size_removed' else 'owner_adjust' end),
    coalesce(ctx ->> 'event_key', lower(tg_op) || ':' || gen_random_uuid()),
    (ctx ->> 'order_id')::uuid,
    (ctx ->> 'order_item_id')::uuid,
    (ctx ->> 'return_line_id')::uuid,
    coalesce((ctx ->> 'actor_user_id')::uuid, (select auth.uid())),
    ctx ->> 'note'
  );
  return null;
end;
$$;

create trigger product_variants_record_movement
  after insert or delete or update of stock, reserved on public.product_variants
  for each row execute function private.product_variants_record_movement();

-- ---------------------------------------------------------------------------
-- The one way the inventory functions change stock
-- ---------------------------------------------------------------------------

-- Applies a change to a size's available and held stock, once per event key.
-- Returns false if that event was already recorded (nothing changes). The
-- caller must already hold the locks it needs (see the order functions); this
-- locks the size row too, so it is safe on its own. Constraint violations
-- (negative stock, pre-loved above 1) are raised as usual.
create function private.inventory_apply(
  p_variant_id uuid,
  p_available_delta integer,
  p_reserved_delta integer,
  p_reason text,
  p_event_key text,
  p_order_id uuid default null,
  p_order_item_id uuid default null,
  p_return_line_id uuid default null,
  p_note text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  size_row public.product_variants;
begin
  if exists (select 1 from public.stock_movements m where m.event_key = p_event_key) then
    return false;
  end if;

  select * into size_row from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Size not found.' using errcode = 'PT404';
  end if;

  -- A record without a change (a written-off return): no update, so no
  -- trigger; write the row directly.
  if p_available_delta = 0 and p_reserved_delta = 0 then
    insert into public.stock_movements (
      variant_id, sku, available_delta, reserved_delta, available_after, reserved_after,
      reason, event_key, order_id, order_item_id, return_line_id, actor_user_id, note
    )
    values (
      size_row.id, size_row.sku, 0, 0, size_row.stock, size_row.reserved,
      p_reason, p_event_key, p_order_id, p_order_item_id, p_return_line_id, (select auth.uid()), p_note
    );
    return true;
  end if;

  perform set_config('private.stock_movement', jsonb_build_object(
    'reason', p_reason, 'event_key', p_event_key, 'order_id', p_order_id,
    'order_item_id', p_order_item_id, 'return_line_id', p_return_line_id, 'note', p_note
  )::text, true);
  update public.product_variants
  set stock = stock + p_available_delta, reserved = reserved + p_reserved_delta
  where id = p_variant_id;
  perform set_config('private.stock_movement', '', true);
  return true;
end;
$$;

-- Applies the admin form's stock changes to a product's existing sizes.
-- For each submitted size:
--   * "stock_was" (what the form loaded) equal to "stock": not changed, so
--     the stock is NOT written, whatever it is now (orders may have changed it).
--   * changed: written only if "inventory_version" is still the size's
--     current version; otherwise PT409 stock_changed. The version increases
--     on every change, so 3 → 2 → 3 still counts as a change.
--   * no "stock_was" (an older form): accepted only if the stock is unchanged.
-- The caller has locked the product and its sizes.
create function private.apply_size_stock(p_product_id uuid, p_sizes jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  size_row public.product_variants;
  submitted jsonb;
  new_stock integer;
begin
  for size_row in
    select * from public.product_variants where product_id = p_product_id order by id
  loop
    select s into submitted
    from jsonb_array_elements(p_sizes) s
    where (s ->> 'size')::numeric = size_row.size_eu
    limit 1;
    continue when submitted is null;

    new_stock := (submitted ->> 'stock')::integer;
    if submitted ? 'stock_was' then
      continue when new_stock = (submitted ->> 'stock_was')::integer;
      if (submitted ->> 'inventory_version') is null
        or (submitted ->> 'inventory_version')::bigint <> size_row.inventory_version then
        raise exception 'Stock for EU % changed since this form was opened.', trim_scale(size_row.size_eu)
          using errcode = 'PT409', hint = 'stock_changed', detail = trim_scale(size_row.size_eu)::text;
      end if;
    elsif new_stock = size_row.stock then
      continue;
    else
      raise exception 'A stock change must name the inventory version it was based on.'
        using errcode = 'PT400', hint = 'inventory_version_required';
    end if;

    perform private.inventory_apply(size_row.id, new_stock - size_row.stock, 0, 'admin_set', 'admin_set:' || gen_random_uuid());
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin product functions, now SECURITY DEFINER (sizes have no direct API
-- write access any more). Same behaviour as before apart from stock, which
-- follows the rules of apply_size_stock. Each still checks for a verified
-- admin first and only touches the product it was given.
-- ---------------------------------------------------------------------------

create or replace function public.admin_create_product(p_fields jsonb, p_sizes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_product public.products;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_fields) is distinct from 'object' or jsonb_typeof(p_sizes) is distinct from 'array' then
    raise exception 'Malformed product data.' using errcode = 'PT400';
  end if;

  insert into public.products (
    item_code, slug, name, brand, department, styles, item_status, condition,
    condition_notes, colour, description, price_paisa, publication_status
  )
  values (
    p_fields ->> 'item_code',
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
    'draft'
  )
  returning * into new_product;

  -- The ledger trigger records each new size's stock ("size_added").
  insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
  select new_product.id, new_product.item_status,
         public.catalogue_sku(new_product.item_code, (s ->> 'size')::numeric),
         (s ->> 'size')::numeric, (s ->> 'stock')::integer
  from jsonb_array_elements(p_sizes) s;

  set constraints all immediate;
  return jsonb_build_object('id', new_product.id, 'version', new_product.version);
end;
$$;

-- Saves a product's details, sizes and photo details together.
--   p_sizes:  [{"size": 42.5, "stock": 1, "stock_was": 1, "inventory_version": 3}, ...]
--             the complete list; stock_was and inventory_version come from the
--             form (see private.apply_size_stock)
--   p_images: [{"id": "...", "alt": "...", "shows_defect": false}, ...]
--             every photo to keep, in display order; others are removed from
--             the listing (their Storage paths are returned for clean-up).
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
    price_paisa = (p_fields ->> 'price_paisa')::integer
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

-- One size's available stock, for quick corrections (e.g. after a count).
-- p_request_id makes a retry harmless: the same request is applied once.
create function public.admin_adjust_stock(
  p_variant_id uuid,
  p_inventory_version bigint,
  p_stock integer,
  p_request_id uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  size_row public.product_variants;
  event text := 'admin_set:' || p_request_id;
begin
  perform public.admin_require_catalogue_admin();
  if p_variant_id is null or p_request_id is null or p_stock is null or p_stock < 0 or p_stock > 9999
    or (p_note is not null and char_length(p_note) > 500) then
    raise exception 'Malformed stock change.' using errcode = 'PT400';
  end if;

  -- Locks: the product (shared), then the size.
  perform 1 from public.products p
  where p.id = (select v.product_id from public.product_variants v where v.id = p_variant_id)
  for share;
  select * into size_row from public.product_variants where id = p_variant_id for update;
  if not found then
    raise exception 'Size not found.' using errcode = 'PT404';
  end if;

  -- Already applied (a retry): report the current state.
  if exists (select 1 from public.stock_movements m where m.event_key = event) then
    return jsonb_build_object('stock', size_row.stock, 'reserved', size_row.reserved,
      'inventory_version', size_row.inventory_version, 'applied', false);
  end if;
  if p_inventory_version is distinct from size_row.inventory_version then
    raise exception 'This size''s stock changed since you opened it.'
      using errcode = 'PT409', hint = 'stock_changed', detail = trim_scale(size_row.size_eu)::text;
  end if;

  perform private.inventory_apply(size_row.id, p_stock - size_row.stock, 0, 'admin_set', event, p_note => p_note);
  select * into size_row from public.product_variants where id = p_variant_id;
  return jsonb_build_object('stock', size_row.stock, 'reserved', size_row.reserved,
    'inventory_version', size_row.inventory_version, 'applied', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

-- Sizes: no direct writes through the API any more (revoking the table
-- privileges also revokes the column grants). The functions above are the
-- only way.
revoke insert, update, delete on table public.product_variants from authenticated;

-- Visitors read only the storefront's columns; held stock stays private.
revoke select on table public.product_variants from anon;
grant select (id, product_id, item_status, sku, size_eu, stock, created_at, updated_at)
  on table public.product_variants to anon;

-- The ledger: verified admins can read it; nobody writes it through the API.
alter table public.stock_movements enable row level security;
revoke all on table public.stock_movements from public, anon, authenticated;
grant select on table public.stock_movements to authenticated;

create policy "Verified admins can read stock movements"
  on public.stock_movements for select to authenticated
  using ((select public.is_catalogue_admin()));

-- Functions. Supabase lets API roles execute new functions in public by
-- default; the internal ones live in the private schema, which they can't use.
revoke execute on function
  private.append_only(),
  private.product_variants_inventory_version(),
  private.product_variants_record_movement(),
  private.inventory_apply(uuid, integer, integer, text, text, uuid, uuid, uuid, text),
  private.apply_size_stock(uuid, jsonb)
  from public, anon, authenticated;

revoke execute on function public.admin_adjust_stock(uuid, bigint, integer, uuid, text) from public, anon;
grant execute on function public.admin_adjust_stock(uuid, bigint, integer, uuid, text) to authenticated;
