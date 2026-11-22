-- Commission lifecycle, adjustments and manually recorded payouts.
--
-- Builds on 20261118120100_referral_checkout.sql. Every referral order has
-- one fixed commission (public.order_referrals, per line in
-- public.order_line_referrals). Its state is NOT stored: it is worked out
-- whenever it is read or paid, from the order and the payout records, so a
-- repeated event, a status retry or a re-run can never move it twice.
--
-- States (private.commission_rows), in this order of precedence:
--   cancelled          order cancelled: earns nothing
--   reversed           order returned (the whole parcel; partial returns
--                      don't exist yet): the returned lines' commission is
--                      reversed, worked out per line from the return lines,
--                      which for a whole parcel is all of it
--   awaiting_delivery  placed, confirmed, dispatched or a failed delivery
--                      being retried: an estimate
--   paid               included in a payout
--   no_commission      delivered, but the commission is zero (e.g. a 0%
--                      rate): nothing to pay, never offered for payout
--   on_hold            delivered, and an admin has put the commission on
--                      hold (e.g. a return is being arranged); see below
--   held               delivered, less than hold_hours (720 = 30 x 24 hours,
--                      saved on the order) since the RECORDED delivery time
--                      (orders.delivered_at, fixed once set). Release time =
--                      delivered_at + hold_hours, an absolute instant (UTC in
--                      the database, shown in Pakistan time). Available from
--                      that instant exactly (>=), on the database's clock.
--   awaiting_payment   hold over, but the courier hasn't paid the shop yet
--                      (payment_status pending or collected; it must be
--                      "settled")
--   available          hold over and payment settled: can be paid out
--
-- What blocks availability: the 30-day hold, any payment status other than
-- "settled", and an admin's commission hold. The order model has no "return
-- requested" state: a return is recorded when the parcel is back
-- (delivered -> returned), which makes the commission "reversed" at once.
--
-- Commission holds (admin_set_commission_hold): an admin can hold one order's
-- commission while a return is being arranged, with a reason; and release it,
-- with a reason. Every hold and release is kept (who, when, why). A hold
-- changes nothing about the order, its payment or its saved terms; releasing
-- it only removes that one block, so the 30-day hold and settled payment are
-- still required. Holding and paying the same order run one after the other
-- (both lock the order row): hold first, the payout refuses it; payout first,
-- the hold is refused (already paid).
--
-- Returns after a payout: the commission stays paid (the payout is history)
-- and a negative adjustment of the paid amount is recorded automatically
-- (trigger on orders). Outstanding adjustments count against the next payout.
--
-- Payouts (admin_record_agent_payout) are recorded by an admin after paying
-- the agent outside the app. In one transaction the database checks that
-- every selected commission is "available" and unpaid, that every
-- outstanding negative adjustment is included, and that the amount equals
-- the selection's total (more than zero). A request id makes retries safe.
--
-- Locking: a payout locks the agent row FOR NO KEY UPDATE (one payout per
-- agent at a time), then its orders FOR SHARE in id order. A return locks
-- its order FOR UPDATE and never the agent row (its adjustment's foreign key
-- takes only KEY SHARE, which NO KEY UPDATE doesn't block). So a return and
-- a payout of the same order run one after the other: return first, the
-- payout refuses that commission; payout first, the return records the
-- adjustment.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.agent_adjustments (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.sales_agents (id) on delete restrict,
  -- return_after_payout: automatic, for an order whose paid commission was reversed.
  -- manual: an admin's correction, with a reason.
  kind text not null,
  order_id uuid references public.order_referrals (order_id) on delete restrict,
  amount_paisa bigint not null,
  reason text not null,
  details jsonb,
  request_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),

  constraint agent_adjustments_request_key unique (request_id),
  constraint agent_adjustments_kind_valid check (kind in ('return_after_payout', 'manual')),
  constraint agent_adjustments_amount_valid check (amount_paisa <> 0 and abs(amount_paisa) <= 100000000000),
  constraint agent_adjustments_reason_valid check (char_length(reason) between 5 and 300 and reason !~ '[[:cntrl:]]'),
  constraint agent_adjustments_kind_shape check (
    (kind = 'return_after_payout' and order_id is not null and amount_paisa < 0 and request_id is null)
    or (kind = 'manual' and request_id is not null))
);

create unique index agent_adjustments_one_reversal_per_order on public.agent_adjustments (order_id)
  where kind = 'return_after_payout';
create index agent_adjustments_agent_idx on public.agent_adjustments (agent_id, created_at desc);

create table public.agent_payouts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.sales_agents (id) on delete restrict,
  request_id uuid not null,
  -- SHA-256 of the request (agent, selection, amount, date, method,
  -- reference): the same request id with anything different is refused.
  request_fingerprint bytea not null,
  amount_paisa bigint not null,
  paid_on date not null,
  method text not null,
  reference text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),

  constraint agent_payouts_request_key unique (request_id),
  constraint agent_payouts_amount_positive check (amount_paisa > 0),
  constraint agent_payouts_method_valid check (method in ('cash', 'bank_transfer', 'easypaisa', 'jazzcash', 'other')),
  constraint agent_payouts_reference_valid check (reference is null or (char_length(reference) between 1 and 100 and reference !~ '[[:cntrl:]]')),
  constraint agent_payouts_note_valid check (note is null or (char_length(note) between 1 and 500 and note !~ '[[:cntrl:]]'))
);

create index agent_payouts_agent_idx on public.agent_payouts (agent_id, paid_on desc, created_at desc);

-- What each payout paid: commissions (by order) and adjustments. Each is
-- paid at most once (unique), whatever happens concurrently.
create table public.agent_payout_lines (
  id bigint generated always as identity primary key,
  payout_id uuid not null references public.agent_payouts (id) on delete restrict,
  agent_id uuid not null references public.sales_agents (id) on delete restrict,
  order_id uuid references public.order_referrals (order_id) on delete restrict,
  adjustment_id uuid references public.agent_adjustments (id) on delete restrict,
  amount_paisa bigint not null,

  constraint agent_payout_lines_order_key unique (order_id),
  constraint agent_payout_lines_adjustment_key unique (adjustment_id),
  constraint agent_payout_lines_one_thing check ((order_id is null) <> (adjustment_id is null)),
  constraint agent_payout_lines_order_positive check (order_id is null or amount_paisa > 0)
);

create index agent_payout_lines_payout_idx on public.agent_payout_lines (payout_id);

-- Admin holds on single commissions: every hold and release, never changed.
-- The latest event for an order says whether it is on hold.
create table public.commission_hold_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.order_referrals (order_id) on delete restrict,
  agent_id uuid not null references public.sales_agents (id) on delete restrict,
  action text not null,
  reason text not null,
  request_id uuid not null,
  -- SHA-256 of {order, action, reason}: the same request id with anything else is refused.
  request_fingerprint bytea not null,
  actor_user_id uuid,
  created_at timestamptz not null default now(),

  constraint commission_hold_events_request_key unique (request_id),
  constraint commission_hold_events_action_valid check (action in ('hold', 'release')),
  constraint commission_hold_events_reason_valid check (char_length(reason) between 5 and 300 and reason !~ '[[:cntrl:]]'),
  constraint commission_hold_events_fingerprint_length check (octet_length(request_fingerprint) = 32)
);

create index commission_hold_events_order_idx on public.commission_hold_events (order_id, id desc);

create trigger commission_hold_events_append_only before update or delete on public.commission_hold_events
  for each row execute function private.append_only();
create trigger commission_hold_events_no_truncate before truncate on public.commission_hold_events
  for each statement execute function private.append_only();

create trigger agent_adjustments_append_only before update or delete on public.agent_adjustments
  for each row execute function private.append_only();
create trigger agent_adjustments_no_truncate before truncate on public.agent_adjustments
  for each statement execute function private.append_only();
create trigger agent_payouts_append_only before update or delete on public.agent_payouts
  for each row execute function private.append_only();
create trigger agent_payouts_no_truncate before truncate on public.agent_payouts
  for each statement execute function private.append_only();
create trigger agent_payout_lines_append_only before update or delete on public.agent_payout_lines
  for each row execute function private.append_only();
create trigger agent_payout_lines_no_truncate before truncate on public.agent_payout_lines
  for each statement execute function private.append_only();

-- ---------------------------------------------------------------------------
-- Commission states (derived)
-- ---------------------------------------------------------------------------

-- The commission reversed by an order's returns, line by line: a line's
-- commission times the share of its pairs that came back (all of them, for
-- the whole-parcel returns that exist today), rounded down.
create function private.commission_reversed(p_order_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(
    case when back.quantity >= oi.quantity then lr.commission_paisa
         else floor(lr.commission_paisa::numeric * back.quantity / oi.quantity)::bigint end), 0)::bigint
  from public.order_line_referrals lr
  join public.order_items oi on oi.id = lr.order_item_id
  join lateral (
    select coalesce(sum(rl.quantity), 0) as quantity from public.order_return_lines rl where rl.order_item_id = oi.id
  ) back on true
  where lr.order_id = p_order_id;
$$;

-- Every commission of one agent (or of all agents, p_agent_id null) with its
-- state as of now().
create function private.commission_rows(p_agent_id uuid)
returns table (
  order_id uuid, agent_id uuid, order_number text, placed_at timestamptz, order_status text, payment_status text,
  delivered_at timestamptz, release_at timestamptz, code text, terms_version integer, discount_bp integer,
  commission_bp integer, applies_to_sale_items boolean, eligible_subtotal_paisa bigint, discount_paisa bigint,
  commission_basis_paisa bigint, commission_paisa bigint, reversed_paisa bigint, earned_paisa bigint,
  state text, payout_id uuid, paid_paisa bigint, on_hold boolean, hold_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.order_id, r.agent_id, o.order_number, o.created_at, o.status, o.payment_status,
    o.delivered_at, o.delivered_at + make_interval(hours => r.hold_hours), r.code, r.terms_version, r.discount_bp,
    r.commission_bp, r.applies_to_sale_items, r.eligible_subtotal_paisa, r.discount_paisa,
    r.commission_basis_paisa, r.commission_paisa, x.reversed, r.commission_paisa - x.reversed,
    case
      when o.status = 'cancelled' then 'cancelled'
      when o.status = 'returned' then 'reversed'
      when o.status in ('awaiting_confirmation', 'confirmed', 'dispatched', 'delivery_failed') then 'awaiting_delivery'
      when pl.order_id is not null then 'paid'
      when r.commission_paisa = 0 then 'no_commission'
      when h.action = 'hold' then 'on_hold'
      when o.status = 'delivered' and now() < o.delivered_at + make_interval(hours => r.hold_hours) then 'held'
      when o.status = 'delivered' and o.payment_status <> 'settled' then 'awaiting_payment'
      when o.status = 'delivered' then 'available'
      else 'unknown'
    end,
    pl.payout_id, pl.amount_paisa, coalesce(h.action = 'hold', false), case when h.action = 'hold' then h.reason end
  from public.order_referrals r
  join public.orders o on o.id = r.order_id
  left join public.agent_payout_lines pl on pl.order_id = r.order_id
  left join lateral (
    select e.action, e.reason from public.commission_hold_events e where e.order_id = r.order_id order by e.id desc limit 1
  ) h on true
  cross join lateral (
    select case when o.status = 'cancelled' then r.commission_paisa
                when o.status = 'returned' then private.commission_reversed(r.order_id)
                else 0 end as reversed
  ) x
  where p_agent_id is null or r.agent_id = p_agent_id;
$$;

-- Totals for one agent.
create function private.agent_totals(p_agent_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'referred_orders', count(*),
    'cancelled_orders', count(*) filter (where c.state = 'cancelled'),
    'returned_orders', count(*) filter (where c.state = 'reversed'),
    'awaiting_delivery_paisa', coalesce(sum(c.commission_paisa) filter (where c.state = 'awaiting_delivery'), 0),
    'held_paisa', coalesce(sum(c.commission_paisa) filter (where c.state = 'held'), 0),
    'awaiting_payment_paisa', coalesce(sum(c.commission_paisa) filter (where c.state = 'awaiting_payment'), 0),
    'available_paisa', coalesce(sum(c.commission_paisa) filter (where c.state = 'available'), 0),
    'on_hold_paisa', coalesce(sum(c.commission_paisa) filter (where c.state = 'on_hold'), 0),
    'reversed_paisa', coalesce(sum(c.reversed_paisa) filter (where c.state = 'reversed'), 0),
    'paid_paisa', (select coalesce(sum(p.amount_paisa), 0) from public.agent_payouts p where p.agent_id = p_agent_id),
    'outstanding_adjustments_paisa', (
      select coalesce(sum(a.amount_paisa), 0) from public.agent_adjustments a
      where a.agent_id = p_agent_id and not exists (select 1 from public.agent_payout_lines pl where pl.adjustment_id = a.id)),
    'next_release_at', min(c.release_at) filter (where c.state = 'held')
  ) || jsonb_build_object('payable_paisa',
    coalesce(sum(c.commission_paisa) filter (where c.state = 'available'), 0) + (
      select coalesce(sum(a.amount_paisa), 0) from public.agent_adjustments a
      where a.agent_id = p_agent_id and not exists (select 1 from public.agent_payout_lines pl where pl.adjustment_id = a.id)))
  from private.commission_rows(p_agent_id) c;
$$;

create function private.page_bounds(p_page integer, p_page_size integer)
returns integer[]
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_page is null or p_page < 0 or p_page > 100000 or p_page_size is null or p_page_size not between 1 and 100 then
    raise exception 'Malformed page.' using errcode = 'PT400';
  end if;
  return array[p_page * p_page_size, p_page_size];
end;
$$;

-- ---------------------------------------------------------------------------
-- Returns after payout: the automatic adjustment
-- ---------------------------------------------------------------------------

create function private.orders_commission_reversal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  paid public.agent_payout_lines;
  reversed bigint;
begin
  select * into paid from public.agent_payout_lines pl where pl.order_id = new.id;
  if not found then
    return null;
  end if;
  reversed := least(paid.amount_paisa, private.commission_reversed(new.id));
  if reversed > 0 then
    insert into public.agent_adjustments (agent_id, kind, order_id, amount_paisa, reason, details)
    values (paid.agent_id, 'return_after_payout', new.id, -reversed,
      'Order ' || new.order_number || ' was returned after its commission was paid.',
      jsonb_build_object('payout_id', paid.payout_id, 'paid_paisa', paid.amount_paisa,
        'lines', (select jsonb_agg(jsonb_build_object('line_no', lr.line_no, 'commission_paisa', lr.commission_paisa)
                                   order by lr.line_no)
                  from public.order_line_referrals lr where lr.order_id = new.id)))
    on conflict (order_id) where kind = 'return_after_payout' do nothing;
  end if;
  return null;
end;
$$;

create trigger orders_commission_reversal
  after update of status on public.orders
  for each row when (new.status = 'returned' and old.status is distinct from 'returned')
  execute function private.orders_commission_reversal();

-- ---------------------------------------------------------------------------
-- Admin: reports, adjustments and payouts
-- ---------------------------------------------------------------------------

-- Every agent with their current configuration and totals.
create function public.admin_list_agents()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return coalesce((
    select jsonb_agg(private.agent_admin_view(a.id) || jsonb_build_object('totals', private.agent_totals(a.id))
                     order by a.created_at desc)
    from public.sales_agents a), '[]'::jsonb);
end;
$$;

-- One agent: configuration, totals, what can be paid now, and the change log.
create function public.admin_get_agent(p_agent_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  if not exists (select 1 from public.sales_agents a where a.id = p_agent_id) then
    return null;
  end if;
  return private.agent_admin_view(p_agent_id) || jsonb_build_object(
    'totals', private.agent_totals(p_agent_id),
    'available', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', c.order_id, 'order_number', c.order_number,
        'commission_paisa', c.commission_paisa, 'release_at', c.release_at) order by c.release_at, c.order_number)
      from private.commission_rows(p_agent_id) c where c.state = 'available'), '[]'::jsonb),
    'outstanding_adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'amount_paisa', a.amount_paisa, 'reason', a.reason,
        'created_at', a.created_at) order by a.created_at)
      from public.agent_adjustments a
      where a.agent_id = p_agent_id and not exists (select 1 from public.agent_payout_lines pl where pl.adjustment_id = a.id)),
      '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('kind', e.kind, 'details', e.details, 'actor_user_id', e.actor_user_id,
        'created_at', e.created_at) order by e.id desc)
      from (select * from public.sales_agent_events e where e.agent_id = p_agent_id order by e.id desc limit 50) e),
      '[]'::jsonb));
end;
$$;

-- An agent's referral orders, newest first, with the terms saved on each.
create function public.admin_agent_commissions(p_agent_id uuid, p_page integer, p_page_size integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  bounds integer[] := private.page_bounds(p_page, p_page_size);
begin
  perform public.admin_require_catalogue_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.order_referrals r where r.agent_id = p_agent_id),
    'page', p_page, 'page_size', p_page_size,
    'rows', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.placed_at desc, c.order_number desc)
      from (select * from private.commission_rows(p_agent_id) c2
            order by c2.placed_at desc, c2.order_number desc offset bounds[1] limit bounds[2]) c), '[]'::jsonb));
end;
$$;

-- An agent's payouts (with what each paid) and all adjustments, newest first.
create function public.admin_agent_payouts(p_agent_id uuid, p_page integer, p_page_size integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  bounds integer[] := private.page_bounds(p_page, p_page_size);
begin
  perform public.admin_require_catalogue_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.agent_payouts p where p.agent_id = p_agent_id),
    'page', p_page, 'page_size', p_page_size,
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'amount_paisa', p.amount_paisa, 'paid_on', p.paid_on,
        'method', p.method, 'reference', p.reference, 'note', p.note, 'created_by', p.created_by, 'created_at', p.created_at,
        'lines', (select jsonb_agg(jsonb_build_object('order_number', o.order_number, 'adjustment_id', pl.adjustment_id,
                    'amount_paisa', pl.amount_paisa) order by pl.id)
                  from public.agent_payout_lines pl left join public.orders o on o.id = pl.order_id
                  where pl.payout_id = p.id))
        order by p.paid_on desc, p.created_at desc)
      from (select * from public.agent_payouts p2 where p2.agent_id = p_agent_id
            order by p2.paid_on desc, p2.created_at desc offset bounds[1] limit bounds[2]) p), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'amount_paisa', a.amount_paisa, 'reason', a.reason,
        'order_number', o.order_number, 'created_by', a.created_by, 'created_at', a.created_at,
        'payout_id', (select pl.payout_id from public.agent_payout_lines pl where pl.adjustment_id = a.id))
        order by a.created_at desc)
      from public.agent_adjustments a left join public.orders o on o.id = a.order_id
      where a.agent_id = p_agent_id), '[]'::jsonb));
end;
$$;

-- The referral saved on one order, for the admin order page. Null if none.
create function public.admin_order_referral(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return (
    select to_jsonb(c) || jsonb_build_object(
      'agent_username_now', a.username, 'agent_display_name', a.display_name, 'agent_username_then', r.agent_username,
      'hold_hours', r.hold_hours, 'rounding_rule', r.rounding_rule,
      'hold_history', (select jsonb_agg(jsonb_build_object('action', e.action, 'reason', e.reason,
                         'actor_user_id', e.actor_user_id, 'created_at', e.created_at) order by e.id)
                       from public.commission_hold_events e where e.order_id = r.order_id),
      'lines', (select jsonb_agg(jsonb_build_object('line_no', lr.line_no, 'eligible', lr.eligible,
                  'line_total_paisa', lr.line_total_paisa, 'discount_paisa', lr.discount_paisa,
                  'commission_paisa', lr.commission_paisa) order by lr.line_no)
                from public.order_line_referrals lr where lr.order_id = r.order_id))
    from public.order_referrals r
    join public.sales_agents a on a.id = r.agent_id
    join private.commission_rows(r.agent_id) c on c.order_id = r.order_id
    where r.order_id = p_order_id);
end;
$$;

-- A manual correction (positive or negative) with a reason. Outstanding until
-- a payout includes it.
create function public.admin_add_agent_adjustment(p_agent_id uuid, p_request_id uuid, p_amount_paisa bigint, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_reason text := regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g');
  existing public.agent_adjustments;
  new_id uuid;
begin
  perform public.admin_require_catalogue_admin();
  if p_request_id is null or p_agent_id is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  perform 1 from public.sales_agents where id = p_agent_id for no key update;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
  select * into existing from public.agent_adjustments a where a.request_id = p_request_id;
  if found then
    if (existing.agent_id, existing.amount_paisa, existing.reason) is not distinct from (p_agent_id, p_amount_paisa, v_reason) then
      return jsonb_build_object('result', 'replayed', 'id', existing.id);
    end if;
    return jsonb_build_object('result', 'mismatch');
  end if;
  if p_amount_paisa is null or p_amount_paisa = 0 or abs(p_amount_paisa) > 100000000000 then
    raise exception 'Enter an amount other than zero.' using errcode = 'PT400', hint = 'invalid_amount';
  end if;
  if char_length(v_reason) not between 5 and 300 or v_reason ~ '[[:cntrl:]]' then
    raise exception 'Give a reason (5-300 characters).' using errcode = 'PT400', hint = 'reason_required';
  end if;
  insert into public.agent_adjustments (agent_id, kind, amount_paisa, reason, request_id, created_by)
  values (p_agent_id, 'manual', p_amount_paisa, v_reason, p_request_id, (select auth.uid()))
  returning id into new_id;
  return jsonb_build_object('result', 'done', 'id', new_id);
end;
$$;

-- Records a payout the admin has made outside the app. p_order_ids: the
-- commissions paid (each must be "available"); p_adjustment_ids: the
-- outstanding adjustments settled (every negative one must be included).
-- p_amount_paisa must equal their total, and be more than zero.
-- Results: done | replayed (same request again) | mismatch (same request id,
-- different request). Refusals raise PT409 with hint not_available,
-- adjustments_required or already_paid, or PT400.
create function public.admin_record_agent_payout(
  p_agent_id uuid, p_request_id uuid, p_order_ids uuid[], p_adjustment_ids uuid[], p_amount_paisa bigint,
  p_paid_on date, p_method text, p_reference text default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  order_ids uuid[] := array(select distinct x from unnest(coalesce(p_order_ids, '{}')) x where x is not null order by x);
  adjustment_ids uuid[] := array(select distinct x from unnest(coalesce(p_adjustment_ids, '{}')) x where x is not null order by x);
  v_reference text := nullif(regexp_replace(btrim(coalesce(p_reference, '')), '\s+', ' ', 'g'), '');
  v_note text := nullif(regexp_replace(btrim(coalesce(p_note, '')), '\s+', ' ', 'g'), '');
  fingerprint bytea;
  existing public.agent_payouts;
  bad text;
  commissions bigint;
  adjustments bigint;
  new_id uuid;
begin
  perform public.admin_require_catalogue_admin();
  if p_agent_id is null or p_request_id is null or p_paid_on is null
    or cardinality(order_ids) + cardinality(adjustment_ids) = 0 or cardinality(order_ids) > 500 or cardinality(adjustment_ids) > 500 then
    raise exception 'Malformed payout.' using errcode = 'PT400', hint = 'invalid_payout';
  end if;
  fingerprint := sha256(convert_to(jsonb_build_object('agent', p_agent_id, 'orders', to_jsonb(order_ids),
    'adjustments', to_jsonb(adjustment_ids), 'amount', p_amount_paisa, 'paid_on', p_paid_on, 'method', p_method,
    'reference', v_reference)::text, 'UTF8'));

  -- One payout per agent at a time; nothing else waits on this lock in a way
  -- that could deadlock (see the header).
  perform 1 from public.sales_agents where id = p_agent_id for no key update;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
  select * into existing from public.agent_payouts p where p.request_id = p_request_id;
  if found then
    if existing.agent_id = p_agent_id and existing.request_fingerprint = fingerprint then
      return jsonb_build_object('result', 'replayed', 'id', existing.id);
    end if;
    return jsonb_build_object('result', 'mismatch');
  end if;

  if p_method is null or p_method not in ('cash', 'bank_transfer', 'easypaisa', 'jazzcash', 'other') then
    raise exception 'Choose how the agent was paid.' using errcode = 'PT400', hint = 'invalid_method';
  end if;
  if p_paid_on > (now() at time zone 'Asia/Karachi')::date or p_paid_on < date '2026-01-01' then
    raise exception 'The payment date can''t be in the future.' using errcode = 'PT400', hint = 'invalid_date';
  end if;
  if char_length(v_reference) > 100 or v_reference ~ '[[:cntrl:]]' or char_length(v_note) > 500 or v_note ~ '[[:cntrl:]]' then
    raise exception 'Reference up to 100 characters, note up to 500.' using errcode = 'PT400', hint = 'invalid_payout';
  end if;

  -- The orders, so a return can't land in between (a return locks them FOR UPDATE).
  perform 1 from public.orders o where o.id = any (order_ids) order by o.id for share;

  select string_agg(coalesce(c.order_number, x::text), ', ') into bad
  from unnest(order_ids) x
  left join private.commission_rows(p_agent_id) c on c.order_id = x
  where c.order_id is null or c.state <> 'available';
  if bad is not null then
    if exists (select 1 from public.agent_payout_lines pl where pl.order_id = any (order_ids)) then
      raise exception 'Already paid: %.', bad using errcode = 'PT409', hint = 'already_paid';
    end if;
    if exists (select 1 from private.commission_rows(p_agent_id) c where c.order_id = any (order_ids) and c.state = 'on_hold') then
      raise exception 'On hold: %.', bad using errcode = 'PT409', hint = 'on_hold';
    end if;
    -- Zero commissions are never paid (a payout line is always more than zero).
    if exists (select 1 from private.commission_rows(p_agent_id) c where c.order_id = any (order_ids) and c.state = 'no_commission') then
      raise exception 'Nothing to pay for: %.', bad using errcode = 'PT409', hint = 'nothing_to_pay';
    end if;
    raise exception 'Not available to pay: %.', bad using errcode = 'PT409', hint = 'not_available';
  end if;

  if exists (
    select 1 from unnest(adjustment_ids) x
    left join public.agent_adjustments a on a.id = x and a.agent_id = p_agent_id
    where a.id is null or exists (select 1 from public.agent_payout_lines pl where pl.adjustment_id = x)
  ) then
    raise exception 'An adjustment is already settled or isn''t this agent''s.' using errcode = 'PT409', hint = 'already_paid';
  end if;
  if exists (
    select 1 from public.agent_adjustments a
    where a.agent_id = p_agent_id and a.amount_paisa < 0 and a.id <> all (adjustment_ids)
      and not exists (select 1 from public.agent_payout_lines pl where pl.adjustment_id = a.id)
  ) then
    raise exception 'Include every outstanding deduction in the payout.' using errcode = 'PT409', hint = 'adjustments_required';
  end if;

  select coalesce(sum(c.commission_paisa), 0) into commissions
  from private.commission_rows(p_agent_id) c where c.order_id = any (order_ids);
  select coalesce(sum(a.amount_paisa), 0) into adjustments from public.agent_adjustments a where a.id = any (adjustment_ids);
  if p_amount_paisa is null or p_amount_paisa <> commissions + adjustments or p_amount_paisa <= 0 then
    raise exception 'The amount must equal the selected earnings and adjustments (Rs. % here), and be more than zero.',
      to_char((commissions + adjustments) / 100.0, 'FM999999999990.00')
      using errcode = 'PT400', hint = 'invalid_amount';
  end if;

  insert into public.agent_payouts (agent_id, request_id, request_fingerprint, amount_paisa, paid_on, method, reference, note, created_by)
  values (p_agent_id, p_request_id, fingerprint, p_amount_paisa, p_paid_on, p_method, v_reference, v_note, (select auth.uid()))
  returning id into new_id;
  insert into public.agent_payout_lines (payout_id, agent_id, order_id, amount_paisa)
  select new_id, p_agent_id, c.order_id, c.commission_paisa
  from private.commission_rows(p_agent_id) c where c.order_id = any (order_ids);
  insert into public.agent_payout_lines (payout_id, agent_id, adjustment_id, amount_paisa)
  select new_id, p_agent_id, a.id, a.amount_paisa from public.agent_adjustments a where a.id = any (adjustment_ids);
  return jsonb_build_object('result', 'done', 'id', new_id);
end;
$$;

-- Holds (p_hold true) or releases (false) one order's commission, with a
-- reason (5-300 characters). Safe to retry with the same request id; the same
-- id with a different order, action or reason is refused (request_mismatch).
-- Refusals: already_on_hold, not_on_hold, already_paid, not_holdable
-- (cancelled, returned, or no commission).
create function public.admin_set_commission_hold(p_order_id uuid, p_request_id uuid, p_hold boolean, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_reason text := regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g');
  v_fingerprint bytea;
  referral public.order_referrals;
  earlier public.commission_hold_events;
  current_state text;
  current_hold boolean;
begin
  perform public.admin_require_catalogue_admin();
  if p_order_id is null or p_request_id is null or p_hold is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  v_fingerprint := sha256(convert_to(jsonb_build_object('order', p_order_id, 'hold', p_hold, 'reason', v_reason)::text, 'UTF8'));

  -- The order row: a payout of this order (FOR SHARE) and this wait for each other.
  perform 1 from public.orders o where o.id = p_order_id for no key update;
  if not found then
    raise exception 'Order not found.' using errcode = 'PT404';
  end if;
  select * into referral from public.order_referrals r where r.order_id = p_order_id;
  if not found then
    raise exception 'This order has no referral commission.' using errcode = 'PT404';
  end if;
  select * into earlier from public.commission_hold_events e where e.request_id = p_request_id;
  if found then
    if earlier.request_fingerprint = v_fingerprint then
      return jsonb_build_object('result', 'replayed', 'on_hold', earlier.action = 'hold');
    end if;
    raise exception 'This form was already used for a different change. Reload the page.'
      using errcode = 'PT409', hint = 'request_mismatch';
  end if;
  if char_length(v_reason) not between 5 and 300 or v_reason ~ '[[:cntrl:]]' then
    raise exception 'Give a reason (5-300 characters).' using errcode = 'PT400', hint = 'reason_required';
  end if;

  select c.state, c.on_hold into current_state, current_hold
  from private.commission_rows(referral.agent_id) c where c.order_id = p_order_id;
  if p_hold then
    if current_hold then
      raise exception 'Already on hold.' using errcode = 'PT409', hint = 'already_on_hold';
    end if;
    if current_state = 'paid' then
      raise exception 'This commission was already paid.' using errcode = 'PT409', hint = 'already_paid';
    end if;
    if current_state in ('cancelled', 'reversed', 'no_commission') then
      raise exception 'There is no commission to hold on this order.' using errcode = 'PT409', hint = 'not_holdable';
    end if;
  elsif not current_hold then
    raise exception 'This commission isn''t on hold.' using errcode = 'PT409', hint = 'not_on_hold';
  end if;

  insert into public.commission_hold_events (order_id, agent_id, action, reason, request_id, request_fingerprint, actor_user_id)
  values (p_order_id, referral.agent_id, case when p_hold then 'hold' else 'release' end, v_reason, p_request_id, v_fingerprint,
    (select auth.uid()));
  return jsonb_build_object('result', 'done', 'on_hold', p_hold);
end;
$$;

-- ---------------------------------------------------------------------------
-- The signed-in agent: their own data only, no customer details
-- ---------------------------------------------------------------------------

create function public.agent_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  agent public.sales_agents := private.require_active_agent();
begin
  return jsonb_build_object(
    'display_name', agent.display_name, 'username', agent.username, 'code', agent.code,
    'code_enabled', agent.code_enabled, 'discount_bp', agent.discount_bp, 'commission_bp', agent.commission_bp,
    'applies_to_sale_items', agent.applies_to_sale_items,
    'totals', private.agent_totals(agent.id),
    'upcoming_releases', coalesce((
      select jsonb_agg(jsonb_build_object('order_number', c.order_number, 'commission_paisa', c.commission_paisa,
        'release_at', c.release_at) order by c.release_at)
      from (select * from private.commission_rows(agent.id) c2 where c2.state = 'held' order by c2.release_at limit 10) c),
      '[]'::jsonb),
    'now', now());
end;
$$;

-- The agent's referred orders, newest first: order number, date, qualifying
-- amount, discount, commission and state. Nothing about the customer.
create function public.agent_referrals(p_page integer, p_page_size integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  agent public.sales_agents := private.require_active_agent();
  bounds integer[] := private.page_bounds(p_page, p_page_size);
begin
  return jsonb_build_object(
    'total', (select count(*) from public.order_referrals r where r.agent_id = agent.id),
    'page', p_page, 'page_size', p_page_size,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('order_number', c.order_number, 'placed_at', c.placed_at,
        'delivered_at', c.delivered_at, 'release_at', c.release_at, 'eligible_subtotal_paisa', c.eligible_subtotal_paisa,
        'discount_paisa', c.discount_paisa, 'commission_bp', c.commission_bp, 'commission_paisa', c.commission_paisa,
        'earned_paisa', c.earned_paisa, 'reversed_paisa', c.reversed_paisa, 'state', c.state)
        order by c.placed_at desc, c.order_number desc)
      from (select * from private.commission_rows(agent.id) c2
            order by c2.placed_at desc, c2.order_number desc offset bounds[1] limit bounds[2]) c), '[]'::jsonb));
end;
$$;

-- The agent's payouts and adjustments, newest first.
create function public.agent_payouts(p_page integer, p_page_size integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  agent public.sales_agents := private.require_active_agent();
  bounds integer[] := private.page_bounds(p_page, p_page_size);
begin
  return jsonb_build_object(
    'total', (select count(*) from public.agent_payouts p where p.agent_id = agent.id),
    'page', p_page, 'page_size', p_page_size,
    'payouts', coalesce((
      select jsonb_agg(jsonb_build_object('amount_paisa', p.amount_paisa, 'paid_on', p.paid_on, 'method', p.method,
        'reference', p.reference, 'orders', (select count(*) from public.agent_payout_lines pl where pl.payout_id = p.id and pl.order_id is not null))
        order by p.paid_on desc, p.created_at desc)
      from (select * from public.agent_payouts p2 where p2.agent_id = agent.id
            order by p2.paid_on desc, p2.created_at desc offset bounds[1] limit bounds[2]) p), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(jsonb_build_object('amount_paisa', a.amount_paisa, 'reason', a.reason, 'kind', a.kind,
        'order_number', o.order_number, 'created_at', a.created_at,
        'settled', exists (select 1 from public.agent_payout_lines pl where pl.adjustment_id = a.id))
        order by a.created_at desc)
      from public.agent_adjustments a left join public.orders o on o.id = a.order_id
      where a.agent_id = agent.id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

alter table public.agent_adjustments enable row level security;
alter table public.agent_payouts enable row level security;
alter table public.agent_payout_lines enable row level security;
alter table public.commission_hold_events enable row level security;
revoke all on table public.agent_adjustments, public.agent_payouts, public.agent_payout_lines, public.commission_hold_events
  from public, anon, authenticated;

revoke execute on function
  private.commission_reversed(uuid),
  private.commission_rows(uuid),
  private.agent_totals(uuid),
  private.page_bounds(integer, integer),
  private.orders_commission_reversal()
  from public, anon, authenticated;

revoke execute on function
  public.admin_list_agents(),
  public.admin_get_agent(uuid),
  public.admin_agent_commissions(uuid, integer, integer),
  public.admin_agent_payouts(uuid, integer, integer),
  public.admin_order_referral(uuid),
  public.admin_add_agent_adjustment(uuid, uuid, bigint, text),
  public.admin_record_agent_payout(uuid, uuid, uuid[], uuid[], bigint, date, text, text, text),
  public.admin_set_commission_hold(uuid, uuid, boolean, text),
  public.agent_dashboard(),
  public.agent_referrals(integer, integer),
  public.agent_payouts(integer, integer)
  from public, anon;
grant execute on function
  public.admin_list_agents(),
  public.admin_get_agent(uuid),
  public.admin_agent_commissions(uuid, integer, integer),
  public.admin_agent_payouts(uuid, integer, integer),
  public.admin_order_referral(uuid),
  public.admin_add_agent_adjustment(uuid, uuid, bigint, text),
  public.admin_record_agent_payout(uuid, uuid, uuid[], uuid[], bigint, date, text, text, text),
  public.admin_set_commission_hold(uuid, uuid, boolean, text),
  public.agent_dashboard(),
  public.agent_referrals(integer, integer),
  public.agent_payouts(integer, integer)
  to authenticated;
