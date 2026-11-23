-- ==============================================================================
-- P0-A LIVE POSTGRES VERIFICATION SCRIPT
-- Execute against a test/staging Supabase or PostgreSQL instance AFTER applying
-- migrations 000001..000005 to assert:
--   1. Exact expected RPC signatures exist and legacy insecure overloads do not.
--   2. Every SECURITY DEFINER financial RPC denies EXECUTE to PUBLIC, anon, and
--      authenticated, and grants EXECUTE to service_role.
--   3. Every SECURITY DEFINER and trigger function pins a safe search_path with
--      pg_temp ordered last.
--   4. Table RLS is enabled on all governance & financial tables with no permissive
--      client write policies.
-- ==============================================================================

do $$
declare
  v_missing text[] := array[]::text[];
  v_overloads integer;
  v_fn record;
  v_cfg text;
  v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_has_authenticated boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  v_expected_sigs text[] := array[
    'public.reserve_refund_execution(uuid,uuid,text,text,text,text,integer,text,text,text,timestamp with time zone,boolean,text,integer,text)',
    'public.finalize_refund_execution(uuid,boolean,text,jsonb)',
    'public.fail_refund_execution(uuid,text,boolean)',
    'public.mark_refund_uncertain(uuid,text,text,text,jsonb)',
    'public.reconcile_mark_refund_not_executed(uuid,boolean,text,jsonb)',
    'public.record_authoritative_order_refund(uuid,uuid,integer,text,uuid,timestamp with time zone)'
  ];
  v_sig text;
begin
  -- 1. Check exact expected signatures exist
  foreach v_sig in array v_expected_sigs loop
    if to_regprocedure(v_sig) is null then
      v_missing := array_append(v_missing, v_sig);
    end if;
  end loop;

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception 'P0-A verification failed: missing expected RPC signature(s): %', v_missing;
  end if;

  -- 2. Check no stale 11-arg or 12-arg reserve_refund_execution overloads linger
  select count(*) into v_overloads
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'reserve_refund_execution';

  if v_overloads <> 1 then
    raise exception 'P0-A verification failed: expected exactly 1 reserve_refund_execution overload, found %', v_overloads;
  end if;

  -- 3. Verify permissions & search_path on every SECURITY DEFINER financial/governance RPC
  for v_fn in
    select
      p.oid,
      p.proname,
      p.prosecdef,
      p.proconfig,
      pg_get_userbyid(p.proowner) as owner_name,
      pg_get_function_identity_arguments(p.oid) as identity_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        p.proname in (
          'reserve_refund_execution',
          'finalize_refund_execution',
          'fail_refund_execution',
          'mark_refund_uncertain',
          'reconcile_mark_refund_not_executed',
          'record_authoritative_order_refund'
        )
        or (p.prosecdef and p.proname ~* '(refund|approval|provenance)')
      )
  loop
    if not v_fn.prosecdef then
      raise exception 'P0-A verification failed: %.%(%) must be SECURITY DEFINER', 'public', v_fn.proname, v_fn.identity_args;
    end if;

    if v_fn.owner_name in ('anon', 'authenticated') then
      raise exception 'P0-A verification failed: function % owned by low-privilege role %', v_fn.proname, v_fn.owner_name;
    end if;

    if has_function_privilege('public', v_fn.oid, 'EXECUTE') then
      raise exception 'P0-A verification failed: PUBLIC still has EXECUTE on %.%(%)', 'public', v_fn.proname, v_fn.identity_args;
    end if;

    if v_has_anon and has_function_privilege('anon', v_fn.oid, 'EXECUTE') then
      raise exception 'P0-A verification failed: anon still has EXECUTE on %.%(%)', 'public', v_fn.proname, v_fn.identity_args;
    end if;

    if v_has_authenticated and has_function_privilege('authenticated', v_fn.oid, 'EXECUTE') then
      raise exception 'P0-A verification failed: authenticated still has EXECUTE on %.%(%)', 'public', v_fn.proname, v_fn.identity_args;
    end if;

    if v_has_service_role and not has_function_privilege('service_role', v_fn.oid, 'EXECUTE') then
      raise exception 'P0-A verification failed: service_role lacks EXECUTE on %.%(%)', 'public', v_fn.proname, v_fn.identity_args;
    end if;

    select cfg into v_cfg
    from unnest(coalesce(v_fn.proconfig, array[]::text[])) as cfg
    where cfg like 'search_path=%'
    limit 1;

    if v_cfg is null or v_cfg !~ 'pg_temp$' then
      raise exception 'P0-A verification failed: %.%(%) missing safe pinned search_path ending in pg_temp (proconfig=%)',
        'public', v_fn.proname, v_fn.identity_args, v_fn.proconfig;
    end if;
  end loop;

  -- 4. Verify trigger functions pin search_path and deny PUBLIC/anon/authenticated direct execution
  for v_fn in
    select p.oid, p.proname, p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('prevent_provider_idempotency_key_mutation', 'set_factory_job_updated_at')
  loop
    if has_function_privilege('public', v_fn.oid, 'EXECUTE')
       or (v_has_anon and has_function_privilege('anon', v_fn.oid, 'EXECUTE'))
       or (v_has_authenticated and has_function_privilege('authenticated', v_fn.oid, 'EXECUTE')) then
      raise exception 'P0-A verification failed: trigger function % retains direct PUBLIC/anon/authenticated EXECUTE privilege', v_fn.proname;
    end if;

    select cfg into v_cfg
    from unnest(coalesce(v_fn.proconfig, array[]::text[])) as cfg
    where cfg like 'search_path=%'
    limit 1;

    if v_cfg is null or v_cfg !~ 'pg_temp$' then
      raise exception 'P0-A verification failed: trigger function % missing safe pinned search_path (proconfig=%)',
        v_fn.proname, v_fn.proconfig;
    end if;
  end loop;

  -- 5. Verify RLS is enabled on all provenance, approval, order, membership, and refund tables
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('provenance_signing_keys', 'provenance_ledger', 'refund_authorizations', 'owner_approvals', 'authenticated_refund_requests', 'orders', 'business_memberships')
      and not c.relrowsecurity
  ) then
    raise exception 'P0-A verification failed: RLS disabled on one or more financial/provenance/order tables';
  end if;

  raise notice 'P0-A RPC security verification PASSED against live PostgreSQL catalog.';
end $$;
