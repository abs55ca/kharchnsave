-- Only after every app using this database reads internal product fields
-- through admin_get_products. This completes the deferred 20261117120400
-- contract on a database where the pricing expansion is already installed.
-- Preserve the two public columns added by the later pricing migration.
-- No product data changes. See docs/pricing-rollout-review.md.

begin;
revoke select on table public.products from authenticated;
grant select (
  id, item_code, slug, name, brand, department, styles, item_status, condition,
  condition_notes, colour, description, price_paisa, sale_price_paisa,
  publication_status, listed_at, created_at, updated_at, version,
  light_up, light_up_condition, light_up_activation,
  reference_price_paisa, referral_excluded
) on table public.products to authenticated;

revoke select on table public.product_variants from authenticated;
grant select (id, product_id, item_status, sku, size_eu, stock, created_at, updated_at)
  on table public.product_variants to authenticated;
notify pgrst, 'reload schema';
commit;
