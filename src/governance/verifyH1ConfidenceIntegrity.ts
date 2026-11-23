import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import {
  appendProvenanceHop,
  buildCanonicalProvenancePayload,
  normalizeConfidenceBasisPoints,
  type FinanceRefundRequest,
} from './provenance';
import { evaluateFinanceRefund } from './financeRefundGate';
import {
  createKeyringSignatureVerifier,
  ingestAuthenticatedRefundRequest,
  signCanonicalPayloadHmac,
  type ServerKeyring,
} from '../../server/provenanceAuth';
import {
  SqlitePersistentReplayStore,
  SupabasePersistentReplayStore,
} from '../../server/replayStore';
import {
  executeAuthorizedFinanceRefund,
  type PaymentRefundProviderAdapter,
} from '../../server/financeExecutor';
import { createGovernanceRouter } from '../../server/governanceRoutes';
import type { GovernanceAuthVerifier } from '../../server/governanceAuth';
import type { AuthoritativeOrderStore } from '../../server/orderStore';

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

function createMockSupabaseClient(opts: {
  authReqRow?: { data: any; error: any };
  ledgerRow?: { data: any; error: any };
}) {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  if (table === 'authenticated_refund_requests') {
                    return opts.authReqRow ?? { data: null, error: null };
                  }
                  if (table === 'provenance_ledger') {
                    return opts.ledgerRow ?? { data: null, error: null };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  } as any;
}

async function startTestHttpServer(opts: {
  keyring: ServerKeyring;
  replayStore: SqlitePersistentReplayStore;
  authVerifier: GovernanceAuthVerifier;
  orderStore: AuthoritativeOrderStore;
  paymentProvider: PaymentRefundProviderAdapter;
}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(
    createGovernanceRouter({
      replayStore: opts.replayStore,
      getKeyring: () => opts.keyring,
      getAuthVerifier: () => opts.authVerifier,
      orderStore: opts.orderStore,
      paymentProvider: opts.paymentProvider,
    })
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function runTests() {
  const results: TestResult[] = [];
  const pass = (name: string, detail?: string) => {
    results.push({ name, passed: true, detail });
  };

  // Ephemeral runtime-only secret for testing
  const secret = crypto.randomBytes(32).toString('hex');
  const keyring: ServerKeyring = {
    activeKeyId: 'ephemeral-h1-key',
    keys: {
      'ephemeral-h1-key': {
        keyId: 'ephemeral-h1-key',
        secret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
      },
    },
  };
  const verifySig = createKeyringSignatureVerifier(keyring);
  const store = new SqlitePersistentReplayStore(':memory:');
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const h1OrderAmounts = new Map<string, number>([
    ['biz-h1:ord-h1-low-conf', 1500],
    ['biz-h1:ord-h1-init-auth', 1500],
    ['biz-h1:ord-h1-high-conf', 1900],
    ['biz-h1:ord-h1-legacy-v1', 1500],
    ['biz-h1:ord-h1-unpersisted', 1500],
    ['biz-h1:ord-h1-corrupt-sqlite', 1500],
  ]);
  const testH1OrderStore: AuthoritativeOrderStore = {
    configured: true,
    getOrderForBusiness: async ({ orderId, businessId }) => {
      const amountCents = h1OrderAmounts.get(`${businessId}:${orderId}`);
      if (amountCents === undefined) return null;
      return {
        orderId,
        businessId,
        businessStatus: 'active',
        ownerId,
        tenantId: 'tenant-h1',
        amountCents,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      };
    },
  };
  let providerCalls = 0;

  const provider: PaymentRefundProviderAdapter = {
    providerName: 'h1_test_provider',
    supportsIdempotencyKey: true,
    supportsRefundLookup: true,
    executeRefund: async ({ providerIdempotencyKey }) => {
      providerCalls += 1;
      return {
        outcome: 'CONFIRMED_SUCCESS',
        txId: `tx-h1-${providerIdempotencyKey.slice(-8)}`,
      };
    },
  };

  try {
    // -------------------------------------------------------------------------
    // TEST 1 & 2: Confidence 0.40 -> 0.99 tampering invalidates v2 signature &
    // low-confidence execute_under_policy cannot bypass Owner Approval
    // -------------------------------------------------------------------------
    assert.equal(normalizeConfidenceBasisPoints(0.4), 4000);
    assert.equal(normalizeConfidenceBasisPoints(0.99), 9900);

    const lowConfReq = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-h1',
        order_id: 'ord-h1-low-conf',
        customer_email: 'buyer@example.test',
        amount_usd: 15.0, // Below $25 auto-refund cap!
        reason: 'Low confidence auto-refund candidate',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-h1-1',
        raw_trigger_payload: '{"ticket":"h1-1"}',
        confidence: 0.4,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    assert.equal(lowConfReq.provenance?.ingestion_auth?.canonical_version, 'v2');
    await store.recordProvenanceOrigin(lowConfReq.provenance!, lowConfReq.order_id);

    // Unmodified low-confidence request must ESCALATE (never auto-execute)
    const unmodifiedRes = await executeAuthorizedFinanceRefund(lowConfReq, {
      keyring,
      replayStore: store,
      paymentProvider: provider,
    });
    assert.equal(unmodifiedRes.status, 'ESCALATED_TO_OWNER_APPROVAL');
    assert.equal(unmodifiedRes.executedNewRefund, false);
    assert.equal(providerCalls, 0);

    // Tampered confidence 0.40 -> 0.99 without re-signing must fail verification
    const tamperedConfReq: FinanceRefundRequest = {
      ...lowConfReq,
      provenance: {
        ...lowConfReq.provenance!,
        confidence: 0.99,
      },
    };
    const tamperedGateDecision = evaluateFinanceRefund(tamperedConfReq, {
      verifyIngestionSignature: verifySig,
    });
    assert.equal(tamperedGateDecision.decision, 'REJECT_SECURITY_VIOLATION');
    assert.ok(
      tamperedGateDecision.reasons.some((r) => r.includes('signature mismatch'))
    );

    const tamperedExecRes = await executeAuthorizedFinanceRefund(tamperedConfReq, {
      keyring,
      replayStore: store,
      paymentProvider: provider,
    });
    assert.equal(tamperedExecRes.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(tamperedExecRes.executedNewRefund, false);
    assert.equal(providerCalls, 0);
    pass(
      'H1-1 & H1-2 — Confidence 0.40 -> 0.99 tampering rejected & low-confidence cannot bypass owner approval'
    );

    // -------------------------------------------------------------------------
    // TEST 3: Changing or stripping initial_authority_level invalidates signature
    // -------------------------------------------------------------------------
    const recReq = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-h1',
        order_id: 'ord-h1-init-auth',
        customer_email: 'buyer@example.test',
        amount_usd: 15.0,
        reason: 'Initial authority tamper test',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-h1-3',
        raw_trigger_payload: '{"ticket":"h1-3"}',
        confidence: 0.95,
        authority_level: 'recommend_only',
      },
      keyring
    );
    await store.recordProvenanceOrigin(recReq.provenance!, recReq.order_id);

    const escalatedInitialAuthReq: FinanceRefundRequest = {
      ...recReq,
      provenance: {
        ...recReq.provenance!,
        authority_level: 'execute_under_policy',
        initial_authority_level: 'execute_under_policy',
      },
    };
    const resInitAuthTampered = await executeAuthorizedFinanceRefund(
      escalatedInitialAuthReq,
      {
        keyring,
        replayStore: store,
        paymentProvider: provider,
      }
    );
    assert.equal(resInitAuthTampered.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(providerCalls, 0);

    const strippedInitialAuthReq: FinanceRefundRequest = {
      ...recReq,
      provenance: {
        ...recReq.provenance!,
        initial_authority_level: undefined,
      },
    };
    const resInitAuthStripped = evaluateFinanceRefund(strippedInitialAuthReq, {
      verifyIngestionSignature: verifySig,
    });
    assert.equal(resInitAuthStripped.decision, 'REJECT_SECURITY_VIOLATION');
    pass('H1-3 — Mutating or stripping initial_authority_level fails closed');

    // -------------------------------------------------------------------------
    // TEST 4 & 5: Missing or invalid confidence values fail closed everywhere
    // -------------------------------------------------------------------------
    const badConfidenceValues: unknown[] = [
      undefined,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0.01,
      1.01,
      '0.95',
    ];

    for (const badVal of badConfidenceValues) {
      assert.throws(() =>
        ingestAuthenticatedRefundRequest(
          {
            business_id: 'biz-h1',
            order_id: 'ord-h1-bad-ingest',
            customer_email: 'buyer@example.test',
            amount_usd: 10.0,
            reason: 'Bad confidence ingest',
            source_agent: 'customer_support',
            trigger_type: 'customer_ticket',
            trigger_id: 'tkt-bad',
            raw_trigger_payload: '{}',
            confidence: badVal as number,
            authority_level: 'execute_under_policy',
          },
          keyring
        )
      );

      const mutatedBadReq: FinanceRefundRequest = {
        ...lowConfReq,
        provenance: {
          ...lowConfReq.provenance!,
          confidence: badVal as number,
        },
      };
      const gateBad = evaluateFinanceRefund(mutatedBadReq, {
        verifyIngestionSignature: verifySig,
      });
      assert.equal(
        gateBad.decision,
        'REJECT_SECURITY_VIOLATION',
        `Expected REJECT_SECURITY_VIOLATION for confidence=${String(badVal)}`
      );

      const execBad = await executeAuthorizedFinanceRefund(mutatedBadReq, {
        keyring,
        replayStore: store,
        paymentProvider: provider,
      });
      assert.equal(execBad.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(providerCalls, 0);
    }
    pass('H1-4 & H1-5 — Missing, NaN, infinite, non-numeric, and out-of-range confidence values fail closed');

    // -------------------------------------------------------------------------
    // TEST 6: Valid high-confidence v2 signed request executes; legacy v1 fails closed
    // -------------------------------------------------------------------------
    const highConfReq = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-h1',
        order_id: 'ord-h1-high-conf',
        customer_email: 'buyer@example.test',
        amount_usd: 19.0,
        reason: 'Valid high-confidence refund',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-h1-6',
        raw_trigger_payload: '{"ticket":"h1-6"}',
        confidence: 0.96,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    await store.recordProvenanceOrigin(highConfReq.provenance!, highConfReq.order_id);
    const highConfWithHop: FinanceRefundRequest = {
      ...highConfReq,
      provenance: appendProvenanceHop(highConfReq.provenance!, 'security'),
    };
    const highConfRes = await executeAuthorizedFinanceRefund(highConfWithHop, {
      keyring,
      replayStore: store,
      orderStore: testH1OrderStore,
      requirePersistedProvenance: true,
      paymentProvider: provider,
    });
    assert.equal(highConfRes.status, 'EXECUTED');
    assert.equal(highConfRes.executedNewRefund, true);
    assert.equal(providerCalls, 1);

    // Construct an actual cryptographically valid legacy v1 signature -> MUST fail closed!
    const v1BaseReq = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-h1',
        order_id: 'ord-h1-legacy-v1',
        customer_email: 'buyer@example.test',
        amount_usd: 15.0,
        reason: 'Legacy v1 signature test',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-h1-v1',
        raw_trigger_payload: '{"ticket":"h1-v1"}',
        confidence: 0.99,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const v1ProvDraft = {
      ...v1BaseReq.provenance!,
      ingestion_auth: {
        ...v1BaseReq.provenance!.ingestion_auth!,
        canonical_version: 'v1' as const,
      },
    };
    const v1Canonical = buildCanonicalProvenancePayload({
      request: v1BaseReq,
      provenance: v1ProvDraft,
    });
    assert.ok(!v1Canonical.includes('confidence_bps'));
    const v1SignedReq: FinanceRefundRequest = {
      ...v1BaseReq,
      provenance: {
        ...v1ProvDraft,
        ingestion_auth: {
          ...v1ProvDraft.ingestion_auth,
          signature: signCanonicalPayloadHmac(v1Canonical, secret),
        },
      },
    };
    const v1Res = await executeAuthorizedFinanceRefund(v1SignedReq, {
      keyring,
      replayStore: store,
      paymentProvider: provider,
    });
    assert.equal(v1Res.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(providerCalls, 1);
    pass('H1-6 — Valid high-confidence v2 request executes; legacy v1 signature fails closed');

    // -------------------------------------------------------------------------
    // TEST 7: Missing or corrupted persisted provenance snapshot cannot authorize
    // execution, client priorProvenance is ignored, and Supabase store never
    // substitutes confidence = 1
    // -------------------------------------------------------------------------
    // 7a. Unpersisted valid v2 request with requirePersistedProvenance: true fails closed
    const unpersistedReq = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-h1',
        order_id: 'ord-h1-unpersisted',
        customer_email: 'buyer@example.test',
        amount_usd: 15.0,
        reason: 'Not recorded in ledger',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-h1-7a',
        raw_trigger_payload: '{"ticket":"h1-7a"}',
        confidence: 0.95,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const missingSnapshotRes = await executeAuthorizedFinanceRefund(unpersistedReq, {
      keyring,
      replayStore: store,
      requirePersistedProvenance: true,
      paymentProvider: provider,
    });
    assert.equal(missingSnapshotRes.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(providerCalls, 1);

    // 7b. Client-supplied priorProvenance property on req is ignored
    const spoofedPriorReq = {
      ...lowConfReq,
      priorProvenance: {
        ...lowConfReq.provenance!,
        confidence: 0.99,
      },
      provenance: {
        ...lowConfReq.provenance!,
        confidence: 0.99,
      },
    } as unknown as FinanceRefundRequest;
    const spoofedPriorRes = await executeAuthorizedFinanceRefund(spoofedPriorReq, {
      keyring,
      replayStore: store,
      requirePersistedProvenance: true,
      paymentProvider: provider,
    });
    assert.equal(spoofedPriorRes.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(providerCalls, 1);

    // 7c. Corrupted SQLite persisted snapshot (invalid confidence / invalid JSON) fails closed
    const corruptDbPath = `/tmp/h1-corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
    try {
      const corruptStore = new SqlitePersistentReplayStore(corruptDbPath);
      const reqCorrupt = ingestAuthenticatedRefundRequest(
        {
          business_id: 'biz-h1',
          order_id: 'ord-h1-corrupt-sqlite',
          customer_email: 'buyer@example.test',
          amount_usd: 15.0,
          reason: 'Corrupt sqlite snapshot test',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-h1-7c',
          raw_trigger_payload: '{"ticket":"h1-7c"}',
          confidence: 0.95,
          authority_level: 'execute_under_policy',
        },
        keyring
      );
      await corruptStore.recordProvenanceOrigin(reqCorrupt.provenance!, reqCorrupt.order_id);
      corruptStore.close();

      const rawDb = new DatabaseSync(corruptDbPath);
      const tamperedJson = JSON.stringify({
        ...reqCorrupt.provenance!,
        confidence: null,
      });
      rawDb
        .prepare('UPDATE provenance_ledger SET provenance_json = ? WHERE request_id = ?')
        .run(tamperedJson, reqCorrupt.provenance!.request_id);
      rawDb.close();

      const reopenedCorruptStore = new SqlitePersistentReplayStore(corruptDbPath);
      const corruptExecRes = await executeAuthorizedFinanceRefund(reqCorrupt, {
        keyring,
        replayStore: reopenedCorruptStore,
        requirePersistedProvenance: true,
        paymentProvider: provider,
      });
      assert.equal(corruptExecRes.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(corruptExecRes.code, 'PROVENANCE_SNAPSHOT_CORRUPTED_OR_UNAVAILABLE');
      assert.equal(providerCalls, 1);
      reopenedCorruptStore.close();
    } finally {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          const fs = await import('node:fs');
          if (fs.existsSync(corruptDbPath + suffix)) fs.unlinkSync(corruptDbPath + suffix);
        } catch {}
      }
    }

    // 7d. SupabasePersistentReplayStore.getProvenanceSnapshot never substitutes confidence=1
    const sbPartialClient = createMockSupabaseClient({
      authReqRow: { data: null, error: null },
      ledgerRow: {
        data: {
          request_id: lowConfReq.provenance!.request_id,
          nonce: lowConfReq.provenance!.nonce,
          bound_order_id: lowConfReq.order_id,
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-h1-1',
          trigger_raw_hash: lowConfReq.provenance!.original_trigger.raw_hash,
          initial_authority_level: 'execute_under_policy',
          current_authority_level: 'execute_under_policy',
          chain: lowConfReq.provenance!.chain,
          policy_version: '2026.11.0',
          created_at: lowConfReq.provenance!.created_at,
        },
        error: null,
      },
    });
    const sbPartialStore = new SupabasePersistentReplayStore(
      'https://example.supabase.co',
      'service-role-test-placeholder',
      undefined,
      sbPartialClient
    );
    await assert.rejects(
      () => sbPartialStore.getProvenanceSnapshot(lowConfReq.provenance!.request_id),
      /fail-closed|Incomplete provenance snapshot/i
    );

    const sbValidClient = createMockSupabaseClient({
      authReqRow: {
        data: {
          order_id: lowConfReq.order_id,
          provenance_json: lowConfReq.provenance,
        },
        error: null,
      },
      ledgerRow: {
        data: {
          request_id: lowConfReq.provenance!.request_id,
          nonce: lowConfReq.provenance!.nonce,
          bound_order_id: lowConfReq.order_id,
          trigger_raw_hash: lowConfReq.provenance!.original_trigger.raw_hash,
          initial_authority_level: 'execute_under_policy',
        },
        error: null,
      },
    });
    const sbValidStore = new SupabasePersistentReplayStore(
      'https://example.supabase.co',
      'service-role-test-placeholder',
      undefined,
      sbValidClient
    );
    const sbSnap = await sbValidStore.getProvenanceSnapshot(lowConfReq.provenance!.request_id);
    assert.equal(sbSnap?.confidence, 0.4);

    // 7e. HTTP POST /api/governance/provenance/ingest rejects missing/invalid confidence (400)
    //     and POST /api/governance/finance/refund rejects unpersisted request (403)
    const ownerTok = `tok-owner-${crypto.randomBytes(8).toString('hex')}`;
    const authVerifier: GovernanceAuthVerifier = {
      configured: true,
      ownerUserIds: new Set([ownerId]),
      verifyAccessToken: async (tok) =>
        tok === ownerTok
          ? {
              id: ownerId,
              email: 'owner@example.test',
              appMetadata: { role: 'owner', tenant_id: 'tenant-h1' },
            }
          : null,
    };
    const server = await startTestHttpServer({
      keyring,
      replayStore: store,
      authVerifier,
      orderStore: testH1OrderStore,
      paymentProvider: provider,
    });
    try {
      const rMissingConfIngest = await fetch(
        `${server.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerTok}`,
          },
          body: JSON.stringify({
            business_id: 'biz-h1',
            order_id: 'ord-http-missing-conf',
            amount_usd: 15.0,
            authority_level: 'execute_under_policy',
          }),
        }
      );
      assert.equal(rMissingConfIngest.status, 400);

      const rUnpersistedRefund = await fetch(
        `${server.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerTok}`,
          },
          body: JSON.stringify(unpersistedReq),
        }
      );
      assert.equal(rUnpersistedRefund.status, 403);
      assert.equal(providerCalls, 1);
    } finally {
      await server.close();
    }

    pass(
      'H1-7 — Missing/corrupted persisted provenance snapshot fails closed, client priorProvenance ignored, and Supabase store preserves real confidence'
    );

    console.log('\n=== H1 Cryptographic Confidence Integrity Verification ===');
    for (const r of results) {
      console.log(`PASS: ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    }
    console.log(`\nALL ${results.length} H1 REGRESSION CHECKS PASSED.\n`);
  } finally {
    store.close();
  }
}

runTests().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
