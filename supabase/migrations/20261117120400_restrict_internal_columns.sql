-- Internal product columns only for verified admins (step 2 of 2: "contract").
--
-- Apply only after every running copy of the website reads products in the
-- admin through admin_get_products (20261117120200_internal_columns_admin_reads.sql):
-- the previous version's product list and editor select label_name, reserved
-- and inventory_version directly and stop loading once this is applied. The
-- storefront, checkout, scan and label pages of either version are unaffected.
-- Rollout and recovery: README, "D. Hosted follow-up".
--
-- Afterwards authenticated has exactly anon's column list on products and
-- product_variants (RLS unchanged: published rows, plus every row for
-- verified admins, so the admin pages still list drafts). Nobody reads
-- label_name, reserved or inventory_version directly; verified admins read
-- them through admin_get_products and the scan functions.

revoke select on table public.products from authenticated;
grant select (
  id, item_code, slug, name, brand, department, styles, item_status, condition,
  condition_notes, colour, description, price_paisa, sale_price_paisa, publication_status, listed_at,
  created_at, updated_at, version, light_up, light_up_condition, light_up_activation
) on table public.products to authenticated;

revoke select on table public.product_variants from authenticated;
grant select (id, product_id, item_status, sku, size_eu, stock, created_at, updated_at)
  on table public.product_variants to authenticated;
