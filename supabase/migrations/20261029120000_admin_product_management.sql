-- Product management for verified admins: write access to the catalogue,
-- publishing rules, stable identifiers, conflict detection and product photos
-- in Supabase Storage.
--
-- Builds on 20261027120000_create_catalogue.sql and
-- 20261027200000_create_admin_members.sql. Existing constraints, policies and
-- data are kept; this migration only adds to them, and changes no rows.
--
-- Who can do what afterwards:
--
-- * Visitors (anon) and signed-in users who are not verified admins: exactly as
--   before. They can read published products, their sizes and photos, and
--   nothing else. They can't write anything or call the admin functions.
-- * A verified admin: a signed-in user with a row in public.admin_members AND a
--   session that completed two-step verification (JWT "aal" = "aal2"), checked
--   by public.is_catalogue_admin(). They can read every product (drafts and
--   archived too), create drafts, edit, publish, unpublish and archive. Nobody
--   can delete a product through the API.
-- * An admin who signed in with only a password (aal1) is treated like any
--   other signed-in user: published reads only, no writes.
--
-- Admin-membership management is not changed: memberships stay owner-only.
--
-- Photos are stored in a PRIVATE Storage bucket named "product-photos", which
-- the owner creates in the dashboard (see README, "Product photos"). This
-- migration only adds access policies for it; it does not write Storage
-- metadata. Shoppers can read a photo only while it belongs to a published
-- product; admins can read, upload and remove photos. Nobody can overwrite or
-- move one.

-- ---------------------------------------------------------------------------
-- Who is a verified admin
-- ---------------------------------------------------------------------------

-- Security invoker: it reads the caller's own admin_members row (the only row
-- RLS lets them see) and the caller's verified JWT.
create function public.is_catalogue_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false)
    and exists (
      select 1 from public.admin_members m where m.user_id = (select auth.uid())
    );
$$;

comment on function public.is_catalogue_admin() is
  'True only for an admin_members user whose session completed two-step verification (aal2).';

revoke execute on function public.is_catalogue_admin() from public, anon;
grant execute on function public.is_catalogue_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------

-- Bumped on every change to a product (by the trigger below), so a save based
-- on an older copy is detected instead of silently overwriting newer work.
-- Adding a column with a default doesn't fire update triggers or touch rows.
alter table public.products
  add column version integer not null default 1;

comment on column public.products.version is
  'Increases on every change; admin saves must name the version they edited (conflict detection).';

-- Uploaded photos live in Storage and are referenced by their object path,
-- never by a (possibly expiring) URL. Existing photos keep using src (a site
-- path or https URL); each image has exactly one of the two.
alter table public.product_images
  alter column src drop not null,
  add column storage_path text;

comment on column public.product_images.storage_path is
  'Object path in the private product-photos bucket: <product id>/<image id>.webp. Null for site/URL images (src).';

-- ---------------------------------------------------------------------------
-- Extra rules (all existing rows already satisfy them; if one doesn't, the
-- migration stops with that constraint's name and changes nothing)
-- ---------------------------------------------------------------------------

alter table public.products
  add constraint products_item_code_length check (char_length(item_code) <= 40),
  add constraint products_name_length check (char_length(name) <= 120),
  add constraint products_brand_length check (char_length(brand) <= 60),
  add constraint products_colour_length check (char_length(colour) <= 60),
  add constraint products_description_length check (char_length(description) <= 4000),
  add constraint products_condition_notes_count check (cardinality(condition_notes) <= 12),
  -- Rs. 10,00,000 at most: catches a misplaced digit.
  add constraint products_price_maximum check (price_paisa <= 100000000),
  add constraint products_version_positive check (version > 0),
  -- Publishing rules that can be checked on the row itself. Sizes and photos
  -- are checked by the deferred trigger further down.
  add constraint products_published_price_positive check (publication_status <> 'published' or price_paisa > 0),
  add constraint products_published_needs_description check (publication_status <> 'published' or btrim(description) <> ''),
  add constraint products_published_needs_style check (publication_status <> 'published' or cardinality(styles) > 0);

alter table public.product_variants
  add constraint product_variants_stock_maximum check (stock <= 9999);

alter table public.product_images
  add constraint product_images_one_source check ((src is null) <> (storage_path is null)),
  add constraint product_images_storage_path_format check (
    storage_path is null
    or storage_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
  ),
  -- The object lives in its own product's folder.
  add constraint product_images_storage_path_in_product_folder check (
    storage_path is null or split_part(storage_path, '/', 1) = product_id::text
  ),
  add constraint product_images_storage_path_key unique (storage_path),
  add constraint product_images_alt_length check (char_length(alt) <= 300),
  add constraint product_images_dimensions_maximum check (width <= 10000 and height <= 10000);

-- ---------------------------------------------------------------------------
-- Stable identifiers and the version counter
-- ---------------------------------------------------------------------------

-- A product counts as "has been published" once listed_at is set; it is set
-- when a product is first published and is never cleared.
create function public.products_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id then
    raise exception 'A product''s ID never changes.'
      using errcode = 'PT400', hint = 'id_locked';
  end if;
  if old.listed_at is not null and new.item_code is distinct from old.item_code then
    raise exception 'The item code can''t change once the product has been published.'
      using errcode = 'PT400', hint = 'item_code_locked';
  end if;
  if old.listed_at is not null and new.listed_at is null then
    raise exception 'A published product''s listing date can''t be removed.'
      using errcode = 'PT400', hint = 'listed_at_locked';
  end if;
  new.version := old.version + 1;
  return new;
end;
$$;

revoke execute on function public.products_guard_update() from public, anon, authenticated;

create trigger products_guard_update
  before update on public.products
  for each row execute function public.products_guard_update();

-- A size's SKU (and the size itself) is fixed once the product has been
-- published, and such sizes can't be deleted (set the stock to 0 instead), so
-- an SKU is never reused for something else. Deleting a whole product as the
-- database owner still cascades (pg_trigger_depth() > 1).
create function public.product_variants_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_published boolean;
begin
  -- (product_id itself isn't updatable through the API: no column grant.)
  select p.listed_at is not null into was_published
  from public.products p where p.id = old.product_id;

  if coalesce(was_published, false) then
    if tg_op = 'DELETE' and pg_trigger_depth() <= 1 then
      raise exception 'Sizes of a product that has been published can''t be removed; set the stock to 0 instead.'
        using errcode = 'PT400', hint = 'variant_locked';
    end if;
    if tg_op = 'UPDATE' and (new.sku is distinct from old.sku or new.size_eu is distinct from old.size_eu) then
      raise exception 'The SKU and size can''t change once the product has been published.'
        using errcode = 'PT400', hint = 'sku_locked';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke execute on function public.product_variants_guard() from public, anon, authenticated;

create trigger product_variants_guard
  before update or delete on public.product_variants
  for each row execute function public.product_variants_guard();

-- ---------------------------------------------------------------------------
-- A published product must have at least one size and one photo. Checked at
-- the end of the transaction, so a save can replace sizes and photos in any
-- order. (Zero stock is allowed: sold-out listings stay visible.)
-- ---------------------------------------------------------------------------

create function public.check_published_product_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
begin
  -- Separate branches: PL/pgSQL can only read fields the table actually has.
  if tg_table_name = 'products' then
    target := new.id;
  elsif tg_op = 'DELETE' then
    target := old.product_id;
  else
    target := new.product_id;
  end if;

  if exists (
    select 1 from public.products p
    where p.id = target and p.publication_status = 'published'
  ) then
    if not exists (select 1 from public.product_variants v where v.product_id = target) then
      raise exception 'A published product needs at least one size.'
        using errcode = '23514', constraint = 'products_published_needs_size';
    end if;
    if not exists (select 1 from public.product_images i where i.product_id = target) then
      raise exception 'A published product needs at least one photo.'
        using errcode = '23514', constraint = 'products_published_needs_photo';
    end if;
  end if;
  return null;
end;
$$;

revoke execute on function public.check_published_product_complete() from public, anon, authenticated;

create constraint trigger products_published_complete
  after insert or update on public.products
  deferrable initially deferred
  for each row execute function public.check_published_product_complete();

create constraint trigger product_variants_published_complete
  after delete or update on public.product_variants
  deferrable initially deferred
  for each row execute function public.check_published_product_complete();

create constraint trigger product_images_published_complete
  after delete or update on public.product_images
  deferrable initially deferred
  for each row execute function public.check_published_product_complete();

-- ---------------------------------------------------------------------------
-- Table access for verified admins (anon's read-only access is unchanged)
-- ---------------------------------------------------------------------------

-- Column lists leave out IDs, timestamps and version (managed by the
-- database) and product_images.src (admins add photos through Storage only).
grant insert (
  item_code, slug, name, brand, department, styles, item_status, condition,
  condition_notes, colour, description, price_paisa, publication_status, listed_at
) on table public.products to authenticated;
grant update (
  item_code, slug, name, brand, department, styles, item_status, condition,
  condition_notes, colour, description, price_paisa, publication_status, listed_at
) on table public.products to authenticated;
-- No DELETE on products: listings are archived, never deleted.

grant insert (product_id, item_status, sku, size_eu, stock) on table public.product_variants to authenticated;
grant update (sku, stock) on table public.product_variants to authenticated;
grant delete on table public.product_variants to authenticated;

grant insert (id, product_id, storage_path, alt, width, height, sort_order, focus, shows_defect)
  on table public.product_images to authenticated;
grant update (alt, sort_order, focus, shows_defect) on table public.product_images to authenticated;
grant delete on table public.product_images to authenticated;

-- Every policy below requires a verified admin (member + aal2). They sit
-- alongside the existing "Public can read published ..." policies.
create policy "Verified admins can read all products"
  on public.products for select to authenticated
  using ((select public.is_catalogue_admin()));

create policy "Verified admins can create draft products"
  on public.products for insert to authenticated
  with check ((select public.is_catalogue_admin()) and publication_status = 'draft');

create policy "Verified admins can update products"
  on public.products for update to authenticated
  using ((select public.is_catalogue_admin()))
  with check ((select public.is_catalogue_admin()));

create policy "Verified admins can read all sizes"
  on public.product_variants for select to authenticated
  using ((select public.is_catalogue_admin()));

create policy "Verified admins can add sizes"
  on public.product_variants for insert to authenticated
  with check ((select public.is_catalogue_admin()));

create policy "Verified admins can update sizes"
  on public.product_variants for update to authenticated
  using ((select public.is_catalogue_admin()))
  with check ((select public.is_catalogue_admin()));

create policy "Verified admins can remove sizes"
  on public.product_variants for delete to authenticated
  using ((select public.is_catalogue_admin()));

create policy "Verified admins can read all photos"
  on public.product_images for select to authenticated
  using ((select public.is_catalogue_admin()));

create policy "Verified admins can add photos"
  on public.product_images for insert to authenticated
  with check ((select public.is_catalogue_admin()));

create policy "Verified admins can update photos"
  on public.product_images for update to authenticated
  using ((select public.is_catalogue_admin()))
  with check ((select public.is_catalogue_admin()));

create policy "Verified admins can remove photos"
  on public.product_images for delete to authenticated
  using ((select public.is_catalogue_admin()));

-- ---------------------------------------------------------------------------
-- Admin functions (RPCs). SECURITY INVOKER: they run with the caller's own
-- rights, so the grants and policies above still apply to every statement.
-- Each one also checks is_catalogue_admin() first and the product's version,
-- and does all its work in one transaction (all or nothing).
--
-- Errors use SQLSTATE PT400 (bad request), PT404 (not found), PT409 (someone
-- else saved first) and 42501 (not a verified admin), which PostgREST turns
-- into the matching HTTP status. Constraint violations keep their own codes.
-- ---------------------------------------------------------------------------

create function public.admin_require_catalogue_admin()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not public.is_catalogue_admin() then
    raise exception 'Only verified admins can manage products.' using errcode = '42501';
  end if;
end;
$$;

-- Locks the product row and checks it is the version the caller edited.
create function public.admin_lock_product(p_product_id uuid, p_expected_version integer)
returns public.products
language plpgsql
security invoker
set search_path = ''
as $$
declare
  found_product public.products;
begin
  perform public.admin_require_catalogue_admin();
  select * into found_product from public.products where id = p_product_id for update;
  if not found then
    raise exception 'Product not found.' using errcode = 'PT404';
  end if;
  if p_expected_version is null or found_product.version <> p_expected_version then
    raise exception 'This product was changed somewhere else since you opened it.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;
  return found_product;
end;
$$;

-- "<item code>-<size>", e.g. PL-M-1001-43 or NW-K-3001-19.5
create function public.catalogue_sku(p_item_code text, p_size numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_item_code || '-' || trim_scale(p_size)::text;
$$;

create function public.admin_create_product(p_fields jsonb, p_sizes jsonb)
returns jsonb
language plpgsql
security invoker
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
--   p_sizes:  [{"size": 42.5, "stock": 1}, ...]            the complete list
--   p_images: [{"id": "...", "alt": "...", "shows_defect": false}, ...]
--             every photo to keep, in display order; others are removed from
--             the listing (their Storage paths are returned for clean-up).
create function public.admin_save_product(
  p_product_id uuid,
  p_expected_version integer,
  p_fields jsonb,
  p_sizes jsonb,
  p_images jsonb
)
returns jsonb
language plpgsql
security invoker
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

  current_product := public.admin_lock_product(p_product_id, p_expected_version);

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

  -- Sizes no longer listed (blocked by a trigger once the product has been published).
  delete from public.product_variants v
  where v.product_id = p_product_id
    and v.size_eu not in (select (s ->> 'size')::numeric from jsonb_array_elements(p_sizes) s);

  -- Changing to pre-loved: lower the stock first (pre-loved allows 0 or 1).
  -- Changing to new: change the product first, then raise the stock.
  if target_status = 'preloved' then
    update public.product_variants v
    set stock = (s ->> 'stock')::integer
    from jsonb_array_elements(p_sizes) s
    where v.product_id = p_product_id and v.size_eu = (s ->> 'size')::numeric
      and v.stock is distinct from (s ->> 'stock')::integer;
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

  update public.product_variants v
  set stock = (s ->> 'stock')::integer
  from jsonb_array_elements(p_sizes) s
  where v.product_id = p_product_id and v.size_eu = (s ->> 'size')::numeric
    and v.stock is distinct from (s ->> 'stock')::integer;

  -- A draft that has never been published may still change its item code;
  -- its SKUs follow (the trigger refuses this once it has been published).
  update public.product_variants v
  set sku = public.catalogue_sku(p_fields ->> 'item_code', v.size_eu)
  where v.product_id = p_product_id
    and v.sku <> public.catalogue_sku(p_fields ->> 'item_code', v.size_eu)
    and current_product.item_code is distinct from p_fields ->> 'item_code';

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

-- Records a photo that has just been uploaded to Storage, as the last photo.
create function public.admin_add_product_image(
  p_product_id uuid,
  p_expected_version integer,
  p_image_id uuid,
  p_storage_path text,
  p_width integer,
  p_height integer,
  p_alt text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_version integer;
begin
  perform public.admin_require_catalogue_admin();
  perform public.admin_lock_product(p_product_id, p_expected_version);

  if (select count(*) from public.product_images where product_id = p_product_id) >= 12 then
    raise exception 'A product can have at most 12 photos.' using errcode = 'PT400', hint = 'too_many_photos';
  end if;

  insert into public.product_images (id, product_id, storage_path, alt, width, height, sort_order)
  values (
    p_image_id, p_product_id, p_storage_path, p_alt, p_width, p_height,
    coalesce((select max(sort_order) + 1 from public.product_images where product_id = p_product_id), 0)
  );

  -- Count the new photo as a change to the product (bumps its version).
  update public.products set name = name where id = p_product_id
  returning version into new_version;

  set constraints all immediate;
  return new_version;
end;
$$;

-- Publish, unpublish (back to draft), archive, or restore an archived product
-- as a draft. Publishing sets the listing date the first time.
create function public.admin_set_publication_status(
  p_product_id uuid,
  p_expected_version integer,
  p_status text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_product public.products;
  new_version integer;
begin
  perform public.admin_require_catalogue_admin();
  current_product := public.admin_lock_product(p_product_id, p_expected_version);

  if not (current_product.publication_status, p_status) in (
    ('draft', 'published'), ('published', 'draft'),
    ('draft', 'archived'), ('published', 'archived'),
    ('archived', 'draft')
  ) then
    raise exception 'A % product can''t be changed to %.', current_product.publication_status, p_status
      using errcode = 'PT400', hint = 'bad_transition';
  end if;

  update public.products set
    publication_status = p_status,
    listed_at = case when p_status = 'published' then coalesce(listed_at, current_date) else listed_at end
  where id = p_product_id
  returning version into new_version;

  set constraints all immediate;
  return new_version;
end;
$$;

-- Supabase lets API roles execute new functions by default. Only signed-in
-- users may call the admin functions (which then require a verified admin);
-- the helpers are internal.
revoke execute on function
  public.admin_require_catalogue_admin(),
  public.admin_lock_product(uuid, integer),
  public.catalogue_sku(text, numeric),
  public.admin_create_product(jsonb, jsonb),
  public.admin_save_product(uuid, integer, jsonb, jsonb, jsonb),
  public.admin_add_product_image(uuid, integer, uuid, text, integer, integer, text),
  public.admin_set_publication_status(uuid, integer, text)
  from public, anon;
grant execute on function
  public.admin_require_catalogue_admin(),
  public.admin_lock_product(uuid, integer),
  public.catalogue_sku(text, numeric),
  public.admin_create_product(jsonb, jsonb),
  public.admin_save_product(uuid, integer, jsonb, jsonb, jsonb),
  public.admin_add_product_image(uuid, integer, uuid, text, integer, integer, text),
  public.admin_set_publication_status(uuid, integer, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: the private "product-photos" bucket
-- ---------------------------------------------------------------------------

-- Shoppers: a photo is readable only while a published product uses it. The
-- subquery runs with the reader's own rights, so the catalogue's RLS also
-- limits it to published products.
create policy "Shoppers can view photos of published products"
  on storage.objects for select to anon, authenticated
  using (
    bucket_id = 'product-photos'
    and exists (
      select 1
      from public.product_images i
      join public.products p on p.id = i.product_id
      where i.storage_path = objects.name
        and p.publication_status = 'published'
    )
  );

-- Admins can read every photo, including drafts and unused uploads (also
-- needed to remove them).
create policy "Verified admins can view all product photos"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-photos' and (select public.is_catalogue_admin()));

-- New uploads only, at <existing product id>/<new id>.webp. With no UPDATE
-- policy, existing photos can't be overwritten or moved.
create policy "Verified admins can upload product photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-photos'
    and (select public.is_catalogue_admin())
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$'
    and exists (select 1 from public.products p where p.id::text = split_part(objects.name, '/', 1))
  );

create policy "Verified admins can remove product photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-photos' and (select public.is_catalogue_admin()));
