-- Admin reads of the internal product columns through admin functions
-- (step 1 of 2: "expand").
--
-- anon reads products and sizes column by column
-- (20261031120000_inventory_ledger.sql, 20261101120000_label_names_and_light_up.sql,
-- 20261101130000_item_codes_and_sale_prices.sql), but authenticated kept
-- table-wide SELECT, so any signed-in account (not only admins) could read the
-- label names and the held stock (reserved, inventory_version) of published
-- products. RLS limits rows, not columns.
--
-- This migration adds the admin read path only and changes no grants, so the
-- previous version of the website keeps working while the new one (which
-- reads through these functions) is rolled out. Step 2,
-- 20261117120400_restrict_internal_columns.sql, then removes the direct column
-- access, once no instance of the previous version is left (README,
-- "D. Hosted follow-up").
--
--   admin_get_products(ids)  the product editor's row, sizes, barcodes and
--                            photos, read in one snapshot (stock and
--                            inventory_version together, which the stale
--                            stock check relies on). Refuses anyone but a
--                            verified admin (member + aal2).
--   admin_scan_product / admin_scan_lookup  (labels and the scan page) become
--                            SECURITY DEFINER so they keep reading label_name
--                            after step 2; they already check for a verified
--                            admin first. Their results are unchanged.

-- The product editor's copy of up to 100 products (any publication status),
-- shaped like the admin pages' former PostgREST select (lib/admin/products.ts).
-- Unknown ids are left out.
create function public.admin_get_products(p_product_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  if p_product_ids is null or cardinality(p_product_ids) > 100 then
    raise exception 'Ask for at most 100 products.' using errcode = 'PT400';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id, 'version', p.version, 'item_code', p.item_code, 'slug', p.slug, 'name', p.name,
      'brand', p.brand, 'department', p.department, 'styles', p.styles, 'item_status', p.item_status,
      'condition', p.condition, 'condition_notes', p.condition_notes, 'colour', p.colour,
      'description', p.description, 'price_paisa', p.price_paisa, 'sale_price_paisa', p.sale_price_paisa,
      'publication_status', p.publication_status, 'listed_at', p.listed_at, 'updated_at', p.updated_at,
      'label_name', p.label_name, 'light_up', p.light_up, 'light_up_condition', p.light_up_condition,
      'light_up_activation', p.light_up_activation,
      'product_variants', coalesce((
        select jsonb_agg(jsonb_build_object(
          'sku', v.sku, 'size_eu', v.size_eu, 'stock', v.stock, 'reserved', v.reserved,
          'inventory_version', v.inventory_version,
          'variant_barcodes', (select jsonb_build_object('barcode', b.barcode) from public.variant_barcodes b where b.variant_id = v.id)
        ) order by v.size_eu)
        from public.product_variants v where v.product_id = p.id
      ), '[]'::jsonb),
      'product_images', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id, 'src', i.src, 'storage_path', i.storage_path, 'alt', i.alt, 'width', i.width,
          'height', i.height, 'sort_order', i.sort_order, 'shows_defect', i.shows_defect
        ) order by i.sort_order)
        from public.product_images i where i.product_id = p.id
      ), '[]'::jsonb)
    ) order by p.updated_at desc, p.id)
    from public.products p
    where p.id = any(p_product_ids)
  ), '[]'::jsonb);
end;
$$;

revoke execute on function public.admin_get_products(uuid[]) from public, anon;
grant execute on function public.admin_get_products(uuid[]) to authenticated;

-- Unchanged otherwise: admin_scan_lookup refuses non-admins first (42501);
-- admin_scan_product returns null to anyone but a verified admin.
alter function public.admin_scan_product(uuid, uuid) security definer;
alter function public.admin_scan_lookup(text) security definer;
