-- ==============================================================================
-- PHASE 2 SECURITY MIGRATION: Authenticated Provenance & Persistent Replay Protection
-- Additive & Idempotent. Preserves all Phase 1 and Business OS tables/policies.
-- ==============================================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. PROVENANCE SIGNING KEY REGISTRY (Metadata & Rotation Status ONLY — NO SECRETS)
-- Raw HMAC secrets live strictly in server environment variables / secret manager.
-- ------------------------------------------------------------------------------
create table if not exists public.provenance_signing_keys (
  key_id text primary key,
  algorithm text not null default 'HMAC-SHA256' check (algorithm in ('HMAC-SHA256')),
  allowed_component text not null,
  status text not null default 'active' check (status in ('active', 'rotated_grace', 'revoked')),
  expires_at timestamptz,
  rotated_from_key_id text references public.provenance_signing_keys(key_id),
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.provenance_signing_keys enable row level security;

-- Authenticated owners may inspect key status metadata for audit; only service_role mutates
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provenance_signing_keys'
      and policyname = 'Authenticated users inspect key metadata'
  ) then
    create policy "Authenticated users inspect key metadata"
      on public.provenance_signing_keys for select
      to authenticated
      using (true);
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 2. IMMUTABLE PROVENANCE LEDGER (Append-only request origin & chain snapshots)
-- ------------------------------------------------------------------------------
create table if not exists public.provenance_ledger (
  request_id uuid primary key,
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  nonce text not null unique,
  bound_order_id text not null,
  source_agent text not null,
  trigger_type text not null,
  trigger_id text not null,
  trigger_raw_hash text not null,
  initial_authority_level text not null check (initial_authority_level in ('recommend_only', 'execute_under_policy', 'owner_approved')),
  current_authority_level text not null check (current_authority_level in ('recommend_only', 'execute_under_policy', 'owner_approved')),
  chain jsonb not null default '[]'::jsonb,
  policy_version text not null,
  key_id text not null,
  ingestion_signature text not null,
  created_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.provenance_ledger enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'provenance_ledger'
      and policyname = 'Owners view their provenance ledger'
  ) then
    create policy "Owners view their provenance ledger"
      on public.provenance_ledger for select
      using (auth.uid() = owner_id);
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 3. REFUND AUTHORIZATIONS & REPLAY PROTECTION LEDGER
-- DB-enforced uniqueness prevents replay, concurrent double-spend, nonce reuse,
-- and cross-order reuse of approvals.
-- ------------------------------------------------------------------------------
create table if not exists public.refund_authorizations (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  request_id uuid not null unique,
  nonce text not null unique,
  order_id text not null,
  business_id text not null,
  approval_id text,
  amount_cents integer not null check (amount_cents > 0),
  idempotency_key text not null unique,
  canonical_digest text not null,
  key_id text not null,
  status text not null default 'executing' check (status in ('executing', 'executed', 'failed', 'rejected')),
  execution_tx_id text,
  outcome_payload jsonb,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

-- An Owner Approval ID may only ever bind to one single request_id + order_id
create unique index if not exists uq_refund_auth_approval_id
  on public.refund_authorizations (approval_id)
  where approval_id is not null;

-- At most one active/executed refund per order_id
create unique index if not exists uq_refund_active_or_executed_order
  on public.refund_authorizations (order_id)
  where status in ('executing', 'executed');

create index if not exists idx_refund_auth_order_created
  on public.refund_authorizations (order_id, created_at desc);

alter table public.refund_authorizations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'refund_authorizations'
      and policyname = 'Owners view their refund authorizations'
  ) then
    create policy "Owners view their refund authorizations"
      on public.refund_authorizations for select
      using (auth.uid() = owner_id);
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 4. ATOMIC RESERVE / FINALIZE FUNCTIONS (Two-Phase Replay & Concurrency Gate)
-- Ensures an approval is NEVER marked consumed before actual execution succeeds.
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
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_existing public.refund_authorizations%rowtype;
  v_conflict record;
  v_new_id uuid;
begin
  -- Serialize same-request / same-order / same-nonce reservations inside transaction
  perform pg_advisory_xact_lock(hashtext(p_request_id::text));
  perform pg_advisory_xact_lock(hashtext('order:' || p_order_id));

  -- 1. Check same request_id
  select * into v_existing
  from public.refund_authorizations
  where request_id = p_request_id
  for update;

  if found then
    if v_existing.order_id <> p_order_id
       or v_existing.nonce <> p_nonce
       or v_existing.amount_cents <> p_amount_cents
       or v_existing.canonical_digest <> p_canonical_digest
       or coalesce(v_existing.approval_id, '') <> coalesce(p_approval_id, '') then
      return jsonb_build_object(
        'status', 'REPLAY_CONFLICT',
        'reason', 'request_id already bound to different order, nonce, approval, or amount.'
      );
    end if;

    if v_existing.status = 'executed' then
      if v_existing.idempotency_key = p_idempotency_key then
        return jsonb_build_object(
          'status', 'IDEMPOTENT_REPLAY',
          'reservation_id', v_existing.id,
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

    if v_existing.status = 'executing' then
      return jsonb_build_object(
        'status', 'CONCURRENT_IN_FLIGHT',
        'reason', 'Refund execution already in flight.'
      );
    end if;

    -- Retry after prior execution provider failure
    update public.refund_authorizations
    set status = 'executing',
        idempotency_key = p_idempotency_key,
        updated_at = timezone('utc'::text, now())
    where id = v_existing.id and status = 'failed';

    return jsonb_build_object('status', 'ACQUIRED', 'reservation_id', v_existing.id);
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

  -- 4. Reject duplicate active/executed refund for same order
  select request_id, status into v_conflict
  from public.refund_authorizations
  where order_id = p_order_id and status in ('executing', 'executed')
  limit 1;
  if found then
    return jsonb_build_object(
      'status', case when v_conflict.status = 'executing' then 'CONCURRENT_IN_FLIGHT' else 'DUPLICATE_ORDER_REFUND' end,
      'reason', 'Order already has an active or executed refund.'
    );
  end if;

  -- 5. Insert lock row as 'executing' (consumed_at remains NULL until finalized!)
  insert into public.refund_authorizations (
    owner_id, request_id, nonce, order_id, business_id, approval_id,
    amount_cents, idempotency_key, canonical_digest, key_id,
    status, expires_at
  ) values (
    p_owner_id, p_request_id, p_nonce, p_order_id, p_business_id, p_approval_id,
    p_amount_cents, p_idempotency_key, p_canonical_digest, p_key_id,
    'executing', p_expires_at
  )
  returning id into v_new_id;

  return jsonb_build_object('status', 'ACQUIRED', 'reservation_id', v_new_id);
end;
$$;

create or replace function public.finalize_refund_execution(
  p_reservation_id uuid,
  p_success boolean,
  p_execution_tx_id text,
  p_outcome_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if p_success then
    update public.refund_authorizations
    set status = 'executed',
        execution_tx_id = p_execution_tx_id,
        outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
        consumed_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    where id = p_reservation_id and status = 'executing';
  else
    update public.refund_authorizations
    set status = 'failed',
        outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
        updated_at = timezone('utc'::text, now())
    where id = p_reservation_id and status = 'executing';
  end if;
end;
$$;

-- Restrict SECURITY DEFINER financial RPCs strictly to service_role
revoke all on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz) from public;
revoke execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz) to service_role;

revoke all on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public;
revoke execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) to service_role;
