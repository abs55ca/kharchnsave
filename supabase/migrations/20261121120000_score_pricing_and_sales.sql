-- Score-based pricing, sale campaigns and honest discount display.
--
-- Builds on every earlier migration, through
-- 20261118120300_commission_hold_versions.sql (it replaces
-- private.checkout_quote as last defined in 20261118120100_referral_checkout.sql
-- and reads public.sales_agents). README, "Score pricing and sales", has the
-- rollout order and the verification queries.
--
-- The authoritative prices stay where they were: products.price_paisa (the
-- regular price) and products.sale_price_paisa (what customers pay while it
-- is set). Checkout, quotes, order snapshots, referral discounts and
-- commission keep reading only those, unchanged. Scores, pricing groups and
-- campaigns are a way of WRITING those two columns: through the admin
-- functions below, after a preview the admin confirmed, in one transaction.
--
-- Rules (also lib/pricing/rules.ts, which mirrors them for instant previews):
--   * calculated price = floor(group maximum × score / 100), in paisa;
--   * price ending: the highest positive whole-rupee price ending in E
--     (pricing_settings.price_ending_rupees, default 95) not above the
--     calculated amount; an amount already ending in E keeps it; none (e.g.
--     Rs. 90 with E = 95) is "too small": flagged, nothing is written;
--   * score 0 is "needs pricing" unless the admin explicitly made the product
--     a giveaway (product_pricing.giveaway); a published product can't cost 0
--     without that (products_published_price_positive);
--   * sale price = the ending rule applied to floor(regular × (100% − d));
--     the extra discount the ending adds is shown in every preview;
--   * products in manual mode (the default, and every existing product) keep
--     their price: nothing is converted, no score or cost is invented.
--
-- Honest discounts: a crossed-out "was" price needs a SUPPORTED reference
-- price. products.reference_price_paisa (public) is set only by the trigger
-- below, when a sale starts, and only if private.price_history shows the
-- product was actually offered (published, not on sale) at that regular
-- price, for at least pricing_settings.reference_min_days if the owner set
-- one (no minimum is assumed). Its provenance is kept in
-- private.product_reference_prices. While a sale continues the reference can
-- only go down (a higher new regular price never raises it); once it isn't
-- above the sale price it's dropped. Without one, the shop shows the selling
-- price only, with no badge. History starts with this migration: each
-- existing product gets one row "observed_at_migration" with its state now;
-- nothing earlier is assumed or backfilled.
--
-- Campaigns: one active product sale at a time. A campaign's product
-- selection is explicit and stable (included, or kept at the regular price
-- with an optional note); applying it requires the token of the preview the
-- admin saw, so exactly what was reviewed is applied, or nothing. A scheduled
-- start applies the reviewed prices only to products whose regular price is
-- still the one reviewed. Ends and scheduled starts run from
-- private.run_sale_schedule() (pg_cron, supabase/setup/schedule_sale_campaigns.sql)
-- or the admin's "Run due changes now".
--
-- Referral rules are unchanged: a line qualifies unless its product is on
-- sale and the agent's terms exclude sale items, and now also unless its
-- campaign explicitly excludes referral discounts (products.referral_excluded,
-- disclosed to shoppers). Discount and commission are still worked out once
-- per order (private.record_order_referral); existing orders, referral
-- snapshots and commissions are never touched.
--
-- Access: every new table is in the private schema (no API role can reach
-- it). Costs, scores, groups, margins and pricing history are only returned
-- by admin_* functions, which require a verified admin (member + aal2). Every
-- admin write carries a request id: a retry with the same request returns the
-- original answer; the same id with anything else is refused (request_mismatch).
--
-- Locking: every pricing write and the schedule job take one transaction
-- advisory lock first (pricing writes are serialised), then settings, groups,
-- campaigns, then products in id order. Checkout takes products FOR SHARE in
-- id order too, so an order being placed keeps the price it was quoted, and
-- the next quote sees the new one (quote_changed).

-- ===========================================================================
-- Tables
-- ===========================================================================

create table private.pricing_settings (
  id boolean primary key default true,
  price_ending_rupees smallint not null default 95,
  min_profit_paisa integer,
  min_margin_bp integer,
  reference_min_days integer,
  new_sale_target_bp integer not null default 8500,
  preloved_sale_target_bp integer not null default 10000,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint pricing_settings_single_row check (id),
  constraint pricing_settings_ending_range check (price_ending_rupees between 0 and 99),
  constraint pricing_settings_profit_range check (min_profit_paisa is null or min_profit_paisa between 0 and 100000000),
  constraint pricing_settings_margin_range check (min_margin_bp is null or min_margin_bp between 1 and 9000),
  constraint pricing_settings_reference_days_range check (reference_min_days is null or reference_min_days between 1 and 365),
  constraint pricing_settings_targets_range check (new_sale_target_bp between 0 and 10000 and preloved_sale_target_bp between 0 and 10000)
);

insert into private.pricing_settings (id) values (true);

comment on table private.pricing_settings is
  'One row: price ending, optional minimum profit/margin, optional minimum days for a reference price, sale coverage targets.';

create table private.pricing_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  max_price_paisa integer not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  constraint pricing_groups_name_valid check (char_length(name) between 2 and 60 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  constraint pricing_groups_max_valid check (max_price_paisa between 10000 and 100000000 and max_price_paisa % 100 = 0)
);

create unique index pricing_groups_name_key on private.pricing_groups (lower(name));

comment on table private.pricing_groups is
  'Pricing groups: each has its own maximum price (score 100). A product belongs to at most one.';

create table private.product_pricing (
  product_id uuid primary key references public.products (id) on delete cascade,
  mode text not null default 'manual',
  group_id uuid references private.pricing_groups (id) on delete restrict,
  score smallint,
  cost_paisa integer,
  giveaway boolean not null default false,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint product_pricing_mode_valid check (mode in ('manual', 'auto')),
  constraint product_pricing_score_range check (score is null or score between 0 and 100),
  constraint product_pricing_cost_range check (cost_paisa is null or cost_paisa between 0 and 100000000),
  constraint product_pricing_auto_complete check (mode <> 'auto' or (group_id is not null and score is not null)),
  constraint product_pricing_giveaway_explicit check (not giveaway or (mode = 'auto' and score = 0))
);

create index product_pricing_group_idx on private.product_pricing (group_id);

comment on table private.product_pricing is
  'Internal pricing inputs per product: manual (keeps its price) or auto (price from group maximum × score), cost (null = unknown), giveaway.';
comment on column private.product_pricing.cost_paisa is
  'What the product cost the shop, per unit. Null means unknown (never treated as zero).';

-- Every change of a product's regular, sale or reference price or its
-- publication status, written by the trigger below. Append-only. Product ids
-- aren't foreign keys: the history outlives anything.
create table private.price_history (
  id bigint generated always as identity primary key,
  product_id uuid not null,
  regular_price_paisa integer not null,
  sale_price_paisa integer,
  reference_price_paisa integer,
  publication_status text not null,
  reason text not null,
  campaign_id uuid,
  request_id uuid,
  actor_user_id uuid,
  created_at timestamptz not null default now()
);

create index price_history_product_idx on private.price_history (product_id, id);

create trigger price_history_append_only before update or delete on private.price_history
  for each row execute function private.append_only();
create trigger price_history_no_truncate before truncate on private.price_history
  for each statement execute function private.append_only();

comment on table private.price_history is
  'Genuine price history (append-only): what each product was offered at, when, and why it changed. Starts at this migration.';

-- The current sale's reference price and where it came from (or why there
-- is none). One row per product while it is on sale.
create table private.product_reference_prices (
  product_id uuid primary key,
  reference_price_paisa integer,
  offered_price_paisa integer,
  offered_since timestamptz,
  offered_until timestamptz,
  history_id bigint,
  unsupported_reason text,
  established_at timestamptz not null default now(),
  lowered_at timestamptz,
  constraint product_reference_prices_reason check ((reference_price_paisa is null) = (unsupported_reason is not null))
);

comment on table private.product_reference_prices is
  'Provenance of products.reference_price_paisa: the regular price the product was offered at (published, no sale) from offered_since until the sale began.';

-- Admin requests and other pricing events (append-only). A row with a
-- request_id is that request's identity and original answer.
create table private.pricing_events (
  id bigint generated always as identity primary key,
  kind text not null,
  details jsonb not null default '{}'::jsonb,
  actor_user_id uuid,
  request_id uuid,
  operation text,
  request_fingerprint bytea,
  result jsonb,
  created_at timestamptz not null default now(),
  constraint pricing_events_request_complete check (
    request_id is null or (operation is not null and octet_length(request_fingerprint) = 32 and result is not null))
);

create unique index pricing_events_request_key on private.pricing_events (request_id) where request_id is not null;
create index pricing_events_kind_idx on private.pricing_events (kind, id);

create trigger pricing_events_append_only before update or delete on private.pricing_events
  for each row execute function private.append_only();
create trigger pricing_events_no_truncate before truncate on private.pricing_events
  for each statement execute function private.append_only();

create table private.sale_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  preset text not null default 'custom',
  discount_bp integer not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  referral_allowed boolean not null default true,
  require_reference boolean not null default false,
  status text not null default 'draft',
  version integer not null default 1,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  activated_by uuid,
  started_at timestamptz,
  ended_at timestamptz,
  ended_by uuid,
  end_reason text,
  constraint sale_campaigns_name_valid check (char_length(name) between 2 and 80 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  constraint sale_campaigns_preset_valid check (preset in ('new', 'preloved_recent', 'preloved_slow', 'clearance', 'custom')),
  constraint sale_campaigns_discount_range check (discount_bp between 100 and 9000),
  constraint sale_campaigns_window check (ends_at is null or ends_at > starts_at),
  constraint sale_campaigns_status_valid check (status in ('draft', 'scheduled', 'active', 'ended', 'cancelled')),
  constraint sale_campaigns_end_reason_valid check (end_reason is null or end_reason in ('admin', 'schedule'))
);

comment on table private.sale_campaigns is
  'Sale campaigns: draft → scheduled → active → ended, or cancelled. One active product sale at a time.';

create table private.sale_campaign_products (
  campaign_id uuid not null references private.sale_campaigns (id) on delete restrict,
  product_id uuid not null references public.products (id) on delete cascade,
  -- The admin's selection: true = on sale; false = kept at the regular price.
  included boolean not null,
  note text,
  -- An explicit, audited exception to the margin rule (or to unknown costs).
  margin_override_reason text,
  override_by uuid,
  override_at timestamptz,
  -- Reviewed at activation of a scheduled campaign.
  planned_regular_paisa integer,
  planned_sale_paisa integer,
  -- What the campaign actually set (a "live" line: applied and not removed).
  applied_regular_paisa integer,
  applied_sale_paisa integer,
  applied_at timestamptz,
  removed_at timestamptz,
  skipped_reason text,
  updated_at timestamptz not null default now(),
  primary key (campaign_id, product_id),
  constraint sale_campaign_products_note_valid check (note is null or char_length(note) between 1 and 200),
  constraint sale_campaign_products_override_valid check (
    margin_override_reason is null or char_length(margin_override_reason) between 5 and 300),
  constraint sale_campaign_products_applied_complete check (
    (applied_at is null) = (applied_sale_paisa is null) and (applied_at is null) = (applied_regular_paisa is null))
);

create index sale_campaign_products_product_idx on private.sale_campaign_products (product_id);

-- ===========================================================================
-- Public product columns
-- ===========================================================================

alter table public.products
  add column reference_price_paisa integer,
  add column referral_excluded boolean not null default false,
  add column zero_price_approved boolean not null default false,
  add constraint products_reference_price_valid check (
    reference_price_paisa is null or (sale_price_paisa is not null and reference_price_paisa > sale_price_paisa));

-- A published product still needs a price above zero (same rule and name as in
-- 20261029120000_admin_product_management.sql), except an explicit giveaway:
-- zero_price_approved is set only by the pricing functions, when an admin
-- marks the product as a giveaway (audited in private.pricing_events).
alter table public.products drop constraint products_published_price_positive;
alter table public.products add constraint products_published_price_positive
  check (publication_status <> 'published' or price_paisa > 0 or zero_price_approved);

comment on column public.products.zero_price_approved is
  'True only for an explicit giveaway (Pricing): then, and only then, a published product may cost 0.';

comment on column public.products.reference_price_paisa is
  'The supported "was" price for the current sale (set only by the database from genuine price history; null: show no discount badge).';
comment on column public.products.referral_excluded is
  'True while a campaign that excludes referral discounts has this product on sale (shown to shoppers).';

-- Visitors and signed-in users read the same public column list (db-tests/hardening.test.ts).
grant select (reference_price_paisa, referral_excluded) on table public.products to anon, authenticated;

-- History starts now: one observation per existing product, nothing earlier.
insert into private.price_history (product_id, regular_price_paisa, sale_price_paisa, reference_price_paisa, publication_status, reason)
select p.id, p.price_paisa, p.sale_price_paisa, null, p.publication_status, 'observed_at_migration'
from public.products p
order by p.id;

-- Products already on a (manual) sale have no supported reference yet.
insert into private.product_reference_prices (product_id, unsupported_reason)
select p.id, 'no_history_before_tracking' from public.products p where p.sale_price_paisa is not null;

-- ===========================================================================
-- Calculations (immutable; mirrored by lib/pricing/rules.ts)
-- ===========================================================================

-- The highest positive whole-rupee price ending in p_ending (0-99) that
-- doesn't exceed p_amount paisa; null if there is none.
create function private.price_with_ending(p_amount bigint, p_ending integer)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when c > 0 then (c * 100)::bigint end
  from (select p_ending + 100 * floor((floor(p_amount::numeric / 100) - p_ending) / 100) as c) x;
$$;

-- {status: ok | giveaway | needs_pricing | too_small | not_set, calculated_paisa, price_paisa}
create function private.score_calculation(p_max integer, p_score integer, p_giveaway boolean, p_ending integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when p_max is null or p_score is null then jsonb_build_object('status', 'not_set', 'calculated_paisa', null, 'price_paisa', null)
    when p_score = 0 and coalesce(p_giveaway, false) then jsonb_build_object('status', 'giveaway', 'calculated_paisa', 0, 'price_paisa', 0)
    when p_score = 0 then jsonb_build_object('status', 'needs_pricing', 'calculated_paisa', 0, 'price_paisa', null)
    else (
      select jsonb_build_object('status', case when b.p is null then 'too_small' else 'ok' end, 'calculated_paisa', b.c, 'price_paisa', b.p)
      from (select a.c, private.price_with_ending(a.c, p_ending) as p
            from (select floor(p_max::numeric * p_score / 100)::bigint as c) a) b)
  end;
$$;

-- {raw_paisa, price_paisa (null: too small), rounding_paisa, actual_percent}
create function private.sale_calculation(p_regular integer, p_bp integer, p_ending integer)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'raw_paisa', b.raw,
    'price_paisa', b.price,
    'rounding_paisa', case when b.price is not null then b.raw - b.price end,
    'actual_percent', case when b.price is not null then ((p_regular::bigint - b.price) * 100 / p_regular)::integer end)
  from (select a.raw, case when p_regular > 0 then private.price_with_ending(a.raw, p_ending) end as price
        from (select floor(p_regular::numeric * (10000 - p_bp) / 10000)::bigint as raw) a) b;
$$;

-- The badge percentage: floor(100 × (reference − sale) / reference), or null.
create function private.badge_percent(p_reference integer, p_sale integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case when p_reference is not null and p_sale is not null and p_sale > 0 and p_reference > p_sale
              then ((p_reference::bigint - p_sale) * 100 / p_reference)::integer end;
$$;

-- ===========================================================================
-- Request identity and audit
-- ===========================================================================

create function private.pricing_fingerprint(p_operation text, p_payload jsonb)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select sha256(convert_to(jsonb_build_object('operation', p_operation, 'payload', p_payload)::text, 'UTF8'));
$$;

-- Serialises everything that writes prices (and the schedule job), then a
-- request id: returns the original answer if this request was already
-- applied (null if not); the same id with another identity is refused.
create function private.pricing_request_begin(p_request_id uuid, p_operation text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  earlier private.pricing_events;
begin
  if p_request_id is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  perform pg_advisory_xact_lock(20261121, 1);
  select * into earlier from private.pricing_events e where e.request_id = p_request_id;
  if not found then
    return null;
  end if;
  if earlier.operation = p_operation and earlier.request_fingerprint = private.pricing_fingerprint(p_operation, p_payload) then
    return earlier.result || jsonb_build_object('replayed', true);
  end if;
  raise exception 'This form was already used for a different change. Reload the page.' using errcode = 'PT409', hint = 'request_mismatch';
end;
$$;

-- Records an applied request (its identity and answer) and returns the answer.
create function private.pricing_request_done(
  p_request_id uuid, p_operation text, p_payload jsonb, p_kind text, p_details jsonb, p_result jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.pricing_events (kind, details, actor_user_id, request_id, operation, request_fingerprint, result)
  values (p_kind, coalesce(p_details, '{}'::jsonb), (select auth.uid()), p_request_id, p_operation,
    private.pricing_fingerprint(p_operation, p_payload), p_result);
  return p_result;
end;
$$;

-- Marks the rest of this transaction's product price writes as made by the
-- pricing functions (so the guard lets them through) and says why.
create function private.pricing_write_begin(p_reason text, p_request_id uuid, p_campaign_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('kns.pricing_writer', 'on', true);
  perform set_config('kns.price_reason', p_reason, true);
  perform set_config('kns.price_request', coalesce(p_request_id::text, ''), true);
  perform set_config('kns.price_campaign', coalesce(p_campaign_id::text, ''), true);
end;
$$;

create function private.pricing_write_end()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('kns.pricing_writer', '', true);
  perform set_config('kns.price_reason', '', true);
  perform set_config('kns.price_request', '', true);
  perform set_config('kns.price_campaign', '', true);
end;
$$;

-- ===========================================================================
-- Reference prices
-- ===========================================================================

-- Would a sale starting now have a supported reference price? Looks at the
-- product's history: the latest unbroken run of "published, no sale, this
-- regular price". {supported, price_paisa, offered_since, history_id} or
-- {supported: false, reason}.
create function private.reference_candidate(p_product_id uuid, p_price integer, p_status text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  boundary bigint;
  run_first bigint;
  since timestamptz;
  min_days integer := (select s.reference_min_days from private.pricing_settings s);
begin
  if p_status is distinct from 'published' then
    return jsonb_build_object('supported', false, 'reason', 'not_published');
  end if;
  select max(h.id) into boundary from private.price_history h
  where h.product_id = p_product_id
    and not (h.publication_status = 'published' and h.sale_price_paisa is null and h.regular_price_paisa = p_price);
  select min(h.id), min(h.created_at) into run_first, since from private.price_history h
  where h.product_id = p_product_id and h.id > coalesce(boundary, 0);
  if run_first is null then
    return jsonb_build_object('supported', false, 'reason', 'not_offered_at_price');
  end if;
  if min_days is not null and since > now() - make_interval(days => min_days) then
    return jsonb_build_object('supported', false, 'reason', 'offered_too_briefly', 'offered_since', since, 'price_paisa', p_price);
  end if;
  return jsonb_build_object('supported', true, 'price_paisa', p_price, 'offered_since', since, 'history_id', run_first);
end;
$$;

-- ===========================================================================
-- Product triggers
-- ===========================================================================

-- Before a product is written:
--   * a published product can't cost 0 unless it is an explicit giveaway;
--   * an automatically priced product's price, and a product's price while a
--     running campaign has it on sale, change only through the pricing
--     functions (so a stale product form can't undo a reviewed repricing);
--   * the reference price is worked out here, never taken from the caller.
create function private.products_pricing_guard()
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

create trigger products_pricing_guard
  before insert or update on public.products
  for each row execute function private.products_pricing_guard();

-- After: the price history.
create function private.products_price_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := 'created';
begin
  -- (OLD is only read for updates.)
  if tg_op = 'UPDATE' then
    if (new.price_paisa, new.sale_price_paisa, new.reference_price_paisa, new.publication_status)
       is not distinct from (old.price_paisa, old.sale_price_paisa, old.reference_price_paisa, old.publication_status) then
      return null;
    end if;
    v_reason := case when (new.price_paisa, new.sale_price_paisa) is not distinct from (old.price_paisa, old.sale_price_paisa)
                     then 'publication_changed' else 'product_saved' end;
  end if;
  insert into private.price_history (product_id, regular_price_paisa, sale_price_paisa, reference_price_paisa,
    publication_status, reason, campaign_id, request_id, actor_user_id)
  values (new.id, new.price_paisa, new.sale_price_paisa, new.reference_price_paisa, new.publication_status,
    coalesce(nullif(current_setting('kns.price_reason', true), ''), v_reason),
    nullif(current_setting('kns.price_campaign', true), '')::uuid,
    nullif(current_setting('kns.price_request', true), '')::uuid,
    (select auth.uid()));
  return null;
end;
$$;

create trigger products_price_history
  after insert or update on public.products
  for each row execute function private.products_price_history();

-- Versions for the admin forms.
create function private.bump_pricing_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

create trigger pricing_settings_version before update on private.pricing_settings
  for each row execute function private.bump_pricing_version();
create trigger pricing_groups_version before update on private.pricing_groups
  for each row execute function private.bump_pricing_version();
create trigger product_pricing_version before update on private.product_pricing
  for each row execute function private.bump_pricing_version();
create trigger sale_campaigns_version before update on private.sale_campaigns
  for each row execute function private.bump_pricing_version();

-- ===========================================================================
-- What the admin sees of a product's pricing
-- ===========================================================================

create view private.product_pricing_state as
select
  p.id as product_id, p.item_code, p.name, p.brand, p.item_status, p.publication_status, p.listed_at,
  p.price_paisa, p.sale_price_paisa, p.reference_price_paisa, p.referral_excluded, p.version as product_version,
  coalesce((select sum(v.stock) from public.product_variants v where v.product_id = p.id), 0)::integer as stock,
  coalesce(pp.mode, 'manual') as mode, pp.group_id, g.name as group_name, g.max_price_paisa, g.version as group_version,
  pp.score::integer as score, pp.cost_paisa, coalesce(pp.giveaway, false) as giveaway, coalesce(pp.version, 0) as pricing_version,
  live.campaign_id, live.campaign_name, live.discount_bp as campaign_discount_bp, live.referral_allowed as campaign_referral_allowed,
  live.applied_sale_paisa
from public.products p
left join private.product_pricing pp on pp.product_id = p.id
left join private.pricing_groups g on g.id = pp.group_id
left join lateral (
  select l.campaign_id, c.name as campaign_name, c.discount_bp, c.referral_allowed, l.applied_sale_paisa
  from private.sale_campaign_products l
  join private.sale_campaigns c on c.id = l.campaign_id
  where l.product_id = p.id and c.status = 'active' and l.applied_at is not null and l.removed_at is null
  limit 1
) live on true;

-- One unit's money under every referral scenario that can apply to it, with
-- the CURRENT terms of every enabled code (agents' terms differ; the worst
-- case is what a guaranteed margin is checked against). An estimate per unit:
-- an order's discount and commission are worked out once per order.
create function private.unit_economics(p_price bigint, p_cost integer, p_on_sale boolean, p_referral_allowed boolean)
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
    when s.min_margin_bp is not null
      and (worst ->> 'retained_paisa')::bigint * 10000 < s.min_margin_bp::bigint * (worst ->> 'paid_paisa')::bigint then 'violation'
    else 'ok' end;
  return jsonb_build_object('price_paisa', p_price, 'cost_paisa', p_cost, 'on_sale', p_on_sale,
    'referral_allowed', p_referral_allowed, 'scenarios', scenarios, 'worst', worst, 'margin', margin,
    'agents_enabled', enabled, 'agents_excluded', excluded);
end;
$$;

-- ===========================================================================
-- Pricing plans: what a change would do, line by line (previews and applies
-- use the same plan; an apply needs the token of the preview the admin saw)
-- ===========================================================================

-- A pricing item from a request, validated and normalised:
-- {product_id, mode, group_id, score, cost_paisa, giveaway, override_reason}.
create function private.pricing_item_input(p_item jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_product text := lower(coalesce(p_item ->> 'product_id', ''));
  v_group text := lower(p_item ->> 'group_id');
  t_score text := coalesce(jsonb_typeof(p_item -> 'score'), 'null');
  t_cost text := coalesce(jsonb_typeof(p_item -> 'cost_paisa'), 'null');
  t_giveaway text := coalesce(jsonb_typeof(p_item -> 'giveaway'), 'null');
  v_override text := nullif(regexp_replace(btrim(coalesce(p_item ->> 'override_reason', '')), '\s+', ' ', 'g'), '');
begin
  if jsonb_typeof(p_item) is distinct from 'object' or v_product !~ uuid_re
    or coalesce(p_item ->> 'mode', '') not in ('manual', 'auto')
    or (v_group is not null and v_group !~ uuid_re)
    or t_score not in ('number', 'null') or t_cost not in ('number', 'null') or t_giveaway not in ('boolean', 'null')
    or (t_score = 'number' and ((p_item ->> 'score') !~ '^[0-9]{1,3}$' or (p_item ->> 'score')::integer > 100))
    or (t_cost = 'number' and ((p_item ->> 'cost_paisa') !~ '^[0-9]{1,9}$' or (p_item ->> 'cost_paisa')::bigint > 100000000))
    or (v_override is not null and (char_length(v_override) not between 5 and 300 or v_override ~ '[[:cntrl:]]')) then
    raise exception 'Malformed pricing item.' using errcode = 'PT400', hint = 'invalid_item';
  end if;
  return jsonb_build_object('product_id', v_product, 'mode', p_item ->> 'mode', 'group_id', v_group,
    'score', case when t_score = 'number' then (p_item ->> 'score')::integer end,
    'cost_paisa', case when t_cost = 'number' then (p_item ->> 'cost_paisa')::integer end,
    'giveaway', coalesce((p_item ->> 'giveaway')::boolean, false),
    'override_reason', v_override);
end;
$$;

-- One product's line: the pricing it has, the pricing asked for (p_desired,
-- a normalised item), what the rules give, what would be written, and why
-- not if it can't be. p_max_override: the group maximum to use (repricing).
create function private.pricing_line(p_product_id uuid, p_desired jsonb, p_max_override integer)
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

create function private.plan_summary(p_lines jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'apply', count(*) filter (where l ->> 'action' = 'apply'),
    'unchanged', count(*) filter (where l ->> 'action' = 'unchanged'),
    'skip', count(*) filter (where l ->> 'action' = 'skip'),
    'price_changes', count(*) filter (where l ->> 'action' = 'apply'
      and ((l -> 'from' ->> 'price_paisa') is distinct from (l -> 'to' ->> 'price_paisa')
           or (l -> 'from' ->> 'sale_price_paisa') is distinct from (l -> 'to' ->> 'sale_price_paisa'))))
  from jsonb_array_elements(p_lines) l;
$$;

-- A plan for setting products' pricing (bulk setup, one product's panel).
create function private.product_pricing_plan(p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
  items jsonb;
  lines jsonb;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 200 then
    raise exception 'Choose 1 to 200 products.' using errcode = 'PT400', hint = 'invalid_items';
  end if;
  select jsonb_agg(private.pricing_item_input(i) order by n) into items
  from jsonb_array_elements(p_items) with ordinality as x (i, n);
  if (select count(distinct i ->> 'product_id') from jsonb_array_elements(items) i) <> jsonb_array_length(items) then
    raise exception 'Each product can appear once.' using errcode = 'PT400', hint = 'invalid_items';
  end if;
  select * into s from private.pricing_settings;
  select jsonb_agg(private.pricing_line((i ->> 'product_id')::uuid, i, null) order by n) into lines
  from jsonb_array_elements(items) with ordinality as x (i, n);
  return jsonb_build_object('kind', 'product_pricing', 'items', items, 'lines', lines,
    'summary', private.plan_summary(lines), 'settings_version', s.version,
    'token', encode(sha256(convert_to(jsonb_build_object('items', items, 'lines', lines, 'settings', s.version)::text, 'UTF8')), 'hex'));
end;
$$;

-- A plan for changing group maximums (p_changes: [{group_id, max_price_paisa}]),
-- or, with no changes, for bringing every automatic price up to date with
-- its group's maximum and the current price ending.
create function private.reprice_plan(p_changes jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  changes jsonb;
  groups jsonb;
  lines jsonb;
begin
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) > 50 or exists (
    select 1 from jsonb_array_elements(p_changes) c
    where jsonb_typeof(c) <> 'object' or lower(coalesce(c ->> 'group_id', '')) !~ uuid_re
      or coalesce(jsonb_typeof(c -> 'max_price_paisa'), '') <> 'number' or (c ->> 'max_price_paisa') !~ '^[0-9]{5,9}$'
      or (c ->> 'max_price_paisa')::integer not between 10000 and 100000000 or (c ->> 'max_price_paisa')::integer % 100 <> 0
  ) then
    raise exception 'Maximum prices are whole rupees from Rs. 100 to Rs. 10,00,000.' using errcode = 'PT400', hint = 'invalid_maximum';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('group_id', lower(c ->> 'group_id'), 'max_price_paisa', (c ->> 'max_price_paisa')::integer)
                            order by lower(c ->> 'group_id')), '[]'::jsonb)
  into changes from jsonb_array_elements(p_changes) c;
  if (select count(distinct c ->> 'group_id') from jsonb_array_elements(changes) c) <> jsonb_array_length(changes) then
    raise exception 'Each group can appear once.' using errcode = 'PT400', hint = 'invalid_maximum';
  end if;
  if exists (select 1 from jsonb_array_elements(changes) c
             where not exists (select 1 from private.pricing_groups g where g.id = (c ->> 'group_id')::uuid)) then
    raise exception 'That pricing group no longer exists. Reload the page.' using errcode = 'PT404', hint = 'unknown_group';
  end if;
  select * into s from private.pricing_settings;

  select coalesce(jsonb_agg(jsonb_build_object('group_id', g.id, 'name', g.name, 'version', g.version,
           'max_from', g.max_price_paisa, 'max_to', (c ->> 'max_price_paisa')::integer) order by g.name), '[]'::jsonb)
  into groups
  from jsonb_array_elements(changes) c join private.pricing_groups g on g.id = (c ->> 'group_id')::uuid;

  select coalesce(jsonb_agg(private.pricing_line(pp.product_id,
           jsonb_build_object('product_id', pp.product_id, 'mode', pp.mode, 'group_id', pp.group_id, 'score', pp.score,
             'cost_paisa', pp.cost_paisa, 'giveaway', pp.giveaway, 'override_reason', null),
           (select (c ->> 'max_price_paisa')::integer from jsonb_array_elements(changes) c where (c ->> 'group_id')::uuid = pp.group_id))
         order by p.item_code), '[]'::jsonb)
  into lines
  from private.product_pricing pp
  join public.products p on p.id = pp.product_id
  where pp.mode = 'auto'
    and (jsonb_array_length(changes) = 0
         or pp.group_id in (select (c ->> 'group_id')::uuid from jsonb_array_elements(changes) c));

  return jsonb_build_object('kind', 'reprice', 'changes', changes, 'groups', groups, 'lines', lines,
    'summary', private.plan_summary(lines), 'settings_version', s.version,
    'token', encode(sha256(convert_to(jsonb_build_object('changes', changes, 'groups', groups, 'lines', lines,
      'settings', s.version)::text, 'UTF8')), 'hex'));
end;
$$;

-- Writes one applied line: the pricing record, then (if they change) the
-- product's prices and its running campaign line.
create function private.write_pricing_line(p_line jsonb, p_request_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product uuid := (p_line ->> 'product_id')::uuid;
  v_to jsonb := p_line -> 'to';
  v_from jsonb := p_line -> 'from';
begin
  insert into private.product_pricing (product_id, mode, group_id, score, cost_paisa, giveaway, updated_by)
  values (v_product, v_to ->> 'mode', (v_to ->> 'group_id')::uuid, (v_to ->> 'score')::smallint, (v_to ->> 'cost_paisa')::integer,
    (v_to ->> 'giveaway')::boolean, (select auth.uid()))
  on conflict (product_id) do update set mode = excluded.mode, group_id = excluded.group_id, score = excluded.score,
    cost_paisa = excluded.cost_paisa, giveaway = excluded.giveaway, updated_by = excluded.updated_by
  where (private.product_pricing.mode, private.product_pricing.group_id, private.product_pricing.score,
         private.product_pricing.cost_paisa, private.product_pricing.giveaway)
        is distinct from (excluded.mode, excluded.group_id, excluded.score, excluded.cost_paisa, excluded.giveaway);

  if (v_to ->> 'price_paisa', v_to ->> 'sale_price_paisa', v_to ->> 'giveaway')
     is distinct from (v_from ->> 'price_paisa', v_from ->> 'sale_price_paisa', v_from ->> 'giveaway') then
    perform private.pricing_write_begin(p_reason, p_request_id, (p_line -> 'campaign' ->> 'id')::uuid);
    update public.products set price_paisa = (v_to ->> 'price_paisa')::integer, sale_price_paisa = (v_to ->> 'sale_price_paisa')::integer,
      zero_price_approved = (v_to ->> 'giveaway')::boolean and (v_to ->> 'price_paisa')::integer = 0
    where id = v_product;
    if p_line -> 'campaign' ->> 'id' is not null then
      update private.sale_campaign_products l set applied_regular_paisa = (v_to ->> 'price_paisa')::integer,
        applied_sale_paisa = (v_to ->> 'sale_price_paisa')::integer, updated_at = now()
      where l.campaign_id = (p_line -> 'campaign' ->> 'id')::uuid and l.product_id = v_product;
    end if;
    perform private.pricing_write_end();
  end if;
end;
$$;

-- ===========================================================================
-- Campaigns
-- ===========================================================================

-- {name, preset, discount_bp, starts_at, ends_at, referral_allowed, require_reference}, validated.
create function private.campaign_input(p_campaign jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_campaign ->> 'name', '')), '\s+', ' ', 'g');
  v_bp text := p_campaign ->> 'discount_bp';
  v_starts timestamptz;
  v_ends timestamptz;
begin
  if jsonb_typeof(p_campaign) is distinct from 'object' then
    raise exception 'Malformed campaign.' using errcode = 'PT400', hint = 'invalid_campaign';
  end if;
  if char_length(v_name) not between 2 and 80 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Name the sale (2-80 characters).' using errcode = 'PT400', hint = 'invalid_name';
  end if;
  if v_bp is null or v_bp !~ '^[0-9]{3,4}$' or v_bp::integer not between 100 and 9000 then
    raise exception 'The discount is 1%% to 90%%.' using errcode = 'PT400', hint = 'invalid_discount';
  end if;
  begin
    v_starts := (p_campaign ->> 'starts_at')::timestamptz;
    v_ends := (p_campaign ->> 'ends_at')::timestamptz;
  exception when others then
    raise exception 'Enter valid start and end times.' using errcode = 'PT400', hint = 'invalid_window';
  end;
  if v_starts is null or (v_ends is not null and v_ends <= v_starts) then
    raise exception 'The sale needs a start, and its end must come after it.' using errcode = 'PT400', hint = 'invalid_window';
  end if;
  if coalesce(p_campaign ->> 'preset', 'custom') not in ('new', 'preloved_recent', 'preloved_slow', 'clearance', 'custom')
    or coalesce(jsonb_typeof(p_campaign -> 'referral_allowed'), 'boolean') <> 'boolean'
    or coalesce(jsonb_typeof(p_campaign -> 'require_reference'), 'boolean') <> 'boolean' then
    raise exception 'Malformed campaign.' using errcode = 'PT400', hint = 'invalid_campaign';
  end if;
  return jsonb_build_object('name', v_name, 'preset', coalesce(p_campaign ->> 'preset', 'custom'), 'discount_bp', v_bp::integer,
    'starts_at', v_starts, 'ends_at', v_ends,
    'referral_allowed', coalesce((p_campaign ->> 'referral_allowed')::boolean, true),
    'require_reference', coalesce((p_campaign ->> 'require_reference')::boolean, false));
end;
$$;

create function private.campaign_view(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'preset', c.preset, 'discount_bp', c.discount_bp,
    'starts_at', c.starts_at, 'ends_at', c.ends_at, 'referral_allowed', c.referral_allowed,
    'require_reference', c.require_reference, 'status', c.status, 'version', c.version,
    'created_at', c.created_at, 'activated_at', c.activated_at, 'started_at', c.started_at,
    'ended_at', c.ended_at, 'end_reason', c.end_reason,
    -- By the database's clock; part of a preview's token, so "schedule" never becomes "start now" unseen.
    'starts_in_future', c.starts_at > now(),
    'due', case when c.status = 'scheduled' and c.starts_at <= now() then 'start'
                when c.status = 'active' and c.ends_at <= now() then 'end' end)
  from private.sale_campaigns c where c.id = p_campaign_id;
$$;

-- Other scheduled or active campaigns whose window overlaps this one's.
create function private.campaign_overlaps(p_campaign private.sale_campaigns)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status,
    'starts_at', o.starts_at, 'ends_at', o.ends_at) order by o.starts_at), '[]'::jsonb)
  from private.sale_campaigns o
  where o.id <> p_campaign.id and o.status in ('scheduled', 'active')
    and tstzrange(o.starts_at, coalesce(o.ends_at, 'infinity')) && tstzrange(p_campaign.starts_at, coalesce(p_campaign.ends_at, 'infinity'));
$$;

-- Whether a selected product can go on sale now, and at what price.
-- {action: apply | skip, reason, sale, reference...}
create function private.campaign_candidate(p_campaign private.sale_campaigns, p_line private.sale_campaign_products, st private.product_pricing_state)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
  sale_calc jsonb;
  v_sale integer;
  candidate jsonb;
  v_ref integer;
  econ jsonb;
  reason text;
begin
  select * into s from private.pricing_settings;
  if st.price_paisa > 0 then
    sale_calc := private.sale_calculation(st.price_paisa, p_campaign.discount_bp, s.price_ending_rupees);
    v_sale := (sale_calc ->> 'price_paisa')::integer;
  end if;
  candidate := private.reference_candidate(st.product_id, st.price_paisa, st.publication_status);
  if (candidate ->> 'supported')::boolean and v_sale is not null then
    v_ref := (candidate ->> 'price_paisa')::integer;
    if v_ref <= v_sale then
      v_ref := null;
      candidate := candidate || jsonb_build_object('supported', false, 'reason', 'not_above_sale_price');
    end if;
  end if;
  if v_sale is not null then
    econ := private.unit_economics(v_sale, st.cost_paisa, true, p_campaign.referral_allowed);
  end if;
  reason := case
    when st.publication_status <> 'published' then 'not_published'
    when st.price_paisa = 0 then 'free_item'
    when st.sale_price_paisa is not null then 'other_sale'
    when v_sale is null then 'sale_too_small'
    when p_campaign.require_reference and v_ref is null then 'no_reference'
    when econ ->> 'margin' = 'violation' and p_line.margin_override_reason is null then 'margin_violation'
    when econ ->> 'margin' = 'cost_unknown' and p_line.margin_override_reason is null then 'cost_unknown'
  end;
  return jsonb_build_object('action', case when reason is null then 'apply' else 'skip' end, 'reason', reason,
    'regular_paisa', st.price_paisa, 'sale', sale_calc, 'sale_paisa', v_sale, 'reference_paisa', v_ref,
    'reference', candidate, 'badge_percent', private.badge_percent(v_ref, v_sale), 'economics', econ);
end;
$$;

-- What applying the campaign now would do, line by line, with a token.
create function private.campaign_plan(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c private.sale_campaigns;
  s private.pricing_settings;
  r record;
  l private.sale_campaign_products;
  st private.product_pricing_state;
  cand jsonb;
  lines jsonb := '[]'::jsonb;
  live boolean;
  action text;
  econ jsonb;
begin
  select * into c from private.sale_campaigns x where x.id = p_campaign_id;
  if not found then
    raise exception 'Sale not found.' using errcode = 'PT404';
  end if;
  select * into s from private.pricing_settings;
  for r in
    select x.campaign_id, x.product_id
    from private.sale_campaign_products x
    join public.products p on p.id = x.product_id
    where x.campaign_id = c.id
    order by p.item_code
  loop
    select * into l from private.sale_campaign_products x where x.campaign_id = r.campaign_id and x.product_id = r.product_id;
    select * into st from private.product_pricing_state x where x.product_id = r.product_id;
    live := l.applied_at is not null and l.removed_at is null;
    cand := null;
    econ := null;
    if live then
      action := case when l.included then 'keep' else 'remove' end;
      econ := private.unit_economics(st.sale_price_paisa, st.cost_paisa, true, c.referral_allowed);
    elsif not l.included then
      action := 'kept_regular';
    elsif c.status = 'scheduled' then
      action := case when l.planned_sale_paisa is not null then 'planned' else 'skip' end;
    elsif c.status in ('draft', 'active') then
      cand := private.campaign_candidate(c, l, st);
      action := cand ->> 'action';
    else
      action := 'closed';
    end if;
    lines := lines || jsonb_build_array(jsonb_build_object(
      'product_id', st.product_id, 'item_code', st.item_code, 'name', st.name, 'brand', st.brand,
      'item_status', st.item_status, 'publication_status', st.publication_status, 'stock', st.stock,
      'listed_at', st.listed_at, 'included', l.included, 'note', l.note,
      'override_reason', l.margin_override_reason,
      'action', action,
      'reason', coalesce(cand ->> 'reason', case when action = 'skip' then l.skipped_reason end),
      'regular_paisa', st.price_paisa,
      'sale_paisa', case when live then st.sale_price_paisa when action = 'planned' then l.planned_sale_paisa
                         else (cand ->> 'sale_paisa')::integer end,
      'planned_regular_paisa', l.planned_regular_paisa,
      'sale', cand -> 'sale',
      'reference_paisa', case when live then st.reference_price_paisa else (cand ->> 'reference_paisa')::integer end,
      'reference', cand -> 'reference',
      'badge_percent', case when live then private.badge_percent(st.reference_price_paisa, st.sale_price_paisa)
                            else (cand ->> 'badge_percent')::integer end,
      'economics', coalesce(cand -> 'economics', econ),
      'cost_paisa', st.cost_paisa,
      'product_version', st.product_version,
      'applied_at', l.applied_at, 'removed_at', l.removed_at, 'skipped_reason', l.skipped_reason));
  end loop;
  return jsonb_build_object('kind', 'campaign', 'campaign', private.campaign_view(c.id), 'lines', lines,
    'overlaps', private.campaign_overlaps(c),
    'summary', (select jsonb_build_object(
      'apply', count(*) filter (where x ->> 'action' = 'apply'),
      'keep', count(*) filter (where x ->> 'action' = 'keep'),
      'remove', count(*) filter (where x ->> 'action' = 'remove'),
      'skip', count(*) filter (where x ->> 'action' = 'skip'),
      'planned', count(*) filter (where x ->> 'action' = 'planned'),
      'kept_regular', count(*) filter (where x ->> 'action' = 'kept_regular'),
      'no_badge', count(*) filter (where x ->> 'action' in ('apply', 'keep', 'planned') and x ->> 'badge_percent' is null),
      'rounding_paisa', coalesce(sum((x -> 'sale' ->> 'rounding_paisa')::bigint) filter (where x ->> 'action' = 'apply'), 0))
      from jsonb_array_elements(lines) x),
    'settings_version', s.version,
    'token', encode(sha256(convert_to(jsonb_build_object('campaign', private.campaign_view(c.id) - 'due', 'lines', lines,
      'settings', s.version)::text, 'UTF8')), 'hex'));
end;
$$;

-- Puts one selected product on sale (the campaign's live line). False if the
-- product isn't in the state that was reviewed.
create function private.campaign_apply_line(p_campaign private.sale_campaigns, p_product_id uuid, p_regular integer, p_sale integer, p_request_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.pricing_write_begin('campaign_start', p_request_id, p_campaign.id);
  update public.products set sale_price_paisa = p_sale, referral_excluded = not p_campaign.referral_allowed
  where id = p_product_id and price_paisa = p_regular and sale_price_paisa is null and publication_status = 'published';
  perform private.pricing_write_end();
  if not found then
    return false;
  end if;
  update private.sale_campaign_products l set applied_regular_paisa = p_regular, applied_sale_paisa = p_sale, applied_at = now(),
    removed_at = null, skipped_reason = null, planned_regular_paisa = null, planned_sale_paisa = null, updated_at = now()
  where l.campaign_id = p_campaign.id and l.product_id = p_product_id;
  return true;
end;
$$;

-- Takes one product off the campaign's sale.
create function private.campaign_remove_line(p_campaign private.sale_campaigns, p_product_id uuid, p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l private.sale_campaign_products;
begin
  select * into l from private.sale_campaign_products x where x.campaign_id = p_campaign.id and x.product_id = p_product_id;
  perform private.pricing_write_begin('campaign_end', p_request_id, p_campaign.id);
  update public.products set sale_price_paisa = null, referral_excluded = false
  where id = p_product_id and sale_price_paisa is not distinct from l.applied_sale_paisa;
  perform private.pricing_write_end();
  update private.sale_campaign_products x set removed_at = now(), updated_at = now()
  where x.campaign_id = p_campaign.id and x.product_id = p_product_id;
end;
$$;

-- Ends a running campaign: every live line comes off sale.
create function private.campaign_end(p_campaign private.sale_campaigns, p_reason text, p_request_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids uuid[];
  pid uuid;
begin
  select coalesce(array_agg(l.product_id order by l.product_id), '{}') into ids
  from private.sale_campaign_products l
  where l.campaign_id = p_campaign.id and l.applied_at is not null and l.removed_at is null;
  perform 1 from public.products p where p.id = any(ids) order by p.id for update;
  foreach pid in array ids loop
    perform private.campaign_remove_line(p_campaign, pid, p_request_id);
  end loop;
  update private.sale_campaigns set status = 'ended', ended_at = now(), end_reason = p_reason,
    ended_by = case when p_reason = 'admin' then (select auth.uid()) end
  where id = p_campaign.id;
  return cardinality(ids);
end;
$$;

-- Starts a scheduled campaign: the reviewed prices, only where the product is
-- still as reviewed and the rules still allow it.
create function private.campaign_start(p_campaign private.sale_campaigns, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l private.sale_campaign_products;
  st private.product_pricing_state;
  cand jsonb;
  applied integer := 0;
  skipped integer := 0;
  why text;
begin
  perform 1 from public.products p
  where p.id in (select x.product_id from private.sale_campaign_products x where x.campaign_id = p_campaign.id)
  order by p.id for update;
  for l in
    select * from private.sale_campaign_products x
    where x.campaign_id = p_campaign.id and x.included and x.planned_sale_paisa is not null
    order by x.product_id
  loop
    select * into st from private.product_pricing_state x where x.product_id = l.product_id;
    cand := private.campaign_candidate(p_campaign, l, st);
    why := case
      when st.price_paisa is distinct from l.planned_regular_paisa then 'changed_since_review'
      when cand ->> 'action' <> 'apply' then cand ->> 'reason'
      when (cand ->> 'sale_paisa')::integer is distinct from l.planned_sale_paisa then 'changed_since_review'
    end;
    if why is null and private.campaign_apply_line(p_campaign, l.product_id, l.planned_regular_paisa, l.planned_sale_paisa, p_request_id) then
      applied := applied + 1;
    else
      skipped := skipped + 1;
      update private.sale_campaign_products x set skipped_reason = coalesce(why, 'changed_since_review'),
        planned_regular_paisa = null, planned_sale_paisa = null, updated_at = now()
      where x.campaign_id = l.campaign_id and x.product_id = l.product_id;
    end if;
  end loop;
  update private.sale_campaigns set status = 'active', started_at = now() where id = p_campaign.id;
  return jsonb_build_object('applied', applied, 'skipped', skipped);
end;
$$;

-- The schedule: ends running campaigns that are due, then starts scheduled
-- ones that are due. Run every minute by pg_cron
-- (supabase/setup/schedule_sale_campaigns.sql) and by "Run due changes now".
create function private.run_sale_schedule()
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  started timestamptz := clock_timestamp();
  c private.sale_campaigns;
  ended integer := 0;
  begun integer := 0;
  failures integer := 0;
  first_error text;
  result jsonb;
begin
  insert into private.job_heartbeats (job, last_started_at) values ('sale_schedule', started)
  on conflict (job) do update set last_started_at = excluded.last_started_at;

  begin
    perform pg_advisory_xact_lock(20261121, 1);
    for c in select * from private.sale_campaigns x where x.status = 'active' and x.ends_at <= now() order by x.ends_at, x.id for update loop
      perform private.campaign_end(c, 'schedule', null);
      insert into private.pricing_events (kind, details) values ('campaign_ended', jsonb_build_object('campaign_id', c.id, 'by', 'schedule'));
      ended := ended + 1;
    end loop;
    for c in
      select * from private.sale_campaigns x
      where x.status = 'scheduled' and x.starts_at <= now() and (x.ends_at is null or x.ends_at > now())
      order by x.starts_at, x.id for update
    loop
      if exists (select 1 from private.sale_campaigns o where o.status = 'active' and o.id <> c.id) then
        failures := failures + 1;
        first_error := coalesce(first_error, 'another sale is still running; ' || c.name || ' waits');
        continue;
      end if;
      result := private.campaign_start(c, null);
      insert into private.pricing_events (kind, details) values ('campaign_started', jsonb_build_object('campaign_id', c.id, 'by', 'schedule') || result);
      begun := begun + 1;
    end loop;
    -- A scheduled campaign whose window passed before it could start.
    for c in select * from private.sale_campaigns x where x.status = 'scheduled' and x.ends_at <= now() for update loop
      update private.sale_campaigns set status = 'ended', ended_at = now(), end_reason = 'schedule' where id = c.id;
      insert into private.pricing_events (kind, details) values ('campaign_ended', jsonb_build_object('campaign_id', c.id, 'by', 'schedule', 'never_started', true));
      ended := ended + 1;
    end loop;
  exception when others then
    failures := failures + 1;
    first_error := coalesce(first_error, sqlstate || ' ' || left(sqlerrm, 200));
    ended := 0;
    begun := 0;
  end;

  update private.job_heartbeats set
    last_finished_at = clock_timestamp(),
    last_succeeded_at = case when failures = 0 then clock_timestamp() else last_succeeded_at end,
    last_failed_at = case when failures > 0 then clock_timestamp() else last_failed_at end,
    last_error = case when failures > 0 then first_error else last_error end,
    consecutive_failures = case when failures > 0 then consecutive_failures + 1 else 0 end,
    last_released = ended + begun
  where job = 'sale_schedule';

  return jsonb_build_object('ended', ended, 'started', begun, 'failed', failures, 'error', first_error);
end;
$$;

-- ===========================================================================
-- Checkout: as in 20261118120100_referral_checkout.sql, plus
--   * a product whose campaign excludes referral discounts doesn't qualify
--     for a code (lines[].referral_excluded says so);
--   * lines[].reference_price_paisa: the supported "was" price while on sale
--     (null: show no crossed-out price). regular_price_paisa is unchanged.
-- Same signature, so callers and grants are unchanged.
-- ===========================================================================

create or replace function private.checkout_quote(
  p_lines jsonb, p_city text, p_settings public.shop_settings, p_online boolean default true, p_referral_code text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  raw_lines jsonb;
  result_lines jsonb;
  subtotal bigint;
  buyable integer;
  delivery_status text;
  delivery bigint := 0;
  city_row public.delivery_cities;
  city_name text := nullif(btrim(coalesce(p_city, '')), '');
  v_code text := left(private.normalize_referral_code(p_referral_code), 32);
  agent public.sales_agents;
  referral jsonb;
  referral_ok boolean := false;
  eligible_total bigint := 0;
  discount bigint := 0;
  shares bigint[];
begin
  with requested as (
    select l ->> 'sku' as sku, (l ->> 'quantity')::integer as quantity, (l ->> 'unit_price_paisa')::integer as seen_price, n
    from jsonb_array_elements(p_lines) with ordinality as x (l, n)
  ),
  live as (
    select r.*, x.variant_id, x.size_eu, x.name, x.brand, x.item_status, x.condition, x.price_paisa, x.regular_price_paisa,
      x.on_sale, x.referral_excluded, x.reference_price_paisa,
      case
        when x.variant_id is null then 0
        else x.stock + coalesce((
          select sum(oi.quantity)::integer from public.order_items oi
          join public.orders o on o.id = oi.order_id
          where oi.variant_id = x.variant_id and o.status = 'awaiting_confirmation' and o.hold_expires_at <= now()
        ), 0)
      end as available,
      x.variant_id is null as gone
    from requested r
    left join lateral (
      select v.id as variant_id, v.size_eu, v.stock, p.name, p.brand, p.item_status, p.condition,
        coalesce(p.sale_price_paisa, p.price_paisa) as price_paisa, p.price_paisa as regular_price_paisa,
        p.sale_price_paisa is not null as on_sale, p.referral_excluded,
        case when p.sale_price_paisa is not null then p.reference_price_paisa end as reference_price_paisa
      from public.product_variants v
      join public.products p on p.id = v.product_id
      where v.sku = r.sku and (not p_online or p.publication_status = 'published')
    ) x on true
  ),
  judged as (
    select l.*,
      least(l.quantity, l.available, coalesce(case when p_online then p_settings.max_units_per_line end, l.quantity)) as allowed
    from live l
  )
  select
    jsonb_agg(jsonb_build_object(
      'sku', j.sku,
      'status', case when j.gone then 'unavailable' when j.available = 0 then 'sold_out'
                     when j.allowed < j.quantity then 'reduced' else 'ok' end,
      'name', j.name, 'brand', j.brand, 'size_eu', j.size_eu, 'item_status', j.item_status, 'condition', j.condition,
      'quantity', j.quantity, 'allowed_quantity', case when j.gone then 0 else j.allowed end,
      'available', j.available,
      'unit_price_paisa', j.price_paisa,
      'regular_price_paisa', j.regular_price_paisa,
      'price_changed', not j.gone and j.price_paisa is distinct from j.seen_price,
      'seen_price_paisa', j.seen_price,
      -- Internal, removed below.
      '_total', case when not j.gone and j.allowed > 0 then j.allowed::bigint * j.price_paisa else 0 end,
      '_on_sale', coalesce(j.on_sale, false),
      '_excluded', coalesce(j.referral_excluded, false)
    -- Only for products that are for sale here, so an unavailable line looks
    -- exactly as it did before (hardening: nothing about unpublished products).
    ) || case when j.gone then '{}'::jsonb else jsonb_build_object(
      'reference_price_paisa', j.reference_price_paisa, 'referral_excluded', coalesce(j.referral_excluded, false)) end
    order by j.n),
    coalesce(sum(j.allowed::bigint * j.price_paisa) filter (where not j.gone and j.allowed > 0), 0),
    count(*) filter (where not j.gone and j.allowed > 0)
  into raw_lines, subtotal, buyable
  from judged j;
  raw_lines := coalesce(raw_lines, '[]'::jsonb);

  -- The referral code, if any.
  if v_code is not null then
    if private.is_referral_code(v_code) then
      select * into agent from public.sales_agents a where a.code = v_code;
    end if;
    if agent.id is null then
      referral := jsonb_build_object('code', v_code, 'status', 'invalid');
    elsif not agent.code_enabled then
      referral := jsonb_build_object('code', v_code, 'status', 'disabled');
    else
      select coalesce(sum((l ->> '_total')::bigint), 0) into eligible_total
      from jsonb_array_elements(raw_lines) l
      where (agent.applies_to_sale_items or not (l ->> '_on_sale')::boolean) and not (l ->> '_excluded')::boolean;
      referral := jsonb_build_object('code', v_code,
        'status', case when eligible_total > 0 then 'ok' else 'no_eligible_items' end,
        'discount_bp', agent.discount_bp, 'applies_to_sale_items', agent.applies_to_sale_items);
      if eligible_total > 0 then
        referral_ok := true;
        discount := private.percent_of(eligible_total, agent.discount_bp);
        select private.allocate_paisa(discount, array_agg(
                 case when (agent.applies_to_sale_items or not (l ->> '_on_sale')::boolean) and not (l ->> '_excluded')::boolean
                      then (l ->> '_total')::bigint else 0 end
                 order by i))
        into shares
        from jsonb_array_elements(raw_lines) with ordinality as e (l, i);
      end if;
    end if;
  end if;

  select coalesce(jsonb_agg(
    (l - '_total' - '_on_sale' - '_excluded') || jsonb_build_object(
      'referral_eligible', case when referral_ok then (agent.applies_to_sale_items or not (l ->> '_on_sale')::boolean)
                                                     and not (l ->> '_excluded')::boolean end,
      'discount_paisa', case when referral_ok then shares[i] else 0 end)
    order by i), '[]'::jsonb)
  into result_lines
  from jsonb_array_elements(raw_lines) with ordinality as e (l, i);

  if p_settings.delivery_area_mode is null or p_settings.standard_delivery_fee_paisa is null
    or p_settings.free_delivery_enabled is null then
    delivery_status := 'not_configured';
  elsif city_name is null then
    delivery_status := 'city_required';
  else
    select * into city_row from public.delivery_cities c where c.city_key = lower(city_name) and c.active;
    if p_settings.delivery_area_mode = 'selected' and city_row.city is null then
      delivery_status := 'not_served';
    else
      delivery_status := 'ok';
      delivery := coalesce(city_row.fee_paisa, p_settings.standard_delivery_fee_paisa);
      -- Free delivery: judged on what the customer pays for the goods, after the discount.
      if buyable = 0 or (p_settings.free_delivery_enabled and subtotal - discount >= p_settings.free_delivery_min_paisa) then
        delivery := 0;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'lines', result_lines,
    'subtotal_paisa', subtotal,
    'discount_paisa', discount,
    'merchandise_paisa', subtotal - discount,
    'referral', referral,
    'delivery_status', delivery_status,
    'delivery_paisa', delivery,
    'total_paisa', subtotal - discount + delivery,
    'free_delivery_min_paisa', case when p_settings.free_delivery_enabled then p_settings.free_delivery_min_paisa end,
    'orders_open', p_settings.orders_open,
    'exact', delivery_status = 'ok' and (v_code is null or referral_ok) and not exists (
      select 1 from jsonb_array_elements(result_lines) l
      where l ->> 'status' <> 'ok' or (l ->> 'price_changed')::boolean
    )
  );
end;
$$;

-- ===========================================================================
-- Admin functions: reads
-- ===========================================================================

create function private.settings_view()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('price_ending_rupees', s.price_ending_rupees, 'min_profit_paisa', s.min_profit_paisa,
    'min_margin_bp', s.min_margin_bp, 'reference_min_days', s.reference_min_days,
    'new_sale_target_bp', s.new_sale_target_bp, 'preloved_sale_target_bp', s.preloved_sale_target_bp,
    'version', s.version, 'updated_at', s.updated_at)
  from private.pricing_settings s;
$$;

-- Settings, groups, agents' current terms and a count of what needs attention.
create function public.admin_pricing_overview()
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
          and (private.score_calculation(st.max_price_paisa, st.score, st.giveaway, s.price_ending_rupees) ->> 'price_paisa')::integer
              is distinct from st.price_paisa),
        'unknown_cost', count(*) filter (where st.cost_paisa is null and st.publication_status = 'published'))
      from private.product_pricing_state st where st.publication_status <> 'archived'));
end;
$$;

-- Products with their pricing (for the bulk set-up table and the reports).
-- p_filter: {q, item_status, mode, group_id, publication_status, limit, offset}.
create function public.admin_pricing_products(p_filter jsonb)
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
          then private.score_calculation(m.max_price_paisa, m.score, m.giveaway, s.price_ending_rupees) end)
        order by m.item_code)
      from (select * from matching order by item_code limit v_limit offset v_offset) m), '[]'::jsonb))
  );
end;
$$;

-- One product's pricing, with the money under each referral scenario now.
create function public.admin_product_pricing(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  st private.product_pricing_state;
  s private.pricing_settings;
begin
  perform public.admin_require_catalogue_admin();
  select * into st from private.product_pricing_state x where x.product_id = p_product_id;
  if not found then
    return null;
  end if;
  select * into s from private.pricing_settings;
  return jsonb_build_object(
    'product_id', st.product_id, 'item_code', st.item_code, 'name', st.name, 'item_status', st.item_status,
    'publication_status', st.publication_status, 'price_paisa', st.price_paisa, 'sale_price_paisa', st.sale_price_paisa,
    'reference_price_paisa', st.reference_price_paisa, 'mode', st.mode, 'group_id', st.group_id, 'score', st.score,
    'cost_paisa', st.cost_paisa, 'giveaway', st.giveaway, 'pricing_version', st.pricing_version,
    'campaign', case when st.campaign_id is not null then
      jsonb_build_object('id', st.campaign_id, 'name', st.campaign_name, 'discount_bp', st.campaign_discount_bp) end,
    'reference', (select jsonb_build_object('reference_price_paisa', r.reference_price_paisa, 'offered_price_paisa', r.offered_price_paisa,
        'offered_since', r.offered_since, 'offered_until', r.offered_until, 'unsupported_reason', r.unsupported_reason)
      from private.product_reference_prices r where r.product_id = st.product_id and st.sale_price_paisa is not null),
    'economics', private.unit_economics(coalesce(st.sale_price_paisa, st.price_paisa), st.cost_paisa,
      st.sale_price_paisa is not null, coalesce(st.campaign_referral_allowed, true)),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('regular_price_paisa', h.regular_price_paisa, 'sale_price_paisa', h.sale_price_paisa,
        'reference_price_paisa', h.reference_price_paisa, 'publication_status', h.publication_status, 'reason', h.reason,
        'created_at', h.created_at) order by h.id desc)
      from (select * from private.price_history h where h.product_id = st.product_id order by h.id desc limit 20) h), '[]'::jsonb),
    'settings', private.settings_view(),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'max_price_paisa', g.max_price_paisa) order by lower(g.name))
      from private.pricing_groups g), '[]'::jsonb));
end;
$$;

create function public.admin_preview_product_pricing(p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return private.product_pricing_plan(p_items);
end;
$$;

create function public.admin_preview_reprice(p_changes jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return private.reprice_plan(p_changes);
end;
$$;

-- ===========================================================================
-- Admin functions: pricing writes
-- ===========================================================================

create function public.admin_save_pricing_settings(p_expected_version integer, p_request_id uuid, p_settings jsonb)
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
    or (p_settings ->> 'reference_min_days' is not null and (p_settings ->> 'reference_min_days') !~ num) then
    raise exception 'Check the pricing settings.' using errcode = 'PT400', hint = 'invalid_settings';
  end if;
  v_payload := jsonb_build_object('expected_version', p_expected_version,
    'price_ending_rupees', (p_settings ->> 'price_ending_rupees')::integer,
    'min_profit_paisa', (p_settings ->> 'min_profit_paisa')::integer, 'min_margin_bp', (p_settings ->> 'min_margin_bp')::integer,
    'reference_min_days', (p_settings ->> 'reference_min_days')::integer,
    'new_sale_target_bp', (p_settings ->> 'new_sale_target_bp')::integer,
    'preloved_sale_target_bp', (p_settings ->> 'preloved_sale_target_bp')::integer);
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

create function public.admin_create_pricing_group(p_request_id uuid, p_name text, p_max_price_paisa integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_payload jsonb := jsonb_build_object('name', v_name, 'max_price_paisa', p_max_price_paisa);
  earlier jsonb;
  new_id uuid;
begin
  perform public.admin_require_catalogue_admin();
  if char_length(v_name) not between 2 and 60 or v_name ~ '[[:cntrl:]]' then
    raise exception 'Name the group (2-60 characters).' using errcode = 'PT400', hint = 'invalid_name';
  end if;
  if p_max_price_paisa is null or p_max_price_paisa not between 10000 and 100000000 or p_max_price_paisa % 100 <> 0 then
    raise exception 'Maximum prices are whole rupees from Rs. 100 to Rs. 10,00,000.' using errcode = 'PT400', hint = 'invalid_maximum';
  end if;
  earlier := private.pricing_request_begin(p_request_id, 'create_group', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  if exists (select 1 from private.pricing_groups g where lower(g.name) = lower(v_name)) then
    return jsonb_build_object('result', 'name_taken');
  end if;
  insert into private.pricing_groups (name, max_price_paisa, created_by) values (v_name, p_max_price_paisa, (select auth.uid()))
  returning id into new_id;
  return private.pricing_request_done(p_request_id, 'create_group', v_payload, 'group_created', v_payload || jsonb_build_object('id', new_id),
    jsonb_build_object('result', 'created', 'id', new_id, 'version', 1));
end;
$$;

-- Applies a product pricing plan, exactly as previewed (p_token), or answers
-- "stale" with the current preview and changes nothing.
create function public.admin_apply_product_pricing(p_request_id uuid, p_items jsonb, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_payload jsonb := jsonb_build_object('items', p_items, 'token', p_token);
  earlier jsonb;
  plan jsonb;
  line jsonb;
  ids uuid[];
  applied integer := 0;
begin
  perform public.admin_require_catalogue_admin();
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Preview the change first.' using errcode = 'PT400', hint = 'preview_required';
  end if;
  earlier := private.pricing_request_begin(p_request_id, 'product_pricing', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  perform 1 from private.pricing_settings for share;
  perform 1 from private.pricing_groups g order by g.id for share;
  select coalesce(array_agg(distinct lower(i ->> 'product_id')::uuid), '{}') into ids
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) i
  where lower(coalesce(i ->> 'product_id', '')) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  perform 1 from public.products p where p.id = any(ids) order by p.id for update;
  perform 1 from private.product_pricing pp where pp.product_id = any(ids) order by pp.product_id for update;

  plan := private.product_pricing_plan(p_items);
  if plan ->> 'token' <> p_token then
    return jsonb_build_object('result', 'stale', 'preview', plan);
  end if;
  for line in select l from jsonb_array_elements(plan -> 'lines') l where l ->> 'action' = 'apply' loop
    perform private.write_pricing_line(line,  p_request_id,
      case when (line -> 'to' ->> 'giveaway')::boolean and not (line -> 'from' ->> 'giveaway')::boolean then 'giveaway' else 'score_pricing' end);
    applied := applied + 1;
    if (line -> 'to' ->> 'giveaway')::boolean and not (line -> 'from' ->> 'giveaway')::boolean then
      insert into private.pricing_events (kind, details, actor_user_id)
      values ('giveaway_set', jsonb_build_object('product_id', line ->> 'product_id', 'request_id', p_request_id), (select auth.uid()));
    end if;
    if line ->> 'override_reason' is not null and line -> 'economics' ->> 'margin' = 'violation' then
      insert into private.pricing_events (kind, details, actor_user_id)
      values ('margin_override', jsonb_build_object('product_id', line ->> 'product_id', 'reason', line ->> 'override_reason',
        'request_id', p_request_id, 'economics', line -> 'economics'), (select auth.uid()));
    end if;
  end loop;
  return private.pricing_request_done(p_request_id, 'product_pricing', v_payload, 'product_pricing_applied',
    jsonb_build_object('summary', plan -> 'summary', 'lines', (
      select jsonb_agg(jsonb_build_object('product_id', l ->> 'product_id', 'action', l ->> 'action', 'reason', l ->> 'reason',
        'from', l -> 'from', 'to', l -> 'to')) from jsonb_array_elements(plan -> 'lines') l)),
    jsonb_build_object('result', 'applied', 'applied', applied, 'summary', plan -> 'summary',
      'skipped', (select coalesce(jsonb_agg(jsonb_build_object('product_id', l ->> 'product_id', 'item_code', l ->> 'item_code',
        'reason', l ->> 'reason')), '[]'::jsonb) from jsonb_array_elements(plan -> 'lines') l where l ->> 'action' = 'skip')));
end;
$$;

-- Applies group maximum changes (or brings automatic prices up to date),
-- exactly as previewed (p_token), or answers "stale".
create function public.admin_apply_reprice(p_request_id uuid, p_changes jsonb, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_payload jsonb := jsonb_build_object('changes', p_changes, 'token', p_token);
  earlier jsonb;
  plan jsonb;
  line jsonb;
  ch jsonb;
  applied integer := 0;
begin
  perform public.admin_require_catalogue_admin();
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Preview the change first.' using errcode = 'PT400', hint = 'preview_required';
  end if;
  earlier := private.pricing_request_begin(p_request_id, 'reprice', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  perform 1 from private.pricing_settings for share;
  perform 1 from private.pricing_groups g order by g.id for update;
  perform 1 from public.products p where p.id in (select pp.product_id from private.product_pricing pp where pp.mode = 'auto')
  order by p.id for update;
  perform 1 from private.product_pricing pp where pp.mode = 'auto' order by pp.product_id for update;

  plan := private.reprice_plan(p_changes);
  if plan ->> 'token' <> p_token then
    return jsonb_build_object('result', 'stale', 'preview', plan);
  end if;
  for ch in select c from jsonb_array_elements(plan -> 'groups') c loop
    if (ch ->> 'max_from')::integer <> (ch ->> 'max_to')::integer then
      update private.pricing_groups set max_price_paisa = (ch ->> 'max_to')::integer where id = (ch ->> 'group_id')::uuid;
    end if;
  end loop;
  for line in select l from jsonb_array_elements(plan -> 'lines') l where l ->> 'action' = 'apply' loop
    perform private.write_pricing_line(line, p_request_id, 'reprice');
    applied := applied + 1;
  end loop;
  return private.pricing_request_done(p_request_id, 'reprice', v_payload, 'repriced',
    jsonb_build_object('groups', plan -> 'groups', 'summary', plan -> 'summary', 'lines', (
      select jsonb_agg(jsonb_build_object('product_id', l ->> 'product_id', 'action', l ->> 'action', 'reason', l ->> 'reason',
        'from', l -> 'from', 'to', l -> 'to')) from jsonb_array_elements(plan -> 'lines') l)),
    jsonb_build_object('result', 'applied', 'applied', applied, 'summary', plan -> 'summary',
      'skipped', (select coalesce(jsonb_agg(jsonb_build_object('product_id', l ->> 'product_id', 'item_code', l ->> 'item_code',
        'reason', l ->> 'reason')), '[]'::jsonb) from jsonb_array_elements(plan -> 'lines') l where l ->> 'action' = 'skip')));
end;
$$;

-- ===========================================================================
-- Admin functions: campaigns
-- ===========================================================================

create function public.admin_list_campaigns()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return coalesce((
    select jsonb_agg(private.campaign_view(c.id) || jsonb_build_object(
      'included', (select count(*) from private.sale_campaign_products l where l.campaign_id = c.id and l.included),
      'kept_regular', (select count(*) from private.sale_campaign_products l where l.campaign_id = c.id and not l.included),
      'live', (select count(*) from private.sale_campaign_products l where l.campaign_id = c.id and l.applied_at is not null and l.removed_at is null))
      order by case c.status when 'active' then 0 when 'scheduled' then 1 when 'draft' then 2 else 3 end, c.starts_at desc)
    from private.sale_campaigns c), '[]'::jsonb);
end;
$$;

-- A campaign with its preview (what applying it now would do).
create function public.admin_get_campaign(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  if not exists (select 1 from private.sale_campaigns c where c.id = p_campaign_id) then
    return null;
  end if;
  return private.campaign_plan(p_campaign_id);
end;
$$;

-- Every product a campaign could select, with its sale state (for the
-- selection table). Archived products are left out.
create function public.admin_campaign_candidates(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'product_id', st.product_id, 'item_code', st.item_code, 'name', st.name, 'brand', st.brand,
      'item_status', st.item_status, 'publication_status', st.publication_status, 'listed_at', st.listed_at,
      'stock', st.stock, 'price_paisa', st.price_paisa, 'sale_price_paisa', st.sale_price_paisa,
      'group_id', st.group_id, 'group_name', st.group_name, 'score', st.score, 'cost_paisa', st.cost_paisa,
      'eligible', st.publication_status = 'published' and st.stock > 0,
      'selection', case when l.product_id is null then null when l.included then 'included' else 'excluded' end,
      'note', l.note, 'override_reason', l.margin_override_reason,
      'other_campaign', case when st.campaign_id is not null and st.campaign_id <> p_campaign_id then st.campaign_name end)
      order by st.item_status, st.item_code)
    from private.product_pricing_state st
    left join private.sale_campaign_products l on l.campaign_id = p_campaign_id and l.product_id = st.product_id
    where st.publication_status <> 'archived'), '[]'::jsonb);
end;
$$;

-- Coverage: published, in-stock LISTINGS (products, not sizes or units),
-- how many are on sale, and what needs attention.
create function public.admin_sale_coverage()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s private.pricing_settings;
  current_id uuid;
begin
  perform public.admin_require_catalogue_admin();
  select * into s from private.pricing_settings;
  select c.id into current_id from private.sale_campaigns c
  where c.status in ('active', 'scheduled') order by (c.status = 'active') desc, c.starts_at limit 1;
  return (
    with eligible as (
      select st.* from private.product_pricing_state st where st.publication_status = 'published' and st.stock > 0
    ),
    per_status as (
      select x.item_status, count(e.product_id)::integer as eligible,
        (count(e.product_id) filter (where e.sale_price_paisa is not null))::integer as on_sale,
        (count(e.product_id) filter (where e.sale_price_paisa is not null and e.reference_price_paisa is null))::integer as no_badge,
        case x.item_status when 'new' then s.new_sale_target_bp else s.preloved_sale_target_bp end as target_bp
      from (values ('new'), ('preloved')) x (item_status)
      left join eligible e on e.item_status = x.item_status
      group by x.item_status
    )
    select jsonb_build_object(
      'settings', private.settings_view(),
      'current_campaign', case when current_id is not null then private.campaign_view(current_id) end,
      'statuses', (select jsonb_object_agg(p.item_status, jsonb_build_object(
          'eligible', p.eligible, 'on_sale', p.on_sale, 'no_badge', p.no_badge, 'target_bp', p.target_bp,
          'target', (p.eligible::bigint * p.target_bp + 9999) / 10000,
          'coverage_bp', case when p.eligible > 0 then (p.on_sale::bigint * 10000 / p.eligible) end,
          'gap', greatest((p.eligible::bigint * p.target_bp + 9999) / 10000 - p.on_sale, 0)))
        from per_status p),
      'needs_review', coalesce((select jsonb_agg(jsonb_build_object('product_id', e.product_id, 'item_code', e.item_code,
          'name', e.name, 'item_status', e.item_status, 'listed_at', e.listed_at) order by e.listed_at desc, e.item_code)
        from eligible e
        where e.sale_price_paisa is null and not exists (
          select 1 from private.sale_campaign_products l where l.campaign_id = current_id and l.product_id = e.product_id)), '[]'::jsonb),
      'no_badge', coalesce((select jsonb_agg(jsonb_build_object('product_id', e.product_id, 'item_code', e.item_code, 'name', e.name,
          'item_status', e.item_status, 'reason', coalesce(r.unsupported_reason, 'not_offered_at_price')) order by e.item_code)
        from eligible e left join private.product_reference_prices r on r.product_id = e.product_id
        where e.sale_price_paisa is not null and e.reference_price_paisa is null), '[]'::jsonb),
      'kept_regular', coalesce((select jsonb_agg(jsonb_build_object('product_id', e.product_id, 'item_code', e.item_code, 'name', e.name,
          'item_status', e.item_status, 'note', l.note) order by e.item_code)
        from eligible e join private.sale_campaign_products l on l.campaign_id = current_id and l.product_id = e.product_id
        where not l.included), '[]'::jsonb),
      'skipped', coalesce((select jsonb_agg(jsonb_build_object('product_id', e.product_id, 'item_code', e.item_code, 'name', e.name,
          'item_status', e.item_status, 'reason', l.skipped_reason) order by e.item_code)
        from eligible e join private.sale_campaign_products l on l.campaign_id = current_id and l.product_id = e.product_id
        where l.included and l.skipped_reason is not null and (l.applied_at is null or l.removed_at is not null)), '[]'::jsonb),
      'manual_sales', (select count(*) from eligible e where e.sale_price_paisa is not null and e.campaign_id is null),
      'agents', jsonb_build_object(
        'enabled', (select count(*) from public.sales_agents a where a.code_enabled),
        'excluding_sale_items', (select count(*) from public.sales_agents a where a.code_enabled and not coalesce(a.applies_to_sale_items, false)),
        'preloved_on_sale', (select count(*) from eligible e where e.item_status = 'preloved' and e.sale_price_paisa is not null),
        'preloved_eligible', (select count(*) from eligible e where e.item_status = 'preloved')))
  );
end;
$$;

create function public.admin_create_campaign(p_request_id uuid, p_campaign jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v jsonb;
  earlier jsonb;
  new_id uuid;
begin
  -- The access check comes before anything else reads the input.
  perform public.admin_require_catalogue_admin();
  v := private.campaign_input(p_campaign);
  earlier := private.pricing_request_begin(p_request_id, 'create_campaign', v);
  if earlier is not null then
    return earlier;
  end if;
  insert into private.sale_campaigns (name, preset, discount_bp, starts_at, ends_at, referral_allowed, require_reference, created_by)
  values (v ->> 'name', v ->> 'preset', (v ->> 'discount_bp')::integer, (v ->> 'starts_at')::timestamptz,
    (v ->> 'ends_at')::timestamptz, (v ->> 'referral_allowed')::boolean, (v ->> 'require_reference')::boolean, (select auth.uid()))
  returning id into new_id;
  return private.pricing_request_done(p_request_id, 'create_campaign', v, 'campaign_created', v || jsonb_build_object('id', new_id),
    jsonb_build_object('result', 'created', 'id', new_id, 'version', 1));
end;
$$;

-- Locks a campaign for an admin change and checks its version.
create function private.campaign_lock(p_campaign_id uuid, p_expected_version integer)
returns private.sale_campaigns
language plpgsql
security definer
set search_path = ''
as $$
declare
  c private.sale_campaigns;
begin
  select * into c from private.sale_campaigns x where x.id = p_campaign_id for update;
  if not found then
    raise exception 'Sale not found.' using errcode = 'PT404';
  end if;
  if p_expected_version is distinct from c.version then
    raise exception 'This sale was changed somewhere else since you opened it.' using errcode = 'PT409', hint = 'version_conflict';
  end if;
  return c;
end;
$$;

-- Name, discount, dates and referral/reference options: drafts only.
create function public.admin_update_campaign(p_campaign_id uuid, p_expected_version integer, p_request_id uuid, p_campaign jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v jsonb;
  v_payload jsonb;
  earlier jsonb;
  c private.sale_campaigns;
  before jsonb;
begin
  -- The access check comes before anything else reads the input.
  perform public.admin_require_catalogue_admin();
  v := private.campaign_input(p_campaign);
  v_payload := jsonb_build_object('campaign_id', p_campaign_id, 'expected_version', p_expected_version, 'campaign', v);
  earlier := private.pricing_request_begin(p_request_id, 'update_campaign', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  c := private.campaign_lock(p_campaign_id, p_expected_version);
  if c.status <> 'draft' then
    raise exception 'Only a draft sale can be edited. Unschedule it first, or end it and start another.' using errcode = 'PT409', hint = 'campaign_not_draft';
  end if;
  before := private.campaign_view(c.id);
  update private.sale_campaigns set name = v ->> 'name', preset = v ->> 'preset', discount_bp = (v ->> 'discount_bp')::integer,
    starts_at = (v ->> 'starts_at')::timestamptz, ends_at = (v ->> 'ends_at')::timestamptz,
    referral_allowed = (v ->> 'referral_allowed')::boolean, require_reference = (v ->> 'require_reference')::boolean
  where id = c.id;
  return private.pricing_request_done(p_request_id, 'update_campaign', v_payload, 'campaign_updated',
    jsonb_build_object('campaign_id', c.id, 'from', before, 'to', v),
    jsonb_build_object('result', 'done', 'id', c.id, 'version', c.version + 1));
end;
$$;

-- The selection: p_changes [{product_id, state: included | excluded | none,
-- note, override_reason}]. Prices don't change here: applying does.
create function public.admin_set_campaign_selection(p_campaign_id uuid, p_expected_version integer, p_request_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  changes jsonb;
  v_payload jsonb;
  earlier jsonb;
  c private.sale_campaigns;
  ch jsonb;
  existing private.sale_campaign_products;
  v_product uuid;
  v_note text;
  v_override text;
  overrides integer := 0;
begin
  perform public.admin_require_catalogue_admin();
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 500 or exists (
    select 1 from jsonb_array_elements(p_changes) x
    where jsonb_typeof(x) <> 'object' or lower(coalesce(x ->> 'product_id', '')) !~ uuid_re
      or coalesce(x ->> 'state', '') not in ('included', 'excluded', 'none')
      or char_length(btrim(coalesce(x ->> 'note', ''))) > 200
      or (nullif(btrim(coalesce(x ->> 'override_reason', '')), '') is not null and char_length(btrim(x ->> 'override_reason')) not between 5 and 300)
  ) then
    raise exception 'Malformed selection.' using errcode = 'PT400', hint = 'invalid_selection';
  end if;
  select jsonb_agg(jsonb_build_object('product_id', lower(x ->> 'product_id'), 'state', x ->> 'state',
           'note', nullif(regexp_replace(btrim(coalesce(x ->> 'note', '')), '\s+', ' ', 'g'), ''),
           'override_reason', nullif(regexp_replace(btrim(coalesce(x ->> 'override_reason', '')), '\s+', ' ', 'g'), ''),
           'override_set', x ? 'override_reason') order by lower(x ->> 'product_id'))
  into changes from jsonb_array_elements(p_changes) x;
  if (select count(distinct x ->> 'product_id') from jsonb_array_elements(changes) x) <> jsonb_array_length(changes) then
    raise exception 'Each product can appear once.' using errcode = 'PT400', hint = 'invalid_selection';
  end if;
  v_payload := jsonb_build_object('campaign_id', p_campaign_id, 'expected_version', p_expected_version, 'changes', changes);
  earlier := private.pricing_request_begin(p_request_id, 'campaign_selection', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  c := private.campaign_lock(p_campaign_id, p_expected_version);
  if c.status = 'scheduled' then
    raise exception 'This sale is scheduled. Unschedule it to change its products.' using errcode = 'PT409', hint = 'campaign_scheduled';
  elsif c.status not in ('draft', 'active') then
    raise exception 'This sale is over.' using errcode = 'PT409', hint = 'campaign_closed';
  end if;
  for ch in select x from jsonb_array_elements(changes) x loop
    v_product := (ch ->> 'product_id')::uuid;
    if not exists (select 1 from public.products p where p.id = v_product) then
      raise exception 'A selected product no longer exists. Reload the page.' using errcode = 'PT404', hint = 'unknown_product';
    end if;
    v_note := ch ->> 'note';
    v_override := ch ->> 'override_reason';
    select * into existing from private.sale_campaign_products l where l.campaign_id = c.id and l.product_id = v_product;
    if ch ->> 'state' = 'none' then
      if found and existing.applied_at is not null and existing.removed_at is null then
        update private.sale_campaign_products l set included = false, updated_at = now() where l.campaign_id = c.id and l.product_id = v_product;
      elsif found then
        delete from private.sale_campaign_products l where l.campaign_id = c.id and l.product_id = v_product;
      end if;
    else
      insert into private.sale_campaign_products (campaign_id, product_id, included, note, margin_override_reason, override_by, override_at)
      values (c.id, v_product, ch ->> 'state' = 'included', v_note,
        case when (ch ->> 'override_set')::boolean then v_override end,
        case when (ch ->> 'override_set')::boolean and v_override is not null then (select auth.uid()) end,
        case when (ch ->> 'override_set')::boolean and v_override is not null then now() end)
      on conflict (campaign_id, product_id) do update set included = excluded.included, note = excluded.note,
        margin_override_reason = case when (ch ->> 'override_set')::boolean then excluded.margin_override_reason
                                      else private.sale_campaign_products.margin_override_reason end,
        override_by = case when (ch ->> 'override_set')::boolean then excluded.override_by else private.sale_campaign_products.override_by end,
        override_at = case when (ch ->> 'override_set')::boolean then excluded.override_at else private.sale_campaign_products.override_at end,
        skipped_reason = null, updated_at = now();
      if (ch ->> 'override_set')::boolean and v_override is not null then
        overrides := overrides + 1;
        insert into private.pricing_events (kind, details, actor_user_id)
        values ('margin_override', jsonb_build_object('campaign_id', c.id, 'product_id', v_product, 'reason', v_override,
          'request_id', p_request_id), (select auth.uid()));
      end if;
    end if;
  end loop;
  update private.sale_campaigns set updated_at = now() where id = c.id;
  return private.pricing_request_done(p_request_id, 'campaign_selection', v_payload, 'campaign_selection_changed',
    jsonb_build_object('campaign_id', c.id, 'changes', changes, 'overrides', overrides),
    jsonb_build_object('result', 'done', 'id', c.id, 'version', c.version + 1));
end;
$$;

-- Activates a draft (now, or scheduled for its start) or applies an active
-- campaign's selection changes: exactly the preview the admin saw (p_token),
-- or nothing ("stale", with the current preview). Refused while another
-- campaign's window overlaps (campaign_overlap: end, cancel or reschedule one).
create function public.admin_apply_campaign(p_campaign_id uuid, p_expected_version integer, p_request_id uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_payload jsonb := jsonb_build_object('campaign_id', p_campaign_id, 'expected_version', p_expected_version, 'token', p_token);
  earlier jsonb;
  c private.sale_campaigns;
  plan jsonb;
  line jsonb;
  v_overlaps jsonb;
  applied integer := 0;
  removed integer := 0;
  skipped integer := 0;
  outcome text;
begin
  perform public.admin_require_catalogue_admin();
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Preview the sale first.' using errcode = 'PT400', hint = 'preview_required';
  end if;
  earlier := private.pricing_request_begin(p_request_id, 'apply_campaign', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  perform 1 from private.pricing_settings for share;
  c := private.campaign_lock(p_campaign_id, p_expected_version);
  if c.status = 'scheduled' then
    raise exception 'This sale is already scheduled.' using errcode = 'PT409', hint = 'campaign_scheduled';
  elsif c.status not in ('draft', 'active') then
    raise exception 'This sale is over.' using errcode = 'PT409', hint = 'campaign_closed';
  end if;
  if c.status = 'draft' then
    if c.ends_at is not null and c.ends_at <= now() then
      raise exception 'This sale''s end time has passed. Change its dates first.' using errcode = 'PT409', hint = 'campaign_window_passed';
    end if;
    v_overlaps := private.campaign_overlaps(c);
    if c.starts_at <= now() then
      -- Starting now: no other sale may still be running, even one whose end is overdue.
      v_overlaps := v_overlaps || coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status))
        from private.sale_campaigns o where o.status = 'active' and o.id <> c.id
          and not v_overlaps @> jsonb_build_array(jsonb_build_object('id', o.id))), '[]'::jsonb);
    end if;
    if jsonb_array_length(v_overlaps) > 0 then
      raise exception 'Another sale (%) runs at the same time. End, cancel or reschedule one of them first.',
        (select string_agg(o ->> 'name', ', ') from jsonb_array_elements(v_overlaps) o)
        using errcode = 'PT409', hint = 'campaign_overlap';
    end if;
  end if;
  perform 1 from public.products p
  where p.id in (select l.product_id from private.sale_campaign_products l where l.campaign_id = c.id)
  order by p.id for update;

  plan := private.campaign_plan(c.id);
  if plan ->> 'token' <> p_token then
    return jsonb_build_object('result', 'stale', 'preview', plan);
  end if;

  if c.status = 'draft' and c.starts_at > now() then
    for line in select l from jsonb_array_elements(plan -> 'lines') l loop
      update private.sale_campaign_products x set
        planned_regular_paisa = case when line ->> 'action' = 'apply' then (line ->> 'regular_paisa')::integer end,
        planned_sale_paisa = case when line ->> 'action' = 'apply' then (line ->> 'sale_paisa')::integer end,
        skipped_reason = case when line ->> 'action' = 'skip' then line ->> 'reason' end, updated_at = now()
      where x.campaign_id = c.id and x.product_id = (line ->> 'product_id')::uuid;
      if line ->> 'action' = 'apply' then applied := applied + 1; elsif line ->> 'action' = 'skip' then skipped := skipped + 1; end if;
    end loop;
    update private.sale_campaigns set status = 'scheduled', activated_at = now(), activated_by = (select auth.uid()) where id = c.id;
    outcome := 'scheduled';
  else
    for line in select l from jsonb_array_elements(plan -> 'lines') l order by l ->> 'product_id' loop
      if line ->> 'action' = 'apply' then
        if private.campaign_apply_line(c, (line ->> 'product_id')::uuid, (line ->> 'regular_paisa')::integer,
             (line ->> 'sale_paisa')::integer, p_request_id) then
          applied := applied + 1;
        else
          raise exception 'A product changed while the sale was being applied. Preview again.' using errcode = 'PT409', hint = 'preview_stale';
        end if;
      elsif line ->> 'action' = 'remove' then
        perform private.campaign_remove_line(c, (line ->> 'product_id')::uuid, p_request_id);
        removed := removed + 1;
      elsif line ->> 'action' = 'skip' then
        update private.sale_campaign_products x set skipped_reason = line ->> 'reason', updated_at = now()
        where x.campaign_id = c.id and x.product_id = (line ->> 'product_id')::uuid;
        skipped := skipped + 1;
      end if;
    end loop;
    if c.status = 'draft' then
      update private.sale_campaigns set status = 'active', activated_at = now(), activated_by = (select auth.uid()), started_at = now()
      where id = c.id;
      outcome := 'activated';
    else
      update private.sale_campaigns set updated_at = now() where id = c.id;
      outcome := 'updated';
    end if;
  end if;
  return private.pricing_request_done(p_request_id, 'apply_campaign', v_payload, 'campaign_' || outcome,
    jsonb_build_object('campaign_id', c.id, 'summary', plan -> 'summary', 'lines', (
      select jsonb_agg(jsonb_build_object('product_id', l ->> 'product_id', 'action', l ->> 'action', 'reason', l ->> 'reason',
        'regular_paisa', l -> 'regular_paisa', 'sale_paisa', l -> 'sale_paisa', 'reference_paisa', l -> 'reference_paisa'))
      from jsonb_array_elements(plan -> 'lines') l)),
    jsonb_build_object('result', outcome, 'id', c.id, 'version', (select x.version from private.sale_campaigns x where x.id = c.id),
      'applied', applied, 'removed', removed, 'skipped', skipped));
end;
$$;

-- Ends a running sale, cancels a draft or scheduled one, or unschedules a
-- scheduled one (back to draft). p_action: end | cancel | unschedule.
create function public.admin_end_campaign(p_campaign_id uuid, p_expected_version integer, p_request_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_payload jsonb := jsonb_build_object('campaign_id', p_campaign_id, 'expected_version', p_expected_version, 'action', p_action);
  earlier jsonb;
  c private.sale_campaigns;
  removed integer := 0;
begin
  perform public.admin_require_catalogue_admin();
  if p_action is null or p_action not in ('end', 'cancel', 'unschedule') then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  earlier := private.pricing_request_begin(p_request_id, 'end_campaign', v_payload);
  if earlier is not null then
    return earlier;
  end if;
  c := private.campaign_lock(p_campaign_id, p_expected_version);
  if p_action = 'end' and c.status = 'active' then
    removed := private.campaign_end(c, 'admin', p_request_id);
  elsif p_action = 'cancel' and c.status in ('draft', 'scheduled') then
    update private.sale_campaigns set status = 'cancelled', ended_at = now(), ended_by = (select auth.uid()) where id = c.id;
  elsif p_action = 'unschedule' and c.status = 'scheduled' then
    update private.sale_campaign_products l set planned_regular_paisa = null, planned_sale_paisa = null, skipped_reason = null, updated_at = now()
    where l.campaign_id = c.id;
    update private.sale_campaigns set status = 'draft', activated_at = null, activated_by = null where id = c.id;
  else
    raise exception 'A % sale can''t be changed that way.', c.status using errcode = 'PT409', hint = 'bad_transition';
  end if;
  return private.pricing_request_done(p_request_id, 'end_campaign', v_payload, 'campaign_' || p_action,
    jsonb_build_object('campaign_id', c.id, 'from_status', c.status, 'removed', removed),
    jsonb_build_object('result', 'done', 'id', c.id, 'status', (select x.status from private.sale_campaigns x where x.id = c.id),
      'version', (select x.version from private.sale_campaigns x where x.id = c.id), 'removed', removed));
end;
$$;

-- "Run due changes now": what the schedule job does, on demand.
create function public.admin_run_sale_schedule()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return private.run_sale_schedule();
end;
$$;

-- Schedule job health (like admin_order_health).
create function public.admin_sale_schedule_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return jsonb_build_object(
    'heartbeat', (select to_jsonb(h) - 'job' from private.job_heartbeats h where h.job = 'sale_schedule'),
    'overdue', coalesce((select jsonb_agg(private.campaign_view(c.id)) from private.sale_campaigns c
      where (c.status = 'scheduled' and c.starts_at <= now() - interval '5 minutes')
         or (c.status = 'active' and c.ends_at <= now() - interval '5 minutes')), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- Access control
-- ===========================================================================

revoke all on table private.pricing_settings, private.pricing_groups, private.product_pricing, private.price_history,
  private.product_reference_prices, private.pricing_events, private.sale_campaigns, private.sale_campaign_products,
  private.product_pricing_state
  from public, anon, authenticated;

revoke execute on function
  private.price_with_ending(bigint, integer),
  private.score_calculation(integer, integer, boolean, integer),
  private.sale_calculation(integer, integer, integer),
  private.badge_percent(integer, integer),
  private.pricing_fingerprint(text, jsonb),
  private.pricing_request_begin(uuid, text, jsonb),
  private.pricing_request_done(uuid, text, jsonb, text, jsonb, jsonb),
  private.pricing_write_begin(text, uuid, uuid),
  private.pricing_write_end(),
  private.reference_candidate(uuid, integer, text),
  private.products_pricing_guard(),
  private.products_price_history(),
  private.bump_pricing_version(),
  private.unit_economics(bigint, integer, boolean, boolean),
  private.pricing_item_input(jsonb),
  private.pricing_line(uuid, jsonb, integer),
  private.plan_summary(jsonb),
  private.product_pricing_plan(jsonb),
  private.reprice_plan(jsonb),
  private.write_pricing_line(jsonb, uuid, text),
  private.campaign_input(jsonb),
  private.campaign_view(uuid),
  private.campaign_overlaps(private.sale_campaigns),
  private.campaign_candidate(private.sale_campaigns, private.sale_campaign_products, private.product_pricing_state),
  private.campaign_plan(uuid),
  private.campaign_apply_line(private.sale_campaigns, uuid, integer, integer, uuid),
  private.campaign_remove_line(private.sale_campaigns, uuid, uuid),
  private.campaign_end(private.sale_campaigns, text, uuid),
  private.campaign_start(private.sale_campaigns, uuid),
  private.run_sale_schedule(),
  private.settings_view(),
  private.campaign_lock(uuid, integer)
  from public, anon, authenticated;

revoke execute on function
  public.admin_pricing_overview(),
  public.admin_pricing_products(jsonb),
  public.admin_product_pricing(uuid),
  public.admin_preview_product_pricing(jsonb),
  public.admin_preview_reprice(jsonb),
  public.admin_save_pricing_settings(integer, uuid, jsonb),
  public.admin_create_pricing_group(uuid, text, integer),
  public.admin_apply_product_pricing(uuid, jsonb, text),
  public.admin_apply_reprice(uuid, jsonb, text),
  public.admin_list_campaigns(),
  public.admin_get_campaign(uuid),
  public.admin_campaign_candidates(uuid),
  public.admin_sale_coverage(),
  public.admin_create_campaign(uuid, jsonb),
  public.admin_update_campaign(uuid, integer, uuid, jsonb),
  public.admin_set_campaign_selection(uuid, integer, uuid, jsonb),
  public.admin_apply_campaign(uuid, integer, uuid, text),
  public.admin_end_campaign(uuid, integer, uuid, text),
  public.admin_run_sale_schedule(),
  public.admin_sale_schedule_health()
  from public, anon;
grant execute on function
  public.admin_pricing_overview(),
  public.admin_pricing_products(jsonb),
  public.admin_product_pricing(uuid),
  public.admin_preview_product_pricing(jsonb),
  public.admin_preview_reprice(jsonb),
  public.admin_save_pricing_settings(integer, uuid, jsonb),
  public.admin_create_pricing_group(uuid, text, integer),
  public.admin_apply_product_pricing(uuid, jsonb, text),
  public.admin_apply_reprice(uuid, jsonb, text),
  public.admin_list_campaigns(),
  public.admin_get_campaign(uuid),
  public.admin_campaign_candidates(uuid),
  public.admin_sale_coverage(),
  public.admin_create_campaign(uuid, jsonb),
  public.admin_update_campaign(uuid, integer, uuid, jsonb),
  public.admin_set_campaign_selection(uuid, integer, uuid, jsonb),
  public.admin_apply_campaign(uuid, integer, uuid, text),
  public.admin_end_campaign(uuid, integer, uuid, text),
  public.admin_run_sale_schedule(),
  public.admin_sale_schedule_health()
  to authenticated;
