-- Barcodes for in-store scanning: one permanent barcode per sellable unit
-- (a product's size row, public.product_variants).
--
-- Builds on 20261029120000_admin_product_management.sql. Existing tables,
-- constraints, policies and rows are not changed; this migration adds a new
-- table, gives every existing size a barcode there, and adds one rule to
-- products (an item code can't look like a barcode).
--
-- The format is "U" + a 7-digit serial number + a Damm check digit, e.g.
-- U00000013. The check digit catches every single-digit typo and every swap
-- of two neighbouring digits when a code is typed by hand.
--
-- Rules:
--
-- * Every size gets a barcode when it is created (drafts too), issued by the
--   database. Nobody can choose, change, move or delete one, not even through
--   the API's admin functions.
-- * A barcode is never reused. If a draft's size is removed, its barcode stays
--   in public.variant_barcodes with variant_id = null ("retired").
-- * A barcode only identifies a size. Price, stock and details always come
--   from the catalogue tables. Looking one up never changes anything.
-- * Only verified admins (membership + aal2, public.is_catalogue_admin()) can
--   read barcodes or look them up. Visitors and the storefront can't see
--   them: they live in their own table, so the public read access to
--   product_variants is unchanged.

-- ---------------------------------------------------------------------------
-- Barcode format helpers (internal)
-- ---------------------------------------------------------------------------

create sequence public.barcode_serial as integer minvalue 1 maxvalue 9999999 no cycle;

comment on sequence public.barcode_serial is
  'Serial numbers for barcodes (U + 7 digits + check digit). Never cycles: it stops with an error when used up.';

-- Supabase grants API roles access to new sequences by default.
revoke all on sequence public.barcode_serial from public, anon, authenticated;

-- Damm check digit of a string of digits. Appending it makes the check of the
-- whole string 0. Mirrored in lib/barcodes/code.ts (same test vectors).
create function public.barcode_check_digit(p_digits text)
returns integer
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  -- Damm's table: row = interim digit, column = next digit.
  damm constant integer[] := array[
    0, 3, 1, 7, 5, 9, 8, 6, 4, 2,
    7, 0, 9, 2, 1, 5, 4, 8, 6, 3,
    4, 2, 0, 6, 8, 7, 1, 3, 5, 9,
    1, 7, 5, 0, 9, 8, 3, 4, 2, 6,
    6, 1, 2, 3, 0, 4, 5, 9, 7, 8,
    3, 6, 7, 4, 2, 0, 9, 5, 8, 1,
    5, 8, 6, 9, 7, 2, 0, 1, 3, 4,
    8, 9, 4, 5, 3, 6, 2, 0, 1, 7,
    9, 4, 3, 8, 6, 1, 7, 2, 0, 5,
    2, 5, 8, 1, 4, 3, 6, 7, 9, 0
  ];
  interim integer := 0;
begin
  if p_digits !~ '^[0-9]+$' then
    return null;
  end if;
  for i in 1 .. char_length(p_digits) loop
    interim := damm[interim * 10 + substr(p_digits, i, 1)::integer + 1];
  end loop;
  return interim;
end;
$$;

-- "U" + the serial as 7 digits + its check digit.
create function public.format_barcode(p_serial integer)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select 'U' || lpad(p_serial::text, 7, '0') || public.barcode_check_digit(lpad(p_serial::text, 7, '0'))::text;
$$;

create function public.is_valid_barcode(p_barcode text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_barcode ~ '^U[0-9]{8}$' and public.barcode_check_digit(substr(p_barcode, 2)) = 0, false);
$$;

revoke execute on function
  public.barcode_check_digit(text),
  public.format_barcode(integer),
  public.is_valid_barcode(text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The barcode register
-- ---------------------------------------------------------------------------

-- Every barcode ever issued, and the size it belongs to. The primary key is
-- what guarantees a barcode is never issued twice, whatever the serial
-- number counter does.
create table public.variant_barcodes (
  barcode text primary key,
  -- Null once the size was removed (only possible before the product was
  -- first published): the barcode is retired, never reused.
  variant_id uuid references public.product_variants (id) on delete set null,
  product_id uuid references public.products (id) on delete set null,
  sku_at_issue text not null,
  size_eu numeric(3, 1) not null,
  created_at timestamptz not null default now(),

  constraint variant_barcodes_barcode_valid check (public.is_valid_barcode(barcode)),
  -- At most one barcode per size (several retired rows may have null).
  constraint variant_barcodes_variant_key unique (variant_id)
);

comment on table public.variant_barcodes is
  'Permanent register of in-store barcodes: one per size (product_variants row), never changed, moved or reused.';
comment on column public.variant_barcodes.barcode is
  'U + 7-digit serial + Damm check digit, e.g. U00000013. Printed on the label as Code 128.';
comment on column public.variant_barcodes.variant_id is
  'The size this barcode belongs to; null once that size was removed (the barcode is then retired).';
comment on column public.variant_barcodes.sku_at_issue is
  'The size''s SKU when the barcode was issued, kept for history (a draft''s SKU can still change).';
comment on column public.variant_barcodes.size_eu is
  'The EU size the barcode was issued for (a size row''s size never changes; changing it replaces the row).';

-- Existing sizes, in a fixed order: item code, then size.
insert into public.variant_barcodes (barcode, variant_id, product_id, sku_at_issue, size_eu)
select public.format_barcode((row_number() over (order by p.item_code, v.size_eu))::integer), v.id, v.product_id, v.sku, v.size_eu
from public.product_variants v
join public.products p on p.id = v.product_id;

select setval(
  'public.barcode_serial',
  greatest((select count(*) from public.variant_barcodes), 1),
  (select count(*) > 0 from public.variant_barcodes)
);

-- ---------------------------------------------------------------------------
-- Issuing barcodes, and keeping them fixed
-- ---------------------------------------------------------------------------

-- Runs as the owner (API roles have no access to the register or the
-- counter). If the counter ever pointed at a barcode that already exists, it
-- moves on to the next number instead of failing or reusing it.
create function public.issue_variant_barcode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate text;
begin
  loop
    candidate := public.format_barcode(nextval('public.barcode_serial'::regclass)::integer);
    insert into public.variant_barcodes (barcode, variant_id, product_id, sku_at_issue, size_eu)
    values (candidate, new.id, new.product_id, new.sku, new.size_eu)
    on conflict (barcode) do nothing;
    exit when found;
  end loop;
  return null;
end;
$$;

revoke execute on function public.issue_variant_barcode() from public, anon, authenticated;

create trigger product_variants_issue_barcode
  after insert on public.product_variants
  for each row execute function public.issue_variant_barcode();

-- A barcode never changes, never moves to another size and is never deleted.
-- The only change allowed is the database itself clearing variant_id or
-- product_id when that size or product is deleted (ON DELETE SET NULL).
create function public.variant_barcodes_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Separate branches: DELETE and TRUNCATE have no NEW row.
  if tg_op <> 'UPDATE' then
    raise exception 'Barcodes are permanent: they can''t be changed, moved to another size or deleted.'
      using errcode = 'PT400', hint = 'barcode_locked';
  end if;
  if new.barcode is distinct from old.barcode
    or new.sku_at_issue is distinct from old.sku_at_issue
    or new.size_eu is distinct from old.size_eu
    or new.created_at is distinct from old.created_at
    or (new.variant_id is distinct from old.variant_id and new.variant_id is not null)
    or (new.product_id is distinct from old.product_id and new.product_id is not null) then
    raise exception 'Barcodes are permanent: they can''t be changed, moved to another size or deleted.'
      using errcode = 'PT400', hint = 'barcode_locked';
  end if;
  return new;
end;
$$;

revoke execute on function public.variant_barcodes_guard() from public, anon, authenticated;

create trigger variant_barcodes_guard
  before update or delete on public.variant_barcodes
  for each row execute function public.variant_barcodes_guard();

create trigger variant_barcodes_no_truncate
  before truncate on public.variant_barcodes
  for each statement execute function public.variant_barcodes_guard();

-- Scanned text is looked up as a barcode first, then as an item code, so an
-- item code must never look like a barcode.
alter table public.products
  add constraint products_item_code_not_barcode check (item_code !~ '^U[0-9]{8}$');

-- ---------------------------------------------------------------------------
-- Access: verified admins can read barcodes; nobody writes through the API
-- ---------------------------------------------------------------------------

alter table public.variant_barcodes enable row level security;

revoke all on table public.variant_barcodes from public, anon, authenticated;
grant select on table public.variant_barcodes to authenticated;

create policy "Verified admins can read barcodes"
  on public.variant_barcodes for select to authenticated
  using ((select public.is_catalogue_admin()));

-- ---------------------------------------------------------------------------
-- Scan lookup (read only)
--
-- STABLE functions can't change data (Postgres refuses INSERT, UPDATE and
-- DELETE inside them), so a lookup can never change stock. SECURITY INVOKER:
-- the caller's own grants and RLS apply to every read.
-- ---------------------------------------------------------------------------

-- A product with its sizes (all of them, or just p_variant_id), their
-- barcodes and its main photo, or null if the caller isn't a verified admin.
create function public.admin_scan_product(p_product_id uuid, p_variant_id uuid)
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

-- Looks up scanned or typed text: a barcode first, then an exact item code,
-- then an exact SKU. Spaces are ignored and letters uppercased. Returns
--   {"kind": "unit", "matched_by": "barcode" | "sku", "code", "product"}
--   {"kind": "product", "matched_by": "item_code", "code", "product"}  (all sizes)
--   {"kind": "retired", "code", "sku", "size_eu", "product"}  (product may be null)
--   {"kind": "not_found", "code"}
create function public.admin_scan_lookup(p_code text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  code text := upper(regexp_replace(coalesce(p_code, ''), '[[:space:]]', '', 'g'));
  issued public.variant_barcodes;
  match_product uuid;
  match_variant uuid;
begin
  perform public.admin_require_catalogue_admin();
  if code = '' or char_length(code) > 40 then
    return jsonb_build_object('kind', 'not_found', 'code', left(code, 40));
  end if;

  select * into issued from public.variant_barcodes b where b.barcode = code;
  if found then
    if issued.variant_id is null then
      return jsonb_build_object(
        'kind', 'retired', 'code', code, 'sku', issued.sku_at_issue, 'size_eu', issued.size_eu,
        'product', public.admin_scan_product(issued.product_id, null)
      );
    end if;
    select v.product_id into match_product from public.product_variants v where v.id = issued.variant_id;
    return jsonb_build_object(
      'kind', 'unit', 'matched_by', 'barcode', 'code', code,
      'product', public.admin_scan_product(match_product, issued.variant_id)
    );
  end if;

  select p.id into match_product from public.products p where p.item_code = code;
  if found then
    return jsonb_build_object(
      'kind', 'product', 'matched_by', 'item_code', 'code', code,
      'product', public.admin_scan_product(match_product, null)
    );
  end if;

  select v.product_id, v.id into match_product, match_variant from public.product_variants v where v.sku = code;
  if found then
    return jsonb_build_object(
      'kind', 'unit', 'matched_by', 'sku', 'code', code,
      'product', public.admin_scan_product(match_product, match_variant)
    );
  end if;

  return jsonb_build_object('kind', 'not_found', 'code', code);
end;
$$;

revoke execute on function
  public.admin_scan_product(uuid, uuid),
  public.admin_scan_lookup(text)
  from public, anon;
grant execute on function
  public.admin_scan_product(uuid, uuid),
  public.admin_scan_lookup(text)
  to authenticated;
