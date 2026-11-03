-- Label names and light-up soles.
--
-- 1. products.label_name: an optional short name for the printed shelf label
--    only. The website always shows the full product name. Null: the label
--    uses the product name, if it fits. Whether a name fits the label is
--    checked by the app (lib/labels/name-fit.ts); the database only refuses
--    blank padding, control characters and anything over 60 characters.
--    Visitors (the publishable key) can no longer read products with
--    "select *": they get every column except label_name.
--
-- 2. products.light_up, light_up_condition, light_up_activation:
--      light_up              null = not recorded, false = no, true = yes
--      light_up_condition    when light_up is true (and only then):
--                            not_checked, both_work, one_works, neither_works
--      light_up_activation   optional, only when light_up is true, e.g.
--                            "Soles flash when walking."
--    Existing products start as "not recorded"; nothing assumes they were
--    inspected.
--
-- Builds on every earlier migration. Adding nullable columns rewrites no
-- rows and fires no triggers: product versions, stock, held stock, inventory
-- versions, barcodes and orders are untouched.
--
-- admin_create_product, admin_save_product and admin_scan_product are
-- replaced with the same functions plus these fields (same signatures, so
-- their grants are kept). Stock handling is unchanged: a save writes a size's
-- stock only when the admin changed it, and only if its inventory version
-- still matches (private.apply_size_stock), so editing a label name or the
-- light-up details never changes stock, reserved pairs or inventory versions.
-- A save that leaves the new fields out (an older caller) keeps their values.

-- ---------------------------------------------------------------------------
-- New columns and rules
-- ---------------------------------------------------------------------------

alter table public.products
  add column label_name text,
  add column light_up boolean,
  add column light_up_condition text,
  add column light_up_activation text,
  add constraint products_label_name_valid check (
    label_name is null
    or (char_length(label_name) between 1 and 60 and label_name = btrim(label_name) and label_name !~ '[[:cntrl:]]')
  ),
  add constraint products_light_up_condition_valid check (
    light_up_condition is null or light_up_condition in ('not_checked', 'both_work', 'one_works', 'neither_works')
  ),
  -- A condition exactly when the soles light up.
  add constraint products_light_up_condition_matches check ((light_up is true) = (light_up_condition is not null)),
  add constraint products_light_up_activation_valid check (
    light_up_activation is null
    or (light_up is true and char_length(light_up_activation) between 1 and 120
        and light_up_activation = btrim(light_up_activation) and light_up_activation !~ '[[:cntrl:]]')
  );

comment on column public.products.label_name is
  'Short name for the printed shelf label only (null: the product name). Admin-only; never shown on the website.';
comment on column public.products.light_up is
  'Light-up soles: null = not recorded, false = no, true = yes (then light_up_condition says whether they work).';
comment on column public.products.light_up_condition is
  'When light_up: not_checked, both_work, one_works or neither_works. The shop shows a Light-up badge only for both_work.';
comment on column public.products.light_up_activation is
  'Optional, when light_up: how the lights activate, as the admin observed it (e.g. "Soles flash when walking.").';

-- ---------------------------------------------------------------------------
-- Admin product functions: the same as in 20261031120000_inventory_ledger.sql
-- apart from the new fields
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
    condition_notes, colour, description, price_paisa, publication_status,
    label_name, light_up, light_up_condition, light_up_activation
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
    'draft',
    nullif(p_fields ->> 'label_name', ''),
    (p_fields ->> 'light_up')::boolean,
    p_fields ->> 'light_up_condition',
    nullif(p_fields ->> 'light_up_activation', '')
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
    price_paisa = (p_fields ->> 'price_paisa')::integer,
    -- Left out of p_fields (an older caller): kept as they are.
    label_name = case when p_fields ? 'label_name' then nullif(p_fields ->> 'label_name', '') else label_name end,
    light_up = case when p_fields ? 'light_up' then (p_fields ->> 'light_up')::boolean else light_up end,
    light_up_condition = case when p_fields ? 'light_up' then p_fields ->> 'light_up_condition' else light_up_condition end,
    light_up_activation = case when p_fields ? 'light_up' then nullif(p_fields ->> 'light_up_activation', '') else light_up_activation end
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
-- Scan and label lookups: the same as in 20261029200000_variant_barcodes.sql,
-- plus the label name (the label page and its download route print it)
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

-- Visitors read products column by column from now on: the same columns as
-- before plus the light-up ones, but not label_name. (Revoking the table
-- privilege first; a column grant can't take away part of it.) Row-level
-- security still limits them to published products. Signed-in users keep
-- table-wide SELECT: the admin pages read label_name, and RLS shows
-- unpublished products to verified admins only. Writes are unchanged: the
-- new columns aren't in the column grants for direct updates, so admins
-- change them only through the functions above.
revoke select on table public.products from anon;
grant select (
  id, item_code, slug, name, brand, department, styles, item_status, condition,
  condition_notes, colour, description, price_paisa, publication_status, listed_at,
  created_at, updated_at, version, light_up, light_up_condition, light_up_activation
) on table public.products to anon;
