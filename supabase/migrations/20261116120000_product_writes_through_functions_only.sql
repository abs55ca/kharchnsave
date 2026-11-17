-- Product and photo writes only through the admin functions.
--
-- 20261029120000_admin_product_management.sql gave verified admins column
-- grants on products and product_images, and the admin functions ran as
-- SECURITY INVOKER on top of them. 20261031120000_inventory_ledger.sql made
-- admin_create_product and admin_save_product SECURITY DEFINER, but the
-- grants stayed, so a verified admin's session token could still skip the
-- functions over the REST API: change a published price or name without the
-- version check, archive or back-date a listing, insert products, or delete
-- photo rows (leaving their Storage objects behind).
--
-- 1. The two remaining invoker functions become SECURITY DEFINER, like the
--    other admin product functions. Nothing else about them changes: each
--    still calls admin_require_catalogue_admin() first (the same check the
--    RLS policies made), locks the product and checks its version, and keeps
--    search_path = ''. Their EXECUTE grants are unchanged.
-- 2. Verified admins lose direct INSERT/UPDATE on products and
--    INSERT/UPDATE/DELETE on product_images. As for product_variants in
--    20261031120000, revoking the table privilege also revokes the column
--    grants. SELECT (the admin screens' reads, still limited by RLS) and
--    anon's access are unchanged. No rows, versions, stock or photos change.

alter function public.admin_add_product_image(uuid, integer, uuid, text, integer, integer, text) security definer;
alter function public.admin_set_publication_status(uuid, integer, text) security definer;

revoke insert, update on table public.products from authenticated;
revoke insert, update, delete on table public.product_images from authenticated;
