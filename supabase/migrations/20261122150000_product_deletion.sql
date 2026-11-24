-- Permanent product deletion, including every order that contains the product.
--
-- An admin deletes a product from its edit page (app/admin/products/[id]):
--   1. public.admin_product_deletion_preview(product) lists what will go: the
--      product, its sizes and photos, and every order containing it (with the
--      order's other products, which disappear from that order's record too).
--      It also lists what blocks the delete, and returns a token for exactly
--      this state.
--   2. public.admin_delete_product(product, token, typed item code, request id)
--      deletes it all in one transaction, or nothing.
--
-- Refused (nothing deleted) while any of those orders:
--   * isn't finished: awaiting confirmation, confirmed, dispatched or
--     delivery failed (finish or cancel it first). Finished = delivered,
--     returned, cancelled, or an in-store sale;
--   * has a refund due to the customer;
--   * has agent commission that was paid out, or an adjustment after a payout
--     (those are records of money that has moved; deleting them would
--     corrupt the payout).
-- Also refused when anything changed since the preview (the token differs):
-- the new preview comes back instead.
--
-- Deleted: the product (and through ON DELETE CASCADE its sizes, photo rows,
-- photo registrations, pricing settings and sale-campaign lines), its
-- reference price and price history, its own stock-ledger rows, and each
-- order containing it with that order's lines, events, returns, referral
-- record and commission holds.
-- Kept: other products' stock-ledger rows from those orders (so their stock
-- history still adds up), with the link to the deleted order removed;
-- the product's barcodes, retired (a printed label can still be recognised and
-- a barcode is never issued twice); pricing request audit rows (they can cover
-- several products); and one row in private.product_deletions saying who
-- deleted which product and which order numbers (no customer details).
-- Photo files in Storage are removed by the website after the delete
-- (app/admin/products/actions.ts); the result lists their paths.
--
-- The tables involved are append-only by design (private.append_only and
-- private.orders_guard refuse every DELETE). Those guards now let a delete
-- through only while kns.product_purge is 'on', which only
-- admin_delete_product sets, for its own transaction. Nothing else changes:
-- the same statements are refused everywhere else (db-tests/product-deletion.test.ts).

-- ===========================================================================
-- Deletion log (append-only)
-- ===========================================================================

create table private.product_deletions (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  request_fingerprint bytea not null,
  product_id uuid not null,
  item_code text not null,
  product_name text not null,
  order_numbers text[] not null,
  result jsonb not null,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  constraint product_deletions_request_key unique (request_id),
  constraint product_deletions_fingerprint_length check (octet_length(request_fingerprint) = 32)
);

comment on table private.product_deletions is
  'One row per permanently deleted product: who, when, its item code and name, and the order numbers deleted with it. Also the request''s original answer (a retry gets it again).';

create trigger product_deletions_append_only before update or delete on private.product_deletions
  for each row execute function private.append_only();
create trigger product_deletions_no_truncate before truncate on private.product_deletions
  for each statement execute function private.append_only();

-- ===========================================================================
-- Guards: allow the purge, and only the purge
-- ===========================================================================

create or replace function private.append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Product deletion (public.admin_delete_product) only: whole rows may be
  -- deleted, and a stock-ledger row may lose its link to a deleted order
  -- (nothing else about it may change).
  if coalesce(current_setting('kns.product_purge', true), '') = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if tg_op = 'UPDATE' and tg_table_name = 'stock_movements'
       and new.order_id is null and new.order_item_id is null and new.return_line_id is null
       and to_jsonb(new) - array['order_id', 'order_item_id', 'return_line_id']
         = to_jsonb(old) - array['order_id', 'order_item_id', 'return_line_id'] then
      return new;
    end if;
  end if;
  raise exception '% rows can''t be changed or removed.', tg_table_name
    using errcode = 'PT400', hint = 'append_only';
end;
$$;

-- Same body as 20261118120100_referral_checkout.sql, except the DELETE branch.
create or replace function private.orders_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('kns.product_purge', true), '') = 'on' then
      return old;
    end if;
    raise exception 'Orders are never deleted.' using errcode = 'PT400', hint = 'append_only';
  end if;
  if (new.id, new.order_number, new.channel, new.request_key_hash, new.request_fingerprint,
      new.subtotal_paisa, new.discount_paisa, new.delivery_paisa, new.total_paisa, new.created_at)
     is distinct from
     (old.id, old.order_number, old.channel, old.request_key_hash, old.request_fingerprint,
      old.subtotal_paisa, old.discount_paisa, old.delivery_paisa, old.total_paisa, old.created_at) then
    raise exception 'An order''s number, contents and totals never change.' using errcode = 'PT400', hint = 'order_locked';
  end if;
  if old.delivered_at is not null and new.delivered_at is distinct from old.delivered_at then
    raise exception 'An order''s delivery time never changes once recorded.' using errcode = 'PT400', hint = 'order_locked';
  end if;
  if new.status is distinct from old.status and (old.status, new.status) not in (
    ('awaiting_confirmation', 'confirmed'), ('awaiting_confirmation', 'cancelled'),
    ('confirmed', 'dispatched'), ('confirmed', 'cancelled'),
    ('dispatched', 'delivered'), ('dispatched', 'delivery_failed'),
    ('delivery_failed', 'dispatched'), ('delivery_failed', 'delivered'), ('delivery_failed', 'returned'),
    ('delivered', 'returned')
  ) then
    raise exception 'An order can''t go from % to %.', old.status, new.status using errcode = 'PT409', hint = 'bad_transition';
  end if;
  if new.payment_status is distinct from old.payment_status and (old.payment_status, new.payment_status) not in (
    ('pending', 'collected'), ('pending', 'void'), ('collected', 'settled'),
    ('collected', 'refund_due'), ('settled', 'refund_due'), ('refund_due', 'refunded')
  ) then
    raise exception 'Payment can''t go from % to %.', old.payment_status, new.payment_status
      using errcode = 'PT409', hint = 'bad_payment_transition';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

-- ===========================================================================
-- What a deletion would remove (also the token's input)
-- ===========================================================================

create function private.product_deletion_plan(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.products;
  v_orders jsonb;
  v_token_input jsonb;
begin
  select * into p from public.products where id = p_product_id;
  if not found then
    return null;
  end if;

  with ids as (
    select distinct oi.order_id
    from public.order_items oi
    where oi.product_id = p.id
       or oi.variant_id in (select v.id from public.product_variants v where v.product_id = p.id)
  ),
  o as (
    select x.*,
      array_remove(array[
        case when x.status in ('awaiting_confirmation', 'confirmed', 'dispatched', 'delivery_failed') then 'open' end,
        case when x.payment_status = 'refund_due' then 'refund_due' end,
        case when exists (select 1 from public.agent_payout_lines pl where pl.order_id = x.id) then 'commission_paid' end,
        case when exists (select 1 from public.agent_adjustments a where a.order_id = x.id) then 'commission_adjusted' end
      ], null) as blockers
    from public.orders x
    where x.id in (select order_id from ids)
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_number', o.order_number,
      'channel', o.channel,
      'status', o.status,
      'payment_status', o.payment_status,
      'total_paisa', o.total_paisa,
      'created_at', o.created_at,
      'version', o.version,
      'other_products', (
        select coalesce(jsonb_agg(distinct oi.item_code || ' ' || oi.brand || ' ' || oi.product_name), '[]'::jsonb)
        from public.order_items oi where oi.order_id = o.id and oi.product_id <> p.id),
      'has_referral', exists (select 1 from public.order_referrals r where r.order_id = o.id),
      'blockers', to_jsonb(o.blockers)
    ) order by o.created_at, o.order_number), '[]'::jsonb),
    jsonb_build_object('product_version', p.version,
      'orders', coalesce(jsonb_agg(jsonb_build_array(o.id, o.version) order by o.id), '[]'::jsonb))
  into v_orders, v_token_input
  from o;

  return jsonb_build_object(
    'product', jsonb_build_object(
      'id', p.id, 'item_code', p.item_code, 'name', p.name, 'brand', p.brand,
      'publication_status', p.publication_status, 'version', p.version),
    'sizes', (select count(*) from public.product_variants v where v.product_id = p.id),
    'photos', (select count(*) from public.product_images i where i.product_id = p.id),
    'orders', v_orders,
    'blocked', exists (select 1 from jsonb_array_elements(v_orders) e where jsonb_array_length(e -> 'blockers') > 0),
    'token', encode(sha256(convert_to(v_token_input::text, 'UTF8')), 'hex')
  );
end;
$$;

create function public.admin_product_deletion_preview(p_product_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  return private.product_deletion_plan(p_product_id);
end;
$$;

-- ===========================================================================
-- The deletion
-- ===========================================================================

create function public.admin_delete_product(
  p_product_id uuid, p_expected_token text, p_confirm_item_code text, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_payload jsonb := jsonb_build_object('product_id', p_product_id, 'token', p_expected_token,
    'confirm', upper(btrim(coalesce(p_confirm_item_code, ''))));
  v_fingerprint bytea := sha256(convert_to(v_payload::text, 'UTF8'));
  earlier private.product_deletions;
  p public.products;
  plan jsonb;
  v_variants uuid[];
  v_orders uuid[];
  v_numbers text[];
  v_items uuid[];
  v_returns uuid[];
  v_paths text[];
  v_result jsonb;
begin
  perform public.admin_require_catalogue_admin();
  if p_product_id is null or p_request_id is null or p_expected_token is null or p_expected_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;

  -- One deletion at a time; a request id is answered once.
  perform pg_advisory_xact_lock(20261122, 1);
  select * into earlier from private.product_deletions d where d.request_id = p_request_id;
  if found then
    if earlier.request_fingerprint = v_fingerprint then
      return earlier.result || jsonb_build_object('replayed', true);
    end if;
    raise exception 'This form was already used for a different change. Reload the page.'
      using errcode = 'PT409', hint = 'request_mismatch';
  end if;

  -- Lock the product and its sizes (checkout locks sizes before it records
  -- an order, so no order for this product can appear after this point),
  -- then every order containing it.
  select * into p from public.products where id = p_product_id for update;
  if not found then
    raise exception 'This product no longer exists.' using errcode = 'PT404', hint = 'not_found';
  end if;
  if upper(btrim(coalesce(p_confirm_item_code, ''))) <> p.item_code then
    raise exception 'Type the item code exactly as shown to confirm.' using errcode = 'PT400', hint = 'confirm_mismatch';
  end if;
  select coalesce(array_agg(v.id order by v.id), '{}') into v_variants
  from (select v.id from public.product_variants v where v.product_id = p.id order by v.id for update) v;
  perform 1 from public.orders x
  where x.id in (select oi.order_id from public.order_items oi where oi.product_id = p.id or oi.variant_id = any (v_variants))
  order by x.id
  for update;

  plan := private.product_deletion_plan(p.id);
  if plan ->> 'token' <> p_expected_token then
    return jsonb_build_object('result', 'stale', 'preview', plan);
  end if;
  if (plan ->> 'blocked')::boolean then
    raise exception 'This product is in orders that block deletion. Reload the page to see why.'
      using errcode = 'PT409', hint = 'delete_blocked';
  end if;

  select coalesce(array_agg((e ->> 'id')::uuid), '{}'), coalesce(array_agg(e ->> 'order_number' order by e ->> 'order_number'), '{}')
    into v_orders, v_numbers
  from jsonb_array_elements(plan -> 'orders') e;
  select coalesce(array_agg(oi.id), '{}') into v_items from public.order_items oi where oi.order_id = any (v_orders);
  select coalesce(array_agg(r.id), '{}') into v_returns from public.order_return_lines r where r.order_id = any (v_orders);
  select coalesce(array_agg(distinct path order by path), '{}') into v_paths
  from (
    select i.storage_path as path from public.product_images i where i.product_id = p.id and i.storage_path is not null
    union
    select r.storage_path from private.photo_registrations r where r.product_id = p.id
  ) s;

  perform set_config('kns.product_purge', 'on', true);

  -- Orders, child rows first.
  update public.stock_movements m
  set order_id = null, order_item_id = null, return_line_id = null
  where (m.order_id = any (v_orders) or m.order_item_id = any (v_items) or m.return_line_id = any (v_returns))
    and not (m.variant_id = any (v_variants));
  delete from public.stock_movements m where m.variant_id = any (v_variants);
  delete from public.commission_hold_events h where h.order_id = any (v_orders);
  delete from public.order_line_referrals l where l.order_id = any (v_orders);
  delete from public.order_referrals r where r.order_id = any (v_orders);
  delete from public.order_return_lines r where r.order_id = any (v_orders);
  delete from public.order_events e where e.order_id = any (v_orders);
  delete from public.order_items oi where oi.order_id = any (v_orders);
  delete from public.orders x where x.id = any (v_orders);

  -- The product. Deleting its sizes writes 'size_removed' ledger rows; those go too.
  delete from private.product_reference_prices r where r.product_id = p.id;
  delete from private.price_history h where h.product_id = p.id;
  delete from public.products x where x.id = p.id;
  delete from public.stock_movements m where m.variant_id = any (v_variants);

  perform set_config('kns.product_purge', '', true);

  v_result := jsonb_build_object(
    'result', 'deleted',
    'product_id', p.id,
    'item_code', p.item_code,
    'name', p.name,
    'orders_deleted', to_jsonb(v_numbers),
    'storage_paths', to_jsonb(v_paths));
  insert into private.product_deletions (request_id, request_fingerprint, product_id, item_code, product_name, order_numbers, result, actor_user_id)
  values (p_request_id, v_fingerprint, p.id, p.item_code, p.name, v_numbers, v_result, (select auth.uid()));
  return v_result;
end;
$$;

-- ===========================================================================
-- Access control
-- ===========================================================================

revoke all on table private.product_deletions from public, anon, authenticated;

revoke execute on function private.product_deletion_plan(uuid) from public, anon, authenticated;

revoke execute on function
  public.admin_product_deletion_preview(uuid),
  public.admin_delete_product(uuid, text, text, uuid)
  from public, anon;
grant execute on function
  public.admin_product_deletion_preview(uuid),
  public.admin_delete_product(uuid, text, text, uuid)
  to authenticated;
