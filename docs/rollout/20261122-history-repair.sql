-- Audit only: already executed on kharchnsave-dev on 2026-11-22. Do not replay.
begin;
lock table supabase_migrations.schema_migrations in exclusive mode;
do $guard$ begin if (select array_agg(version order by version) from supabase_migrations.schema_migrations) is distinct from array['20261122135902','20261122140020','20261122143848']::text[] then raise exception 'migration history changed'; end if; end $guard$;
delete from supabase_migrations.schema_migrations where version in ('20261122135902','20261122140020','20261122143848');
insert into supabase_migrations.schema_migrations (version,name) values
('20261027120000','create_catalogue'),
('20261027200000','create_admin_members'),
('20261029120000','admin_product_management'),
('20261029200000','variant_barcodes'),
('20261030120000','kns_barcodes'),
('20261031120000','inventory_ledger'),
('20261031130000','guest_orders'),
('20261031140000','settings_where_clauses'),
('20261101120000','label_names_and_light_up'),
('20261101130000','item_codes_and_sale_prices'),
('20261116120000','product_writes_through_functions_only'),
('20261117120000','function_default_privileges'),
('20261117120100','checkout_quota_quotes_and_phone_limit'),
('20261117120200','internal_columns_admin_reads'),
('20261117120300','idempotent_photo_registration'),
('20261117120400','restrict_internal_columns'),
('20261118120000','sales_agents'),
('20261118120100','referral_checkout'),
('20261118120200','commission_accounting'),
('20261118120300','commission_hold_versions'),
('20261121120000','score_pricing_and_sales'),
('20261122134446','pricing_review_guards');
commit;
