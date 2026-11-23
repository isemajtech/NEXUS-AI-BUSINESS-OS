-- ==============================================================================
-- ROLLBACK FOR P0-B MIGRATION (20261117000004_p0b_refund_crash_recovery.sql)
-- Non-destructive: preserves refund_authorizations rows and restores 000003 RPCs.
-- Note: blocks constraint rollback if active 'uncertain_reconciliation_required' rows exist.
-- ==============================================================================

do $$
begin
  if exists (
    select 1 from public.refund_authorizations
    where status in ('executing', 'uncertain_reconciliation_required')
  ) then
    raise exception 'Cannot rollback P0-B migration while executing or uncertain_reconciliation_required rows exist; finalize or reconcile them first.';
  end if;
end $$;

drop trigger if exists trg_prevent_provider_idempotency_key_mutation on public.refund_authorizations;
drop function if exists public.prevent_provider_idempotency_key_mutation();
drop function if exists public.reconcile_mark_refund_not_executed(uuid, boolean, text, jsonb);
drop function if exists public.mark_refund_uncertain(uuid, text, text, text, jsonb);
drop function if exists public.fail_refund_execution(uuid, text, boolean);
drop function if exists public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer);

drop index if exists public.uq_refund_active_or_executed_order;
create unique index if not exists uq_refund_active_or_executed_order
  on public.refund_authorizations (order_id)
  where status in ('executing', 'executed');

drop index if exists public.uq_refund_auth_provider_idempotency_key;
drop index if exists public.idx_refund_auth_status_lease;

alter table public.refund_authorizations
  drop constraint if exists refund_authorizations_provider_outcome_check;

alter table public.refund_authorizations
  alter column provider_idempotency_key drop not null;

alter table public.refund_authorizations
  drop constraint if exists refund_authorizations_status_check;

alter table public.refund_authorizations
  add constraint refund_authorizations_status_check
  check (status in ('executing', 'executed', 'failed', 'rejected'));

-- Restore 20261117000003 12-argument reserve_refund_execution and finalize_refund_execution
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
  p_require_owner_approval boolean default false
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
begin
  perform pg_advisory_xact_lock(hashtext(p_request_id::text));
  perform pg_advisory_xact_lock(hashtext('order:' || p_order_id));
  if p_approval_id is not null then
    perform pg_advisory_xact_lock(hashtext('approval:' || p_approval_id));
  end if;

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
      if v_approval.expires_at <= timezone('utc'::text, now()) then
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

    update public.refund_authorizations
    set status = 'executing',
        idempotency_key = p_idempotency_key,
        updated_at = timezone('utc'::text, now())
    where id = v_existing.id and status = 'failed';

    return jsonb_build_object('status', 'ACQUIRED', 'reservation_id', v_existing.id);
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
    if v_approval.expires_at <= timezone('utc'::text, now()) then
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

  select request_id into v_conflict from public.refund_authorizations where nonce = p_nonce limit 1;
  if found then
    return jsonb_build_object('status', 'NONCE_REUSED', 'reason', 'Nonce already used.');
  end if;

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
declare
  v_auth public.refund_authorizations%rowtype;
begin
  if p_success then
    select * into v_auth
    from public.refund_authorizations
    where id = p_reservation_id and status = 'executing'
    for update;

    if not found then
      raise exception 'Could not finalize reservation %: not in executing state', p_reservation_id;
    end if;

    update public.refund_authorizations
    set status = 'executed',
        execution_tx_id = p_execution_tx_id,
        outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
        consumed_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    where id = p_reservation_id and status = 'executing';

    if v_auth.approval_id is not null then
      update public.owner_approvals
      set status = 'consumed',
          consumed_at = timezone('utc'::text, now()),
          consumed_by_request_id = v_auth.request_id,
          consumed_by_reservation_id = p_reservation_id,
          updated_at = timezone('utc'::text, now())
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
        outcome_payload = coalesce(p_outcome_payload, '{}'::jsonb),
        updated_at = timezone('utc'::text, now())
    where id = p_reservation_id and status = 'executing';
  end if;
end;
$$;

-- Preserve strict service_role permissions on restored 000003 RPCs
revoke all on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean) from public;
revoke execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean) to service_role;

revoke all on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public;
revoke execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_refund_execution(uuid, boolean, text, jsonb) to service_role;
