import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

function readSql(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

function normalizeSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function assertExactRpcLockdown(
  normalizedSql: string,
  fnName: string,
  argSignature: string,
  contextLabel: string
) {
  const fullSig = `public.${fnName}(${argSignature})`.toLowerCase();
  assert(
    normalizedSql.includes(`revoke all on function ${fullSig} from public`),
    `${contextLabel}: missing "revoke all on function ${fullSig} from public"`
  );
  assert(
    normalizedSql.includes(`revoke execute on function ${fullSig} from public, anon, authenticated`),
    `${contextLabel}: missing "revoke execute on function ${fullSig} from public, anon, authenticated"`
  );
  assert(
    normalizedSql.includes(`grant execute on function ${fullSig} to service_role`),
    `${contextLabel}: missing "grant execute on function ${fullSig} to service_role"`
  );
}

function extractFunctionDefinitions(sql: string): Array<{
  name: string;
  header: string;
  body: string;
}> {
  const results: Array<{ name: string; header: string; body: string }> = [];
  const regex =
    /create\s+or\s+replace\s+function\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns[\s\S]*?as\s*\$\$([\s\S]*?)\$\$;/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    results.push({
      name: match[1].toLowerCase(),
      header: match[0].slice(0, match[0].indexOf('$$')).toLowerCase(),
      body: match[3].toLowerCase(),
    });
  }
  return results;
}

async function runTests() {
  const results: TestResult[] = [];

  const test = (name: string, fn: () => void) => {
    try {
      fn();
      results.push({ name, passed: true });
    } catch (err: any) {
      results.push({ name, passed: false, detail: err?.message || String(err) });
    }
  };

  const m0001 = readSql('supabase/migrations/20261116000001_digital_product_factory_phase1.sql');
  const m0002 = readSql('supabase/migrations/20261116000002_provenance_auth_replay_protection.sql');
  const m0003 = readSql('supabase/migrations/20261117000003_p0_owner_approval_ledger.sql');
  const m0003Rollback = readSql(
    'supabase/migrations/20261117000003_p0_owner_approval_ledger_rollback.sql'
  );
  const m0004 = readSql('supabase/migrations/20261117000004_p0b_refund_crash_recovery.sql');
  const m0004Rollback = readSql(
    'supabase/migrations/20261117000004_p0b_refund_crash_recovery_rollback.sql'
  );
  const m0005 = readSql('supabase/migrations/20261117000005_p0a_rpc_permission_hardening.sql');
  const m0005Rollback = readSql(
    'supabase/migrations/20261117000005_p0a_rpc_permission_hardening_rollback.sql'
  );
  const m0007 = readSql('supabase/migrations/20261117000007_h2_tenant_business_isolation.sql');
  const m0007Rollback = readSql(
    'supabase/migrations/20261117000007_h2_tenant_business_isolation_rollback.sql'
  );
  const m0008 = readSql(
    'supabase/migrations/20261118000008_h2_authoritative_orders_and_memberships.sql'
  );
  const m0008Rollback = readSql(
    'supabase/migrations/20261118000008_h2_authoritative_orders_and_memberships_rollback.sql'
  );
  const m0009 = readSql(
    'supabase/migrations/20261118000009_h3_expiration_consistency.sql'
  );
  const m0009Rollback = readSql(
    'supabase/migrations/20261118000009_h3_expiration_consistency_rollback.sql'
  );
  const verifySql = readSql('supabase/verification/verify_p0a_rpc_security.sql');
  const replayStoreTs = readSql('server/replayStore.ts');
  const orderStoreTs = readSql('server/orderStore.ts');

  // Signatures
  const sigReserve11 =
    'uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz';
  const sigReserve12 =
    'uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean';
  const sigReserve14 =
    'uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer';
  const sigReserve15 =
    'uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz, boolean, text, integer, text';
  const sigFinalize4 = 'uuid, boolean, text, jsonb';
  const sigFail3 = 'uuid, text, boolean';
  const sigUncertain5 = 'uuid, text, text, text, jsonb';
  const sigReconcile4 = 'uuid, boolean, text, jsonb';

  test('1. Migration 000002 restricts 11-arg reserve & 4-arg finalize RPCs to service_role and pins safe search_path', () => {
    const norm = normalizeSql(m0002);
    assertExactRpcLockdown(norm, 'reserve_refund_execution', sigReserve11, '000002');
    assertExactRpcLockdown(norm, 'finalize_refund_execution', sigFinalize4, '000002');

    const fns = extractFunctionDefinitions(m0002);
    assert.equal(fns.length, 2, 'Expected 2 functions in 000002');
    for (const fn of fns) {
      assert(fn.header.includes('security definer'), `000002 ${fn.name} must be SECURITY DEFINER`);
      assert(
        /set\s+search_path\s*=\s*pg_catalog,\s*public,\s*extensions,\s*pg_temp/.test(fn.header),
        `000002 ${fn.name} must pin search_path ending in pg_temp`
      );
    }
  });

  test('2. Migration 000003 restricts 12-arg reserve & 4-arg finalize RPCs to service_role and pins safe search_path', () => {
    const norm = normalizeSql(m0003);
    assert(
      norm.includes(`drop function if exists public.reserve_refund_execution(${sigReserve11})`),
      '000003 must drop legacy 11-arg reserve_refund_execution before creating 12-arg'
    );
    assertExactRpcLockdown(norm, 'reserve_refund_execution', sigReserve12, '000003');
    assertExactRpcLockdown(norm, 'finalize_refund_execution', sigFinalize4, '000003');

    const fns = extractFunctionDefinitions(m0003);
    assert.equal(fns.length, 2, 'Expected 2 functions in 000003');
    for (const fn of fns) {
      assert(fn.header.includes('security definer'), `000003 ${fn.name} must be SECURITY DEFINER`);
      assert(
        /set\s+search_path\s*=\s*pg_catalog,\s*public,\s*extensions,\s*pg_temp/.test(fn.header),
        `000003 ${fn.name} must pin search_path ending in pg_temp`
      );
    }
  });

  test('3. Migration 000004 restricts all 5 P0-B SECURITY DEFINER RPCs and trigger function', () => {
    const norm = normalizeSql(m0004);
    assert(
      norm.includes(`drop function if exists public.reserve_refund_execution(${sigReserve12})`),
      '000004 must drop legacy 12-arg reserve_refund_execution before creating 14-arg'
    );
    assertExactRpcLockdown(norm, 'reserve_refund_execution', sigReserve14, '000004');
    assertExactRpcLockdown(norm, 'finalize_refund_execution', sigFinalize4, '000004');
    assertExactRpcLockdown(norm, 'fail_refund_execution', sigFail3, '000004');
    assertExactRpcLockdown(norm, 'mark_refund_uncertain', sigUncertain5, '000004');
    assertExactRpcLockdown(norm, 'reconcile_mark_refund_not_executed', sigReconcile4, '000004');

    assert(
      norm.includes(
        'revoke execute on function public.prevent_provider_idempotency_key_mutation() from public, anon, authenticated'
      ),
      '000004 must revoke direct trigger function execution from public, anon, authenticated'
    );

    const fns = extractFunctionDefinitions(m0004);
    assert.equal(fns.length, 6, 'Expected 6 functions in 000004');
    for (const fn of fns) {
      assert(
        /set\s+search_path\s*=\s*pg_catalog,\s*public,(?:\s*extensions,)?\s*pg_temp/.test(fn.header),
        `000004 ${fn.name} must pin safe search_path ending in pg_temp`
      );
    }
  });

  test('4. Migration 000003 rollback restores pre-P0-A 11-arg reserve & 4-arg finalize without dangling owner_approvals refs', () => {
    const norm = normalizeSql(m0003Rollback);

    assert(
      norm.includes(`drop function if exists public.reserve_refund_execution(${sigReserve12})`),
      '000003_rollback must drop 12-arg reserve_refund_execution'
    );

    const fns = extractFunctionDefinitions(m0003Rollback);
    assert.equal(fns.length, 2, '000003_rollback must restore 2 pre-P0-A functions');

    const reserveFn = fns.find((f) => f.name === 'reserve_refund_execution');
    const finalizeFn = fns.find((f) => f.name === 'finalize_refund_execution');
    assert(reserveFn && finalizeFn, 'Missing restored reserve_refund_execution or finalize_refund_execution');

    assert(
      !reserveFn.body.includes('owner_approvals'),
      'Restored 11-arg reserve_refund_execution must not reference dropped owner_approvals'
    );
    assert(
      !finalizeFn.body.includes('owner_approvals'),
      'Restored 4-arg finalize_refund_execution must not reference dropped owner_approvals'
    );
    assert(
      !reserveFn.header.includes('p_require_owner_approval'),
      'Restored reserve_refund_execution must be the original 11-arg signature'
    );

    assertExactRpcLockdown(norm, 'reserve_refund_execution', sigReserve11, '000003_rollback');
    assertExactRpcLockdown(norm, 'finalize_refund_execution', sigFinalize4, '000003_rollback');
  });

  test('5. Migration 000003 rollback enforces pre-flight safety guards (P0-B deps, active executions, non-empty owner_approvals) and preserves provenance/refund data', () => {
    const norm = normalizeSql(m0003Rollback);

    assert(
      norm.includes('fail_refund_execution') &&
        norm.includes('mark_refund_uncertain') &&
        norm.includes('reconcile_mark_refund_not_executed'),
      '000003_rollback must check for dependent P0-B RPCs before dropping owner_approvals'
    );
    assert(
      norm.includes(`status in ('executing', 'uncertain_reconciliation_required')`),
      '000003_rollback must abort if executing or uncertain_reconciliation_required refund rows exist'
    );
    assert(
      norm.includes('select count(*) into v_approval_count from public.owner_approvals') &&
        norm.includes('if v_approval_count > 0 then raise exception'),
      '000003_rollback must refuse to silently drop non-empty owner_approvals'
    );
    assert(
      !norm.includes('drop table if exists public.provenance_ledger') &&
        !norm.includes('drop table if exists public.refund_authorizations') &&
        !norm.includes('truncate'),
      '000003_rollback must never destroy provenance_ledger or refund_authorizations data'
    );
  });

  test('6. Migration 000004 rollback preserves RPC permissions and schema compatibility with 000003', () => {
    const norm = normalizeSql(m0004Rollback);
    assert(
      norm.includes(`where status in ('executing', 'uncertain_reconciliation_required')`),
      '000004_rollback must block if executing or uncertain rows exist'
    );
    assert(
      norm.includes('alter column provider_idempotency_key drop not null'),
      '000004_rollback must drop NOT NULL on provider_idempotency_key so restored 000003 inserts do not crash'
    );
    assertExactRpcLockdown(norm, 'reserve_refund_execution', sigReserve12, '000004_rollback');
    assertExactRpcLockdown(norm, 'finalize_refund_execution', sigFinalize4, '000004_rollback');
  });

  test('7. Additive hardening migration 000005 covers already-migrated DBs dynamically and 000005 rollback fails safe', () => {
    const norm05 = normalizeSql(m0005);
    assert(norm05.includes('from pg_proc p'), '000005 must scan pg_proc dynamically');
    assert(
      norm05.includes("'reserve_refund_execution'") &&
        norm05.includes("'finalize_refund_execution'") &&
        norm05.includes("'fail_refund_execution'") &&
        norm05.includes("'mark_refund_uncertain'") &&
        norm05.includes("'reconcile_mark_refund_not_executed'") &&
        norm05.includes("'prevent_provider_idempotency_key_mutation'") &&
        norm05.includes("'set_factory_job_updated_at'"),
      '000005 must harden all financial RPCs and trigger functions'
    );
    assert(
      norm05.includes("has_function_privilege('public', p.oid, 'execute')") &&
        norm05.includes("has_function_privilege('anon', p.oid, 'execute')") &&
        norm05.includes("has_function_privilege('authenticated', p.oid, 'execute')"),
      '000005 must assert zero leaked privileges remain'
    );

    const norm05Rb = normalizeSql(m0005Rollback);
    assert(
      norm05Rb.includes('raise exception') && !norm05Rb.includes('grant execute'),
      '000005_rollback must fail safe and never re-grant PUBLIC/anon/authenticated EXECUTE'
    );
  });

  test('8. SupabasePersistentReplayStore RPC names and parameter names exactly match 000004/000007 SQL functions', () => {
    const norm07 = normalizeSql(m0007);
    assert(
      norm07.includes(`drop function if exists public.reserve_refund_execution(${sigReserve14})`),
      '000007 must drop 14-arg reserve_refund_execution before creating 15-arg'
    );
    assertExactRpcLockdown(norm07, 'reserve_refund_execution', sigReserve15, '000007');
    const norm07Rb = normalizeSql(m0007Rollback);
    assert(
      norm07Rb.includes('raise exception') &&
        !norm07Rb.includes('uq_refund_active_order on public.refund_authorizations (order_id)') &&
        !norm07Rb.includes('grant execute'),
      '000007_rollback must fail safe with RAISE EXCEPTION instead of restoring global order_id lock or 14-arg RPC'
    );

    const rpcExpectations: Array<{ rpc: string; params: string[]; sqlSource: string }> = [
      {
        rpc: 'reserve_refund_execution',
        params: [
          'p_owner_id',
          'p_request_id',
          'p_nonce',
          'p_order_id',
          'p_business_id',
          'p_approval_id',
          'p_amount_cents',
          'p_idempotency_key',
          'p_canonical_digest',
          'p_key_id',
          'p_expires_at',
          'p_require_owner_approval',
          'p_provider_name',
          'p_lease_seconds',
          'p_tenant_id',
        ],
        sqlSource: m0007,
      },
      {
        rpc: 'finalize_refund_execution',
        params: ['p_reservation_id', 'p_success', 'p_execution_tx_id', 'p_outcome_payload'],
        sqlSource: m0004,
      },
      {
        rpc: 'fail_refund_execution',
        params: ['p_reservation_id', 'p_reason', 'p_retry_allowed'],
        sqlSource: m0004,
      },
      {
        rpc: 'mark_refund_uncertain',
        params: [
          'p_reservation_id',
          'p_provider_outcome_status',
          'p_provider_tx_id',
          'p_reason',
          'p_outcome_payload',
        ],
        sqlSource: m0004,
      },
      {
        rpc: 'reconcile_mark_refund_not_executed',
        params: ['p_reservation_id', 'p_retry_allowed', 'p_reason', 'p_outcome_payload'],
        sqlSource: m0004,
      },
    ];

    for (const item of rpcExpectations) {
      assert(
        replayStoreTs.includes(`.rpc('${item.rpc}'`),
        `SupabasePersistentReplayStore missing .rpc('${item.rpc}')`
      );
      for (const param of item.params) {
        assert(
          replayStoreTs.includes(`${param}:`),
          `SupabasePersistentReplayStore missing parameter ${param} for ${item.rpc}`
        );
        assert(
          item.sqlSource.includes(param),
          `SQL function ${item.rpc} missing parameter ${param}`
        );
      }
    }
  });

  test('9. RLS enabled on all provenance, approval, and refund tables without client write policies', () => {
    const norm02 = normalizeSql(m0002);
    const norm03 = normalizeSql(m0003);
    assert(norm02.includes('alter table public.provenance_signing_keys enable row level security'));
    assert(norm02.includes('alter table public.provenance_ledger enable row level security'));
    assert(norm02.includes('alter table public.refund_authorizations enable row level security'));
    assert(norm03.includes('alter table public.owner_approvals enable row level security'));

    // Ensure no client INSERT/UPDATE/DELETE/ALL policies were added to ledger/refund/approval tables
    assert(!/on public\.(provenance_ledger|refund_authorizations|provenance_signing_keys) for (insert|update|delete|all)/.test(norm02));
    assert(!/on public\.owner_approvals for (insert|update|delete|all)/.test(norm03));
  });

  test('10. Live Postgres SQL verification script exists and covers privilege/signature/search_path assertions', () => {
    const normVer = normalizeSql(verifySql);
    assert(normVer.includes('to_regprocedure(v_sig)'));
    assert(normVer.includes("has_function_privilege('public'"));
    assert(normVer.includes("has_function_privilege('anon'"));
    assert(normVer.includes("has_function_privilege('authenticated'"));
    assert(normVer.includes("has_function_privilege('service_role'"));
    assert(normVer.includes("cfg !~ 'pg_temp$'"));
    assert(normVer.includes('c.relrowsecurity'));
    assert(m0001.includes('set_factory_job_updated_at'));
  });

  test('11. Migration 000008 restricts 15-arg reserve & record_authoritative_order_refund RPCs, locks down orders/memberships RLS, and fails safe on rollback', () => {
    const norm08 = normalizeSql(m0008);
    const sigRecordOrderRefund = 'uuid, uuid, integer, text, uuid, timestamptz';
    assertExactRpcLockdown(norm08, 'reserve_refund_execution', sigReserve15, '000008');
    assertExactRpcLockdown(
      norm08,
      'record_authoritative_order_refund',
      sigRecordOrderRefund,
      '000008'
    );

    const fns08 = extractFunctionDefinitions(m0008);
    assert.equal(fns08.length, 2, 'Expected 2 functions in 000008');
    for (const fn of fns08) {
      assert(fn.header.includes('security definer'), `000008 ${fn.name} must be SECURITY DEFINER`);
      assert(
        /set\s+search_path\s*=\s*pg_catalog,\s*public,\s*extensions,\s*pg_temp/.test(fn.header),
        `000008 ${fn.name} must pin search_path ending in pg_temp`
      );
    }

    assert(norm08.includes('alter table public.orders enable row level security'));
    assert(norm08.includes('alter table public.business_memberships enable row level security'));
    assert(norm08.includes('drop policy if exists "owners view and manage their orders" on public.orders'));
    assert(
      !/create\s+policy[\s\S]*?on\s+public\.(orders|business_memberships)\s+for\s+(insert|update|delete|all)/.test(
        norm08
      ),
      '000008 must not create client write RLS policies on orders or business_memberships'
    );

    assert(orderStoreTs.includes(".rpc('record_authoritative_order_refund'"));
    for (const p of [
      'p_order_uuid',
      'p_business_uuid',
      'p_refund_amount_cents',
      'p_refund_tx_id',
      'p_reservation_id',
      'p_refunded_at',
    ]) {
      assert(orderStoreTs.includes(`${p}:`), `orderStore.ts missing ${p}`);
      assert(m0008.includes(p), `000008 missing ${p}`);
    }

    const norm08Rb = normalizeSql(m0008Rollback);
    assert(
      norm08Rb.includes('raise exception') && !norm08Rb.includes('grant execute'),
      '000008_rollback must fail safe with RAISE EXCEPTION'
    );
  });

  test('12. Migration 000009 preserves 15-arg reserve_refund_execution lockdown, enforces H3 expiration consistency, and fails safe on rollback', () => {
    const norm09 = normalizeSql(m0009);
    assertExactRpcLockdown(norm09, 'reserve_refund_execution', sigReserve15, '000009');

    const fns09 = extractFunctionDefinitions(m0009);
    assert.equal(fns09.length, 1, 'Expected 1 function in 000009');
    assert(fns09[0].header.includes('security definer'), '000009 reserve_refund_execution must be SECURITY DEFINER');
    assert(
      /set\s+search_path\s*=\s*pg_catalog,\s*public,\s*extensions,\s*pg_temp/.test(fns09[0].header),
      '000009 reserve_refund_execution must pin search_path ending in pg_temp'
    );

    assert(norm09.includes("'refund_request_expired'"));
    assert(norm09.includes("'approval_exceeds_request_expiration'"));
    assert(norm09.includes("'missing_or_malformed_timestamp'"));
    assert(norm09.includes('v_approval.expires_at <= v_now'));
    assert(norm09.includes('v_approval.expires_at > v_effective_req_expires'));
    assert(norm09.includes('v_effective_req_expires <= v_now'));
    assert(norm09.includes('chk_auth_refund_req_expires_after_created'));

    const norm09Rb = normalizeSql(m0009Rollback);
    assert(
      norm09Rb.includes('raise exception') && !norm09Rb.includes('grant execute'),
      '000009_rollback must fail safe with RAISE EXCEPTION'
    );
  });

  console.log('\n=== P0-A Supabase RPC Security & Rollback Verification ===');
  let failures = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`PASS: ${r.name}`);
    } else {
      failures++;
      console.error(`FAIL: ${r.name}\n      ${r.detail}`);
    }
  }
  console.log(`\nSummary: ${results.length - failures}/${results.length} static migration checks passed.`);
  console.log(
    'Live Postgres execution note: NOT VERIFIED in workspace (no local PostgreSQL/psql runtime; execute supabase/verification/verify_p0a_rpc_security.sql against staging Supabase to verify live catalog grants).'
  );
  if (failures > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
