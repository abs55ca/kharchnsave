-- KNS barcodes: the barcode format changes from "U" + 8 digits (U00000084) to
-- "KNS" + 8 digits (KNS00000084): a 7-digit serial number and its Damm check
-- digit, computed over the 7 digits as before.
--
-- Builds on 20261029200000_variant_barcodes.sql, which is not changed. Only
-- test labels were ever printed with U barcodes, so they are retired rather
-- than kept as a second live format:
--
-- * Every size that has a U barcode gets a KNS barcode with a fresh serial
--   number from the counter, in item-code then size order. Its U barcode
--   stays in the register, retired (variant_id = null), with its product, SKU
--   and size as they were. Scanning it says the label is no longer in use and
--   names the size's current barcode.
-- * From now on only KNS barcodes are issued. A U barcode can only exist as a
--   retired row (variant_barcodes_barcode_format).
-- * A serial number is used once, whatever the prefix: KNS00000084 can never be
--   issued if U00000084 was (variant_barcodes_serial_key).
--
-- The rules of the first migration still hold: no barcode's text, SKU, size or
-- date is changed, nothing is deleted, and nothing is reused. The one exception
-- is this migration itself, which gives the sizes that had a U barcode a new
-- one, once. Retiring uses the same step as removing a draft's size (clearing
-- variant_id), which the guard trigger already allows, so no trigger is
-- disabled.
--
-- On a project with no sizes yet (a new production project), the replacement
-- step does nothing and no U barcode ever exists.
--
-- Also: item codes can't look like a KNS barcode (or "KN5" + 8 digits, which
-- the scan box reads as KNS), and the scan lookup reads "KN5…" as "KNS…".

-- ---------------------------------------------------------------------------
-- Format helpers
-- ---------------------------------------------------------------------------

-- Replacing the function a CHECK constraint uses doesn't recheck existing
-- rows, so the constraint is dropped here and added back (checked) below.
alter table public.variant_barcodes drop constraint variant_barcodes_barcode_valid;

-- "KNS" + the serial as 7 digits + its check digit.
create or replace function public.format_barcode(p_serial integer)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select 'KNS' || lpad(p_serial::text, 7, '0') || public.barcode_check_digit(lpad(p_serial::text, 7, '0'))::text;
$$;

-- A current (KNS) barcode with a correct check digit.
create or replace function public.is_valid_barcode(p_barcode text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_barcode ~ '^KNS[0-9]{8}$' and public.barcode_check_digit(right(p_barcode, 8)) = 0, false);
$$;

-- A retired U barcode with a correct check digit.
create function public.is_legacy_barcode(p_barcode text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_barcode ~ '^U[0-9]{8}$' and public.barcode_check_digit(right(p_barcode, 8)) = 0, false);
$$;

revoke execute on function public.is_legacy_barcode(text) from public, anon, authenticated;

comment on sequence public.barcode_serial is
  'Serial numbers for barcodes (KNS + 7 digits + check digit). Never cycles: it stops with an error when used up.';

-- ---------------------------------------------------------------------------
-- A serial number is used once, whatever the prefix
-- ---------------------------------------------------------------------------

create unique index variant_barcodes_serial_key on public.variant_barcodes (right(barcode, 8));

-- As before, but skipping any serial already used by a barcode of either
-- format (the same barcode always means the same serial, so this also covers
-- the primary key).
create or replace function public.issue_variant_barcode()
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
    on conflict ((right(barcode, 8))) do nothing;
    exit when found;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Retire the U barcodes and issue KNS replacements
-- ---------------------------------------------------------------------------

do $$
declare
  size record;
  candidate text;
begin
  for size in
    select v.id, v.product_id, v.sku, v.size_eu
    from public.variant_barcodes b
    join public.product_variants v on v.id = b.variant_id
    join public.products p on p.id = v.product_id
    where b.barcode ~ '^U[0-9]{8}$'
    order by p.item_code, v.size_eu
  loop
    -- Retire first: a size has at most one barcode (variant_barcodes_variant_key).
    update public.variant_barcodes set variant_id = null where variant_id = size.id;
    loop
      candidate := public.format_barcode(nextval('public.barcode_serial'::regclass)::integer);
      insert into public.variant_barcodes (barcode, variant_id, product_id, sku_at_issue, size_eu)
      values (candidate, size.id, size.product_id, size.sku, size.size_eu)
      on conflict ((right(barcode, 8))) do nothing;
      exit when found;
    end loop;
  end loop;
end;
$$;

-- Live barcodes are KNS; a U barcode can only be a retired one.
alter table public.variant_barcodes
  add constraint variant_barcodes_barcode_format check (
    public.is_valid_barcode(barcode) or (public.is_legacy_barcode(barcode) and variant_id is null)
  );

comment on table public.variant_barcodes is
  'Permanent register of in-store barcodes: one per size (product_variants row), never changed, moved or reused. Retired U barcodes from before KNS are kept with no size.';
comment on column public.variant_barcodes.barcode is
  'KNS + 7-digit serial + Damm check digit, e.g. KNS00000013, printed on the label as Code 128. Retired rows may have the first format, U + 8 digits.';

-- ---------------------------------------------------------------------------
-- Item codes can't look like a KNS barcode
-- ---------------------------------------------------------------------------

-- "KN5" too: the scan lookup reads it as "KNS", so such an item code could
-- never be found by scanning. The U rule (products_item_code_not_barcode)
-- stays: U barcodes still scan, as retired labels.
alter table public.products
  add constraint products_item_code_not_kns_barcode check (item_code !~ '^KN[S5][0-9]{8}$');

-- ---------------------------------------------------------------------------
-- Scan lookup: "KN5…" reads as "KNS…", and a retired barcode names the
-- size's current one
-- ---------------------------------------------------------------------------

-- Looks up scanned or typed text: a barcode first, then an exact item code,
-- then an exact SKU. Spaces are ignored, letters uppercased, and "KN5" + 8
-- digits read as "KNS" + 8 digits. Returns
--   {"kind": "unit", "matched_by": "barcode" | "sku", "code", "product"}
--   {"kind": "product", "matched_by": "item_code", "code", "product"}  (all sizes)
--   {"kind": "retired", "code", "sku", "size_eu", "current_barcode", "product"}
--     (current_barcode: the barcode now on that product's size with the same
--     EU size, or null; product may be null)
--   {"kind": "not_found", "code"}
create or replace function public.admin_scan_lookup(p_code text)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  code text := regexp_replace(
    upper(regexp_replace(coalesce(p_code, ''), '[[:space:]]', '', 'g')),
    '^KN5([0-9]{8})$', 'KNS\1');
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
        'current_barcode', (
          select b.barcode
          from public.product_variants v
          join public.variant_barcodes b on b.variant_id = v.id
          where v.product_id = issued.product_id and v.size_eu = issued.size_eu
        ),
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
