-- ==============================================================================
-- H2 FINAL SECURITY MIGRATION: Authoritative Orders, Business Memberships,
-- Refund Eligibility Integrity, & DB-Level Owner/Tenant Scope Enforcement
-- Additive & Idempotent. Do not apply automatically without review/approval.
--
-- Addresses remaining H2 audit gaps:
--   1. Adds tenant_id to public.businesses (without modifying UUID primary keys)
--      and safely backfills tenant_id from owner_id::text where owner_id IS NOT NULL.
--   2. Establishes public.business_memberships for non-owner staff & separated
--      tenant_id != owner_id authorization without trusting client claims.
--   3. Establishes/upgrades authoritative public.orders with integer amount_cents,
--      currency, payment_status, status, refunded_amount_cents, external_refunded,
--      audit/refund columns, business-scoped (business_id, order_number) uniqueness,
--      and locked-down RLS (no client self-approval/mutation of payment/refund state).
--      NEVER auto-marks existing legacy rows as paid without payment evidence.
--   4. Hardens 15-arg reserve_refund_execution to verify owner_id & tenant_id
--      consistency against existing refund_authorizations & owner_approvals inside SQL.
--   5. Adds service_role-only SECURITY DEFINER RPC record_authoritative_order_refund.
-- ==============================================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. BUSINESSES: Add tenant_id while preserving existing UUID primary keys
-- ------------------------------------------------------------------------------
alter table public.businesses
  add column if not exists tenant_id text;

update public.businesses
set tenant_id = owner_id::text
where tenant_id is null
  and owner_id is not null;

create index if not exists idx_businesses_tenant_owner_status
  on public.businesses (tenant_id, owner_id, status);

-- Backfill authenticated_refund_requests.tenant_id safely if still null
update public.authenticated_refund_requests
set tenant_id = owner_id::text
where tenant_id is null
  and owner_id is not null;

-- ------------------------------------------------------------------------------
-- 2. BUSINESS MEMBERSHIPS: Authoritative tenant & business RBAC mapping
-- ------------------------------------------------------------------------------
create table if not exists public.business_memberships (
  id uuid primary key default uuid_generate_v4(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  tenant_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'finance_operator', 'support_operator')),
  status text not null default 'active' check (status in ('active', 'suspended', 'revoked')),
  invited_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create unique index if not exists uq_business_memberships_biz_user
  on public.business_memberships (business_id, user_id);

create index if not exists idx_business_memberships_user_status
  on public.business_memberships (user_id, status);

create index if not exists idx_business_memberships_tenant_biz_status
  on public.business_memberships (tenant_id, business_id, status);

alter table public.business_memberships enable row level security;

-- Read-only client policies: users see their own memberships; business owners see
-- memberships on businesses they own. Zero client INSERT/UPDATE/DELETE policies
-- prevent client-side privilege escalation.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'business_memberships'
      and policyname = 'Members can read own business memberships'
  ) then
    create policy "Members can read own business memberships"
      on public.business_memberships for select
      to authenticated
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'business_memberships'
      and policyname = 'Business owners can view business memberships'
  ) then
    create policy "Business owners can view business memberships"
      on public.business_memberships for select
      to authenticated
      using (
        exists (
          select 1
          from public.businesses b
          where b.id = business_memberships.business_id
            and b.owner_id = auth.uid()
        )
      );
  end if;
end $$;

-- Seed missing owner membership rows strictly from verified public.businesses.owner_id
insert into public.business_memberships (business_id, tenant_id, user_id, role, status)
select
  b.id,
  coalesce(nullif(btrim(b.tenant_id), ''), b.owner_id::text),
  b.owner_id,
  'owner',
  case when b.status = 'active' then 'active' else 'suspended' end
from public.businesses b
where b.owner_id is not null
on conflict (business_id, user_id) do nothing;

-- ------------------------------------------------------------------------------
-- 3. AUTHORITATIVE ORDERS TABLE: Create or upgrade idempotently
-- ------------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete restrict,
  tenant_id text,
  business_id uuid not null references public.businesses(id) on delete restrict,
  order_number text not null,
  customer_id uuid,
  product_id uuid,
  amount numeric(12, 2),
  amount_cents integer check (amount_cents is null or amount_cents > 0),
  currency text not null default 'USD',
  payment_status text not null default 'unpaid',
  status text not null default 'pending',
  refunded_amount_cents integer not null default 0 check (refunded_amount_cents >= 0),
  external_refunded boolean not null default false,
  payment_provider text,
  payment_intent_id text,
  payment_method text default 'stripe',
  paid_at timestamptz,
  refund_tx_id text,
  refund_reservation_id uuid,
  refunded_at timestamptz,
  refund_reason text,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

-- Upgrade path if public.orders already existed from client template
alter table public.orders
  add column if not exists owner_id uuid references auth.users(id) on delete restrict,
  add column if not exists tenant_id text,
  add column if not exists amount_cents integer,
  add column if not exists currency text not null default 'USD',
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists refunded_amount_cents integer not null default 0,
  add column if not exists external_refunded boolean not null default false,
  add column if not exists payment_provider text,
  add column if not exists payment_intent_id text,
  add column if not exists payment_method text default 'stripe',
  add column if not exists paid_at timestamptz,
  add column if not exists refund_tx_id text,
  add column if not exists refund_reservation_id uuid,
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_reason text,
  add column if not exists updated_at timestamptz not null default timezone('utc'::text, now());

-- Drop any legacy global order_number unique constraint & replace with business-scoped uniqueness
do $$
declare
  v_conname text;
begin
  for v_conname in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'orders'
      and c.contype = 'u'
      and array_length(c.conkey, 1) = 1
      and exists (
        select 1
        from pg_attribute a
        where a.attrelid = t.oid
          and a.attnum = c.conkey[1]
          and a.attname = 'order_number'
      )
  loop
    execute format('alter table public.orders drop constraint if exists %I', v_conname);
  end loop;
end $$;

drop index if exists public.orders_order_number_key;
create unique index if not exists uq_orders_business_order_number
  on public.orders (business_id, order_number);

create index if not exists idx_orders_scope_payment_status
  on public.orders (business_id, tenant_id, owner_id, payment_status, status);

-- Ensure payment_status, status, and refunded_amount_cents constraints exist cleanly
do $$
declare
  v_conname text;
begin
  for v_conname in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'orders'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%completed%'
  loop
    execute format('alter table public.orders drop constraint if exists %I', v_conname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_status_check' and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_status_check
      check (status in ('pending', 'processing', 'completed', 'refunded', 'disputed', 'cancelled'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'orders_payment_status_check' and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_payment_status_check
      check (
        payment_status in (
          'unpaid',
          'pending',
          'authorized',
          'paid',
          'settled',
          'partially_refunded',
          'refunded',
          'failed',
          'disputed',
          'cancelled'
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'orders_amount_cents_positive_check' and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_amount_cents_positive_check
      check (amount_cents is null or amount_cents > 0);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'orders_refunded_amount_bounds_check' and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders
      add constraint orders_refunded_amount_bounds_check
      check (
        refunded_amount_cents >= 0
        and (amount_cents is null or refunded_amount_cents <= amount_cents)
      );
  end if;
end $$;

-- Conservative non-assuming backfill for pre-existing rows:
--   * Backfill amount_cents only when numeric amount > 0.
--   * Backfill tenant_id/owner_id only from linked public.businesses when missing.
--   * Preserve refunded/disputed/cancelled terminal protections so pre-existing
--     refunded/disputed/cancelled rows remain blocked.
--   * NEVER invent payment_status='paid' from fulfillment status='completed'; legacy
--     completed rows remain payment_status='unpaid' (ineligible for refund) until
--     verified manually against payment-provider settlement logs.
update public.orders o
set
  amount_cents = case
    when o.amount_cents is null and o.amount is not null and round(o.amount * 100)::integer > 0
      then round(o.amount * 100)::integer
    else o.amount_cents
  end,
  owner_id = coalesce(o.owner_id, b.owner_id),
  tenant_id = coalesce(nullif(btrim(o.tenant_id), ''), nullif(btrim(b.tenant_id), ''), b.owner_id::text),
  currency = coalesce(nullif(btrim(upper(o.currency)), ''), 'USD'),
  payment_status = case
    when o.status = 'refunded' then 'refunded'
    when o.status = 'disputed' then 'disputed'
    when o.status = 'cancelled' then 'cancelled'
    else o.payment_status
  end,
  refunded_amount_cents = case
    when o.status = 'refunded' and o.refunded_amount_cents = 0
      then coalesce(o.amount_cents, greatest(0, coalesce(round(o.amount * 100)::integer, 0)))
    else o.refunded_amount_cents
  end,
  updated_at = timezone('utc'::text, now())
from public.businesses b
where o.business_id = b.id
  and (
    o.amount_cents is null
    or o.owner_id is null
    or nullif(btrim(o.tenant_id), '') is null
    or (o.status in ('refunded', 'disputed', 'cancelled') and o.payment_status = 'unpaid')
  );

-- MANUAL VERIFIED BACKFILL PROCEDURE (RUN ONLY AFTER PAYMENT-PROVIDER AUDIT):
-- Do NOT blindly mark existing orders 'paid'. Operators must join against verified
-- payment gateway settlement exports (payment_provider, payment_intent_id, paid_at)
-- before marking historical rows refundable:
--   update public.orders o
--   set payment_status = 'paid',
--       payment_provider = s.provider,
--       payment_intent_id = s.payment_intent_id,
--       paid_at = s.settled_at,
--       updated_at = timezone('utc'::text, now())
--   from staging_verified_settlements s
--   where o.business_id = s.business_id
--     and o.order_number = s.order_number
--     and o.amount_cents = s.settled_amount_cents
--     and upper(o.currency) = upper(s.currency)
--     and o.payment_status = 'unpaid'
--     and o.status not in ('refunded', 'disputed', 'cancelled')
--     and s.refunded = false;

alter table public.orders enable row level security;

-- Drop permissive client write policy ("for all") on public.orders so clients cannot
-- forge payment_status='paid' or clear refunded_amount_cents directly from browser.
drop policy if exists "Owners view and manage their orders" on public.orders;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'orders'
      and policyname = 'Authorized business owners and active members view orders'
  ) then
    create policy "Authorized business owners and active members view orders"
      on public.orders for select
      to authenticated
      using (
        auth.uid() = owner_id
        or exists (
          select 1
          from public.business_memberships m
          join public.businesses b on b.id = m.business_id
          where m.business_id = orders.business_id
            and m.user_id = auth.uid()
            and m.status = 'active'
            and b.status = 'active'
            and (orders.tenant_id is null or m.tenant_id = orders.tenant_id)
        )
      );
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 4. HARDEN 15-ARG reserve_refund_execution WITH DB-LEVEL OWNER/TENANT CHECKS
-- ------------------------------------------------------------------------------
create or replace function public.reserve_refund_execution(
  p_owner_id uuid,
  p_request_id uuid,
  p_nonce text,
  p_order_id text,
  p_business_id text,
  p_approval_id text,
  p_amount_cents integer,
  p_idempotency_key text,
  p_canonical_digest text,
  p_key_id text,
  p_expires_at timestamptz,
  p_require_owner_approval boolean default false,
  p_provider_name text default null,
  p_lease_seconds integer default 60,
  p_tenant_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_existing public.refund_authorizations%rowtype;
  v_auth_req record;
  v_approval public.owner_approvals%rowtype;
  v_conflict record;
  v_new_id uuid;
  v_provider_idem text;
  v_now timestamptz := timezone('utc'::text, now());
  v_lease_expires timestamptz := v_now + make_interval(secs => greatest(1, coalesce(p_lease_seconds, 60)));
  v_next_attempt integer;
  v_effective_tenant text := coalesce(nullif(btrim(p_tenant_id), ''), p_owner_id::text);
begin
  if nullif(btrim(p_business_id), '') is null or nullif(btrim(p_order_id), '') is null then
    return jsonb_build_object(
      'status', 'REPLAY_CONFLICT',
      'reason', 'business_id and order_id must be non-empty.'
    );
  end if;

  if p_owner_id is null and v_effective_tenant is null then
    return jsonb_build_object(
      'status', 'REPLAY_CONFLICT',
      'reason', 'Authoritative owner_id or tenant_id scope is required (fail-closed).'
    );
  end if;

  perform pg_advisory_xact_lock(hashtext(p_request_id::text));
  perform pg_advisory_xact_lock(hashtext('order:' || p_business_id || ':' || p_order_id));
  if p_approval_id is not null then
    perform pg_advisory_xact_lock(hashtext('approval:' || p_approval_id));
  end if;

  -- 0. Verify against persisted authenticated_refund_requests scope if recorded
  select owner_id, tenant_id, business_id, order_id
  into v_auth_req
  from public.authenticated_refund_requests
  where request_id = p_request_id
  limit 1;

  if found then
    if v_auth_req.business_id <> p_business_id
       or v_auth_req.order_id <> p_order_id
       or (v_auth_req.owner_id is null and nullif(btrim(v_auth_req.tenant_id), '') is null)
       or v_auth_req.owner_id is distinct from p_owner_id
       or nullif(btrim(v_auth_req.tenant_id), '') is distinct from v_effective_tenant then
      return jsonb_build_object(
        'status', 'REPLAY_CONFLICT',
        'reason', 'Persisted request owner or tenant scope does not match execution caller scope.'
      );
    end if;
  end if;

  -- 1. Check same request_id
  select * into v_existing
  from public.refund_authorizations
  where request_id = p_request_id
  for update;

  if found then
    if v_existing.order_id <> p_order_id
       or v_existing.business_id <> p_business_id
       or v_existing.nonce <> p_nonce
       or v_existing.amount_cents <> p_amount_cents
       or v_existing.canonical_digest <> p_canonical_digest
       or coalesce(v_existing.approval_id, '') <> coalesce(p_approval_id, '') then
      return jsonb_build_object(
        'status', 'REPLAY_CONFLICT',
        'reason', 'request_id already bound to different order, business, nonce, approval, or amount.'
      );
    end if;

    -- DB-layer owner_id & tenant_id scope verification on existing reservation
    if (v_existing.owner_id is null and nullif(btrim(v_existing.tenant_id), '') is null)
       or (v_existing.owner_id is not null and p_owner_id is not null and v_existing.owner_id <> p_owner_id)
       or (v_existing.owner_id is not null and p_owner_id is null)
       or (v_existing.owner_id is null and p_owner_id is not null)
       or (nullif(btrim(v_existing.tenant_id), '') is distinct from v_effective_tenant) then
      return jsonb_build_object(
        'status', 'REPLAY_CONFLICT',
        'reason', 'request_id already bound to different owner or tenant scope.'
      );
    end if;

    if v_existing.status = 'executed' then
      if v_existing.idempotency_key = p_idempotency_key then
        return jsonb_build_object(
          'status', 'IDEMPOTENT_REPLAY',
          'reservation_id', v_existing.id,
          'provider_idempotency_key', v_existing.provider_idempotency_key,
          'execution_tx_id', v_existing.execution_tx_id,
          'consumed_at', v_existing.consumed_at,
          'outcome_payload', coalesce(v_existing.outcome_payload, '{}'::jsonb)
        );
      end if;
      return jsonb_build_object(
        'status', 'REPLAY_ALREADY_CONSUMED',
        'reason', 'Refund authorization already consumed.'
      );
    end if;

    if v_existing.status = 'uncertain_reconciliation_required' then
      return jsonb_build_object(
        'status', 'UNCERTAIN_RECONCILIATION_REQUIRED',
        'reservation_id', v_existing.id,
        'provider_idempotency_key', v_existing.provider_idempotency_key,
        'reason', 'Refund execution is locked pending provider reconciliation.'
      );
    end if;

    if v_existing.status = 'executing' then
      if v_existing.lease_expires_at is not null and v_existing.lease_expires_at < v_now then
        return jsonb_build_object(
          'status', 'STALE_EXECUTION_REQUIRES_RECONCILIATION',
          'reservation_id', v_existing.id,
          'provider_idempotency_key', v_existing.provider_idempotency_key,
          'reason', 'Stale executing reservation lease expired; provider reconciliation required before retry.'
        );
      end if;
      return jsonb_build_object(
        'status', 'CONCURRENT_IN_FLIGHT',
        'reservation_id', v_existing.id,
        'provider_idempotency_key', v_existing.provider_idempotency_key,
        'reason', 'Refund execution already in flight.'
      );
    end if;

    if v_existing.status = 'rejected' or coalesce(v_existing.retry_allowed, true) = false then
      return jsonb_build_object(
        'status', 'RETRY_NOT_PERMITTED',
        'reservation_id', v_existing.id,
        'provider_idempotency_key', v_existing.provider_idempotency_key,
        'reason', 'Refund authorization is not eligible for automatic retry.'
      );
    end if;

    if p_require_owner_approval then
      if p_approval_id is null or btrim(p_approval_id) = '' then
        return jsonb_build_object('status', 'APPROVAL_NOT_FOUND', 'reason', 'Owner approval required.');
      end if;
      select * into v_approval from public.owner_approvals where approval_id = btrim(p_approval_id) for update;
      if not found then
        return jsonb_build_object('status', 'APPROVAL_NOT_FOUND', 'reason', 'Authoritative owner approval not found.');
      end if;
      if v_approval.status = 'consumed' or v_approval.consumed_at is not null then
        return jsonb_build_object('status', 'APPROVAL_ALREADY_CONSUMED', 'reason', 'Owner approval already consumed.');
      end if;
      if v_approval.status <> 'approved' then
        return jsonb_build_object('status', 'APPROVAL_NOT_APPROVED', 'reason', 'Owner approval status is not approved.');
      end if;
      if v_approval.expires_at <= v_now then
        return jsonb_build_object('status', 'APPROVAL_EXPIRED', 'reason', 'Owner approval expired.');
      end if;
      if v_approval.request_id <> p_request_id
         or v_approval.order_id <> p_order_id
         or v_approval.business_id <> p_business_id
         or v_approval.amount_cents <> p_amount_cents
         or btrim(coalesce(v_approval.approved_by_user_id, '')) = ''
         or (v_approval.owner_id is null and nullif(btrim(v_approval.tenant_id), '') is null)
         or v_approval.owner_id is distinct from p_owner_id
         or nullif(btrim(v_approval.tenant_id), '') is distinct from v_effective_tenant then
        return jsonb_build_object('status', 'APPROVAL_BINDING_MISMATCH', 'reason', 'Owner approval binding or owner/tenant scope mismatch.');
      end if;
    end if;

    v_next_attempt := coalesce(v_existing.attempt_count, 1) + 1;

    -- Re-acquire failed row WITHOUT modifying immutable provider_idempotency_key or idempotency_key
    update public.refund_authorizations
    set status = 'executing',
        provider_outcome_status = 'pending',
        provider_name = coalesce(p_provider_name, provider_name),
        attempt_count = v_next_attempt,
        execution_started_at = v_now,
        lease_expires_at = v_lease_expires,
        updated_at = v_now
    where id = v_existing.id
      and status = 'failed'
      and retry_allowed = true;

    if not found then
      return jsonb_build_object(
        'status', 'RETRY_NOT_PERMITTED',
        'reason', 'Reservation could not be re-acquired for retry.'
      );
    end if;

    return jsonb_build_object(
      'status', 'ACQUIRED',
      'reservation_id', v_existing.id,
      'provider_idempotency_key', v_existing.provider_idempotency_key,
      'attempt_count', v_next_attempt,
      'lease_expires_at', v_lease_expires
    );
  end if;

  -- 1b. Authoritative owner approval lock & validation when owner_approved
  if p_require_owner_approval then
    if p_approval_id is null or btrim(p_approval_id) = '' then
      return jsonb_build_object('status', 'APPROVAL_NOT_FOUND', 'reason', 'Owner approval required.');
    end if;
    select * into v_approval from public.owner_approvals where approval_id = btrim(p_approval_id) for update;
    if not found then
      return jsonb_build_object('status', 'APPROVAL_NOT_FOUND', 'reason', 'Authoritative owner approval not found.');
    end if;
    if v_approval.status = 'consumed' or v_approval.consumed_at is not null then
      return jsonb_build_object('status', 'APPROVAL_ALREADY_CONSUMED', 'reason', 'Owner approval already consumed.');
    end if;
    if v_approval.status <> 'approved' then
      return jsonb_build_object('status', 'APPROVAL_NOT_APPROVED', 'reason', 'Owner approval status is not approved.');
    end if;
    if v_approval.expires_at <= v_now then
      return jsonb_build_object('status', 'APPROVAL_EXPIRED', 'reason', 'Owner approval expired.');
    end if;
    if v_approval.request_id <> p_request_id
       or v_approval.order_id <> p_order_id
       or v_approval.business_id <> p_business_id
       or v_approval.amount_cents <> p_amount_cents
       or btrim(coalesce(v_approval.approved_by_user_id, '')) = ''
       or (v_approval.owner_id is null and nullif(btrim(v_approval.tenant_id), '') is null)
       or v_approval.owner_id is distinct from p_owner_id
       or nullif(btrim(v_approval.tenant_id), '') is distinct from v_effective_tenant then
      return jsonb_build_object('status', 'APPROVAL_BINDING_MISMATCH', 'reason', 'Owner approval binding or owner/tenant scope mismatch.');
    end if;
  end if;

  -- 2. Reject reused nonce
  select request_id into v_conflict from public.refund_authorizations where nonce = p_nonce limit 1;
  if found then
    return jsonb_build_object('status', 'NONCE_REUSED', 'reason', 'Nonce already used.');
  end if;

  -- 3. Reject reused approval_id across different request/order
  if p_approval_id is not null then
    select request_id, order_id into v_conflict
    from public.refund_authorizations
    where approval_id = p_approval_id
    limit 1;
    if found then
      return jsonb_build_object(
        'status', 'APPROVAL_ORDER_MISMATCH',
        'reason', 'Approval ID already bound to another request/order.'
      );
    end if;
  end if;

  -- 4. Reject duplicate active, uncertain, or executed refund for same (business_id, order_id)
  select id, request_id, status, lease_expires_at, provider_idempotency_key into v_conflict
  from public.refund_authorizations
  where business_id = p_business_id
    and order_id = p_order_id
    and status in ('executing', 'uncertain_reconciliation_required', 'executed')
  limit 1;
  if found then
    if v_conflict.status = 'uncertain_reconciliation_required' then
      return jsonb_build_object(
        'status', 'UNCERTAIN_RECONCILIATION_REQUIRED',
        'reservation_id', v_conflict.id,
        'provider_idempotency_key', v_conflict.provider_idempotency_key,
        'reason', 'Order already has an uncertain refund requiring reconciliation.'
      );
    end if;
    if v_conflict.status = 'executing' then
      if v_conflict.lease_expires_at is not null and v_conflict.lease_expires_at < v_now then
        return jsonb_build_object(
          'status', 'STALE_EXECUTION_REQUIRES_RECONCILIATION',
          'reservation_id', v_conflict.id,
          'provider_idempotency_key', v_conflict.provider_idempotency_key,
          'reason', 'Order has a stale executing refund reservation requiring reconciliation.'
        );
      end if;
      return jsonb_build_object(
        'status', 'CONCURRENT_IN_FLIGHT',
        'reservation_id', v_conflict.id,
        'provider_idempotency_key', v_conflict.provider_idempotency_key,
        'reason', 'Order already has an active refund in flight.'
      );
    end if;
    return jsonb_build_object(
      'status', 'DUPLICATE_ORDER_REFUND',
      'reason', 'Order already has an executed refund.'
    );
  end if;

  -- 5. Generate server-controlled immutable provider_idempotency_key & insert reservation
  v_provider_idem := 'prov-idem-' || uuid_generate_v4()::text;

  insert into public.refund_authorizations (
    owner_id, tenant_id, request_id, nonce, order_id, business_id, approval_id,
    amount_cents, idempotency_key, provider_idempotency_key,
    provider_name, provider_outcome_status, retry_allowed, attempt_count,
    canonical_digest, key_id, status,
    execution_started_at, lease_expires_at, expires_at
  ) values (
    p_owner_id, v_effective_tenant, p_request_id, p_nonce, p_order_id, p_business_id, p_approval_id,
    p_amount_cents, p_idempotency_key, v_provider_idem,
    p_provider_name, 'pending', true, 1,
    p_canonical_digest, p_key_id, 'executing',
    v_now, v_lease_expires, p_expires_at
  )
  returning id into v_new_id;

  return jsonb_build_object(
    'status', 'ACQUIRED',
    'reservation_id', v_new_id,
    'provider_idempotency_key', v_provider_idem,
    'attempt_count', 1,
    'lease_expires_at', v_lease_expires
  );
end;
$$;

revoke all on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer, text) from public;
revoke execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer, text) to service_role;

-- ------------------------------------------------------------------------------
-- 5. AUTHORITATIVE ORDER REFUND TRACKING RPC (FULL REFUNDS ONLY, service_role ONLY)
-- ------------------------------------------------------------------------------
create or replace function public.record_authoritative_order_refund(
  p_order_uuid uuid,
  p_business_uuid uuid,
  p_refund_amount_cents integer,
  p_refund_tx_id text,
  p_reservation_id uuid,
  p_refunded_at timestamptz default timezone('utc'::text, now())
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_effective_ts timestamptz := coalesce(p_refunded_at, timezone('utc'::text, now()));
begin
  if p_order_uuid is null or p_business_uuid is null then
    return jsonb_build_object('status', 'INVALID_INPUT', 'reason', 'order_uuid and business_uuid are required.');
  end if;

  if p_refund_amount_cents is null or p_refund_amount_cents <= 0 then
    return jsonb_build_object('status', 'INVALID_AMOUNT', 'reason', 'Positive refund amount_cents is required.');
  end if;

  if nullif(btrim(p_refund_tx_id), '') is null then
    return jsonb_build_object('status', 'INVALID_TX_ID', 'reason', 'Provider refund_tx_id is required.');
  end if;

  select * into v_order
  from public.orders
  where id = p_order_uuid
    and business_id = p_business_uuid
  for update;

  if not found then
    return jsonb_build_object('status', 'ORDER_NOT_FOUND', 'reason', 'Authoritative order not found for business.');
  end if;

  if v_order.payment_status = 'refunded'
     and v_order.refund_reservation_id = p_reservation_id
     and v_order.refund_tx_id = p_refund_tx_id then
    return jsonb_build_object('status', 'ALREADY_RECORDED', 'order_id', v_order.id);
  end if;

  if v_order.external_refunded
     or v_order.payment_status in ('refunded', 'partially_refunded', 'disputed', 'cancelled')
     or v_order.status in ('refunded', 'disputed', 'cancelled')
     or coalesce(v_order.refunded_amount_cents, 0) > 0 then
    return jsonb_build_object('status', 'ALREADY_REFUNDED_OR_INELIGIBLE', 'reason', 'Order already refunded or terminal.');
  end if;

  if v_order.payment_status not in ('paid', 'settled') then
    return jsonb_build_object('status', 'ORDER_UNPAID', 'reason', 'Order payment_status is not paid or settled.');
  end if;

  if v_order.amount_cents is null or v_order.amount_cents <> p_refund_amount_cents then
    return jsonb_build_object('status', 'AMOUNT_MISMATCH', 'reason', 'Full refund requires exact match to authoritative amount_cents.');
  end if;

  update public.orders
  set refunded_amount_cents = p_refund_amount_cents,
      payment_status = 'refunded',
      status = 'refunded',
      refund_tx_id = btrim(p_refund_tx_id),
      refund_reservation_id = p_reservation_id,
      refunded_at = v_effective_ts,
      updated_at = v_effective_ts
  where id = v_order.id
    and business_id = p_business_uuid
    and payment_status in ('paid', 'settled')
    and refunded_amount_cents = 0
    and external_refunded = false;

  if not found then
    return jsonb_build_object('status', 'CONFLICT', 'reason', 'Order state changed concurrently during refund update.');
  end if;

  return jsonb_build_object(
    'status', 'UPDATED',
    'order_id', v_order.id,
    'refunded_amount_cents', p_refund_amount_cents,
    'refund_tx_id', btrim(p_refund_tx_id)
  );
end;
$$;

revoke all on function public.record_authoritative_order_refund(uuid, uuid, integer, text, uuid, timestamptz) from public;
revoke execute on function public.record_authoritative_order_refund(uuid, uuid, integer, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.record_authoritative_order_refund(uuid, uuid, integer, text, uuid, timestamptz) to service_role;

-- ------------------------------------------------------------------------------
-- 6. SECURITY ASSERTION: Verify RLS & zero leaked RPC permissions
-- ------------------------------------------------------------------------------
do $$
declare
  v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_has_authenticated boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_leaked text[];
begin
  select array_agg(format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
  into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in ('reserve_refund_execution', 'record_authoritative_order_refund')
    and (
      has_function_privilege('public', p.oid, 'EXECUTE')
      or (v_has_anon and has_function_privilege('anon', p.oid, 'EXECUTE'))
      or (v_has_authenticated and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    );

  if coalesce(array_length(v_leaked, 1), 0) > 0 then
    raise exception 'H2-000008 migration failed; overexposed SECURITY DEFINER RPCs: %', v_leaked;
  end if;
end $$;
