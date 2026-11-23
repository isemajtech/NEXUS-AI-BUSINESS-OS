-- ==============================================================================
-- P0-A SECURITY MIGRATION: Database RPC Permission Hardening & Search-Path Pinning
-- Idempotent & safe for both fresh and already-migrated Supabase databases.
--
-- Hardens all inherited and current financial / governance SECURITY DEFINER RPCs
-- and trigger functions across migrations 000001..000004:
--   1. Revokes EXECUTE (and ALL) from PUBLIC, anon, and authenticated on EVERY
--      overload in schema public (defeating Postgres default PUBLIC grant and
--      Supabase default EXECUTE grants to anon/authenticated).
--   2. Grants EXECUTE strictly to service_role for financial RPCs.
--   3. Pins safe deterministic search_path ending with pg_temp to block temp
--      object hijacking in SECURITY DEFINER and trigger functions.
--   4. Verifies zero residual PUBLIC/anon/authenticated EXECUTE privileges remain
--      on any financial/governance SECURITY DEFINER RPC.
-- ==============================================================================

do $$
declare
  v_fn record;
  v_fn_sig text;
  v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_has_authenticated boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  v_leaked text[];
begin
  -- 1. Harden every overload of financial / governance RPCs in public schema
  for v_fn in
    select
      p.oid,
      n.nspname,
      p.proname,
      p.prosecdef,
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
          'reconcile_mark_refund_not_executed'
        )
        or (p.prosecdef and p.proname ~* '(refund|approval|provenance)')
      )
  loop
    v_fn_sig := format('%I.%I(%s)', v_fn.nspname, v_fn.proname, v_fn.identity_args);

    execute format('revoke all on function %s from public', v_fn_sig);
    execute format('revoke execute on function %s from public', v_fn_sig);

    if v_has_anon then
      execute format('revoke all on function %s from anon', v_fn_sig);
      execute format('revoke execute on function %s from anon', v_fn_sig);
    end if;

    if v_has_authenticated then
      execute format('revoke all on function %s from authenticated', v_fn_sig);
      execute format('revoke execute on function %s from authenticated', v_fn_sig);
    end if;

    if v_has_service_role then
      execute format('grant execute on function %s to service_role', v_fn_sig);
    end if;

    execute format(
      'alter function %s set search_path = pg_catalog, public, extensions, pg_temp',
      v_fn_sig
    );
  end loop;

  -- 2. Harden trigger functions (pin search_path and revoke direct PUBLIC/anon/authenticated execute)
  for v_fn in
    select
      p.oid,
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid) as identity_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'prevent_provider_idempotency_key_mutation',
        'set_factory_job_updated_at'
      )
  loop
    v_fn_sig := format('%I.%I(%s)', v_fn.nspname, v_fn.proname, v_fn.identity_args);

    execute format('revoke all on function %s from public', v_fn_sig);
    execute format('revoke execute on function %s from public', v_fn_sig);

    if v_has_anon then
      execute format('revoke all on function %s from anon', v_fn_sig);
      execute format('revoke execute on function %s from anon', v_fn_sig);
    end if;

    if v_has_authenticated then
      execute format('revoke all on function %s from authenticated', v_fn_sig);
      execute format('revoke execute on function %s from authenticated', v_fn_sig);
    end if;

    execute format(
      'alter function %s set search_path = pg_catalog, public, pg_temp',
      v_fn_sig
    );
  end loop;

  -- 3. Post-condition assertion: fail transaction if any financial/governance SECURITY DEFINER RPC
  --    remains executable by PUBLIC, anon, or authenticated.
  select array_agg(format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
  into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and (
      p.proname in (
        'reserve_refund_execution',
        'finalize_refund_execution',
        'fail_refund_execution',
        'mark_refund_uncertain',
        'reconcile_mark_refund_not_executed'
      )
      or p.proname ~* '(refund|approval|provenance)'
    )
    and (
      has_function_privilege('public', p.oid, 'EXECUTE')
      or (v_has_anon and has_function_privilege('anon', p.oid, 'EXECUTE'))
      or (v_has_authenticated and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    );

  if coalesce(array_length(v_leaked, 1), 0) > 0 then
    raise exception 'P0-A RPC permission hardening failed; overexposed SECURITY DEFINER functions: %', v_leaked;
  end if;
end $$;
