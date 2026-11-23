import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type ServerKeyring,
  ingestAuthenticatedRefundRequest,
  sha256HexNode,
} from '../../server/provenanceAuth';
import { buildCanonicalProvenancePayload } from './provenance';
import {
  type PersistentReplayStore,
  SqlitePersistentReplayStore,
} from '../../server/replayStore';
import {
  type PaymentRefundProviderAdapter,
  executeAuthorizedFinanceRefund,
  identifyStaleRefundReservations,
  reconcileFinanceRefund,
} from '../../server/financeExecutor';
import type { AuthoritativeOrderStore } from '../../server/orderStore';

const testP0BOrderStore: AuthoritativeOrderStore = {
  configured: true,
  getOrderForBusiness: async ({ orderId, businessId }) => {
    if (businessId !== 'biz-p0b') return null;
    const amountCents =
      orderId === 'ord-p0b-09-stale'
        ? 1800
        : orderId === 'ord-p0b-04'
        ? 1500
        : 12500;
    return {
      orderId,
      businessId,
      businessStatus: 'active',
      ownerId: 'usr-owner-p0b',
      tenantId: 'usr-owner-p0b',
      amountCents,
      refundedAmountCents: 0,
      currency: 'USD',
      paymentStatus: 'paid',
      status: 'completed',
      eligibleForRefund: true,
    };
  },
};

function createEphemeralKeyring(): ServerKeyring {
  const secret = crypto.randomBytes(32).toString('hex');
  return {
    activeKeyId: 'ephemeral-p0b-key',
    keys: {
      'ephemeral-p0b-key': {
        keyId: 'ephemeral-p0b-key',
        secret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    },
  };
}

class SimulatedIdempotentProvider {
  public readonly providerName = 'simulated-provider-no-real-money';
  public executeCallsByOrder = new Map<string, number>();
  public successCountByOrder = new Map<string, number>();
  public refundsByProviderIdemKey = new Map<
    string,
    { txId: string; orderId: string; amountCents: number }
  >();
  public keysPassedPerOrder = new Map<string, string[]>();

  createAdapter(behavior: {
    mode:
      | 'succeed'
      | 'succeed_but_timeout_response'
      | 'throw_network_error'
      | 'confirmed_reject'
      | 'confirmed_reject_non_retryable'
      | 'record_at_provider_then_timeout';
    supportsIdempotencyKey?: boolean;
    supportsRefundLookup?: boolean;
    lookupThrows?: boolean;
    lookupUnknown?: boolean;
  }): PaymentRefundProviderAdapter {
    const supportsIdem = behavior.supportsIdempotencyKey ?? true;
    const supportsLookup = behavior.supportsRefundLookup ?? true;

    return {
      providerName: this.providerName,
      supportsIdempotencyKey: supportsIdem,
      supportsRefundLookup: supportsLookup,
      executeRefund: async ({ request, providerIdempotencyKey, amountCents }) => {
        this.executeCallsByOrder.set(
          request.order_id,
          (this.executeCallsByOrder.get(request.order_id) ?? 0) + 1
        );
        const list = this.keysPassedPerOrder.get(request.order_id) ?? [];
        list.push(providerIdempotencyKey);
        this.keysPassedPerOrder.set(request.order_id, list);

        // Enforce provider-side idempotency replay protection if already processed
        if (supportsIdem) {
          const existing = this.refundsByProviderIdemKey.get(providerIdempotencyKey);
          if (existing) {
            return {
              outcome: 'CONFIRMED_SUCCESS',
              txId: existing.txId,
              providerStatus: 'succeeded',
            };
          }
        }

        if (behavior.mode === 'throw_network_error') {
          throw new Error('Simulated TCP socket hangup mid-request');
        }

        if (behavior.mode === 'succeed_but_timeout_response') {
          return {
            outcome: 'UNKNOWN_OR_TIMEOUT',
            reason: 'Simulated gateway 504 timeout before response receipt',
            errorCode: 'GATEWAY_TIMEOUT',
          };
        }

        if (behavior.mode === 'record_at_provider_then_timeout') {
          // Provider actually charged/refunded, but network timed out returning HTTP response!
          const txId = `sim-tx-timeout-processed-${request.order_id}`;
          this.refundsByProviderIdemKey.set(providerIdempotencyKey, {
            txId,
            orderId: request.order_id,
            amountCents,
          });
          this.successCountByOrder.set(
            request.order_id,
            (this.successCountByOrder.get(request.order_id) ?? 0) + 1
          );
          return {
            outcome: 'UNKNOWN_OR_TIMEOUT',
            reason: 'Simulated response drop AFTER provider processed refund',
            errorCode: 'RESPONSE_LOST',
          };
        }

        if (behavior.mode === 'confirmed_reject') {
          return {
            outcome: 'CONFIRMED_FAILURE',
            reason: 'Simulated definitive provider rejection (temporary lock)',
            errorCode: 'PROVIDER_DECLINED_RETRYABLE',
            retryable: true,
          };
        }

        if (behavior.mode === 'confirmed_reject_non_retryable') {
          return {
            outcome: 'CONFIRMED_FAILURE',
            reason: 'Simulated permanent failure (charge already reversed)',
            errorCode: 'ALREADY_REFUNDED_EXTERNAL',
            retryable: false,
          };
        }

        const txId = `sim-tx-${request.order_id}-${crypto.randomBytes(4).toString('hex')}`;
        this.refundsByProviderIdemKey.set(providerIdempotencyKey, {
          txId,
          orderId: request.order_id,
          amountCents,
        });
        this.successCountByOrder.set(
          request.order_id,
          (this.successCountByOrder.get(request.order_id) ?? 0) + 1
        );
        return {
          outcome: 'CONFIRMED_SUCCESS',
          txId,
          providerRefundId: txId,
          providerStatus: 'succeeded',
        };
      },
      lookupRefundByIdempotencyKey: supportsLookup
        ? async ({ providerIdempotencyKey }) => {
            if (behavior.lookupThrows) {
              throw new Error('Simulated provider lookup API outage');
            }
            if (behavior.lookupUnknown) {
              return {
                outcome: 'UNKNOWN_OR_UNSUPPORTED',
                reason: 'Simulated ambiguous provider lookup response',
              };
            }
            const found = this.refundsByProviderIdemKey.get(providerIdempotencyKey);
            if (found) {
              return {
                outcome: 'FOUND_SUCCESS',
                txId: found.txId,
                providerRefundId: found.txId,
                providerStatus: 'succeeded',
              };
            }
            return {
              outcome: 'CONFIRMED_NOT_EXECUTED',
              reason: 'Provider confirms no refund exists for this provider_idempotency_key',
            };
          }
        : undefined,
    };
  }

  assertZeroDuplicateRefunds(): void {
    for (const [orderId, count] of this.successCountByOrder.entries()) {
      assert.ok(
        count <= 1,
        `CRITICAL INVARIANT VIOLATION: order "${orderId}" executed ${count} provider refunds!`
      );
    }
  }
}

async function runP0BCrashRecoveryTests() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0b-crash-recovery-'));
  const keyring = createEphemeralKeyring();
  const simProvider = new SimulatedIdempotentProvider();
  const memStore = new SqlitePersistentReplayStore(':memory:');
  let passed = 0;

  const pass = (name: string, detail: string) => {
    passed += 1;
    console.log(`[PASS] ${name} -> ${detail}`);
  };

  const makeOwnerApprovedReq = async (
    store: PersistentReplayStore,
    orderId: string,
    approvalId: string,
    amountUsd = 125.0
  ) => {
    const req = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-p0b',
        order_id: orderId,
        customer_email: 'synthetic-p0b@example.test',
        amount_usd: amountUsd,
        reason: `P0-B test refund for ${orderId}`,
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: `tkt-${orderId}`,
        raw_trigger_payload: JSON.stringify({ orderId }),
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    await store.recordOwnerApproval({
      approvalId,
      requestId: req.provenance!.request_id,
      orderId,
      businessId: 'biz-p0b',
      amountCents: Math.round(amountUsd * 100),
      approvedByUserId: 'usr-owner-p0b',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ownerId: 'usr-owner-p0b',
      tenantId: 'usr-owner-p0b',
    });
    return {
      ...req,
      provenance: {
        ...req.provenance!,
        owner_approval_id: approvalId,
      },
    };
  };

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Provider succeeds and database finalization succeeds
    // -------------------------------------------------------------------------
    const req1 = await makeOwnerApprovedReq(memStore, 'ord-p0b-01', 'apr-p0b-01');
    const res1 = await executeAuthorizedFinanceRefund(req1, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(res1.status, 'EXECUTED');
    assert.equal(res1.executedNewRefund, true);
    assert.ok(res1.providerIdempotencyKey.startsWith('prov-idem-'));
    const rsv1 = await memStore.getRefundReservation({ reservationId: res1.reservationId });
    assert.equal(rsv1?.status, 'executed');
    assert.equal(rsv1?.providerOutcomeStatus, 'confirmed_success');
    const apr1 = await memStore.getOwnerApproval('apr-p0b-01');
    assert.equal(apr1?.status, 'consumed');
    assert.equal(simProvider.successCountByOrder.get('ord-p0b-01'), 1);
    pass('P0B-1 — Provider succeeds & DB finalization succeeds', `tx=${res1.executionTxId}`);

    // -------------------------------------------------------------------------
    // TEST 2: Provider succeeds but finalization throws (must NEVER call failRefundExecution!)
    // -------------------------------------------------------------------------
    const req2 = await makeOwnerApprovedReq(memStore, 'ord-p0b-02', 'apr-p0b-02');
    let failCalledCount2 = 0;
    const failingFinalizeStore: PersistentReplayStore = {
      recordProvenanceOrigin: (p, o) => memStore.recordProvenanceOrigin(p, o),
      getProvenanceSnapshot: (r) => memStore.getProvenanceSnapshot(r),
      recordOwnerApproval: (i) => memStore.recordOwnerApproval(i),
      getOwnerApproval: (a) => memStore.getOwnerApproval(a),
      revokeOwnerApproval: (a) => memStore.revokeOwnerApproval(a),
      getReplayPrecheck: (i) => memStore.getReplayPrecheck(i),
      reserveRefundExecution: (i) => memStore.reserveRefundExecution(i),
      finalizeRefundExecution: async () => {
        throw new Error('Simulated SQLITE_BUSY / connection drop during finalization');
      },
      failRefundExecution: async (i) => {
        failCalledCount2 += 1;
        return memStore.failRefundExecution(i);
      },
      markRefundUncertain: (i) => memStore.markRefundUncertain(i),
      reconcileMarkNotExecuted: (i) => memStore.reconcileMarkNotExecuted(i),
      getRefundReservation: (f) => memStore.getRefundReservation(f),
      listStaleExecutingReservations: (n) => memStore.listStaleExecutingReservations(n),
      listUncertainReservations: () => memStore.listUncertainReservations(),
      close: () => {},
    };
    const res2 = await executeAuthorizedFinanceRefund(req2, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: failingFinalizeStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(res2.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');
    assert.equal(res2.executedNewRefund, false);
    assert.equal(res2.uncertaintyCode, 'FINALIZATION_FAILED_AFTER_PROVIDER_SUCCESS');
    assert.ok(res2.knownProviderTxId?.startsWith('sim-tx-ord-p0b-02'));
    assert.equal(failCalledCount2, 0, 'failRefundExecution must NEVER be called after provider success');
    const rsv2 = await memStore.getRefundReservation({ reservationId: res2.reservationId });
    assert.equal(rsv2?.status, 'uncertain_reconciliation_required');
    assert.equal(rsv2?.providerOutcomeStatus, 'finalization_failed_after_success');
    const apr2 = await memStore.getOwnerApproval('apr-p0b-02');
    assert.equal(apr2?.status, 'approved');
    assert.equal(simProvider.successCountByOrder.get('ord-p0b-02'), 1);
    pass(
      'P0B-2 — Provider succeeds but DB finalization throws',
      'failRefundExecution NOT called; marked uncertain_reconciliation_required with order lock held'
    );

    // -------------------------------------------------------------------------
    // TEST 3: Provider succeeds, process is abruptly interrupted BEFORE finalization (file-backed SQLite)
    // -------------------------------------------------------------------------
    const crashDbPath = path.join(tempDir, 'crash-recovery.sqlite');
    const proc1Store = new SqlitePersistentReplayStore(crashDbPath);
    const tCrash0 = new Date(Date.now() - 120_000); // started 2 mins ago
    const baseReq3 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-p0b',
        order_id: 'ord-p0b-03',
        customer_email: 'synthetic-p0b@example.test',
        amount_usd: 125.0,
        reason: 'P0-B crash recovery test for ord-p0b-03',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt-ord-p0b-03',
        raw_trigger_payload: JSON.stringify({ orderId: 'ord-p0b-03' }),
        confidence: 1.0,
        authority_level: 'owner_approved',
        now: tCrash0,
        ttlMs: 15 * 60_000,
      },
      keyring
    );
    await proc1Store.recordOwnerApproval({
      approvalId: 'apr-p0b-03',
      requestId: baseReq3.provenance!.request_id,
      orderId: 'ord-p0b-03',
      businessId: 'biz-p0b',
      amountCents: 12500,
      approvedByUserId: 'usr-owner-p0b',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ownerId: 'usr-owner-p0b',
      tenantId: 'usr-owner-p0b',
    });
    const req3 = {
      ...baseReq3,
      provenance: {
        ...baseReq3.provenance!,
        owner_approval_id: 'apr-p0b-03',
      },
    };

    // Simulate SIGKILL immediately after provider succeeds (neither finalize nor markUncertain runs!)
    const sigkillBeforeFinalizeStore: PersistentReplayStore = {
      recordProvenanceOrigin: (p, o) => proc1Store.recordProvenanceOrigin(p, o),
      getProvenanceSnapshot: (r) => proc1Store.getProvenanceSnapshot(r),
      recordOwnerApproval: (i) => proc1Store.recordOwnerApproval(i),
      getOwnerApproval: (a) => proc1Store.getOwnerApproval(a),
      revokeOwnerApproval: (a) => proc1Store.revokeOwnerApproval(a),
      getReplayPrecheck: (i) => proc1Store.getReplayPrecheck(i),
      reserveRefundExecution: (i) => proc1Store.reserveRefundExecution(i),
      finalizeRefundExecution: async () => {
        throw new Error('SIMULATED_SIGKILL_BEFORE_FINALIZE');
      },
      failRefundExecution: async () => {
        throw new Error('Must never be called on finalize interruption');
      },
      markRefundUncertain: async () => {
        // Process died instantly before cleanup write could happen
        throw new Error('SIMULATED_SIGKILL_BEFORE_CLEANUP');
      },
      reconcileMarkNotExecuted: (i) => proc1Store.reconcileMarkNotExecuted(i),
      getRefundReservation: (f) => proc1Store.getRefundReservation(f),
      listStaleExecutingReservations: (n) => proc1Store.listStaleExecutingReservations(n),
      listUncertainReservations: () => proc1Store.listUncertainReservations(),
      close: () => {},
    };

    const res3Proc1 = await executeAuthorizedFinanceRefund(req3, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: sigkillBeforeFinalizeStore,
      now: tCrash0,
      executionLeaseMs: 15_000,
      policyOverrides: { maxRequestAgeMs: 15 * 60_000 },
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(res3Proc1.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');
    assert.equal(simProvider.successCountByOrder.get('ord-p0b-03'), 1);
    const rowAfterSigkill = await proc1Store.getRefundReservation({
      requestId: req3.provenance!.request_id,
    });
    assert.equal(rowAfterSigkill?.status, 'executing');
    proc1Store.close();

    // Process 2 restarts using the SAME SQLite file
    const proc2Store = new SqlitePersistentReplayStore(crashDbPath);
    try {
      // Blind retry by Process 2 MUST be blocked (lease expired -> STALE_EXECUTION_REQUIRES_RECONCILIATION)
      const retryProc2 = await executeAuthorizedFinanceRefund(req3, {
        keyring,
        orderStore: testP0BOrderStore,
        replayStore: proc2Store,
        policyOverrides: { maxRequestAgeMs: 15 * 60_000 },
        paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
      });
      assert.equal(retryProc2.status, 'REJECTED_REPLAY_OR_CONFLICT');
      assert.equal(retryProc2.code, 'STALE_EXECUTION_REQUIRES_RECONCILIATION');
      assert.equal(simProvider.successCountByOrder.get('ord-p0b-03'), 1);

      // Process 2 reconciles using persisted provider_idempotency_key -> discovers refund & finalizes!
      const rec3 = await reconcileFinanceRefund(
        { requestId: req3.provenance!.request_id },
        {
          replayStore: proc2Store,
          paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
        }
      );
      assert.equal(rec3.status, 'RECONCILED_EXECUTED');
      assert.equal(rec3.reconciled, true);
      assert.equal(simProvider.successCountByOrder.get('ord-p0b-03'), 1);
      const apr3After = await proc2Store.getOwnerApproval('apr-p0b-03');
      assert.equal(apr3After?.status, 'consumed');
    } finally {
      proc2Store.close();
    }
    pass(
      'P0B-3 — Process interrupted before DB finalization recovers across restart',
      'executing row preserved across restart, blind retry blocked, reconciliation finalized executed & consumed approval with 1 provider refund'
    );

    // -------------------------------------------------------------------------
    // TEST 4: Provider times out with unknown outcome
    // -------------------------------------------------------------------------
    const req4 = await makeOwnerApprovedReq(memStore, 'ord-p0b-04', 'apr-p0b-04', 15.0);
    const res4 = await executeAuthorizedFinanceRefund(req4, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed_but_timeout_response' }),
    });
    assert.equal(res4.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');
    assert.equal(res4.uncertaintyCode, 'PROVIDER_TIMEOUT_OR_UNKNOWN');
    assert.equal(res4.executedNewRefund, false);
    const rsv4 = await memStore.getRefundReservation({ reservationId: res4.reservationId });
    assert.equal(rsv4?.status, 'uncertain_reconciliation_required');
    assert.equal(rsv4?.providerOutcomeStatus, 'timeout_or_unknown');
    const apr4 = await memStore.getOwnerApproval('apr-p0b-04');
    assert.equal(apr4?.status, 'approved');
    pass('P0B-4 — Provider timeout marks uncertain_reconciliation_required', `rsv=${res4.reservationId}`);

    // -------------------------------------------------------------------------
    // TEST 5: Provider definitively rejects the refund
    // -------------------------------------------------------------------------
    const req5 = await makeOwnerApprovedReq(memStore, 'ord-p0b-05', 'apr-p0b-05');
    const res5Fail = await executeAuthorizedFinanceRefund(req5, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'confirmed_reject' }),
    });
    assert.equal(res5Fail.status, 'PROVIDER_EXECUTION_FAILED');
    assert.equal(res5Fail.retryEligible, true);
    const firstProviderIdemKey = res5Fail.providerIdempotencyKey;
    assert.ok(firstProviderIdemKey.startsWith('prov-idem-'));

    const rsv5AfterFail = await memStore.getRefundReservation({ reservationId: res5Fail.reservationId });
    assert.equal(rsv5AfterFail?.status, 'failed');
    assert.equal(rsv5AfterFail?.providerOutcomeStatus, 'confirmed_failure');
    assert.equal((await memStore.getOwnerApproval('apr-p0b-05'))?.status, 'approved');
    pass('P0B-5 — Provider definitively rejects the refund', `status=${res5Fail.status}, approval preserved`);

    // -------------------------------------------------------------------------
    // TEST 6: Retry uses the exact same provider_idempotency_key
    // -------------------------------------------------------------------------
    const res5Retry = await executeAuthorizedFinanceRefund(req5, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(res5Retry.status, 'EXECUTED');
    assert.equal(res5Retry.providerIdempotencyKey, firstProviderIdemKey);

    const keysSentToProvider5 = simProvider.keysPassedPerOrder.get('ord-p0b-05') || [];
    assert.equal(keysSentToProvider5.length, 2);
    assert.equal(keysSentToProvider5[0], firstProviderIdemKey);
    assert.equal(keysSentToProvider5[1], firstProviderIdemKey);
    pass('P0B-6 — Retry uses the exact same provider_idempotency_key', `key=${firstProviderIdemKey}`);

    // -------------------------------------------------------------------------
    // TEST 7: Idempotency key cannot be overwritten on retry or direct update
    // -------------------------------------------------------------------------
    const req7 = await makeOwnerApprovedReq(memStore, 'ord-p0b-07', 'apr-p0b-07');
    const res7Fail = await executeAuthorizedFinanceRefund(req7, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'confirmed_reject' }),
    });
    assert.equal(res7Fail.status, 'PROVIDER_EXECUTION_FAILED');
    // Retry even when client supplies a different client idempotency_key must still keep server provider_idempotency_key intact
    const res7Retry = await executeAuthorizedFinanceRefund(
      { ...req7, idempotency_key: 'client-supplied-different-retry-key' },
      {
        keyring,
        orderStore: testP0BOrderStore,
        replayStore: memStore,
        paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
      }
    );
    assert.equal(res7Retry.status, 'EXECUTED');
    assert.equal(res7Retry.providerIdempotencyKey, res7Fail.providerIdempotencyKey);

    // Also verify DB-level trigger prevents overwriting provider_idempotency_key directly
    const trigDbPath = path.join(tempDir, 'trigger-check.sqlite');
    const trigStore = new SqlitePersistentReplayStore(trigDbPath);
    const rawCheckDb = new DatabaseSync(trigDbPath);
    const reqTrig = await makeOwnerApprovedReq(trigStore, 'ord-p0b-trig', 'apr-p0b-trig');
    const resTrig = await executeAuthorizedFinanceRefund(reqTrig, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: trigStore,
      paymentProvider: simProvider.createAdapter({ mode: 'confirmed_reject' }),
    });
    assert.equal(resTrig.status, 'PROVIDER_EXECUTION_FAILED');
    assert.throws(() => {
      rawCheckDb
        .prepare(`UPDATE refund_authorizations SET provider_idempotency_key = 'attacker-overwrite' WHERE id = ?`)
        .run(resTrig.reservationId);
    }, /provider_idempotency_key is immutable/);
    rawCheckDb.close();
    trigStore.close();

    pass(
      'P0B-7 — Provider idempotency key cannot be overwritten',
      'immutable on retry with altered client key & protected by DB trigger'
    );

    // -------------------------------------------------------------------------
    // TEST 8: Uncertain transactions cannot be executed again (same request, new request on same order, or same approval)
    // -------------------------------------------------------------------------
    // Retry on ord-p0b-04 (which is in uncertain_reconciliation_required from TEST 4)
    const callsBefore8 = simProvider.executeCallsByOrder.get('ord-p0b-04') ?? 0;
    const retrySameReq4 = await executeAuthorizedFinanceRefund(req4, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(retrySameReq4.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(retrySameReq4.code, 'UNCERTAIN_RECONCILIATION_REQUIRED');

    // Different request trying to refund the SAME locked order 'ord-p0b-04' (e.g. under policy <= $25)
    const sneakyReq4 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-p0b',
        order_id: 'ord-p0b-04',
        customer_email: 'synthetic-p0b@example.test',
        amount_usd: 15.0,
        reason: 'Second request while order locked in uncertain state',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-sneaky-04',
        raw_trigger_payload: '{"sneaky":true}',
        confidence: 0.99,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const retryNewReqSameOrder4 = await executeAuthorizedFinanceRefund(sneakyReq4, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(retryNewReqSameOrder4.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(retryNewReqSameOrder4.code, 'UNCERTAIN_RECONCILIATION_REQUIRED');
    assert.equal(simProvider.executeCallsByOrder.get('ord-p0b-04'), callsBefore8);
    pass(
      'P0B-8 — Uncertain transactions cannot be executed again',
      'same request & new request for same order blocked with UNCERTAIN_RECONCILIATION_REQUIRED'
    );

    // -------------------------------------------------------------------------
    // TEST 9: Stale executing reservations remain blocked until reconciliation
    // -------------------------------------------------------------------------
    const staleOrderId = 'ord-p0b-09-stale';
    const tOld = new Date(Date.now() - 300_000);
    const tAfterLease = new Date(tOld.getTime() + 180_000);
    const req9 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-p0b',
        order_id: staleOrderId,
        customer_email: 'synthetic-p0b@example.test',
        amount_usd: 18.0,
        reason: 'Stale lease test',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-stale-09',
        raw_trigger_payload: '{"stale":true}',
        confidence: 0.99,
        authority_level: 'execute_under_policy',
        now: tOld,
        ttlMs: 15 * 60_000,
      },
      keyring
    );
    // Directly acquire reservation in the past with a 30s lease (simulating crashed worker still in 'executing')
    const rawRsv9 = await memStore.reserveRefundExecution({
      requestId: req9.provenance!.request_id,
      nonce: req9.provenance!.nonce!,
      orderId: req9.order_id,
      businessId: req9.business_id,
      ownerId: 'usr-owner-p0b',
      tenantId: 'usr-owner-p0b',
      approvalId: null,
      requireOwnerApproval: false,
      amountCents: 1800,
      idempotencyKey: req9.idempotency_key!,
      canonicalDigest: sha256HexNode(
        buildCanonicalProvenancePayload({ request: req9, provenance: req9.provenance! })
      ),
      keyId: req9.provenance!.ingestion_auth!.key_id,
      providerName: simProvider.providerName,
      executionLeaseMs: 30_000,
      expiresAt: new Date(tOld.getTime() + 600_000).toISOString(),
      nowIso: tOld.toISOString(),
      provenanceSnapshot: req9.provenance!,
    });
    assert.equal(rawRsv9.status, 'ACQUIRED');

    const staleList = await identifyStaleRefundReservations(memStore, tAfterLease);
    assert.ok(staleList.some((r) => r.id === rawRsv9.reservationId));

    // Attempting to execute again (even after lease expiration!) MUST stay blocked & NOT auto-fail!
    const retryStaleBlocked = await executeAuthorizedFinanceRefund(req9, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      now: tAfterLease,
      policyOverrides: { maxRequestAgeMs: 24 * 3600_000 },
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(retryStaleBlocked.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(retryStaleBlocked.code, 'STALE_EXECUTION_REQUIRES_RECONCILIATION');
    assert.equal(simProvider.executeCallsByOrder.get(staleOrderId) ?? 0, 0);
    const stillExecuting9 = await memStore.getRefundReservation({ reservationId: rawRsv9.reservationId });
    assert.equal(stillExecuting9?.status, 'executing');
    pass(
      'P0B-9 — Stale executing reservations remain blocked until reconciliation',
      'identified as stale, NOT auto-failed, blocked with STALE_EXECUTION_REQUIRES_RECONCILIATION'
    );

    // -------------------------------------------------------------------------
    // TEST 10: Reconciliation discovers existing provider refund & finalizes without issuing a 2nd refund
    // -------------------------------------------------------------------------
    const req10 = await makeOwnerApprovedReq(memStore, 'ord-p0b-10', 'apr-p0b-10');
    const res10Timeout = await executeAuthorizedFinanceRefund(req10, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'record_at_provider_then_timeout' }),
    });
    assert.equal(res10Timeout.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');
    assert.equal(simProvider.successCountByOrder.get('ord-p0b-10'), 1);

    const callsBeforeRec10 = simProvider.executeCallsByOrder.get('ord-p0b-10');
    const rec10 = await reconcileFinanceRefund(
      { reservationId: res10Timeout.reservationId },
      {
        replayStore: memStore,
        paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
      }
    );
    assert.equal(rec10.status, 'RECONCILED_EXECUTED');
    assert.equal(rec10.reconciled, true);
    assert.equal(rec10.reservationStatus, 'executed');
    // Must NOT have called executeRefund again!
    assert.equal(simProvider.executeCallsByOrder.get('ord-p0b-10'), callsBeforeRec10);
    assert.equal(simProvider.successCountByOrder.get('ord-p0b-10'), 1);
    assert.equal((await memStore.getOwnerApproval('apr-p0b-10'))?.status, 'consumed');
    pass(
      'P0B-10 — Reconciliation discovers existing provider refund & finalizes without 2nd refund',
      `tx=${rec10.executionTxId}, approval consumed`
    );

    // -------------------------------------------------------------------------
    // TEST 11: Reconciliation confirms NO provider refund and permits a safe retry
    // -------------------------------------------------------------------------
    // Reconcile req4 (from TEST 4, where provider timed out BEFORE creating any refund)
    const rec11 = await reconcileFinanceRefund(
      { reservationId: res4.reservationId },
      {
        replayStore: memStore,
        paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
      }
    );
    assert.equal(rec11.status, 'RECONCILED_NOT_EXECUTED_RETRY_PERMITTED');
    assert.equal(rec11.reconciled, true);
    assert.equal(rec11.reservationStatus, 'failed');
    assert.equal(rec11.providerIdempotencyKey, res4.providerIdempotencyKey);

    // Now safe retry executes once using the exact same provider_idempotency_key!
    const retryAfterRec11 = await executeAuthorizedFinanceRefund(req4, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(retryAfterRec11.status, 'EXECUTED');
    assert.equal(retryAfterRec11.providerIdempotencyKey, res4.providerIdempotencyKey);
    const keysSent4 = simProvider.keysPassedPerOrder.get('ord-p0b-04') || [];
    assert.equal(keysSent4.length, 2);
    assert.equal(keysSent4[0], keysSent4[1]);
    assert.equal(simProvider.successCountByOrder.get('ord-p0b-04'), 1);
    assert.equal((await memStore.getOwnerApproval('apr-p0b-04'))?.status, 'consumed');
    pass(
      'P0B-11 — Reconciliation confirms non-execution & permits safe retry',
      `reused providerIdempotencyKey=${res4.providerIdempotencyKey}`
    );

    // -------------------------------------------------------------------------
    // TEST 12: Missing provider idempotency or lookup capability fails closed
    // -------------------------------------------------------------------------
    // 12a. Adapter lacking supportsIdempotencyKey fails closed (0 provider calls)
    const req12a = await makeOwnerApprovedReq(memStore, 'ord-p0b-12a', 'apr-p0b-12a');
    const noIdemRes = await executeAuthorizedFinanceRefund(req12a, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({
        mode: 'succeed',
        supportsIdempotencyKey: false,
      }),
    });
    assert.equal(noIdemRes.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(noIdemRes.code, 'PROVIDER_IDEMPOTENCY_UNSUPPORTED');
    assert.equal(simProvider.executeCallsByOrder.get('ord-p0b-12a') ?? 0, 0);

    // 12b. Legacy callback cannot auto-retry a failed reservation without idempotency
    const req12b = await makeOwnerApprovedReq(memStore, 'ord-p0b-12b', 'apr-p0b-12b');
    const fail12b = await executeAuthorizedFinanceRefund(req12b, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'confirmed_reject' }),
    });
    assert.equal(fail12b.status, 'PROVIDER_EXECUTION_FAILED');
    let legacyRetryCalls = 0;
    const legacyRetryBlocked = await executeAuthorizedFinanceRefund(req12b, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      executePaymentRefund: async () => {
        legacyRetryCalls += 1;
        return { txId: 'must-not-run' };
      },
    });
    assert.equal(legacyRetryBlocked.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(legacyRetryBlocked.code, 'PROVIDER_IDEMPOTENCY_UNSUPPORTED');
    assert.equal(legacyRetryCalls, 0);

    // 12c. Missing provider lookup capability keeps uncertain transaction blocked for manual reconciliation
    const req12c = await makeOwnerApprovedReq(memStore, 'ord-p0b-12c', 'apr-p0b-12c');
    const res12cUncertain = await executeAuthorizedFinanceRefund(req12c, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed_but_timeout_response' }),
    });
    assert.equal(res12cUncertain.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');

    const rec12cBlocked = await reconcileFinanceRefund(
      { reservationId: res12cUncertain.reservationId },
      {
        replayStore: memStore,
        paymentProvider: simProvider.createAdapter({
          mode: 'succeed',
          supportsRefundLookup: false,
        }),
      }
    );
    assert.equal(rec12cBlocked.status, 'BLOCKED_LOOKUP_UNSUPPORTED');
    assert.equal(rec12cBlocked.reconciled, false);
    assert.equal(rec12cBlocked.reservationStatus, 'uncertain_reconciliation_required');

    // Also verify reconciliation fails closed when lookup throws or returns unknown
    const rec12cUnknown = await reconcileFinanceRefund(
      { reservationId: res12cUncertain.reservationId },
      {
        replayStore: memStore,
        paymentProvider: simProvider.createAdapter({
          mode: 'succeed',
          supportsRefundLookup: true,
          lookupUnknown: true,
        }),
      }
    );
    assert.equal(rec12cUnknown.status, 'BLOCKED_OUTCOME_UNKNOWN');
    assert.equal(rec12cUnknown.reservationStatus, 'uncertain_reconciliation_required');

    // Confirm order lock is still held so no duplicate refund can run on ord-p0b-12c!
    const retry12cStillBlocked = await executeAuthorizedFinanceRefund(req12c, {
      keyring,
      orderStore: testP0BOrderStore,
      replayStore: memStore,
      paymentProvider: simProvider.createAdapter({ mode: 'succeed' }),
    });
    assert.equal(retry12cStillBlocked.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(retry12cStillBlocked.code, 'UNCERTAIN_RECONCILIATION_REQUIRED');
    assert.equal(simProvider.successCountByOrder.get('ord-p0b-12c') ?? 0, 0);

    pass(
      'P0B-12 — Missing provider idempotency or lookup capability fails closed',
      'no-idempotency blocked, legacy retry blocked, no-lookup kept transaction locked'
    );

    // Final cross-suite invariant check
    simProvider.assertZeroDuplicateRefunds();
    console.log(`\nALL ${passed} P0-B CRASH RECOVERY & RECONCILIATION TESTS PASSED (0 duplicate refunds).\n`);
  } finally {
    memStore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runP0BCrashRecoveryTests().catch((err) => {
  console.error('\n[FAIL] P0-B crash recovery test suite failed:', err);
  process.exit(1);
});
