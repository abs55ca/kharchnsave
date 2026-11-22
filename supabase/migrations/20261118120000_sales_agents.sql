-- Sales agents: accounts, referral codes and their current terms.
--
-- An agent is a Supabase Auth user that a verified admin has set up, plus a
-- row here. The row is what grants the /agent area; signing in alone grants
-- nothing (public sign-up stays disabled in the Auth settings).
--
-- Referral codes (README, "Sales agents"):
--   * letters A-Z and digits 0-9 only, 3 to 16 characters;
--   * case-insensitive: stored upper-case; spaces and hyphens typed by a
--     customer or admin are ignored (private.normalize_referral_code, and the
--     same rule in lib/agents/code.ts);
--   * one per agent, unique across every agent ever created (a unique
--     constraint, so two simultaneous creations can't both get one);
--   * never changed and never released: agents are never deleted, and the
--     code column is fixed by a trigger, so a deactivated agent's code stays
--     reserved and history keeps pointing at the right person.
--
-- Terms (current configuration; every order keeps its own snapshot, see
-- 20261118120100_referral_checkout.sql):
--   * discount_bp      customer discount in basis points (1000 = 10%), 0-50%
--   * commission_bp    agent commission in basis points, 0-50%; required
--                      before the code can be enabled
--   * applies_to_sale_items  whether the discount (and so commission) applies
--                      to products already on sale; must be chosen explicitly
--                      (null until then) before the code can be enabled
--   * code_enabled     whether checkout accepts the code for new orders
--   * access_status    pending (no Auth user linked yet), active, suspended
--                      (can't use /agent; earnings and history are kept)
--
-- Access: RLS on, no table privileges for any API role. Admins (member +
-- aal2) use the admin_* functions below; agents use the agent_* functions in
-- 20261118120200_commission_accounting.sql, which return only their own data.
--
-- Locking: an agent row is locked FOR NO KEY UPDATE by admin changes, FOR
-- SHARE by order placement (its terms can't change mid-order) and FOR NO KEY
-- UPDATE by payouts. Nothing locks an agent row while holding an order lock.
--
-- Retries (every admin change carries a request id made by the form):
--   * The request's identity is its operation and its full, normalised
--     payload (and, for edits, the version the admin saw), kept as a SHA-256
--     fingerprint on the record it created: sales_agents.created_request_fingerprint
--     for a creation, sales_agent_events.request_fingerprint for an edit.
--   * The same request id with the same identity is a replay: nothing is
--     applied again, and the answer is the ORIGINAL result (for an edit, the
--     version that edit produced, never a newer one made by someone else).
--   * The same request id with anything different (another payload, another
--     action) is refused: PT409, hint request_mismatch.
--   * Creation is serialised per request id and per email (transaction
--     advisory locks taken before anything is read), so two identical
--     requests sent at once get the same agent, and two different requests
--     for the same email or code still conflict.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.sales_agents (
  id uuid primary key default gen_random_uuid(),
  -- Restrict: an Auth user who is (or was) an agent can't be deleted; suspend
  -- the agent instead, so earnings and payout history keep their owner.
  user_id uuid references auth.users (id) on delete restrict,
  username text not null,
  display_name text not null,
  -- The email the account was set up with (lower-case). Used only to find
  -- the Auth user when linking; never shown outside the admin area.
  email text not null,
  code text not null,
  access_status text not null default 'pending',
  code_enabled boolean not null default false,
  discount_bp integer not null,
  commission_bp integer,
  applies_to_sale_items boolean,
  -- +1 whenever discount, commission or sale-item eligibility changes.
  terms_version integer not null default 1,
  -- +1 on every change (optimistic concurrency for admin forms).
  version integer not null default 1,
  created_request_id uuid not null,
  -- SHA-256 of the creation request's normalised payload (its retry identity).
  created_request_fingerprint bytea not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sales_agents_user_key unique (user_id),
  constraint sales_agents_username_key unique (username),
  constraint sales_agents_email_key unique (email),
  constraint sales_agents_code_key unique (code),
  constraint sales_agents_request_key unique (created_request_id),
  constraint sales_agents_username_format check (username ~ '^[a-z0-9][a-z0-9._-]{2,29}$'),
  constraint sales_agents_code_format check (code ~ '^[A-Z0-9]{3,16}$'),
  constraint sales_agents_display_name_valid check (
    char_length(display_name) between 2 and 80 and display_name = btrim(display_name) and display_name !~ '[[:cntrl:]]'),
  constraint sales_agents_email_valid check (
    email = lower(email) and char_length(email) between 3 and 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  constraint sales_agents_access_valid check (access_status in ('pending', 'active', 'suspended')),
  constraint sales_agents_pending_iff_unlinked check ((access_status = 'pending') = (user_id is null)),
  constraint sales_agents_discount_range check (discount_bp between 0 and 5000),
  constraint sales_agents_commission_range check (commission_bp is null or commission_bp between 0 and 5000),
  constraint sales_agents_enabled_needs_terms check (
    not code_enabled or (commission_bp is not null and applies_to_sale_items is not null)),
  constraint sales_agents_versions_positive check (version > 0 and terms_version > 0),
  constraint sales_agents_fingerprint_length check (octet_length(created_request_fingerprint) = 32)
);

comment on table public.sales_agents is
  'Sales agents: login link, referral code (fixed, never reused) and CURRENT terms. Orders keep their own snapshot.';

-- Who changed what, and when. Append-only.
create table public.sales_agent_events (
  id bigint generated always as identity primary key,
  agent_id uuid not null references public.sales_agents (id) on delete restrict,
  kind text not null,
  details jsonb,
  actor_user_id uuid,
  -- An admin edit's request id, its identity (operation and payload, as a
  -- SHA-256) and the agent version it produced: a retry with the same
  -- identity gets that version back; anything else is refused.
  request_id uuid,
  operation text,
  request_fingerprint bytea,
  result_version integer,
  created_at timestamptz not null default now(),

  constraint sales_agent_events_request_key unique (agent_id, request_id),
  constraint sales_agent_events_request_complete check (
    request_id is null or (operation is not null and octet_length(request_fingerprint) = 32 and result_version > 0)),
  constraint sales_agent_events_kind_valid check (kind in (
    'created', 'linked', 'profile_changed', 'terms_changed', 'code_enabled', 'code_disabled',
    'suspended', 'reactivated', 'invite_link_created'))
);

create index sales_agent_events_agent_idx on public.sales_agent_events (agent_id, id);

create trigger sales_agent_events_append_only before update or delete on public.sales_agent_events
  for each row execute function private.append_only();
create trigger sales_agent_events_no_truncate before truncate on public.sales_agent_events
  for each statement execute function private.append_only();

-- Fixed facts of an agent; never deleted.
create function private.sales_agents_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Sales agents are never deleted; suspend them instead.' using errcode = 'PT400', hint = 'append_only';
  end if;
  if (new.id, new.code, new.email, new.created_request_id, new.created_request_fingerprint, new.created_by, new.created_at)
     is distinct from (old.id, old.code, old.email, old.created_request_id, old.created_request_fingerprint, old.created_by, old.created_at) then
    raise exception 'An agent''s referral code, email and creation record never change.' using errcode = 'PT400', hint = 'agent_locked';
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    raise exception 'An agent''s login can''t be moved to another account.' using errcode = 'PT400', hint = 'agent_locked';
  end if;
  if (new.discount_bp, new.commission_bp, new.applies_to_sale_items)
     is distinct from (old.discount_bp, old.commission_bp, old.applies_to_sale_items) then
    new.terms_version := old.terms_version + 1;
  else
    new.terms_version := old.terms_version;
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

create trigger sales_agents_guard before update or delete on public.sales_agents
  for each row execute function private.sales_agents_guard();
create trigger sales_agents_no_truncate before truncate on public.sales_agents
  for each statement execute function private.append_only();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The one normalisation rule for referral codes (also lib/agents/code.ts):
-- remove whitespace and hyphens, then upper-case. Doesn't validate.
create function private.normalize_referral_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(coalesce(p_code, ''), '[[:space:]-]+', '', 'g')), '');
$$;

create function private.is_referral_code(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_code ~ '^[A-Z0-9]{3,16}$', false);
$$;

-- Admin-facing view of an agent (never returned to agents or shoppers).
create function private.agent_admin_view(p_agent_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'user_id', a.user_id, 'username', a.username, 'display_name', a.display_name, 'email', a.email,
    'code', a.code, 'access_status', a.access_status, 'code_enabled', a.code_enabled,
    'discount_bp', a.discount_bp, 'commission_bp', a.commission_bp, 'applies_to_sale_items', a.applies_to_sale_items,
    'terms_version', a.terms_version, 'version', a.version, 'created_at', a.created_at, 'updated_at', a.updated_at)
  from public.sales_agents a where a.id = p_agent_id;
$$;

-- Validated terms from a request: {discount_bp, commission_bp, applies_to_sale_items}.
create function private.agent_terms_input(p_terms jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  discount text := p_terms ->> 'discount_bp';
  commission text := p_terms ->> 'commission_bp';
begin
  if jsonb_typeof(p_terms) is distinct from 'object'
    or discount is null or discount !~ '^[0-9]{1,5}$' or discount::integer > 5000
    or (commission is not null and (commission !~ '^[0-9]{1,5}$' or commission::integer > 5000))
    or (p_terms ? 'applies_to_sale_items' and jsonb_typeof(p_terms -> 'applies_to_sale_items') not in ('boolean', 'null')) then
    raise exception 'Discount and commission are percentages from 0 to 50.' using errcode = 'PT400', hint = 'invalid_terms';
  end if;
  return jsonb_build_object(
    'discount_bp', discount::integer,
    'commission_bp', commission::integer,
    'applies_to_sale_items', case when jsonb_typeof(p_terms -> 'applies_to_sale_items') = 'boolean'
                                  then (p_terms ->> 'applies_to_sale_items')::boolean end);
end;
$$;

-- The identity of an admin request: operation, target, the version the admin
-- saw (edits) and the normalised payload.
create function private.agent_request_fingerprint(p_operation text, p_agent_id uuid, p_expected_version integer, p_payload jsonb)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select sha256(convert_to(jsonb_build_object('operation', p_operation, 'agent', p_agent_id,
    'expected_version', p_expected_version, 'payload', p_payload)::text, 'UTF8'));
$$;

-- Locks an agent for an admin edit and checks the request:
--   * null: this request was already applied with the same identity (a
--     retry); the caller answers with private.agent_replay();
--   * the same request id with a different identity: refused (request_mismatch);
--   * otherwise the version the admin saw must be the current one.
create function private.agent_admin_lock(
  p_agent_id uuid, p_expected_version integer, p_request_id uuid, p_operation text, p_payload jsonb
)
returns public.sales_agents
language plpgsql
security definer
set search_path = ''
as $$
declare
  agent public.sales_agents;
  earlier public.sales_agent_events;
begin
  perform public.admin_require_catalogue_admin();
  if p_agent_id is null or p_request_id is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  -- The lock first: the same request still running elsewhere holds it.
  select * into agent from public.sales_agents where id = p_agent_id for no key update;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
  select * into earlier from public.sales_agent_events e where e.agent_id = p_agent_id and e.request_id = p_request_id;
  if found then
    if earlier.request_fingerprint = private.agent_request_fingerprint(p_operation, p_agent_id, p_expected_version, p_payload) then
      return null;
    end if;
    raise exception 'This form was already used for a different change. Reload the page.'
      using errcode = 'PT409', hint = 'request_mismatch';
  end if;
  if p_expected_version is distinct from agent.version then
    raise exception 'This agent was changed somewhere else since you opened it.' using errcode = 'PT409', hint = 'version_conflict';
  end if;
  return agent;
end;
$$;

-- A retry's answer: the version the original request produced (not the
-- current one, which someone else may have changed since).
create function private.agent_replay(p_agent_id uuid, p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('result', 'replayed', 'id', e.agent_id, 'version', e.result_version)
  from public.sales_agent_events e where e.agent_id = p_agent_id and e.request_id = p_request_id;
$$;

-- Records an applied edit (with its identity and resulting version) and answers.
create function private.agent_edit_done(
  p_agent_id uuid, p_request_id uuid, p_operation text, p_expected_version integer, p_payload jsonb,
  p_kind text, p_details jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_version integer := (select a.version from public.sales_agents a where a.id = p_agent_id);
begin
  insert into public.sales_agent_events (agent_id, kind, details, actor_user_id, request_id, operation, request_fingerprint, result_version)
  values (p_agent_id, p_kind, p_details, (select auth.uid()), p_request_id, p_operation,
    private.agent_request_fingerprint(p_operation, p_agent_id, p_expected_version, p_payload), new_version);
  return jsonb_build_object('result', 'done', 'id', p_agent_id, 'version', new_version, 'agent', private.agent_admin_view(p_agent_id));
end;
$$;

create function private.agent_result(p_agent_id uuid, p_result text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('result', p_result, 'agent', private.agent_admin_view(p_agent_id));
$$;

-- ---------------------------------------------------------------------------
-- Admin functions (authenticated; each refuses anyone but a verified admin)
-- ---------------------------------------------------------------------------

-- For the creation form: is this code well-formed and still free? Admins only;
-- says nothing about who holds a taken code.
create function public.admin_check_agent_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text := private.normalize_referral_code(p_code);
begin
  perform public.admin_require_catalogue_admin();
  if char_length(coalesce(p_code, '')) > 64 then
    return jsonb_build_object('code', null, 'valid', false, 'available', false);
  end if;
  return jsonb_build_object(
    'code', v_code,
    'valid', private.is_referral_code(v_code),
    'available', private.is_referral_code(v_code) and not exists (select 1 from public.sales_agents a where a.code = v_code));
end;
$$;

-- Creates an agent (no login yet: access_status pending). Safe to retry with
-- the same request id. p_agent: {username, display_name, email, code,
-- discount_bp, commission_bp, applies_to_sale_items, code_enabled}.
-- Results: created | existing (same request id, same payload: the agent it
-- created) | email_exists (another request already created an agent with
-- this email; its id is returned so the admin can open it) | username_taken
-- | code_taken. The same request id with a different payload is refused
-- (PT409, request_mismatch).
create function public.admin_create_agent(p_request_id uuid, p_agent jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_username text := lower(btrim(coalesce(p_agent ->> 'username', '')));
  v_display_name text := regexp_replace(btrim(coalesce(p_agent ->> 'display_name', '')), '\s+', ' ', 'g');
  v_email text := lower(btrim(coalesce(p_agent ->> 'email', '')));
  v_code text := private.normalize_referral_code(p_agent ->> 'code');
  v_terms jsonb := private.agent_terms_input(p_agent);
  v_enabled boolean := coalesce((p_agent ->> 'code_enabled')::boolean, false);
  v_fingerprint bytea;
  existing public.sales_agents;
  new_id uuid;
  v_constraint text;
begin
  perform public.admin_require_catalogue_admin();
  if p_request_id is null or jsonb_typeof(p_agent) is distinct from 'object' then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'Usernames are 3-30 lower-case letters, digits, dots, hyphens or underscores.'
      using errcode = 'PT400', hint = 'invalid_username';
  end if;
  if char_length(v_display_name) not between 2 and 80 or v_display_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a display name (2-80 characters).' using errcode = 'PT400', hint = 'invalid_display_name';
  end if;
  if char_length(v_email) not between 3 and 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Enter a valid email address.' using errcode = 'PT400', hint = 'invalid_email';
  end if;
  if not private.is_referral_code(v_code) then
    raise exception 'Codes are 3-16 letters and digits.' using errcode = 'PT400', hint = 'invalid_code';
  end if;
  if v_enabled and ((v_terms ->> 'commission_bp') is null or (v_terms ->> 'applies_to_sale_items') is null) then
    raise exception 'Set the commission and choose whether sale items qualify before enabling the code.'
      using errcode = 'PT400', hint = 'terms_required';
  end if;
  -- The request's identity: everything it asked for, normalised.
  v_fingerprint := private.agent_request_fingerprint('create', null, null, jsonb_build_object(
    'username', v_username, 'display_name', v_display_name, 'email', v_email, 'code', v_code,
    'discount_bp', (v_terms ->> 'discount_bp')::integer, 'commission_bp', (v_terms ->> 'commission_bp')::integer,
    'applies_to_sale_items', (v_terms ->> 'applies_to_sale_items')::boolean, 'code_enabled', v_enabled));

  -- Serialise: one creation per request id at a time, then per email, BEFORE
  -- reading anything. A copy of this request still running elsewhere is
  -- waited for, so its agent is found below (and never reported as
  -- "email_exists"); another request for the same email waits too and then
  -- sees the email taken.
  perform pg_advisory_xact_lock(hashtextextended('sales_agent_request:' || p_request_id::text, 20261118));
  perform pg_advisory_xact_lock(hashtextextended('sales_agent_email:' || v_email, 20261118));

  select * into existing from public.sales_agents a where a.created_request_id = p_request_id;
  if found then
    if existing.created_request_fingerprint = v_fingerprint then
      return private.agent_result(existing.id, 'existing');
    end if;
    raise exception 'This form was already used for a different agent. Reload the page.'
      using errcode = 'PT409', hint = 'request_mismatch';
  end if;
  select * into existing from public.sales_agents a where a.email = v_email;
  if found then
    return jsonb_build_object('result', 'email_exists', 'agent_id', existing.id);
  end if;

  begin
    insert into public.sales_agents (username, display_name, email, code, code_enabled, discount_bp, commission_bp,
      applies_to_sale_items, created_request_id, created_request_fingerprint, created_by)
    values (v_username, v_display_name, v_email, v_code, v_enabled, (v_terms ->> 'discount_bp')::integer,
      (v_terms ->> 'commission_bp')::integer, (v_terms ->> 'applies_to_sale_items')::boolean, p_request_id, v_fingerprint,
      (select auth.uid()))
    returning id into new_id;
  exception when unique_violation then
    -- Another request (not this one: that is serialised above) took the code or username.
    get stacked diagnostics v_constraint = constraint_name;
    return jsonb_build_object('result', case v_constraint
      when 'sales_agents_code_key' then 'code_taken'
      when 'sales_agents_username_key' then 'username_taken'
      else 'email_exists' end);
  end;

  insert into public.sales_agent_events (agent_id, kind, details, actor_user_id, request_id, operation, request_fingerprint, result_version)
  values (new_id, 'created', private.agent_admin_view(new_id) - 'user_id', (select auth.uid()), p_request_id, 'create', v_fingerprint, 1);
  return private.agent_result(new_id, 'created');
end;
$$;

-- Links the agent to the Auth user with the agent's email (created by the
-- website's invitation step with the Auth admin API). Safe to repeat.
-- Results: linked | already_linked | no_auth_user (no Auth user with that
-- email yet) | is_admin (admins can't also be agents) | linked_elsewhere.
create function public.admin_link_agent_user(p_agent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  agent public.sales_agents;
  found_user uuid;
  user_count integer;
begin
  perform public.admin_require_catalogue_admin();
  select * into agent from public.sales_agents where id = p_agent_id for no key update;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
  if agent.user_id is not null then
    return private.agent_result(agent.id, 'already_linked');
  end if;
  select count(*), min(u.id::text)::uuid into user_count, found_user from auth.users u where lower(u.email) = agent.email;
  if user_count = 0 then
    return jsonb_build_object('result', 'no_auth_user');
  end if;
  if user_count > 1 then
    raise exception 'More than one login has this email.' using errcode = 'PT409', hint = 'ambiguous_user';
  end if;
  if exists (select 1 from public.admin_members m where m.user_id = found_user) then
    return jsonb_build_object('result', 'is_admin');
  end if;
  if exists (select 1 from public.sales_agents a where a.user_id = found_user) then
    return jsonb_build_object('result', 'linked_elsewhere');
  end if;
  update public.sales_agents set user_id = found_user, access_status = 'active' where id = agent.id;
  insert into public.sales_agent_events (agent_id, kind, actor_user_id)
  values (agent.id, 'linked', (select auth.uid()));
  return private.agent_result(agent.id, 'linked');
end;
$$;

-- Records that an admin created a password-setup link (the link itself is
-- never stored). For the audit trail only.
create function public.admin_note_agent_invite(p_agent_id uuid, p_request_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.admin_require_catalogue_admin();
  if p_request_id is null or p_kind not in ('invite', 'recovery') then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  perform 1 from public.sales_agents where id = p_agent_id;
  if not found then
    raise exception 'Agent not found.' using errcode = 'PT404';
  end if;
  -- Audit only (each link made is noted); the request id is kept in the details.
  insert into public.sales_agent_events (agent_id, kind, details, actor_user_id)
  values (p_agent_id, 'invite_link_created', jsonb_build_object('type', p_kind, 'request_id', p_request_id), (select auth.uid()));
  return private.agent_result(p_agent_id, 'done');
end;
$$;

-- Username and display name. The referral code never changes.
create function public.admin_update_agent_profile(
  p_agent_id uuid, p_expected_version integer, p_request_id uuid, p_username text, p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_display_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_payload jsonb := jsonb_build_object('username', v_username, 'display_name', v_display_name);
  agent public.sales_agents := private.agent_admin_lock(p_agent_id, p_expected_version, p_request_id, 'profile', v_payload);
begin
  if agent is null then
    return private.agent_replay(p_agent_id, p_request_id);
  end if;
  if v_username !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
    raise exception 'Usernames are 3-30 lower-case letters, digits, dots, hyphens or underscores.'
      using errcode = 'PT400', hint = 'invalid_username';
  end if;
  if char_length(v_display_name) not between 2 and 80 or v_display_name ~ '[[:cntrl:]]' then
    raise exception 'Enter a display name (2-80 characters).' using errcode = 'PT400', hint = 'invalid_display_name';
  end if;
  begin
    update public.sales_agents set username = v_username, display_name = v_display_name where id = agent.id;
  exception when unique_violation then
    return jsonb_build_object('result', 'username_taken');
  end;
  return private.agent_edit_done(agent.id, p_request_id, 'profile', p_expected_version, v_payload, 'profile_changed',
    jsonb_build_object('from', jsonb_build_object('username', agent.username, 'display_name', agent.display_name), 'to', v_payload));
end;
$$;

-- Discount, commission and sale-item eligibility, for orders placed from now
-- on. Orders already placed keep the terms they were placed with.
create function public.admin_update_agent_terms(p_agent_id uuid, p_expected_version integer, p_request_id uuid, p_terms jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_terms jsonb := private.agent_terms_input(p_terms);
  agent public.sales_agents := private.agent_admin_lock(p_agent_id, p_expected_version, p_request_id, 'terms', v_terms);
begin
  if agent is null then
    return private.agent_replay(p_agent_id, p_request_id);
  end if;
  if agent.code_enabled and ((v_terms ->> 'commission_bp') is null or (v_terms ->> 'applies_to_sale_items') is null) then
    raise exception 'An enabled code needs a commission and a sale-item choice.' using errcode = 'PT400', hint = 'terms_required';
  end if;
  update public.sales_agents set discount_bp = (v_terms ->> 'discount_bp')::integer,
    commission_bp = (v_terms ->> 'commission_bp')::integer,
    applies_to_sale_items = (v_terms ->> 'applies_to_sale_items')::boolean
  where id = agent.id;
  return private.agent_edit_done(agent.id, p_request_id, 'terms', p_expected_version, v_terms, 'terms_changed',
    jsonb_build_object('from', jsonb_build_object('discount_bp', agent.discount_bp, 'commission_bp', agent.commission_bp,
                         'applies_to_sale_items', agent.applies_to_sale_items, 'terms_version', agent.terms_version),
                       'to', v_terms));
end;
$$;

-- Whether checkout accepts the code for new orders.
create function public.admin_set_agent_code_enabled(p_agent_id uuid, p_expected_version integer, p_request_id uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  agent public.sales_agents := private.agent_admin_lock(p_agent_id, p_expected_version, p_request_id, 'code',
    jsonb_build_object('enabled', p_enabled));
begin
  if agent is null then
    return private.agent_replay(p_agent_id, p_request_id);
  end if;
  if p_enabled is null then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  if p_enabled and (agent.commission_bp is null or agent.applies_to_sale_items is null) then
    raise exception 'Set the commission and choose whether sale items qualify before enabling the code.'
      using errcode = 'PT400', hint = 'terms_required';
  end if;
  update public.sales_agents set code_enabled = p_enabled where id = agent.id;
  return private.agent_edit_done(agent.id, p_request_id, 'code', p_expected_version, jsonb_build_object('enabled', p_enabled),
    case when p_enabled then 'code_enabled' else 'code_disabled' end, null);
end;
$$;

-- Suspends or restores the agent's access to /agent. Earnings, payouts and
-- the code's status are unaffected (disable the code separately).
create function public.admin_set_agent_access(p_agent_id uuid, p_expected_version integer, p_request_id uuid, p_access text)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  agent public.sales_agents := private.agent_admin_lock(p_agent_id, p_expected_version, p_request_id, 'access',
    jsonb_build_object('access', p_access));
begin
  if agent is null then
    return private.agent_replay(p_agent_id, p_request_id);
  end if;
  if p_access is null or p_access not in ('active', 'suspended') then
    raise exception 'Malformed request.' using errcode = 'PT400';
  end if;
  if agent.user_id is null then
    raise exception 'This agent hasn''t got a login yet.' using errcode = 'PT409', hint = 'not_linked';
  end if;
  update public.sales_agents set access_status = p_access where id = agent.id;
  return private.agent_edit_done(agent.id, p_request_id, 'access', p_expected_version, jsonb_build_object('access', p_access),
    case when p_access = 'active' then 'reactivated' else 'suspended' end, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- The signed-in agent
-- ---------------------------------------------------------------------------

-- The caller's agent row, only while active. Everything an agent may call
-- starts here.
create function private.require_active_agent()
returns public.sales_agents
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  agent public.sales_agents;
begin
  select * into agent from public.sales_agents a
  where a.user_id = (select auth.uid()) and a.access_status = 'active';
  if not found then
    raise exception 'Only active sales agents can see this.' using errcode = '42501';
  end if;
  return agent;
end;
$$;

-- For the /agent area's access check: what this login is. Never raises for
-- a signed-in user; returns no data unless the agent is active.
create function public.agent_session()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null then jsonb_build_object('status', 'signed_out')
    else coalesce((
      select case a.access_status
        when 'active' then jsonb_build_object('status', 'active', 'display_name', a.display_name, 'username', a.username)
        else jsonb_build_object('status', 'suspended') end
      from public.sales_agents a where a.user_id = (select auth.uid())
    ), jsonb_build_object('status', 'not_agent'))
  end;
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

alter table public.sales_agents enable row level security;
alter table public.sales_agent_events enable row level security;
-- No policies and no privileges: reads and writes go through the functions.
revoke all on table public.sales_agents, public.sales_agent_events from public, anon, authenticated;

revoke execute on function
  private.sales_agents_guard(),
  private.normalize_referral_code(text),
  private.is_referral_code(text),
  private.agent_admin_view(uuid),
  private.agent_terms_input(jsonb),
  private.agent_request_fingerprint(text, uuid, integer, jsonb),
  private.agent_admin_lock(uuid, integer, uuid, text, jsonb),
  private.agent_replay(uuid, uuid),
  private.agent_edit_done(uuid, uuid, text, integer, jsonb, text, jsonb),
  private.agent_result(uuid, text),
  private.require_active_agent()
  from public, anon, authenticated;

revoke execute on function
  public.admin_check_agent_code(text),
  public.admin_create_agent(uuid, jsonb),
  public.admin_link_agent_user(uuid),
  public.admin_note_agent_invite(uuid, uuid, text),
  public.admin_update_agent_profile(uuid, integer, uuid, text, text),
  public.admin_update_agent_terms(uuid, integer, uuid, jsonb),
  public.admin_set_agent_code_enabled(uuid, integer, uuid, boolean),
  public.admin_set_agent_access(uuid, integer, uuid, text),
  public.agent_session()
  from public, anon;
grant execute on function
  public.admin_check_agent_code(text),
  public.admin_create_agent(uuid, jsonb),
  public.admin_link_agent_user(uuid),
  public.admin_note_agent_invite(uuid, uuid, text),
  public.admin_update_agent_profile(uuid, integer, uuid, text, text),
  public.admin_update_agent_terms(uuid, integer, uuid, jsonb),
  public.admin_set_agent_code_enabled(uuid, integer, uuid, boolean),
  public.admin_set_agent_access(uuid, integer, uuid, text),
  public.agent_session()
  to authenticated;
