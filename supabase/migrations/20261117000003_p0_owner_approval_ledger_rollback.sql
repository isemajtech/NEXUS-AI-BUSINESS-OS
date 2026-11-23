-- ==============================================================================
-- P0-A SECURITY REMEDIATION ROLLBACK: Safe Rollback for Owner Approval Ledger
-- Fails closed if P0-B (000004) objects, active executions, or owner_approvals
-- rows exist. Preserves provenance_ledger and refund_authorizations data, and
-- restores pre-P0-A 11-arg reserve_refund_execution + 4-arg finalize_refund_execution
-- with NO references to dropped owner_approvals and strict service_role permissions.
-- ==============================================================================

do $$
declare
  v_approval_count bigint := 0;
begin
  -- 1. Block if dependent P0-B (20261117000004) RPCs, triggers, or constraints are still present
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname in (
          'fail_refund_execution',
          'mark_refund_uncertain',
          'reconcile_mark_refund_not_executed',
          'prevent_provider_idempotency_key_mutation'
        )
        or (
          p.proname = 'reserve_refund_execution'
          and pg_get_function_identity_arguments(p.oid) like '%p_provider_name text, p_lease_seconds integer%'
        )
      )
  ) or exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname in ('uq_refund_auth_provider_idempotency_key', 'idx_refund_auth_status_lease')
  ) or exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'refund_authorizations'
      and c.conname = 'refund_authorizations_provider_outcome_check'
  ) then
    raise exception 'Cannot rollback P0-A (000003) while dependent P0-B (000004) objects exist; apply 20261117000004_p0b_refund_crash_recovery_rollback.sql first.';
  end if;

  -- 2. Block if active executing or uncertain refund authorizations exist
  if to_regclass('public.refund_authorizations') is not null then
    if exists (
      select 1
      from public.refund_authorizations
      where status in ('executing', 'uncertain_reconciliation_required')
    ) then
      raise exception 'Cannot rollback P0-A while active executing or uncertain refund authorizations exist; finalize or reconcile them first.';
    end if;
  end if;

  -- 3. Prevent silent destruction of existing owner approval / audit records
  if to_regclass('public.owner_approvals') is not null then
    select count(*) into v_approval_count from public.owner_approvals;
    if v_approval_count > 0 then
      raise exception 'Cannot rollback P0-A and drop public.owner_approvals while % authoritative approval record(s) exist; archive/export and clear public.owner_approvals explicitly first.', v_approval_count;
    end if;
  end if;
end $$;

-- 4. Drop P0-A 12-argument reserve_refund_execution and empty owner_approvals artifacts
drop function if exists public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean);

drop policy if exists "Owners view their authoritative owner approvals" on public.owner_approvals;
drop index if exists public.idx_owner_approvals_status_expires;
drop index if exists public.idx_owner_approvals_request_order;
drop table if exists public.owner_approvals;

-- 5. Restore original pre-P0-A (000002) 11-argument reserve_refund_execution
--    No references to dropped public.owner_approvals.
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

-- 6. Restore original pre-P0-A (000002) 4-argument finalize_refund_execution
--    Removes all references to dropped public.owner_approvals.
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

-- 7. Keep strict service_role execution restrictions on restored pre-P0-A RPCs
revoke all on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz) from public;
revoke execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz) to service_role;

revoke all on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public;
revoke execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) to service_role;
