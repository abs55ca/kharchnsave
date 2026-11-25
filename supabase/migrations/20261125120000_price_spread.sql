-- Price spread: shoes in the same group at the same score no longer all get
-- exactly the same price.
--
-- Builds on 20261124120000_size_sales.sql (and everything before it). README,
-- "Score pricing and sales", has the rollout order.
--
-- pricing_settings.price_spread_bp (0-500 basis points, i.e. 0-5%; default 0,
-- which changes nothing) gives every product its own fixed amount below the
-- score price:
--
--   offset (bp)  = (last 8 hex digits of the product's id, as a number)
--                  mod (price_spread_bp + 1)          -- 0 .. spread, per product
--   calculated   = floor(maximum × score × (10000 − offset) / 1 000 000)
--
-- then the price ending as before. The offset only ever LOWERS a price (a
-- score of 100 can't go above the group maximum), is the same every time
-- (prices don't jump around on each repricing), and is mirrored exactly by
-- lib/pricing/rules.ts (spreadOffsetBp, scorePrice).
--
-- Nothing is repriced here. After the spread is changed, automatic prices
-- show as out of date on the Pricing page until the admin previews and
-- confirms "Review out-of-date automatic prices", as with any other change.
--
-- The 4-argument private.score_calculation stays (no spread); the functions
-- that work out automatic prices below now call the 6-argument one. Each is
-- the same body as before except the marked call. CREATE OR REPLACE keeps
-- their ACLs.

alter table private.pricing_settings
  add column price_spread_bp smallint not null default 0,
  add constraint pricing_settings_spread_range check (price_spread_bp between 0 and 500);

-- The product's own offset below the score price, 0..p_spread_bp basis points.
create function private.spread_offset_bp(p_product_id uuid, p_spread_bp integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_product_id is null or coalesce(p_spread_bp, 0) <= 0 then 0
    else ((('x' || right(replace(p_product_id::text, '-', ''), 8))::bit(32)::bigint) % (p_spread_bp + 1))::integer end;
$$;

-- As the 4-argument version, with the product's spread offset applied first.
-- {status, calculated_paisa, price_paisa, spread_bp}
create function private.score_calculation(p_max integer, p_score integer, p_giveaway boolean, p_ending integer,
  p_product_id uuid, p_spread_bp integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_max is null or p_score is null then jsonb_build_object('status', 'not_set', 'calculated_paisa', null, 'price_paisa', null, 'spread_bp', 0)
    when p_score = 0 and coalesce(p_giveaway, false) then jsonb_build_object('status', 'giveaway', 'calculated_paisa', 0, 'price_paisa', 0, 'spread_bp', 0)
    when p_score = 0 then jsonb_build_object('status', 'needs_pricing', 'calculated_paisa', 0, 'price_paisa', null, 'spread_bp', 0)
    else (
      select jsonb_build_object('status', case when b.p is null then 'too_small' else 'ok' end, 'calculated_paisa', b.c, 'price_paisa', b.p,
        'spread_bp', b.o)
      from (select a.c, a.o, private.price_with_ending(a.c, p_ending) as p
            from (select o.o, floor(p_max::numeric * p_score * (10000 - o.o) / 1000000)::bigint as c
                  from (select private.spread_offset_bp(p_product_id, p_spread_bp) as o) o) a) b)
  end;
$$;

create or replace function private.settings_view()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('price_ending_rupees', s.price_ending_rupees, 'min_profit_paisa', s.min_profit_paisa,
    'min_margin_bp', s.min_margin_bp, 'reference_min_days', s.reference_min_days,
    'price_spread_bp', s.price_spread_bp, 'new_sale_target_bp', s.new_sale_target_bp, 'preloved_sale_target_bp', s.preloved_sale_target_bp,
    'version', s.version, 'updated_at', s.updated_at)
  from private.pricing_settings s;
$$;


create or replace function public.admin_pricing_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
begin
  perform public.admin_require_catalogue_admin();
  select * into s from private.pricing_settings;
  return jsonb_build_object(
    'settings', private.settings_view(),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'max_price_paisa', g.max_price_paisa, 'version', g.version,
        'auto', (select count(*) from private.product_pricing pp where pp.group_id = g.id and pp.mode = 'auto'),
        'manual', (select count(*) from private.product_pricing pp where pp.group_id = g.id and pp.mode = 'manual'))
        order by lower(g.name))
      from private.pricing_groups g), '[]'::jsonb),
    'agents', jsonb_build_object(
      'enabled', (select count(*) from public.sales_agents a where a.code_enabled),
      'excluding_sale_items', (select count(*) from public.sales_agents a where a.code_enabled and not coalesce(a.applies_to_sale_items, false)),
      'terms', coalesce((
        select jsonb_agg(jsonb_build_object('discount_bp', t.discount_bp, 'commission_bp', t.commission_bp,
          'applies_to_sale_items', t.applies_to_sale_items, 'agents', t.agents) order by t.discount_bp, t.commission_bp)
        from (select a.discount_bp, a.commission_bp, a.applies_to_sale_items, count(*) as agents
              from public.sales_agents a where a.code_enabled group by 1, 2, 3) t), '[]'::jsonb)),
    'counts', (
      select jsonb_build_object(
        'auto', count(*) filter (where st.mode = 'auto'),
        'manual', count(*) filter (where st.mode = 'manual'),
        'needs_pricing', count(*) filter (where st.price_paisa = 0 and not st.giveaway),
        'out_of_date', count(*) filter (where st.mode = 'auto'
          and (private.score_calculation(st.max_price_paisa, st.score, st.giveaway, s.price_ending_rupees, st.product_id, s.price_spread_bp) ->> 'price_paisa')::integer
              is distinct from st.price_paisa),
        'unknown_cost', count(*) filter (where st.cost_paisa is null and st.publication_status = 'published'))
      from private.product_pricing_state st where st.publication_status <> 'archived'));
end;
$$;


create or replace function public.admin_pricing_products(p_filter jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
  q text := lower(btrim(coalesce(p_filter ->> 'q', '')));
  v_status text := p_filter ->> 'item_status';
  v_mode text := p_filter ->> 'mode';
  v_group text := p_filter ->> 'group_id';
  v_pub text := p_filter ->> 'publication_status';
  v_limit integer := least(greatest(coalesce((p_filter ->> 'limit')::integer, 200), 1), 500);
  v_offset integer := greatest(coalesce((p_filter ->> 'offset')::integer, 0), 0);
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_filter) is distinct from 'object' or char_length(q) > 60
    or (v_group is not null and v_group !~ '^[0-9a-f-]{36}$') then
    raise exception 'Malformed filter.' using errcode = 'PT400';
  end if;
  select * into s from private.pricing_settings;
  return (
    with matching as (
      select st.* from private.product_pricing_state st
      where (v_pub is null and st.publication_status <> 'archived' or st.publication_status = v_pub)
        and (v_status is null or st.item_status = v_status)
        and (v_mode is null or st.mode = v_mode)
        and (v_group is null or st.group_id = v_group::uuid)
        and (q = '' or lower(st.name) like '%' || q || '%' or lower(st.brand) like '%' || q || '%'
             or lower(st.item_code) like '%' || q || '%')
    )
    select jsonb_build_object('total', (select count(*) from matching), 'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', m.product_id, 'item_code', m.item_code, 'name', m.name, 'brand', m.brand,
        'item_status', m.item_status, 'publication_status', m.publication_status, 'listed_at', m.listed_at, 'stock', m.stock,
        'price_paisa', m.price_paisa, 'sale_price_paisa', m.sale_price_paisa, 'reference_price_paisa', m.reference_price_paisa,
        'mode', m.mode, 'group_id', m.group_id, 'group_name', m.group_name, 'max_price_paisa', m.max_price_paisa,
        'score', m.score, 'cost_paisa', m.cost_paisa, 'giveaway', m.giveaway,
        'pricing_version', m.pricing_version, 'product_version', m.product_version,
        'campaign', case when m.campaign_id is not null then jsonb_build_object('id', m.campaign_id, 'name', m.campaign_name) end,
        'calculation', case when m.group_id is not null and m.score is not null
          then private.score_calculation(m.max_price_paisa, m.score, m.giveaway, s.price_ending_rupees, m.product_id, s.price_spread_bp) end)
        order by m.item_code)
      from (select * from matching order by item_code limit v_limit offset v_offset) m), '[]'::jsonb))
  );
end;
$$;


create or replace function public.admin_save_pricing_settings(p_expected_version integer, p_request_id uuid, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  s private.pricing_settings;
  v_payload jsonb;
  earlier jsonb;
  num text := '^[0-9]{1,9}$';
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_settings) is distinct from 'object'
    or coalesce(p_settings ->> 'price_ending_rupees', '') !~ '^[0-9]{1,2}$'
    or coalesce(p_settings ->> 'new_sale_target_bp', '') !~ num or coalesce(p_settings ->> 'preloved_sale_target_bp', '') !~ num
    or (p_settings ->> 'min_profit_paisa' is not null and (p_settings ->> 'min_profit_paisa') !~ num)
    or (p_settings ->> 'min_margin_bp' is not null and (p_settings ->> 'min_margin_bp') !~ num)
    or (p_settings ->> 'reference_min_days' is not null and (p_settings ->> 'reference_min_days') !~ num)
    or (p_settings ->> 'price_spread_bp' is not null and (p_settings ->> 'price_spread_bp') !~ '^[0-9]{1,3}$') then
    raise exception 'Check the pricing settings.' using errcode = 'PT400', hint = 'invalid_settings';
  end if;
  v_payload := jsonb_build_object('expected_version', p_expected_version,
    'price_ending_rupees', (p_settings ->> 'price_ending_rupees')::integer,
    'min_profit_paisa', (p_settings ->> 'min_profit_paisa')::integer, 'min_margin_bp', (p_settings ->> 'min_margin_bp')::integer,
    'reference_min_days', (p_settings ->> 'reference_min_days')::integer,
    'new_sale_target_bp', (p_settings ->> 'new_sale_target_bp')::integer,
    'preloved_sale_target_bp', (p_settings ->> 'preloved_sale_target_bp')::integer,
    -- Optional: left out (an older page), the current spread stays.
    'price_spread_bp', (p_settings ->> 'price_spread_bp')::integer);
  earlier := private.pricing_request_begin(p_request_id, 'settings', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  select * into s from private.pricing_settings for update;
  if p_expected_version is distinct from s.version then
    raise exception 'The pricing settings were changed somewhere else since you opened them.' using errcode = 'PT409', hint = 'version_conflict';
  end if;
  begin
    update private.pricing_settings set
      price_ending_rupees = (v_payload ->> 'price_ending_rupees')::smallint,
      min_profit_paisa = (v_payload ->> 'min_profit_paisa')::integer,
      min_margin_bp = (v_payload ->> 'min_margin_bp')::integer,
      reference_min_days = (v_payload ->> 'reference_min_days')::integer,
      new_sale_target_bp = (v_payload ->> 'new_sale_target_bp')::integer,
      preloved_sale_target_bp = (v_payload ->> 'preloved_sale_target_bp')::integer,
      price_spread_bp = coalesce((v_payload ->> 'price_spread_bp')::smallint, price_spread_bp),
      updated_by = (select auth.uid())
    where id;
  exception when check_violation then
    raise exception 'Check the pricing settings.' using errcode = 'PT400', hint = 'invalid_settings';
  end;
  return private.pricing_request_done(p_request_id, 'settings', v_payload, 'settings_changed',
    jsonb_build_object('from', to_jsonb(s) - 'id' - 'updated_at' - 'updated_by', 'to', v_payload),
    jsonb_build_object('result', 'done', 'version', (select x.version from private.pricing_settings x)));
end;
$$;


create or replace function private.pricing_line(p_product_id uuid, p_desired jsonb, p_max_override integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
  st private.product_pricing_state;
  g private.pricing_groups;
  v_mode text := p_desired ->> 'mode';
  v_group uuid := (p_desired ->> 'group_id')::uuid;
  v_score integer := (p_desired ->> 'score')::integer;
  v_cost integer := (p_desired ->> 'cost_paisa')::integer;
  v_giveaway boolean := coalesce((p_desired ->> 'giveaway')::boolean, false);
  v_override text := p_desired ->> 'override_reason';
  v_max integer;
  calc jsonb;
  sale_calc jsonb;
  proposed_price integer;
  proposed_sale integer;
  new_price integer;
  new_sale integer;
  new_ref integer;
  reason text;
  econ jsonb;
  from_state jsonb;
  to_state jsonb;
begin
  select * into s from private.pricing_settings;
  select * into st from private.product_pricing_state x where x.product_id = p_product_id;
  if not found then
    return jsonb_build_object('product_id', p_product_id, 'action', 'skip', 'reason', 'not_found');
  end if;
  if v_group is not null then
    select * into g from private.pricing_groups x where x.id = v_group;
    if not found then
      reason := 'unknown_group';
    end if;
  end if;
  v_max := coalesce(p_max_override, g.max_price_paisa);
  proposed_price := st.price_paisa;
  proposed_sale := st.sale_price_paisa;

  if reason is null and v_mode = 'auto' and (v_group is null or v_score is null) then
    reason := 'incomplete';
  end if;
  if reason is null and v_giveaway and not (v_mode = 'auto' and v_score = 0) then
    reason := 'giveaway_needs_score_0';
  end if;
  if reason is null and v_group is not null and v_score is not null then
    -- Marked change: the product's own spread below the group price (price_spread_bp).
    calc := private.score_calculation(v_max, v_score, v_giveaway, s.price_ending_rupees, st.product_id, s.price_spread_bp);
    if v_mode = 'auto' then
      if calc ->> 'status' in ('needs_pricing', 'too_small') then
        reason := calc ->> 'status';
      else
        proposed_price := (calc ->> 'price_paisa')::integer;
      end if;
    end if;
  end if;

  if reason is null and proposed_price is distinct from st.price_paisa then
    if st.campaign_id is not null then
      if proposed_price = 0 then
        reason := 'giveaway_on_sale';
      else
        sale_calc := private.sale_calculation(proposed_price, st.campaign_discount_bp, s.price_ending_rupees);
        proposed_sale := (sale_calc ->> 'price_paisa')::integer;
        if proposed_sale is null then
          reason := 'sale_too_small';
        end if;
      end if;
    elsif exists (
      -- A running size sale (20261124120000_size_sales.sql): its prices are fixed until it ends.
      select 1 from private.size_sale_lines z join private.size_sales ss on ss.id = z.size_sale_id
      where z.product_id = st.product_id and ss.status = 'active' and z.removed_at is null
    ) then
      reason := 'size_sale_running';
    elsif st.sale_price_paisa is not null and proposed_price <= st.sale_price_paisa then
      reason := 'manual_sale_conflict';
    end if;
  end if;

  new_price := proposed_price;
  new_sale := proposed_sale;
  if reason is not null then
    new_price := st.price_paisa;
    new_sale := st.sale_price_paisa;
  end if;

  econ := private.unit_economics(coalesce(new_sale, new_price)::bigint,
    case when reason is null then v_cost else st.cost_paisa end,
    coalesce(new_sale, new_price) is distinct from new_price, coalesce(st.campaign_referral_allowed, true));
  if reason is null and (new_price, new_sale) is distinct from (st.price_paisa, st.sale_price_paisa)
     and econ ->> 'margin' = 'violation' and v_override is null then
    reason := 'margin_violation';
    new_price := st.price_paisa;
    new_sale := st.sale_price_paisa;
  end if;

  -- The reference while a sale continues: only down; dropped once not above the sale price.
  new_ref := st.reference_price_paisa;
  if new_ref is not null then
    new_ref := least(new_ref, new_price);
    if new_sale is null or new_ref <= new_sale then
      new_ref := null;
    end if;
  end if;

  from_state := jsonb_build_object('mode', st.mode, 'group_id', st.group_id, 'score', st.score, 'cost_paisa', st.cost_paisa,
    'giveaway', st.giveaway, 'price_paisa', st.price_paisa, 'sale_price_paisa', st.sale_price_paisa,
    'reference_price_paisa', st.reference_price_paisa);
  to_state := case when reason is not null then from_state else
    jsonb_build_object('mode', v_mode, 'group_id', v_group, 'score', v_score, 'cost_paisa', v_cost,
      'giveaway', v_giveaway, 'price_paisa', new_price, 'sale_price_paisa', new_sale, 'reference_price_paisa', new_ref) end;

  return jsonb_build_object(
    'product_id', st.product_id, 'item_code', st.item_code, 'name', st.name, 'brand', st.brand,
    'item_status', st.item_status, 'publication_status', st.publication_status, 'stock', st.stock,
    'group_name', coalesce(g.name, st.group_name), 'max_price_paisa', v_max,
    'from', from_state, 'to', to_state,
    'calculation', calc,
    'proposed', jsonb_build_object('price_paisa', proposed_price, 'sale_price_paisa', proposed_sale, 'sale', sale_calc),
    'campaign', case when st.campaign_id is not null then
      jsonb_build_object('id', st.campaign_id, 'name', st.campaign_name, 'discount_bp', st.campaign_discount_bp) end,
    'badge_from', private.badge_percent(st.reference_price_paisa, st.sale_price_paisa),
    'badge_to', private.badge_percent(new_ref, new_sale),
    'economics', econ,
    'override_reason', v_override,
    'action', case when reason is not null then 'skip' when to_state = from_state then 'unchanged' else 'apply' end,
    'reason', reason,
    'product_version', st.product_version, 'pricing_version', st.pricing_version);
end;
$$;


-- ===========================================================================
-- Access
-- ===========================================================================

revoke execute on function
  private.spread_offset_bp(uuid, integer),
  private.score_calculation(integer, integer, boolean, integer, uuid, integer)
  from public, anon, authenticated;
