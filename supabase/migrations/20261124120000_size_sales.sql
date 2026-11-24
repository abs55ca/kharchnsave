-- Sales by size (Pricing page): discount percentages by EU size within a
-- pricing group, previewed, then applied as one size sale, and ended.
--
-- Rules (mirrored by lib/pricing/size-rules.ts, tested to agree):
--   * A rule is one size (from = to) or an inclusive range (from < to); whole
--     or half EU sizes 15-50, never rounded. A single-size rule overrides a
--     range containing that size. Ranges may not overlap (boundaries count);
--     a size may not have two single-size rules. Unmatched sizes get the
--     group's default discount if one is set, otherwise no sale.
--   * Sale price = regular × (1 − discount), in whole paisa, half up. Always
--     from the regular price: never compounded onto a sale price. Regular
--     prices, scores, group maximums and the score formula are not touched.
--
-- Prices are per product (products.price_paisa / sale_price_paisa); checkout,
-- orders and the shop read them there. A product with several sizes whose
-- sizes fall under different rules (or partly under none) can't be split, so
-- it is BLOCKED with that reason rather than discounted at one percentage.
-- (The imported kids' shoes are one product per size.)
--
-- Eligibility is decided again when applying, with the preview's token: if
-- anything changed, nothing is applied and the new preview comes back. Blocked
-- products are listed with their reason, never silently skipped:
-- not published, free, in a sale campaign, a manual sale price, a sale price
-- that would be too small, the margin rule, or sizes under different rules.
--
-- Applying writes the sale price through the pricing writer; the existing
-- price-history trigger records it, and the existing guard decides the
-- crossed-out "was" price from genuine history (or none). Nothing here sets a
-- reference price. Ending removes only this sale's sale prices (regular
-- prices stay as they are). While a product is in a running size sale, its
-- prices can't be changed elsewhere (the guard, below), sale campaigns skip
-- it ("other_sale"), and repricing skips it ("manual_sale_conflict").
--
-- The promotion planner's saved assignments are not read or changed.

-- ===========================================================================
-- Tables
-- ===========================================================================

create table private.size_sale_rule_sets (
  group_id uuid primary key references private.pricing_groups (id) on delete cascade,
  rules jsonb not null default '[]'::jsonb,
  default_discount_bp integer,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint size_sale_rule_sets_default_valid check (default_discount_bp is null or default_discount_bp between 100 and 9000)
);

comment on table private.size_sale_rule_sets is
  'The saved "Sales by size" rules of each pricing group (validated by private.size_rules_validate).';

create table private.size_sales (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references private.pricing_groups (id) on delete restrict,
  rules jsonb not null,
  default_discount_bp integer,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  started_by uuid,
  ended_at timestamptz,
  ended_by uuid,
  constraint size_sales_status_valid check (status in ('active', 'ended')),
  constraint size_sales_ended_complete check ((status = 'ended') = (ended_at is not null))
);

-- One running size sale per group.
create unique index size_sales_one_active on private.size_sales (group_id) where status = 'active';

comment on table private.size_sales is 'Size sales: the rules applied to a pricing group, from start to end.';

create table private.size_sale_lines (
  size_sale_id uuid not null references private.size_sales (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete cascade,
  discount_bp integer not null,
  rule_label text not null,
  applied_regular_paisa integer not null,
  applied_sale_paisa integer not null,
  -- The "was" price the database accepted when the sale started (null: none shown).
  reference_paisa integer,
  applied_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (size_sale_id, product_id),
  constraint size_sale_lines_discount_valid check (discount_bp between 100 and 9000),
  constraint size_sale_lines_prices_valid check (applied_sale_paisa > 0 and applied_sale_paisa < applied_regular_paisa)
);

-- A product is live in at most one size sale.
create unique index size_sale_lines_one_live on private.size_sale_lines (product_id) where removed_at is null;

comment on table private.size_sale_lines is 'One product in a size sale: its percentage, rule, and the prices it was put on sale at.';

-- ===========================================================================
-- Rules
-- ===========================================================================

-- Validates and normalises a rule set: [{from, to, discount_bp}] → the same,
-- sizes without trailing zeros. Raises PT400 (hint invalid_size_rules) with
-- every problem, row by row (the same sentences as lib/pricing/size-rules.ts).
create function private.size_rules_validate(p_rules jsonb, p_default integer)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  errors text[] := '{}';
  r jsonb;
  i integer := 0;
  j integer;
  a record;
  b record;
  v_from numeric;
  v_to numeric;
  v_bp integer;
  normal jsonb := '[]'::jsonb;
  label_a text;
  label_b text;
begin
  if jsonb_typeof(p_rules) is distinct from 'array' then
    raise exception 'Malformed size rules.' using errcode = 'PT400', hint = 'invalid_size_rules';
  end if;
  if jsonb_array_length(p_rules) > 50 then
    errors := errors || 'Use at most 50 rules.';
  end if;
  for r in select value from jsonb_array_elements(p_rules) loop
    i := i + 1;
    v_from := case when jsonb_typeof(r -> 'from') = 'number' then (r ->> 'from')::numeric end;
    v_to := case when jsonb_typeof(r -> 'to') = 'number' then (r ->> 'to')::numeric end;
    v_bp := case when jsonb_typeof(r -> 'discount_bp') = 'number' and (r ->> 'discount_bp') ~ '^[0-9]{1,5}$' then (r ->> 'discount_bp')::integer end;
    if v_from is null or v_to is null or v_from * 2 <> trunc(v_from * 2) or v_to * 2 <> trunc(v_to * 2)
       or v_from not between 15 and 50 or v_to not between 15 and 50 then
      errors := errors || format('Row %s: sizes are whole or half EU sizes from 15 to 50 (e.g. 29.5).', i);
    elsif v_from > v_to then
      errors := errors || format('Row %s: "from" (EU %s) is above "to" (EU %s).', i, trim_scale(v_from), trim_scale(v_to));
    end if;
    if v_bp is null or v_bp not between 100 and 9000 then
      errors := errors || format('Row %s: the discount is 1%% to 90%% (up to two decimals).', i);
    end if;
    normal := normal || jsonb_build_array(jsonb_build_object('from', trim_scale(v_from), 'to', trim_scale(v_to), 'discount_bp', v_bp));
  end loop;
  if p_default is not null and p_default not between 100 and 9000 then
    errors := errors || 'Default discount: 1% to 90% (up to two decimals), or leave it empty for no sale.'::text;
  end if;
  if cardinality(errors) = 0 then
    for a in select (e ->> 'from')::numeric as f, (e ->> 'to')::numeric as t, n from jsonb_array_elements(normal) with ordinality x(e, n) loop
      for b in select (e ->> 'from')::numeric as f, (e ->> 'to')::numeric as t, n from jsonb_array_elements(normal) with ordinality x(e, n) where n > a.n loop
        label_a := case when a.f = a.t then format('EU %s', trim_scale(a.f)) else format('EU %s–%s', trim_scale(a.f), trim_scale(a.t)) end;
        label_b := case when b.f = b.t then format('EU %s', trim_scale(b.f)) else format('EU %s–%s', trim_scale(b.f), trim_scale(b.t)) end;
        if a.f = a.t and b.f = b.t and a.f = b.f then
          errors := errors || format('Rows %s and %s are both single-size rules for EU %s. Keep one.', a.n, b.n, trim_scale(a.f));
        elsif a.f < a.t and b.f < b.t and a.f <= b.t and b.f <= a.t then
          errors := errors || format('Rows %s and %s overlap (%s and %s). Ranges can''t share sizes; use a single-size rule to override part of a range.', a.n, b.n, label_a, label_b);
        end if;
      end loop;
    end loop;
  end if;
  if cardinality(errors) > 0 then
    raise exception '%', array_to_string(errors, ' ') using errcode = 'PT400', hint = 'invalid_size_rules';
  end if;
  return normal;
end;
$$;

-- The discount for one size: a single-size rule, else a range, else the default; null for none.
create function private.size_rule_match(p_rules jsonb, p_default integer, p_size numeric)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('discount_bp', (e ->> 'discount_bp')::integer, 'label', format('EU %s', trim_scale((e ->> 'from')::numeric)))
     from jsonb_array_elements(p_rules) e
     where (e ->> 'from')::numeric = (e ->> 'to')::numeric and (e ->> 'from')::numeric = p_size limit 1),
    (select jsonb_build_object('discount_bp', (e ->> 'discount_bp')::integer,
       'label', format('EU %s–%s', trim_scale((e ->> 'from')::numeric), trim_scale((e ->> 'to')::numeric)))
     from jsonb_array_elements(p_rules) e
     where (e ->> 'from')::numeric < (e ->> 'to')::numeric and p_size between (e ->> 'from')::numeric and (e ->> 'to')::numeric limit 1),
    case when p_default is not null then jsonb_build_object('discount_bp', p_default, 'label', 'Default') end);
$$;

-- regular × (1 − bp/10000), whole paisa, half up.
create function private.size_sale_price(p_regular integer, p_bp integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select ((p_regular::bigint * (10000 - p_bp) * 2 + 10000) / 20000)::integer;
$$;

-- ===========================================================================
-- The plan: every product in the group, with what would happen and why
-- ===========================================================================

create function private.size_sale_plan(p_group uuid, p_rules jsonb, p_default integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  g private.pricing_groups;
  active private.size_sales;
  st record;
  v_sizes numeric[];
  v_matches jsonb;
  v_distinct integer;
  v_bp integer;
  v_label text;
  v_sale integer;
  v_live private.size_sale_lines;
  v_status text;
  v_reason text;
  v_detail text;
  econ jsonb;
  cand jsonb;
  was jsonb;
  lines jsonb := '[]'::jsonb;
  token_lines jsonb := '[]'::jsonb;
  counts jsonb;
begin
  select * into g from private.pricing_groups x where x.id = p_group;
  if g.id is null then
    raise exception 'That pricing group no longer exists.' using errcode = 'PT404', hint = 'unknown_group';
  end if;
  select * into active from private.size_sales s where s.group_id = p_group and s.status = 'active';

  for st in
    select s.*, (select v.version from public.products v where v.id = s.product_id) as version
    from private.product_pricing_state s join private.product_pricing pp on pp.product_id = s.product_id
    where pp.group_id = p_group
    order by s.item_code
  loop
    select coalesce(array_agg(v.size_eu order by v.size_eu), '{}') into v_sizes from public.product_variants v where v.product_id = st.product_id;
    select coalesce(jsonb_agg(private.size_rule_match(p_rules, p_default, s) order by s), '[]'::jsonb) into v_matches from unnest(v_sizes) s;
    select count(distinct coalesce(m ->> 'discount_bp', 'none')) into v_distinct from jsonb_array_elements(v_matches) m;
    v_bp := case when v_distinct = 1 then (v_matches -> 0 ->> 'discount_bp')::integer end;
    v_label := case when v_distinct = 1 then v_matches -> 0 ->> 'label' end;
    v_sale := case when v_bp is not null and st.price_paisa > 0 then private.size_sale_price(st.price_paisa, v_bp) end;
    v_live := null;
    select l.* into v_live from private.size_sale_lines l join private.size_sales s on s.id = l.size_sale_id
    where l.product_id = st.product_id and l.removed_at is null and s.status = 'active';
    econ := case when v_sale is not null then private.unit_economics(v_sale, st.cost_paisa, true, true) end;
    v_status := 'blocked';
    v_detail := null;
    v_reason := case
      when cardinality(v_sizes) = 0 then 'no_sizes'
      when v_distinct > 1 then 'sizes_differ'
      when v_live.product_id is not null and v_live.applied_sale_paisa is not distinct from v_sale and v_live.applied_regular_paisa = st.price_paisa then 'already_on_this_sale'
      when v_live.product_id is not null then 'size_sale_running_other_rules'
      when v_bp is null then 'no_rule'
      when st.publication_status <> 'published' then 'not_published'
      when st.price_paisa = 0 or st.giveaway then 'free_item'
      when st.campaign_id is not null then 'in_campaign'
      when st.sale_price_paisa is not null then 'manual_sale'
      when v_sale <= 0 or v_sale >= st.price_paisa then 'sale_too_small'
      when econ ->> 'margin' = 'violation' then 'margin_violation'
      when econ ->> 'margin' = 'cost_unknown' then 'cost_unknown_with_margin_rule'
    end;
    if v_reason is null then
      v_status := 'eligible';
    elsif v_reason in ('no_rule', 'already_on_this_sale') then
      v_status := 'unchanged';
    end if;
    if v_reason = 'in_campaign' then v_detail := st.campaign_name; end if;
    if v_reason = 'sizes_differ' then
      select string_agg(format('EU %s: %s', trim_scale(s), coalesce(private.size_rule_match(p_rules, p_default, s) ->> 'label', 'no rule')), ', ' order by s)
      into v_detail from unnest(v_sizes) s;
    end if;
    -- The "was" price the shop would show (the existing check, unchanged): only for a sale that would start.
    was := null;
    if v_status = 'eligible' then
      cand := private.reference_candidate(st.product_id, st.price_paisa, st.publication_status);
      was := case when (cand ->> 'supported')::boolean and st.price_paisa > v_sale
        then jsonb_build_object('shown', true, 'price_paisa', st.price_paisa, 'offered_since', cand ->> 'offered_since')
        else jsonb_build_object('shown', false, 'reason', coalesce(cand ->> 'reason', 'not_offered_at_price')) end;
    elsif v_reason = 'already_on_this_sale' then
      was := jsonb_build_object('shown', v_live.reference_paisa is not null, 'price_paisa', v_live.reference_paisa);
    end if;

    lines := lines || jsonb_build_array(jsonb_build_object(
      'product_id', st.product_id, 'item_code', st.item_code, 'name', st.name, 'brand', st.brand,
      'publication_status', st.publication_status, 'sizes', to_jsonb(v_sizes),
      'rule', v_label, 'discount_bp', v_bp,
      'regular_paisa', st.price_paisa, 'current_paisa', coalesce(st.sale_price_paisa, st.price_paisa),
      'proposed_paisa', v_sale,
      'actual_hundredths', case when v_sale is not null and st.price_paisa > 0
        then (((st.price_paisa - v_sale)::bigint * 20000 + st.price_paisa) / (2 * st.price_paisa::bigint))::integer end,
      'cost_paisa', st.cost_paisa,
      'retained_paisa', econ -> 'worst' -> 'retained_paisa',
      'margin', econ ->> 'margin',
      'status', v_status, 'reason', v_reason, 'detail', v_detail, 'was', was));
    token_lines := token_lines || jsonb_build_array(jsonb_build_array(st.product_id, st.version, st.price_paisa, st.sale_price_paisa, v_sale, v_status, v_reason));
  end loop;

  select jsonb_build_object(
    'eligible', count(*) filter (where l ->> 'status' = 'eligible'),
    'blocked', count(*) filter (where l ->> 'status' = 'blocked'),
    'unchanged', count(*) filter (where l ->> 'status' = 'unchanged'))
  into counts from jsonb_array_elements(lines) l;

  return jsonb_build_object(
    'group', jsonb_build_object('id', g.id, 'name', g.name, 'max_price_paisa', g.max_price_paisa),
    'rules', p_rules, 'default_discount_bp', p_default,
    'active', case when active.id is not null then jsonb_build_object('id', active.id, 'rules', active.rules,
      'default_discount_bp', active.default_discount_bp, 'started_at', active.started_at,
      'same_rules', active.rules = p_rules and active.default_discount_bp is not distinct from p_default,
      'live', (select count(*) from private.size_sale_lines l where l.size_sale_id = active.id and l.removed_at is null)) end,
    'lines', lines, 'counts', counts,
    'token', encode(sha256(convert_to(jsonb_build_object('group', p_group, 'rules', p_rules, 'default', p_default,
      'active', active.id, 'lines', token_lines)::text, 'UTF8')), 'hex'));
end;
$$;

-- ===========================================================================
-- Admin functions
-- ===========================================================================

-- The group's saved rules (or none yet) and its running size sale, if any.
create function public.admin_size_sale_overview(p_group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rs private.size_sale_rule_sets;
  active private.size_sales;
begin
  perform public.admin_require_catalogue_admin();
  select * into rs from private.size_sale_rule_sets r where r.group_id = p_group_id;
  select * into active from private.size_sales s where s.group_id = p_group_id and s.status = 'active';
  return jsonb_build_object(
    'group_id', p_group_id,
    'saved', case when rs.group_id is not null then jsonb_build_object('rules', rs.rules, 'default_discount_bp', rs.default_discount_bp,
      'version', rs.version, 'updated_at', rs.updated_at) end,
    'active', case when active.id is not null then jsonb_build_object('id', active.id, 'rules', active.rules,
      'default_discount_bp', active.default_discount_bp, 'started_at', active.started_at,
      'live', (select count(*) from private.size_sale_lines l where l.size_sale_id = active.id and l.removed_at is null)) end);
end;
$$;

create function public.admin_preview_size_sale(p_group_id uuid, p_rules jsonb, p_default_bp integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return private.size_sale_plan(p_group_id, private.size_rules_validate(p_rules, p_default_bp), p_default_bp);
end;
$$;

-- Applies the eligible lines of the previewed plan (same token), in one
-- transaction. Saves the rules as the group's rules. A running size sale with
-- the SAME rules gets any newly eligible products; with different rules it
-- must be ended first. A retry of the same request gets the original answer.
create function public.admin_apply_size_sale(p_request_id uuid, p_group_id uuid, p_rules jsonb, p_default_bp integer, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_rules jsonb;
  v_payload jsonb;
  earlier jsonb;
  plan jsonb;
  active private.size_sales;
  line jsonb;
  v_ids uuid[];
  v_ref integer;
  applied integer := 0;
  rs_version integer;
begin
  perform public.admin_require_catalogue_admin();
  v_rules := private.size_rules_validate(p_rules, p_default_bp);
  if p_group_id is null or p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Preview the sale first.' using errcode = 'PT400', hint = 'preview_required';
  end if;
  v_payload := jsonb_build_object('group', p_group_id, 'rules', v_rules, 'default', p_default_bp, 'token', p_token);
  earlier := private.pricing_request_begin(p_request_id, 'size_sale_apply', v_payload);
  if earlier is not null then
    return earlier;
  end if;

  -- Lock the group's products (and their prices) for the rest of the transaction.
  select coalesce(array_agg(pp.product_id order by pp.product_id), '{}') into v_ids
  from private.product_pricing pp where pp.group_id = p_group_id;
  perform 1 from public.products p where p.id = any(v_ids) order by p.id for update;
  perform 1 from private.size_sales s where s.group_id = p_group_id for update;

  plan := private.size_sale_plan(p_group_id, v_rules, p_default_bp);
  if plan ->> 'token' <> p_token then
    return jsonb_build_object('result', 'stale', 'preview', plan);
  end if;
  select * into active from private.size_sales s where s.group_id = p_group_id and s.status = 'active';
  if active.id is not null and (active.rules <> v_rules or active.default_discount_bp is distinct from p_default_bp) then
    raise exception 'A size sale with different rules is running for this group. End it first, then apply the new rules.'
      using errcode = 'PT409', hint = 'size_sale_running';
  end if;

  insert into private.size_sale_rule_sets (group_id, rules, default_discount_bp, updated_by)
  values (p_group_id, v_rules, p_default_bp, (select auth.uid()))
  on conflict (group_id) do update set rules = excluded.rules, default_discount_bp = excluded.default_discount_bp,
    version = private.size_sale_rule_sets.version + 1, updated_at = now(), updated_by = excluded.updated_by
  where (private.size_sale_rule_sets.rules, private.size_sale_rule_sets.default_discount_bp)
        is distinct from (excluded.rules, excluded.default_discount_bp);

  if (plan -> 'counts' ->> 'eligible')::integer = 0 then
    return private.pricing_request_done(p_request_id, 'size_sale_apply', v_payload, 'size_sale_nothing',
      jsonb_build_object('group_id', p_group_id, 'counts', plan -> 'counts'),
      jsonb_build_object('result', 'nothing', 'counts', plan -> 'counts'));
  end if;

  if active.id is null then
    insert into private.size_sales (group_id, rules, default_discount_bp, started_by)
    values (p_group_id, v_rules, p_default_bp, (select auth.uid()))
    returning * into active;
  end if;

  for line in select l from jsonb_array_elements(plan -> 'lines') l where l ->> 'status' = 'eligible' loop
    perform private.pricing_write_begin('size_sale_start', p_request_id, null);
    update public.products set sale_price_paisa = (line ->> 'proposed_paisa')::integer
    where id = (line ->> 'product_id')::uuid and price_paisa = (line ->> 'regular_paisa')::integer
      and sale_price_paisa is null and publication_status = 'published'
    returning reference_price_paisa into v_ref;
    if not found then
      perform private.pricing_write_end();
      -- Can't happen with the rows locked and the plan re-checked; refuse rather than half-apply.
      raise exception 'A product changed while applying the sale. Nothing was applied; preview again.' using errcode = 'PT409', hint = 'stale';
    end if;
    perform private.pricing_write_end();
    insert into private.size_sale_lines (size_sale_id, product_id, discount_bp, rule_label, applied_regular_paisa, applied_sale_paisa, reference_paisa)
    values (active.id, (line ->> 'product_id')::uuid, (line ->> 'discount_bp')::integer, line ->> 'rule',
      (line ->> 'regular_paisa')::integer, (line ->> 'proposed_paisa')::integer, v_ref);
    applied := applied + 1;
  end loop;

  return private.pricing_request_done(p_request_id, 'size_sale_apply', v_payload, 'size_sale_applied',
    jsonb_build_object('group_id', p_group_id, 'size_sale_id', active.id, 'applied', applied, 'counts', plan -> 'counts'),
    jsonb_build_object('result', 'applied', 'applied', applied, 'size_sale_id', active.id, 'counts', plan -> 'counts',
      'with_was_price', (select count(*) from private.size_sale_lines l where l.size_sale_id = active.id and l.removed_at is null and l.reference_paisa is not null)));
end;
$$;

-- Ends the group's running size sale: removes only its sale prices; regular prices stay.
create function public.admin_end_size_sale(p_request_id uuid, p_group_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_payload jsonb := jsonb_build_object('group', p_group_id);
  earlier jsonb;
  active private.size_sales;
  l private.size_sale_lines;
  removed integer := 0;
  changed integer := 0;
begin
  perform public.admin_require_catalogue_admin();
  earlier := private.pricing_request_begin(p_request_id, 'size_sale_end', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  select * into active from private.size_sales s where s.group_id = p_group_id and s.status = 'active' for update;
  if active.id is null then
    return private.pricing_request_done(p_request_id, 'size_sale_end', v_payload, 'size_sale_end_nothing',
      jsonb_build_object('group_id', p_group_id), jsonb_build_object('result', 'nothing'));
  end if;
  perform 1 from public.products p
  where p.id in (select x.product_id from private.size_sale_lines x where x.size_sale_id = active.id and x.removed_at is null)
  order by p.id for update;
  for l in select * from private.size_sale_lines x where x.size_sale_id = active.id and x.removed_at is null order by x.product_id loop
    perform private.pricing_write_begin('size_sale_end', p_request_id, null);
    update public.products set sale_price_paisa = null where id = l.product_id and sale_price_paisa = l.applied_sale_paisa;
    if found then removed := removed + 1; else changed := changed + 1; end if;
    perform private.pricing_write_end();
    update private.size_sale_lines x set removed_at = now() where x.size_sale_id = l.size_sale_id and x.product_id = l.product_id;
  end loop;
  update private.size_sales set status = 'ended', ended_at = now(), ended_by = (select auth.uid()) where id = active.id;
  return private.pricing_request_done(p_request_id, 'size_sale_end', v_payload, 'size_sale_ended',
    jsonb_build_object('group_id', p_group_id, 'size_sale_id', active.id, 'removed', removed, 'changed', changed),
    jsonb_build_object('result', 'ended', 'removed', removed, 'changed', changed));
end;
$$;

-- ===========================================================================
-- The price guard: products in a running size sale are locked like campaign products.
-- Same body as 20261121120000_score_pricing_and_sales.sql except the marked
-- "in a running sale" check. CREATE OR REPLACE keeps its trigger and ACL.
-- ===========================================================================

create or replace function private.products_pricing_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  pricing private.product_pricing;
  writer boolean := coalesce(current_setting('kns.pricing_writer', true), '') = 'on';
  in_campaign boolean := false;
  candidate jsonb;
  ref integer;
begin
  select * into pricing from private.product_pricing pp where pp.product_id = new.id;

  -- (A zero price is refused by products_published_price_positive unless
  -- zero_price_approved, which only the pricing functions set. OLD is only
  -- read for updates.)
  if tg_op = 'UPDATE' and not writer then
    if new.zero_price_approved is distinct from old.zero_price_approved then
      raise exception 'Giveaways are set on the Pricing page only.' using errcode = 'PT400', hint = 'auto_priced';
    end if;
    if new.price_paisa is distinct from old.price_paisa and pricing.mode = 'auto' then
      raise exception 'This product is priced automatically from its score. Change it on the Pricing page, or switch it to a manual price there.'
        using errcode = 'PT400', hint = 'auto_priced';
    end if;
    select exists (
      select 1 from private.sale_campaign_products l join private.sale_campaigns c on c.id = l.campaign_id
      where l.product_id = new.id and c.status = 'active' and l.applied_at is not null and l.removed_at is null
    ) or exists (
      -- A running size sale (20261124120000_size_sales.sql) locks prices the same way.
      select 1 from private.size_sale_lines z join private.size_sales s on s.id = z.size_sale_id
      where z.product_id = new.id and s.status = 'active' and z.removed_at is null
    ) into in_campaign;
    if in_campaign and (new.price_paisa is distinct from old.price_paisa or new.sale_price_paisa is distinct from old.sale_price_paisa) then
      raise exception 'This product is in a running sale. Remove it from the sale (Sales) or end the sale before changing its prices.'
        using errcode = 'PT400', hint = 'campaign_price';
    end if;
    if new.referral_excluded is distinct from old.referral_excluded then
      raise exception 'Referral exclusion is set by sale campaigns only.' using errcode = 'PT400', hint = 'campaign_price';
    end if;
  end if;
  if tg_op = 'INSERT' and not writer then
    new.referral_excluded := false;
    new.zero_price_approved := false;
  end if;

  -- The reference price.
  if new.sale_price_paisa is null then
    new.reference_price_paisa := null;
    if tg_op = 'UPDATE' and old.sale_price_paisa is not null then
      delete from private.product_reference_prices r where r.product_id = new.id;
    end if;
  elsif tg_op = 'INSERT' then
    -- A new listing has no price history to support a "was" price.
    new.reference_price_paisa := null;
    insert into private.product_reference_prices (product_id, unsupported_reason) values (new.id, 'new_listing')
    on conflict (product_id) do update set reference_price_paisa = null, offered_price_paisa = null, offered_since = null,
      offered_until = null, history_id = null, unsupported_reason = 'new_listing', established_at = now(), lowered_at = null;
  elsif old.sale_price_paisa is null then
    -- A sale starts: the regular price it was offered at, if the history supports it.
    candidate := private.reference_candidate(old.id, old.price_paisa, old.publication_status);
    ref := null;
    if (candidate ->> 'supported')::boolean then
      ref := least(old.price_paisa, new.price_paisa);
      if ref <= new.sale_price_paisa then
        ref := null;
        candidate := candidate || jsonb_build_object('supported', false, 'reason', 'not_above_sale_price');
      end if;
    end if;
    new.reference_price_paisa := ref;
    insert into private.product_reference_prices (product_id, reference_price_paisa, offered_price_paisa, offered_since,
      offered_until, history_id, unsupported_reason)
    values (new.id, ref, case when ref is not null then old.price_paisa end,
      case when ref is not null then (candidate ->> 'offered_since')::timestamptz end,
      case when ref is not null then now() end,
      case when ref is not null then (candidate ->> 'history_id')::bigint end,
      case when ref is null then coalesce(candidate ->> 'reason', 'not_offered_at_price') end)
    on conflict (product_id) do update set reference_price_paisa = excluded.reference_price_paisa,
      offered_price_paisa = excluded.offered_price_paisa, offered_since = excluded.offered_since,
      offered_until = excluded.offered_until, history_id = excluded.history_id,
      unsupported_reason = excluded.unsupported_reason, established_at = now(), lowered_at = null;
  else
    -- The sale continues: the reference can only go down, never up.
    ref := old.reference_price_paisa;
    if ref is not null then
      ref := least(ref, new.price_paisa);
      if ref <= new.sale_price_paisa then
        ref := null;
      end if;
    end if;
    new.reference_price_paisa := ref;
    if ref is distinct from old.reference_price_paisa then
      update private.product_reference_prices r set reference_price_paisa = ref, lowered_at = now(),
        unsupported_reason = case when ref is null then 'not_above_sale_price' end
      where r.product_id = new.id;
    end if;
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- Repricing (Pricing page): a product in a running size sale is skipped with
-- the reason "size_sale_running" instead of having its regular price moved
-- under its sale price. Same body as 20261121120000_score_pricing_and_sales.sql
-- except the marked check. CREATE OR REPLACE keeps its ACL.
-- ===========================================================================

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
    calc := private.score_calculation(v_max, v_score, v_giveaway, s.price_ending_rupees);
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
-- Initial rules for the Kids Sneakers group, if it exists (editable on the page).
-- ===========================================================================

insert into private.size_sale_rule_sets (group_id, rules, default_discount_bp)
select g.id, '[{"from": 25, "to": 30, "discount_bp": 3000}, {"from": 36, "to": 36, "discount_bp": 3500}]'::jsonb, null
from private.pricing_groups g where lower(btrim(g.name)) = 'kids sneakers'
on conflict (group_id) do nothing;

-- ===========================================================================
-- Access
-- ===========================================================================

revoke all on table private.size_sale_rule_sets, private.size_sales, private.size_sale_lines from public, anon, authenticated;
revoke execute on function
  private.size_rules_validate(jsonb, integer),
  private.size_rule_match(jsonb, integer, numeric),
  private.size_sale_price(integer, integer),
  private.size_sale_plan(uuid, jsonb, integer)
  from public, anon, authenticated;
revoke execute on function
  public.admin_size_sale_overview(uuid),
  public.admin_preview_size_sale(uuid, jsonb, integer),
  public.admin_apply_size_sale(uuid, uuid, jsonb, integer, text),
  public.admin_end_size_sale(uuid, uuid)
  from public, anon;
grant execute on function
  public.admin_size_sale_overview(uuid),
  public.admin_preview_size_sale(uuid, jsonb, integer),
  public.admin_apply_size_sale(uuid, uuid, jsonb, integer, text),
  public.admin_end_size_sale(uuid, uuid)
  to authenticated;
