-- ==============================================================================
-- H3 SECURITY MIGRATION: Request Expiration, Owner Approval Expiration &
-- Execution Consistency Enforcement
-- Additive & Idempotent. Do not apply automatically without review/approval.
--
-- Addresses H3 audit findings at the PostgreSQL layer:
--   1. Validates public.authenticated_refund_requests expiration invariant
--      (expires_at > created_at) for new/updated rows via NOT VALID constraint.
--   2. Hardens 15-arg public.reserve_refund_execution to:
--        - Require non-null p_expires_at.
--        - Verify p_expires_at and p_amount_cents against persisted
--          public.authenticated_refund_requests when present.
--        - Fail closed (REFUND_REQUEST_EXPIRED) when v_effective_req_expires <= v_now
--          (exact boundary consistency with TypeScript now >= expires_at),
--          while preserving IDEMPOTENT_REPLAY for already-executed reservations.
--        - Fail closed (APPROVAL_EXCEEDS_REQUEST_EXPIRATION) if
--          v_approval.expires_at > v_effective_req_expires.
--        - Fail closed (MISSING_OR_MALFORMED_TIMESTAMP) if request or approval
--          timestamps are null or expires_at <= created_at.
--   3. Preserves strict service_role-only EXECUTE lockdown and pinned search_path.
-- ==============================================================================

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'chk_auth_refund_req_expires_after_created'
      and conrelid = 'public.authenticated_refund_requests'::regclass
  ) then
    alter table public.authenticated_refund_requests
      add constraint chk_auth_refund_req_expires_after_created
      check (expires_at > created_at) not valid;
  end if;
end $$;

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
  v_effective_req_expires timestamptz;
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

  if p_expires_at is null then
    return jsonb_build_object(
      'status', 'MISSING_OR_MALFORMED_TIMESTAMP',
      'reason', 'Execution p_expires_at timestamp is required (fail-closed).'
    );
  end if;
  v_effective_req_expires := p_expires_at;

  perform pg_advisory_xact_lock(hashtext(p_request_id::text));
  perform pg_advisory_xact_lock(hashtext('order:' || p_business_id || ':' || p_order_id));
  if p_approval_id is not null then
    perform pg_advisory_xact_lock(hashtext('approval:' || p_approval_id));
  end if;

  -- 0. Verify against persisted authenticated_refund_requests scope, amount, & expiration
  select owner_id, tenant_id, business_id, order_id, amount_cents, created_at, expires_at
  into v_auth_req
  from public.authenticated_refund_requests
  where request_id = p_request_id
  limit 1;

  if found then
    if v_auth_req.business_id <> p_business_id
       or v_auth_req.order_id <> p_order_id
       or v_auth_req.amount_cents <> p_amount_cents
       or (v_auth_req.owner_id is null and nullif(btrim(v_auth_req.tenant_id), '') is null)
       or v_auth_req.owner_id is distinct from p_owner_id
       or nullif(btrim(v_auth_req.tenant_id), '') is distinct from v_effective_tenant then
      return jsonb_build_object(
        'status', 'REPLAY_CONFLICT',
        'reason', 'Persisted request owner, tenant, or binding parameters do not match execution caller scope.'
      );
    end if;

    if v_auth_req.created_at is null
       or v_auth_req.expires_at is null
       or v_auth_req.expires_at <= v_auth_req.created_at then
      return jsonb_build_object(
        'status', 'MISSING_OR_MALFORMED_TIMESTAMP',
        'reason', 'Persisted authenticated_refund_requests row has missing or invalid created_at/expires_at.'
      );
    end if;

    if v_auth_req.expires_at is distinct from p_expires_at then
      return jsonb_build_object(
        'status', 'REPLAY_CONFLICT',
        'reason', 'Execution expires_at does not match persisted request expires_at.'
      );
    end if;

    v_effective_req_expires := v_auth_req.expires_at;
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

    -- Fail closed if the persisted refund request has expired before retry
    if v_effective_req_expires <= v_now then
      return jsonb_build_object(
        'status', 'REFUND_REQUEST_EXPIRED',
        'reason', 'Refund request has expired and is no longer eligible for retry execution.'
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
      if v_approval.created_at is null
         or v_approval.expires_at is null then
        return jsonb_build_object('status', 'MISSING_OR_MALFORMED_TIMESTAMP', 'reason', 'Owner approval has missing created_at/expires_at timestamp.');
      end if;
      if v_approval.expires_at > v_effective_req_expires then
        return jsonb_build_object('status', 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION', 'reason', 'Owner approval expiration exceeds parent refund request expiration.');
      end if;
      if v_approval.expires_at <= v_now then
        return jsonb_build_object('status', 'APPROVAL_EXPIRED', 'reason', 'Owner approval expired.');
      end if;
      if v_approval.expires_at <= v_approval.created_at then
        return jsonb_build_object('status', 'MISSING_OR_MALFORMED_TIMESTAMP', 'reason', 'Owner approval has invalid expires_at <= created_at timestamp.');
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

  -- Fail closed if the refund request has already expired before reservation
  if v_effective_req_expires <= v_now then
    return jsonb_build_object(
      'status', 'REFUND_REQUEST_EXPIRED',
      'reason', 'Refund request has expired and is no longer eligible for execution.'
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
    if v_approval.created_at is null
       or v_approval.expires_at is null then
      return jsonb_build_object('status', 'MISSING_OR_MALFORMED_TIMESTAMP', 'reason', 'Owner approval has missing created_at/expires_at timestamp.');
    end if;
    if v_approval.expires_at > v_effective_req_expires then
      return jsonb_build_object('status', 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION', 'reason', 'Owner approval expiration exceeds parent refund request expiration.');
    end if;
    if v_approval.expires_at <= v_now then
      return jsonb_build_object('status', 'APPROVAL_EXPIRED', 'reason', 'Owner approval expired.');
    end if;
    if v_approval.expires_at <= v_approval.created_at then
      return jsonb_build_object('status', 'MISSING_OR_MALFORMED_TIMESTAMP', 'reason', 'Owner approval has invalid expires_at <= created_at timestamp.');
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
    v_now, v_lease_expires, v_effective_req_expires
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
-- SECURITY ASSERTION: Verify zero leaked RPC privileges & single overload
-- ------------------------------------------------------------------------------
do $$
declare
  v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_has_authenticated boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_leaked text[];
  v_overloads integer;
begin
  select count(*) into v_overloads
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'reserve_refund_execution';

  if v_overloads <> 1 then
    raise exception 'H3-000009 migration failed: expected exactly 1 reserve_refund_execution overload, found %', v_overloads;
  end if;

  select array_agg(format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
  into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname = 'reserve_refund_execution'
    and (
      has_function_privilege('public', p.oid, 'EXECUTE')
      or (v_has_anon and has_function_privilege('anon', p.oid, 'EXECUTE'))
      or (v_has_authenticated and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    );

  if coalesce(array_length(v_leaked, 1), 0) > 0 then
    raise exception 'H3-000009 migration failed; overexposed SECURITY DEFINER RPCs: %', v_leaked;
  end if;
end $$;
