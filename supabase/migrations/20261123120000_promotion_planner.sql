-- Promotion planner (admin only): a discount percentage per product (20, 25,
-- 30 or 35%) and the regular price that would make the CURRENT selling price
-- that discount:
--
--   proposed regular = selling ÷ (1 − discount), in whole paisa (half up).
--
-- These are PROPOSALS, stored here and nowhere else. This migration changes
-- no product, price, sale, history row, checkout quote or order. The shop's
-- crossed-out prices still come only from public.products.reference_price_paisa,
-- which the database sets during a sale from genuine price history
-- (20261121120000_score_pricing_and_sales.sql); nothing here can set it.
--
-- The planner's preview shows, for each proposal, whether that price would
-- pass the same check today (private.reference_candidate: published, offered
-- at exactly that regular price with no sale, for the minimum number of days
-- if one is set). A proposal that fails it stays a proposal.
--
-- Assignments (which percentage) are chosen by the website
-- (lib/promotions/plan.ts: seeded, stable, the configured distribution) and
-- saved here once. A saved percentage never changes; listings of the same
-- model (same brand and name, i.e. other sizes) share it. The proposed price
-- is always worked out here from the current selling price, never taken from
-- the browser; if the selling price changes, the proposal is marked out of date
-- until the planner refreshes it (same percentage).

create table private.promotion_assignments (
  product_id uuid primary key references public.products (id) on delete cascade,
  -- Listings of the same model share an assignment: lower(brand) | lower(name).
  group_key text not null,
  discount_bp integer not null,
  -- How the percentage was chosen.
  basis text not null,
  proposed_regular_paisa bigint not null,
  based_on_selling_paisa integer not null,
  assigned_at timestamptz not null default now(),
  assigned_by uuid,
  refreshed_at timestamptz,
  constraint promotion_assignments_discount_valid check (discount_bp in (2000, 2500, 3000, 3500)),
  constraint promotion_assignments_basis_valid check (basis in ('default_distribution', 'age_and_sales', 'model_group')),
  constraint promotion_assignments_selling_positive check (based_on_selling_paisa > 0),
  constraint promotion_assignments_proposal_matches check (
    proposed_regular_paisa = (based_on_selling_paisa::bigint * 20000 + (10000 - discount_bp)) / (2 * (10000 - discount_bp)))
);

create index promotion_assignments_group_idx on private.promotion_assignments (group_key);

comment on table private.promotion_assignments is
  'Promotion planner proposals (admin only): a discount percentage per product and the regular price it implies from the selling price. Never shown to shoppers; never a price history.';

-- The model a listing belongs to (its other sizes share the assignment).
create function private.promotion_group_key(p_brand text, p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(p_brand)) || '|' || lower(btrim(p_name));
$$;

-- selling ÷ (1 − bp/10000), rounded half up to the paisa.
create function private.promotion_proposed_regular(p_selling integer, p_discount_bp integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select (p_selling::bigint * 20000 + (10000 - p_discount_bp)) / (2 * (10000 - p_discount_bp));
$$;

-- ===========================================================================
-- Admin read: everything the planner and its preview need
-- ===========================================================================

create function public.admin_promotion_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return jsonb_build_object(
    'reference_min_days', (select s.reference_min_days from private.pricing_settings s),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', st.product_id,
        'item_code', st.item_code,
        'name', st.name,
        'brand', st.brand,
        'publication_status', st.publication_status,
        'listed_at', st.listed_at,
        'group_key', private.promotion_group_key(st.brand, st.name),
        'mode', st.mode,
        'score', st.score,
        'regular_price_paisa', st.price_paisa,
        'sale_price_paisa', st.sale_price_paisa,
        'selling_price_paisa', coalesce(st.sale_price_paisa, st.price_paisa),
        'public_reference_paisa', st.reference_price_paisa,
        'sizes', (select coalesce(jsonb_agg(v.size_eu order by v.size_eu), '[]'::jsonb) from public.product_variants v where v.product_id = st.product_id),
        'units_sold', (select coalesce(sum(oi.quantity), 0) from public.order_items oi join public.orders o on o.id = oi.order_id
                       where oi.product_id = st.product_id and o.status <> 'cancelled'),
        'assignment', case when a.product_id is not null then jsonb_build_object(
          'discount_bp', a.discount_bp, 'basis', a.basis, 'proposed_regular_paisa', a.proposed_regular_paisa,
          'based_on_selling_paisa', a.based_on_selling_paisa, 'assigned_at', a.assigned_at,
          'outdated', a.based_on_selling_paisa <> coalesce(st.sale_price_paisa, st.price_paisa)) end,
        -- The existing check, unchanged, applied to the proposal.
        'verification', case when a.product_id is not null
          then private.reference_candidate(st.product_id, a.proposed_regular_paisa::integer, st.publication_status) end
      ) order by st.item_code)
      from private.product_pricing_state st
      left join private.promotion_assignments a on a.product_id = st.product_id
      where st.publication_status in ('draft', 'published') and coalesce(st.sale_price_paisa, st.price_paisa) > 0
    ), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- Admin write: save new assignments, refresh out-of-date proposals
-- ===========================================================================

-- p_items: [{ "product_id": uuid, "discount_bp": 2000|2500|3000|3500, "basis": "default_distribution"|"age_and_sales" }].
-- Only the percentage comes from the request; everything else is worked out here:
--   * a product that already has an assignment keeps its percentage (its
--     proposal is recalculated from the current selling price if that changed);
--   * a product whose model already has an assignment gets that percentage;
--   * otherwise the requested percentage is saved.
-- Safe to repeat: the same request changes nothing the second time.
create function public.admin_save_promotion_assignments(p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  item jsonb;
  st private.product_pricing_state;
  v_product uuid;
  v_bp integer;
  v_basis text;
  v_key text;
  v_selling integer;
  existing private.promotion_assignments;
  group_bp integer;
  inserted integer := 0;
  refreshed integer := 0;
  unchanged integer := 0;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 1000 then
    raise exception 'Malformed request.' using errcode = 'PT400', hint = 'invalid_items';
  end if;
  -- One planner run at a time, so two runs can't give one model two percentages.
  perform pg_advisory_xact_lock(20261123, 1);

  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object'
      or coalesce(item ->> 'product_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(item ->> 'discount_bp', '') not in ('2000', '2500', '3000', '3500')
      or coalesce(item ->> 'basis', '') not in ('default_distribution', 'age_and_sales') then
      raise exception 'Malformed assignment.' using errcode = 'PT400', hint = 'invalid_items';
    end if;
    v_product := (item ->> 'product_id')::uuid;
    v_bp := (item ->> 'discount_bp')::integer;
    v_basis := item ->> 'basis';

    st := null;
    select * into st from private.product_pricing_state s where s.product_id = v_product;
    v_selling := coalesce(st.sale_price_paisa, st.price_paisa);
    if st.product_id is null or st.publication_status not in ('draft', 'published') or coalesce(v_selling, 0) <= 0 then
      continue; -- deleted, archived or unpriced since the preview: nothing to plan
    end if;
    v_key := private.promotion_group_key(st.brand, st.name);

    select * into existing from private.promotion_assignments a where a.product_id = v_product for update;
    if found then
      if existing.based_on_selling_paisa = v_selling and existing.group_key = v_key then
        unchanged := unchanged + 1;
      else
        update private.promotion_assignments
        set based_on_selling_paisa = v_selling,
            proposed_regular_paisa = private.promotion_proposed_regular(v_selling, existing.discount_bp),
            group_key = v_key,
            refreshed_at = now()
        where product_id = v_product;
        refreshed := refreshed + 1;
      end if;
      continue;
    end if;

    select a.discount_bp into group_bp from private.promotion_assignments a
    where a.group_key = v_key order by a.assigned_at, a.product_id limit 1;
    insert into private.promotion_assignments (product_id, group_key, discount_bp, basis, proposed_regular_paisa, based_on_selling_paisa, assigned_by)
    values (v_product, v_key, coalesce(group_bp, v_bp), case when group_bp is not null then 'model_group' else v_basis end,
      private.promotion_proposed_regular(v_selling, coalesce(group_bp, v_bp)), v_selling, (select auth.uid()));
    inserted := inserted + 1;
  end loop;

  return jsonb_build_object('result', 'saved', 'assigned', inserted, 'refreshed', refreshed, 'unchanged', unchanged);
end;
$$;

-- ===========================================================================
-- Access
-- ===========================================================================

revoke all on table private.promotion_assignments from public, anon, authenticated;
revoke execute on function private.promotion_group_key(text, text), private.promotion_proposed_regular(integer, integer)
  from public, anon, authenticated;
revoke execute on function public.admin_promotion_overview(), public.admin_save_promotion_assignments(jsonb) from public, anon;
grant execute on function public.admin_promotion_overview(), public.admin_save_promotion_assignments(jsonb) to authenticated;
