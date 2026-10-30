-- =============================================================================
-- BROWSER TEST FIXTURES, LOCAL SUPABASE ONLY. Never run against kharchnsave-dev
-- or any hosted project.
-- =============================================================================
--
-- Adds what the dev fixtures (supabase/seeds/dev_catalogue_fixtures.sql)
-- don't have: an archived product, for the scan page's "Archived" message.
-- Load the dev fixtures first. Safe to rerun.
--
--   E2E-ARCHIVED   archived   men   pre-loved   EU 41, stock 1

begin;

insert into public.products (
  item_code, slug, name, brand, department, styles, item_status, condition,
  colour, description, price_paisa, publication_status, listed_at
)
values (
  'E2E-ARCHIVED', 'e2e-archived-pair', 'Archived test pair', 'Testbrand', 'men', '{casual}', 'preloved', 'good',
  'Brown', 'Browser test fixture.', 300000, 'archived', '2026-10-01'
)
on conflict (item_code) do nothing;

insert into public.product_variants (product_id, item_status, sku, size_eu, stock)
select p.id, p.item_status, 'E2E-ARCHIVED-41', 41, 1
from public.products p
where p.item_code = 'E2E-ARCHIVED'
on conflict (sku) do nothing;

commit;
