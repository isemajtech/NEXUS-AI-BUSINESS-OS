-- ==============================================================================
-- P0-B SECURITY MIGRATION: Finance Refund Crash Recovery, Durable Provider
-- Idempotency Keys, Stale Lease Detection, & Uncertain Outcome Protection
-- Additive & Idempotent. Do not apply automatically without review/approval.
-- ==============================================================================

-- 1. Extend refund_authorizations with durable provider idempotency, lease, & reconciliation tracking
alter table public.refund_authorizations
  add column if not exists provider_idempotency_key text,
  add column if not exists provider_name text,
  add column if not exists provider_tx_id text,
  add column if not exists provider_outcome_status text not null default 'pending',
  add column if not exists retry_allowed boolean not null default true,
  add column if not exists attempt_count integer not null default 1,
  add column if not exists execution_started_at timestamptz default timezone('utc'::text, now()),
  add column if not exists lease_expires_at timestamptz,
  add column if not exists last_reconciled_at timestamptz,
  add column if not exists reconciliation_notes text;

-- Backfill any pre-existing rows before setting NOT NULL & UNIQUE
update public.refund_authorizations
set provider_idempotency_key = 'prov-idem-' || id::text
where provider_idempotency_key is null;

alter table public.refund_authorizations
  alter column provider_idempotency_key set not null;

-- Update status CHECK constraint to include 'uncertain_reconciliation_required'
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
      and t.relname = 'refund_authorizations'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%executing%'
      and pg_get_constraintdef(c.oid) ilike '%executed%'
  loop
    execute format('alter table public.refund_authorizations drop constraint if exists %I', v_conname);
  end loop;
end $$;

alter table public.refund_authorizations
  add constraint refund_authorizations_status_check
  check (status in ('executing', 'uncertain_reconciliation_required', 'executed', 'failed', 'rejected'));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'refund_authorizations_provider_outcome_check'
  ) then
    alter table public.refund_authorizations
      add constraint refund_authorizations_provider_outcome_check
      check (provider_outcome_status in ('pending', 'confirmed_success', 'confirmed_failure', 'timeout_or_unknown', 'finalization_failed_after_success'));
  end if;
end $$;

-- Preserve order lock during executing, uncertain_reconciliation_required, AND executed states
drop index if exists public.uq_refund_active_or_executed_order;
create unique index if not exists uq_refund_active_or_executed_order
  on public.refund_authorizations (order_id)
  where status in ('executing', 'uncertain_reconciliation_required', 'executed');

create unique index if not exists uq_refund_auth_provider_idempotency_key
  on public.refund_authorizations (provider_idempotency_key);

create index if not exists idx_refund_auth_status_lease
  on public.refund_authorizations (status, lease_expires_at);

-- Enforce immutability of provider_idempotency_key at database engine level
create or replace function public.prevent_provider_idempotency_key_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.provider_idempotency_key is distinct from old.provider_idempotency_key then
    raise exception 'provider_idempotency_key is immutable and cannot be overwritten';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_provider_idempotency_key_mutation() from public;
revoke execute on function public.prevent_provider_idempotency_key_mutation() from public, anon, authenticated;

drop trigger if exists trg_prevent_provider_idempotency_key_mutation on public.refund_authorizations;
create trigger trg_prevent_provider_idempotency_key_mutation
  before update on public.refund_authorizations
  for each row
  execute function public.prevent_provider_idempotency_key_mutation();

-- 2. Replace reserve_refund_execution with immutable server provider_idempotency_key,
--    lease tracking, stale detection, and uncertain-state blocking.
drop function if exists public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean);

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
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_existing public.refund_authorizations%rowtype;
  v_approval public.owner_approvals%rowtype;
  v_conflict record;
  v_new_id uuid;
  v_provider_idem text;
  v_now timestamptz := timezone('utc'::text, now());
  v_lease_expires timestamptz := v_now + make_interval(secs => greatest(1, coalesce(p_lease_seconds, 60)));
  v_next_attempt integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_request_id::text));
  perform pg_advisory_xact_lock(hashtext('order:' || p_order_id));
  if p_approval_id is not null then
    perform pg_advisory_xact_lock(hashtext('approval:' || p_approval_id));
  end if;

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
         or btrim(coalesce(v_approval.approved_by_user_id, '')) = '' then
        return jsonb_build_object('status', 'APPROVAL_BINDING_MISMATCH', 'reason', 'Owner approval binding mismatch.');
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
       or btrim(coalesce(v_approval.approved_by_user_id, '')) = '' then
      return jsonb_build_object('status', 'APPROVAL_BINDING_MISMATCH', 'reason', 'Owner approval binding mismatch.');
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

  -- 4. Reject duplicate active, uncertain, or executed refund for same order
  select id, request_id, status, lease_expires_at, provider_idempotency_key into v_conflict
  from public.refund_authorizations
  where order_id = p_order_id
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
    owner_id, request_id, nonce, order_id, business_id, approval_id,
    amount_cents, idempotency_key, provider_idempotency_key,
    provider_name, provider_outcome_status, retry_allowed, attempt_count,
    canonical_digest, key_id, status,
    execution_started_at, lease_expires_at, expires_at
  ) values (
    p_owner_id, p_request_id, p_nonce, p_order_id, p_business_id, p_approval_id,
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

-- 3. Update finalize_refund_execution to allow reconciliation finalization from 'uncertain_reconciliation_required'
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
declare
  v_auth public.refund_authorizations%rowtype;
  v_now timestamptz := timezone('utc'::text, now());
begin
  if p_success then
    select * into v_auth
    from public.refund_authorizations
    where id = p_reservation_id
      and status in ('executing', 'uncertain_reconciliation_required')
    for update;

    if not found then
      raise exception 'Could not finalize reservation %: invalid state transition', p_reservation_id;
    end if;

    update public.refund_authorizations
    set status = 'executed',
        execution_tx_id = p_execution_tx_id,
        provider_tx_id = coalesce(p_execution_tx_id, provider_tx_id),
        provider_outcome_status = 'confirmed_success',
        outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
        consumed_at = v_now,
        last_reconciled_at = case when status = 'uncertain_reconciliation_required' then v_now else last_reconciled_at end,
        updated_at = v_now
    where id = p_reservation_id
      and status in ('executing', 'uncertain_reconciliation_required');

    if v_auth.approval_id is not null then
      update public.owner_approvals
      set status = 'consumed',
          consumed_at = v_now,
          consumed_by_request_id = v_auth.request_id,
          consumed_by_reservation_id = p_reservation_id,
          updated_at = v_now
      where approval_id = v_auth.approval_id
        and status = 'approved'
        and consumed_at is null;

      if not found then
        raise exception 'Could not atomically consume owner approval %', v_auth.approval_id;
      end if;
    end if;
  else
    update public.refund_authorizations
    set status = 'failed',
        provider_outcome_status = 'confirmed_failure',
        outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
        updated_at = v_now
    where id = p_reservation_id and status = 'executing';

    if not found then
      raise exception 'Could not mark reservation % failed: not in executing state', p_reservation_id;
    end if;
  end if;
end;
$$;

-- 4. Dedicated fail_refund_execution RPC (only called on confirmed provider failure)
create or replace function public.fail_refund_execution(
  p_reservation_id uuid,
  p_reason text,
  p_retry_allowed boolean default true
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := timezone('utc'::text, now());
  v_next_status text := case when coalesce(p_retry_allowed, true) then 'failed' else 'rejected' end;
begin
  update public.refund_authorizations
  set status = v_next_status,
      provider_outcome_status = 'confirmed_failure',
      retry_allowed = coalesce(p_retry_allowed, true),
      outcome_payload = jsonb_build_object('error', p_reason),
      updated_at = v_now
  where id = p_reservation_id and status = 'executing';

  if not found then
    raise exception 'Could not mark reservation % failed: not in executing state', p_reservation_id;
  end if;
end;
$$;

-- 5. Dedicated mark_refund_uncertain RPC (preserves order lock & owner approval)
create or replace function public.mark_refund_uncertain(
  p_reservation_id uuid,
  p_provider_outcome_status text,
  p_provider_tx_id text,
  p_reason text,
  p_outcome_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := timezone('utc'::text, now());
begin
  if p_provider_outcome_status not in ('timeout_or_unknown', 'finalization_failed_after_success') then
    raise exception 'Invalid uncertain provider_outcome_status: %', p_provider_outcome_status;
  end if;

  update public.refund_authorizations
  set status = 'uncertain_reconciliation_required',
      provider_outcome_status = p_provider_outcome_status,
      provider_tx_id = coalesce(p_provider_tx_id, provider_tx_id),
      reconciliation_notes = p_reason,
      outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
      updated_at = v_now
  where id = p_reservation_id
    and status in ('executing', 'uncertain_reconciliation_required');

  if not found then
    raise exception 'Could not mark reservation % uncertain: invalid state', p_reservation_id;
  end if;
end;
$$;

-- 6. Dedicated reconcile_mark_refund_not_executed RPC (only when provider lookup confirms non-execution)
create or replace function public.reconcile_mark_refund_not_executed(
  p_reservation_id uuid,
  p_retry_allowed boolean,
  p_reason text,
  p_outcome_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := timezone('utc'::text, now());
  v_next_status text := case when coalesce(p_retry_allowed, true) then 'failed' else 'rejected' end;
begin
  update public.refund_authorizations
  set status = v_next_status,
      provider_outcome_status = 'confirmed_failure',
      retry_allowed = coalesce(p_retry_allowed, true),
      last_reconciled_at = v_now,
      reconciliation_notes = p_reason,
      outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
      updated_at = v_now
  where id = p_reservation_id
    and status in ('executing', 'uncertain_reconciliation_required');

  if not found then
    raise exception 'Could not reconcile reservation % as not executed: invalid state', p_reservation_id;
  end if;
end;
$$;

-- 7. Strictly restrict SECURITY DEFINER RPC execution to service_role only
revoke all on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer) from public;
revoke execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer) from public, anon, authenticated;
grant execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer) to service_role;

revoke all on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public;
revoke execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) to service_role;

revoke all on function public.fail_refund_execution(uuid, text, boolean) from public;
revoke execute on function public.fail_refund_execution(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.fail_refund_execution(uuid, text, boolean) to service_role;

revoke all on function public.mark_refund_uncertain(uuid, text, text, text, jsonb) from public;
revoke execute on function public.mark_refund_uncertain(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_refund_uncertain(uuid, text, text, text, jsonb) to service_role;

revoke all on function public.reconcile_mark_refund_not_executed(uuid, boolean, text, jsonb) from public;
revoke execute on function public.reconcile_mark_refund_not_executed(uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_mark_refund_not_executed(uuid, boolean, text, jsonb) to service_role;
