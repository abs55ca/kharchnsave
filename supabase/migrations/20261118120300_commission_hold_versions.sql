-- Commission holds: stale hold/release forms are refused.
--
-- Corrects 20261118120200_commission_accounting.sql (forward only; that file
-- is left as it is, in case it has been applied somewhere).
--
-- The problem: admin_set_commission_hold acted on whatever the hold was NOW.
-- Tab A opens the release form for hold #1; tab B releases hold #1 and places
-- hold #2 for a new dispute; tab A's old release form then released hold #2,
-- and the commission could be paid.
--
-- Now every hold/release names the latest hold event the admin saw for that
-- order (p_expected_event_id; null = "no hold events yet"). With the order
-- row locked:
--   1. A request id seen before is answered first: the same request (same
--      order, action, reason AND expected event) gets its ORIGINAL result back
--      and changes nothing, even if the hold has moved on since; the same id
--      with anything else is refused (PT409, request_mismatch).
--   2. Otherwise the expected event must still be the latest one; if not:
--      PT409, hint hold_conflict ("the hold changed since you opened it").
--   3. Then the existing rules (reason, already_on_hold, not_on_hold,
--      already_paid, not_holdable) and the append-only insert.
-- Locking is unchanged: the order row FOR NO KEY UPDATE, which a payout's
-- FOR SHARE on the same order waits for (and vice versa).
--
-- Requests recorded before this migration have a fingerprint without the
-- expected event, so their exact retries after it are refused as
-- request_mismatch (safe: nothing is applied twice; the admin reloads).

alter table public.commission_hold_events add column expected_event_id bigint;

comment on column public.commission_hold_events.expected_event_id is
  'The latest hold event the admin saw when they made this request (null: none yet).';

drop function public.admin_set_commission_hold(uuid, uuid, boolean, text);

-- Holds (p_hold true) or releases (false) one order's commission, with a
-- reason, if the hold is still as the admin saw it. Results: done (with the
-- new event's id) | replayed (the original result of this request).
create function public.admin_set_commission_hold(
  p_order_id uuid, p_expected_event_id bigint, p_request_id uuid, p_hold boolean, p_reason text
)
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
  latest_id bigint;
  current_state text;
  current_hold boolean;
  new_id bigint;
begin
  perform public.admin_require_catalogue_admin();
  if p_order_id is null or p_request_id is null or p_hold is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  v_fingerprint := sha256(convert_to(jsonb_build_object('order', p_order_id, 'hold', p_hold, 'reason', v_reason,
    'expected_event', p_expected_event_id)::text, 'UTF8'));

  -- The order row: a payout of this order (FOR SHARE) and this wait for each other.
  perform 1 from public.orders o where o.id = p_order_id for no key update;
  if not found then
    raise exception 'Order not found.' using errcode = 'PT404';
  end if;
  select * into referral from public.order_referrals r where r.order_id = p_order_id;
  if not found then
    raise exception 'This order has no referral commission.' using errcode = 'PT404';
  end if;

  -- 1. A request seen before: its original result, whatever has happened since.
  select * into earlier from public.commission_hold_events e where e.request_id = p_request_id;
  if found then
    if earlier.request_fingerprint = v_fingerprint then
      return jsonb_build_object('result', 'replayed', 'on_hold', earlier.action = 'hold', 'event_id', earlier.id);
    end if;
    raise exception 'This form was already used for a different change. Reload the page.'
      using errcode = 'PT409', hint = 'request_mismatch';
  end if;

  -- 2. The hold must still be as the admin saw it.
  select max(e.id) into latest_id from public.commission_hold_events e where e.order_id = p_order_id;
  if latest_id is distinct from p_expected_event_id then
    raise exception 'This commission''s hold changed since you opened the page. Reload to see the current hold.'
      using errcode = 'PT409', hint = 'hold_conflict';
  end if;

  -- 3. The existing rules.
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

  insert into public.commission_hold_events (order_id, agent_id, action, reason, request_id, request_fingerprint,
    actor_user_id, expected_event_id)
  values (p_order_id, referral.agent_id, case when p_hold then 'hold' else 'release' end, v_reason, p_request_id,
    v_fingerprint, (select auth.uid()), p_expected_event_id)
  returning id into new_id;
  return jsonb_build_object('result', 'done', 'on_hold', p_hold, 'event_id', new_id);
end;
$$;

-- As in 20261118120200, plus each hold event's id and the latest one (the
-- version a hold/release form must name).
create or replace function public.admin_order_referral(p_order_id uuid)
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
      'hold_history', (select jsonb_agg(jsonb_build_object('id', e.id, 'action', e.action, 'reason', e.reason,
                         'actor_user_id', e.actor_user_id, 'created_at', e.created_at) order by e.id)
                       from public.commission_hold_events e where e.order_id = r.order_id),
      'latest_hold_event_id', (select max(e.id) from public.commission_hold_events e where e.order_id = r.order_id),
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

revoke execute on function public.admin_set_commission_hold(uuid, bigint, uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_commission_hold(uuid, bigint, uuid, boolean, text) to authenticated;
