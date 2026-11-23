-- ==============================================================================
-- H2 SECURITY MIGRATION: Cross-Tenant & Business-Scope Isolation
-- Additive & Idempotent. Do not apply automatically without review/approval.
--
-- Hardens multi-tenant and multi-business boundaries across Supabase tables & RPCs:
--   1. Adds tenant_id columns to refund_authorizations & provenance_ledger and
--      safely backfills tenant_id from owner_id::text where owner_id IS NOT NULL.
--   2. Replaces global (order_id) lock on refund_authorizations with business-scoped
--      partial unique index (business_id, order_id) so distinct businesses with
--      overlapping external order identifiers remain isolated.
--   3. Adds scoped composite indexes so owner/tenant/business queries filter at the
--      database layer before LIMIT clauses.
--   4. Updates reserve_refund_execution (15-arg) to acquire business-scoped advisory
--      locks, reject cross-business request_id binding, persist tenant_id, and
--      preserve strict SECURITY DEFINER + search_path + service_role-only grants.
-- ==============================================================================

-- 1. Add tenant_id column to refund_authorizations and provenance_ledger
alter table public.refund_authorizations
  add column if not exists tenant_id text;

alter table public.provenance_ledger
  add column if not exists tenant_id text;

-- Safe non-destructive backfill ONLY where owner_id is already present
update public.refund_authorizations
set tenant_id = owner_id::text
where tenant_id is null
  and owner_id is not null;

update public.provenance_ledger
set tenant_id = owner_id::text
where tenant_id is null
  and owner_id is not null;

update public.owner_approvals
set tenant_id = owner_id::text
where tenant_id is null
  and owner_id is not null;

-- 2. Replace global order_id active/executed lock with business-scoped (business_id, order_id)
drop index if exists public.uq_refund_active_or_executed_order;
create unique index if not exists uq_refund_active_or_executed_order
  on public.refund_authorizations (business_id, order_id)
  where status in ('executing', 'uncertain_reconciliation_required', 'executed');

-- 3. Scoped composite indexes for DB-side tenant/owner/business filtering before LIMIT
create index if not exists idx_owner_approvals_scope_created
  on public.owner_approvals (tenant_id, owner_id, business_id, created_at desc);

create index if not exists idx_refund_auth_scope_status_lease
  on public.refund_authorizations (tenant_id, owner_id, business_id, status, lease_expires_at);

create index if not exists idx_refund_auth_business_order_created
  on public.refund_authorizations (business_id, order_id, created_at desc);

create index if not exists idx_auth_refund_req_scope_created
  on public.authenticated_refund_requests (tenant_id, owner_id, business_id, created_at desc);

-- 4. Replace 14-arg reserve_refund_execution with 15-arg business-scoped & tenant-bound RPC
drop function if exists public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer);

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
  v_approval public.owner_approvals%rowtype;
  v_conflict record;
  v_new_id uuid;
  v_provider_idem text;
  v_now timestamptz := timezone('utc'::text, now());
  v_lease_expires timestamptz := v_now + make_interval(secs => greatest(1, coalesce(p_lease_seconds, 60)));
  v_next_attempt integer;
  v_effective_tenant text := coalesce(nullif(btrim(p_tenant_id), ''), p_owner_id::text);
begin
  perform pg_advisory_xact_lock(hashtext(p_request_id::text));
  perform pg_advisory_xact_lock(hashtext('order:' || p_business_id || ':' || p_order_id));
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

-- 5. Strictly restrict SECURITY DEFINER RPC execution to service_role only
revoke all on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer, text) from public;
revoke execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer, text) to service_role;

-- Assert zero residual overloads or PUBLIC/anon/authenticated EXECUTE privileges remain
do $$
declare
  v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_has_authenticated boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_overloads integer;
  v_leaked text[];
begin
  select count(*) into v_overloads
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'reserve_refund_execution';

  if v_overloads <> 1 then
    raise exception 'H2 migration failed: expected 1 overload of reserve_refund_execution, found %', v_overloads;
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
    raise exception 'H2 migration failed; overexposed reserve_refund_execution overloads: %', v_leaked;
  end if;
end $$;
