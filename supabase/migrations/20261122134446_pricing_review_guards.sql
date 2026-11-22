-- Forward corrections found during rollout review. No existing prices or
-- orders change. CREATE OR REPLACE preserves both functions' existing ACLs.
-- Regression cases: db-tests/pricing.test.ts.

create or replace function private.unit_economics(p_price bigint, p_cost integer, p_on_sale boolean, p_referral_allowed boolean)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
  scenarios jsonb;
  worst jsonb;
  t record;
  d bigint;
  paid bigint;
  c bigint;
  enabled integer;
  excluded integer;
  margin text;
begin
  select * into s from private.pricing_settings;
  scenarios := jsonb_build_array(jsonb_build_object('kind', 'no_code', 'agents', 0, 'discount_bp', 0, 'commission_bp', 0,
    'discount_paisa', 0, 'paid_paisa', p_price, 'commission_paisa', 0,
    'retained_paisa', case when p_cost is not null then p_price - p_cost end));
  worst := scenarios -> 0;
  if p_referral_allowed then
    for t in
      select a.discount_bp, a.commission_bp, count(*)::integer as agents
      from public.sales_agents a
      where a.code_enabled and a.commission_bp is not null and (not p_on_sale or a.applies_to_sale_items)
      group by a.discount_bp, a.commission_bp
      order by a.discount_bp, a.commission_bp
    loop
      d := private.percent_of(p_price, t.discount_bp);
      paid := p_price - d;
      c := private.percent_of(paid, t.commission_bp);
      scenarios := scenarios || jsonb_build_array(jsonb_build_object('kind', 'referral', 'agents', t.agents,
        'discount_bp', t.discount_bp, 'commission_bp', t.commission_bp, 'discount_paisa', d, 'paid_paisa', paid,
        'commission_paisa', c, 'retained_paisa', case when p_cost is not null then paid - c - p_cost end));
      if paid - c < (worst ->> 'paid_paisa')::bigint - (worst ->> 'commission_paisa')::bigint then
        worst := scenarios -> (jsonb_array_length(scenarios) - 1);
      end if;
    end loop;
  end if;
  select count(*) filter (where a.code_enabled)::integer,
         count(*) filter (where a.code_enabled and (not p_referral_allowed or (p_on_sale and not coalesce(a.applies_to_sale_items, false))))::integer
  into enabled, excluded
  from public.sales_agents a;
  margin := case
    when s.min_profit_paisa is null and s.min_margin_bp is null then 'not_configured'
    when p_cost is null then 'cost_unknown'
    when s.min_profit_paisa is not null and (worst ->> 'retained_paisa')::bigint < s.min_profit_paisa then 'violation'
    -- Lowest retained cash and lowest retained/paid ratio can belong to
    -- different agents. Every enabled scenario must meet the margin floor.
    when s.min_margin_bp is not null and exists (
      select 1 from jsonb_array_elements(scenarios) scenario
      where (scenario ->> 'retained_paisa')::bigint * 10000
        < s.min_margin_bp::bigint * (scenario ->> 'paid_paisa')::bigint
    ) then 'violation'
    else 'ok' end;
  return jsonb_build_object('price_paisa', p_price, 'cost_paisa', p_cost, 'on_sale', p_on_sale,
    'referral_allowed', p_referral_allowed, 'scenarios', scenarios, 'worst', worst, 'margin', margin,
    'agents_enabled', enabled, 'agents_excluded', excluded);
end;
$$;

create or replace function private.campaign_apply_line(p_campaign private.sale_campaigns, p_product_id uuid, p_regular integer, p_sale integer, p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  price_updated boolean;
begin
  perform private.pricing_write_begin('campaign_start', p_request_id, p_campaign.id);
  update public.products set sale_price_paisa = p_sale, referral_excluded = not p_campaign.referral_allowed
  where id = p_product_id and price_paisa = p_regular and sale_price_paisa is null and publication_status = 'published';
  -- PERFORM also sets FOUND; preserve the UPDATE result before cleanup.
  price_updated := found;
  perform private.pricing_write_end();
  if not price_updated then
    return false;
  end if;
  update private.sale_campaign_products l set applied_regular_paisa = p_regular, applied_sale_paisa = p_sale, applied_at = now(),
    removed_at = null, skipped_reason = null, planned_regular_paisa = null, planned_sale_paisa = null, updated_at = now()
  where l.campaign_id = p_campaign.id and l.product_id = p_product_id;
  return true;
end;
$$;
