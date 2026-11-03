-- Saving /admin/settings (and the delivery city list) failed with 21000
-- "UPDATE requires a WHERE clause": Supabase loads pg-safeupdate for API
-- requests, which refuses UPDATE and DELETE statements without a WHERE
-- clause, even inside security definer functions. The SQL tests run as the
-- database owner without it, so they passed.
--
-- Same two functions as in 20261031130000_guest_orders.sql, each with a WHERE
-- clause added; nothing else changes. CREATE OR REPLACE keeps the owner and
-- the grants (verified admins only, through admin_require_catalogue_admin).

create or replace function public.admin_update_shop_settings(p_expected_version integer, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  current_settings public.shop_settings;
  updated public.shop_settings;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_settings) is distinct from 'object' then
    raise exception 'Malformed settings.' using errcode = 'PT400';
  end if;
  select * into current_settings from public.shop_settings for update;
  if p_expected_version is distinct from current_settings.version then
    raise exception 'The settings were changed somewhere else since you opened them.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;
  update public.shop_settings set
    version = version + 1,
    orders_open = coalesce((p_settings ->> 'orders_open')::boolean, false),
    delivery_area_mode = p_settings ->> 'delivery_area_mode',
    standard_delivery_fee_paisa = (p_settings ->> 'standard_delivery_fee_paisa')::integer,
    free_delivery_enabled = (p_settings ->> 'free_delivery_enabled')::boolean,
    free_delivery_min_paisa = (p_settings ->> 'free_delivery_min_paisa')::integer,
    hold_minutes = (p_settings ->> 'hold_minutes')::integer,
    max_lines_per_order = (p_settings ->> 'max_lines_per_order')::integer,
    max_units_per_order = (p_settings ->> 'max_units_per_order')::integer,
    max_units_per_line = (p_settings ->> 'max_units_per_line')::integer,
    max_open_orders_per_phone = (p_settings ->> 'max_open_orders_per_phone')::integer,
    place_attempts_per_ip_10min = (p_settings ->> 'place_attempts_per_ip_10min')::integer,
    place_attempts_per_ip_day = (p_settings ->> 'place_attempts_per_ip_day')::integer,
    lookups_per_ip_10min = (p_settings ->> 'lookups_per_ip_10min')::integer,
    quotes_per_ip_10min = (p_settings ->> 'quotes_per_ip_10min')::integer,
    orders_per_minute_global = (p_settings ->> 'orders_per_minute_global')::integer,
    in_store_sells_unpublished = (p_settings ->> 'in_store_sells_unpublished')::boolean,
    updated_at = now(),
    updated_by = (select auth.uid())
  where id = current_settings.id
  returning * into updated;
  return to_jsonb(updated);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'A setting has an invalid value.' using errcode = 'PT400', hint = 'invalid_settings';
end;
$$;

-- Replaces the delivery city list: [{"city": "Lahore", "active": true, "fee_paisa": null}].
create or replace function public.admin_save_delivery_cities(p_expected_version integer, p_cities jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  new_version integer;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_cities) is distinct from 'array' or jsonb_array_length(p_cities) > 500 then
    raise exception 'Malformed city list.' using errcode = 'PT400';
  end if;
  -- The settings row is the lock for everything delivery-related.
  update public.shop_settings set version = version + 1, updated_at = now(), updated_by = (select auth.uid())
  where version = p_expected_version
  returning version into new_version;
  if new_version is null then
    raise exception 'The settings were changed somewhere else since you opened them.'
      using errcode = 'PT409', hint = 'version_conflict';
  end if;
  -- The whole list is replaced ("where true" satisfies pg-safeupdate).
  delete from public.delivery_cities where true;
  insert into public.delivery_cities (city, active, fee_paisa)
  select private.clean_text(c ->> 'city', 2, 60, 'city'), coalesce((c ->> 'active')::boolean, true), (c ->> 'fee_paisa')::integer
  from jsonb_array_elements(p_cities) c;
  return new_version;
end;
$$;
