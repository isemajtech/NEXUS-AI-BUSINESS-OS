import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FinanceRefundRequest,
  appendProvenanceHop,
  normalRefundRequest,
  adversarialTamperedRequest,
  adversarialPolicyBypassRequest,
} from './provenance';
import { evaluateFinanceRefund } from './financeRefundGate';
import {
  ServerKeyring,
  createKeyringSignatureVerifier,
  ingestAuthenticatedRefundRequest,
  sha256HexNode,
  signCanonicalPayloadHmac,
} from '../../server/provenanceAuth';
import { SqlitePersistentReplayStore } from '../../server/replayStore';
import { executeAuthorizedFinanceRefund } from '../../server/financeExecutor';
import type { AuthoritativeOrderRecord, AuthoritativeOrderStore } from '../../server/orderStore';

function buildTestOrderStore(entries: Array<{
  orderId: string;
  businessId: string;
  amountCents: number;
  ownerId?: string;
  tenantId?: string;
}>): AuthoritativeOrderStore {
  const map = new Map<string, AuthoritativeOrderRecord>();
  for (const e of entries) {
    map.set(`${e.businessId}::${e.orderId}`, {
      orderId: e.orderId,
      businessId: e.businessId,
      businessStatus: 'active',
      ownerId: e.ownerId ?? 'owner-synth',
      tenantId: e.tenantId ?? 'tenant-synth',
      amountCents: e.amountCents,
      refundedAmountCents: 0,
      currency: 'USD',
      paymentStatus: 'paid',
      status: 'completed',
      eligibleForRefund: true,
    });
  }
  return {
    configured: true,
    getOrderForBusiness: async ({ orderId, businessId }) =>
      map.get(`${businessId}::${orderId}`) ?? null,
  };
}

function buildEphemeralTestKeyring(): ServerKeyring {
  // Ephemeral runtime-only random secrets — zero hardcoded test secrets
  const activeSecret = crypto.randomBytes(32).toString('hex');
  const graceSecret = crypto.randomBytes(32).toString('hex');
  const revokedSecret = crypto.randomBytes(32).toString('hex');
  const expiredSecret = crypto.randomBytes(32).toString('hex');
  const unauthorizedComponentSecret = crypto.randomBytes(32).toString('hex');

  return {
    activeKeyId: 'test-ingest-active',
    keys: {
      'test-ingest-active': {
        keyId: 'test-ingest-active',
        secret: activeSecret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      'test-ingest-grace': {
        keyId: 'test-ingest-grace',
        secret: graceSecret,
        status: 'rotated_grace',
        allowedComponent: 'nexus-ingestion-api',
        expiresAt: new Date(Date.now() + 1800_000).toISOString(),
      },
      'test-ingest-revoked': {
        keyId: 'test-ingest-revoked',
        secret: revokedSecret,
        status: 'revoked',
        allowedComponent: 'nexus-ingestion-api',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
      'test-ingest-expired': {
        keyId: 'test-ingest-expired',
        secret: expiredSecret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
      'test-rogue-component-key': {
        keyId: 'test-rogue-component-key',
        secret: unauthorizedComponentSecret,
        status: 'active',
        allowedComponent: 'marketing-blast-worker',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    },
  };
}

async function runAllTests() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-replay-test-'));
  const dbPath = path.join(tempDir, 'replay-test.sqlite');
  const replayStore = new SqlitePersistentReplayStore(dbPath);
  const keyring = buildEphemeralTestKeyring();
  const verifySig = createKeyringSignatureVerifier(keyring);
  const testOrderStore = buildTestOrderStore([
    { orderId: 'ord-synth-001', businessId: 'biz-synth', amountCents: 1900 },
    { orderId: 'ord-synth-06a', businessId: 'biz-synth', amountCents: 15000 },
    { orderId: 'ord-synth-007', businessId: 'biz-synth', amountCents: 1000 },
    { orderId: 'ord-synth-008', businessId: 'biz-synth', amountCents: 2200 },
    { orderId: 'ord-synth-009b', businessId: 'biz-synth', amountCents: 1400 },
  ]);

  let passedCount = 0;
  const recordResult = (name: string, detail: string) => {
    passedCount += 1;
    console.log(`[PASS] ${name} -> ${detail}`);
  };

  try {
    // =========================================================================
    // BASELINE TESTS (Preserved existing fixtures + fail-closed upgrade)
    // =========================================================================
    const baselineUnsigned = evaluateFinanceRefund(normalRefundRequest, {
      verifyIngestionSignature: verifySig,
    });
    assert.equal(baselineUnsigned.allowedToAutoExecute, false);
    assert.equal(baselineUnsigned.decision, 'REJECT_SECURITY_VIOLATION');
    recordResult(
      'BASELINE A — Existing Unsigned Normal Fixture Fails Closed',
      `${baselineUnsigned.decision} (${baselineUnsigned.reasons[0]})`
    );

    const baselineTampered = evaluateFinanceRefund(adversarialTamperedRequest, {
      verifyIngestionSignature: verifySig,
    });
    assert.equal(baselineTampered.allowedToAutoExecute, false);
    assert.equal(baselineTampered.decision, 'REJECT_SECURITY_VIOLATION');
    recordResult(
      'BASELINE B — Existing Tampered Fixture',
      `${baselineTampered.decision} (${baselineTampered.reasons.length} violations caught)`
    );

    const baselinePolicyBypass = evaluateFinanceRefund(adversarialPolicyBypassRequest, {
      verifyIngestionSignature: verifySig,
    });
    assert.equal(baselinePolicyBypass.allowedToAutoExecute, false);
    recordResult(
      'BASELINE C — Existing Policy Bypass Fixture',
      `${baselinePolicyBypass.decision} (${baselinePolicyBypass.reasons[0]})`
    );

    // =========================================================================
    // TEST 1 — VALID AUTHENTICATED REQUEST
    // =========================================================================
    let test1ProviderCalls = 0;
    const rawTrigger1 = JSON.stringify({ ticketId: 'tkt_s_001', issue: 'double_charge' });
    const req1Ingested = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-001',
        customer_email: 'synthetic-01@example.test',
        amount_usd: 19.0,
        reason: 'Synthetic duplicate charge refund',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_001',
        raw_trigger_payload: rawTrigger1,
        confidence: 0.96,
        authority_level: 'execute_under_policy',
        sender_auth: { verified: true, provider: 'supabase_auth', actor_id: 'usr_synth_1' },
      },
      keyring
    );
    await replayStore.recordProvenanceOrigin(req1Ingested.provenance!, req1Ingested.order_id, {
      ownerId: 'owner-synth',
      tenantId: 'tenant-synth',
    });
    const req1WithHop: FinanceRefundRequest = {
      ...req1Ingested,
      provenance: appendProvenanceHop(req1Ingested.provenance!, 'security'),
    };
    const res1 = await executeAuthorizedFinanceRefund(req1WithHop, {
      keyring,
      replayStore,
      orderStore: testOrderStore,
      expectedRawTriggerHash: sha256HexNode(rawTrigger1),
      executePaymentRefund: async () => {
        test1ProviderCalls += 1;
        return { txId: 'tx-synth-001' };
      },
    });
    assert.equal(res1.status, 'EXECUTED');
    assert.equal(res1.executedNewRefund, true);
    assert.equal(test1ProviderCalls, 1);
    assert.equal(res1.updatedChain[res1.updatedChain.length - 1].agent, 'finance');
    recordResult(
      'TEST 1 — Valid Authenticated Request',
      `${res1.status}, txId=${res1.executionTxId}, chainLength=${res1.updatedChain.length}`
    );

    // =========================================================================
    // TEST 2 — MODIFIED RAW TRIGGER
    // =========================================================================
    const rawTrigger2 = JSON.stringify({ ticketId: 'tkt_s_002', issue: 'wrong_tier' });
    const req2 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-002',
        customer_email: 'synthetic-02@example.test',
        amount_usd: 15.0,
        reason: 'Synthetic refund',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_002',
        raw_trigger_payload: rawTrigger2,
        confidence: 0.94,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const modifiedTriggerReq: FinanceRefundRequest = {
      ...req2,
      provenance: {
        ...req2.provenance!,
        original_trigger: {
          ...req2.provenance!.original_trigger,
          raw_hash: sha256HexNode('tampered-trigger-payload'),
        },
      },
    };
    const res2 = await executeAuthorizedFinanceRefund(modifiedTriggerReq, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res2.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(res2.executedNewRefund, false);
    recordResult('TEST 2 — Modified Raw Trigger', `${res2.status}: ${res2.reasons[0]}`);

    // =========================================================================
    // TEST 3 — FORGED INGESTION SIGNATURE
    // =========================================================================
    const req3 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-003',
        customer_email: 'synthetic-03@example.test',
        amount_usd: 12.0,
        reason: 'Synthetic refund',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_003',
        raw_trigger_payload: '{"ticketId":"tkt_s_003"}',
        confidence: 0.92,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const sigChars = req3.provenance!.ingestion_auth!.signature.split('');
    sigChars[0] = sigChars[0] === 'a' ? 'b' : 'a';
    const forgedSigReq: FinanceRefundRequest = {
      ...req3,
      provenance: {
        ...req3.provenance!,
        ingestion_auth: {
          ...req3.provenance!.ingestion_auth!,
          signature: sigChars.join(''),
        },
      },
    };
    const res3 = await executeAuthorizedFinanceRefund(forgedSigReq, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res3.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(res3.executedNewRefund, false);
    recordResult('TEST 3 — Forged Ingestion Signature', `${res3.status}: ${res3.reasons[0]}`);

    // =========================================================================
    // TEST 4 — UNAUTHORIZED SIGNING KEY (Wrong component / unknown key)
    // =========================================================================
    const rogueKeyring: ServerKeyring = {
      activeKeyId: 'test-rogue-component-key',
      keys: keyring.keys,
    };
    const req4 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-004',
        customer_email: 'synthetic-04@example.test',
        amount_usd: 18.0,
        reason: 'Synthetic refund',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_004',
        raw_trigger_payload: '{"ticketId":"tkt_s_004"}',
        confidence: 0.95,
        authority_level: 'execute_under_policy',
        ingested_by_component: 'marketing-blast-worker',
      },
      rogueKeyring
    );
    const res4 = await executeAuthorizedFinanceRefund(req4, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res4.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(res4.executedNewRefund, false);
    recordResult('TEST 4 — Unauthorized Signing Key', `${res4.status}: ${res4.reasons[0]}`);

    // =========================================================================
    // TEST 5 — REPLAYED APPROVED REQUEST (Blocks duplicate execution)
    // =========================================================================
    const replayedNewAttempt: FinanceRefundRequest = {
      ...req1WithHop,
      idempotency_key: 'idem-attacker-replay-new-dispatch',
    };
    const res5 = await executeAuthorizedFinanceRefund(replayedNewAttempt, {
      keyring,
      replayStore,
      orderStore: testOrderStore,
      executePaymentRefund: async () => {
        test1ProviderCalls += 1;
        return { txId: 'should-never-happen' };
      },
    });
    assert.equal(res5.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(res5.executedNewRefund, false);
    assert.equal(test1ProviderCalls, 1);
    recordResult('TEST 5 — Replayed Approved Request', `${res5.status} (${res5.code})`);

    // =========================================================================
    // TEST 6 — SAME APPROVAL, DIFFERENT ORDER
    // =========================================================================
    const ownerApprovedKey = 'test-ingest-active';
    const baseReq6A = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-06a',
        customer_email: 'synthetic-06a@example.test',
        amount_usd: 150.0,
        reason: 'Owner approved custom refund A',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt_s_006a',
        raw_trigger_payload: '{"ticketId":"tkt_s_006a"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    await replayStore.recordOwnerApproval({
      approvalId: 'apr-synth-006',
      requestId: baseReq6A.provenance!.request_id,
      orderId: 'ord-synth-06a',
      businessId: 'biz-synth',
      amountCents: 15000,
      approvedByUserId: 'usr-owner-synth-1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      ownerId: 'owner-synth',
      tenantId: 'tenant-synth',
    });
    const req6A: FinanceRefundRequest = {
      ...baseReq6A,
      provenance: {
        ...baseReq6A.provenance!,
        owner_approval_id: 'apr-synth-006',
        owner_approval_binding: {
          approval_id: 'apr-synth-006',
          request_id: baseReq6A.provenance!.request_id,
          order_id: 'ord-synth-06a',
          amount_usd: 150.0,
          approved_by_user_id: 'usr-owner-synth-1',
        },
      },
    };
    const res6A = await executeAuthorizedFinanceRefund(req6A, {
      keyring,
      replayStore,
      orderStore: testOrderStore,
      executePaymentRefund: async () => ({ txId: 'tx-synth-006a' }),
    });
    assert.equal(res6A.status, 'EXECUTED');

    // Attempt reusing approval 'apr-synth-006' against order 'ord-synth-06b'
    const baseReq6B = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-06b',
        customer_email: 'synthetic-06b@example.test',
        amount_usd: 150.0,
        reason: 'Reused approval on order B',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt_s_006b',
        raw_trigger_payload: '{"ticketId":"tkt_s_006b"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    const req6BReusedApproval: FinanceRefundRequest = {
      ...baseReq6B,
      provenance: {
        ...baseReq6B.provenance!,
        owner_approval_id: 'apr-synth-006',
        owner_approval_binding: {
          approval_id: 'apr-synth-006',
          request_id: baseReq6B.provenance!.request_id,
          order_id: 'ord-synth-06b',
          amount_usd: 150.0,
        },
      },
    };
    const res6B = await executeAuthorizedFinanceRefund(req6BReusedApproval, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.ok(
      res6B.status === 'REJECTED_SECURITY_VIOLATION' ||
        res6B.status === 'REJECTED_REPLAY_OR_CONFLICT'
    );
    assert.equal(res6B.executedNewRefund, false);
    recordResult(
      'TEST 6 — Same Approval, Different Order',
      `${res6B.status} (${res6B.code}) · ${ownerApprovedKey}`
    );

    // =========================================================================
    // TEST 7 — SAME NONCE, DIFFERENT REQUEST
    // =========================================================================
    const baseReq7 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-007',
        customer_email: 'synthetic-07@example.test',
        amount_usd: 10.0,
        reason: 'Different request reusing consumed nonce',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_007',
        raw_trigger_payload: '{"ticketId":"tkt_s_007"}',
        confidence: 0.95,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const req7NonceReusedProv = {
      ...baseReq7.provenance!,
      nonce: req1Ingested.provenance!.nonce!, // Reuse nonce from Test 1
    };
    const req7Base: FinanceRefundRequest = { ...baseReq7, provenance: req7NonceReusedProv };
    const canonical7 = (await import('./provenance')).buildCanonicalProvenancePayload({
      request: req7Base,
      provenance: req7NonceReusedProv,
    });
    const signedReq7: FinanceRefundRequest = {
      ...req7Base,
      provenance: {
        ...req7NonceReusedProv,
        ingestion_auth: {
          ...req7NonceReusedProv.ingestion_auth!,
          signature: signCanonicalPayloadHmac(
            canonical7,
            keyring.keys[keyring.activeKeyId].secret
          ),
        },
      },
    };
    const res7 = await executeAuthorizedFinanceRefund(signedReq7, {
      keyring,
      replayStore,
      orderStore: testOrderStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res7.status, 'REJECTED_REPLAY_OR_CONFLICT');
    assert.equal(res7.code, 'NONCE_REUSED');
    assert.equal(res7.executedNewRefund, false);
    recordResult('TEST 7 — Same Nonce, Different Request', `${res7.status} (${res7.code})`);

    // =========================================================================
    // TEST 8 — CONCURRENT REPLAY ATTEMPTS (At most one succeeds)
    // =========================================================================
    let concurrentProviderCalls = 0;
    const req8 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-008',
        customer_email: 'synthetic-08@example.test',
        amount_usd: 22.0,
        reason: 'Concurrent race test',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_008',
        raw_trigger_payload: '{"ticketId":"tkt_s_008"}',
        confidence: 0.95,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const concurrentOutcomes = await Promise.all(
      Array.from({ length: 5 }, (_, idx) =>
        executeAuthorizedFinanceRefund(
          {
            ...req8,
            idempotency_key: `idem-concurrent-${idx}`,
          },
          {
            keyring,
            replayStore,
            orderStore: testOrderStore,
            executePaymentRefund: async () => {
              concurrentProviderCalls += 1;
              await new Promise((r) => setTimeout(r, 25));
              return { txId: 'tx-synth-008' };
            },
          }
        )
      )
    );
    const executedCount8 = concurrentOutcomes.filter((o) => o.executedNewRefund).length;
    assert.equal(executedCount8, 1);
    assert.equal(concurrentProviderCalls, 1);
    recordResult(
      'TEST 8 — Concurrent Replay Attempts',
      `5 parallel attempts -> ${executedCount8} executed, providerCalls=${concurrentProviderCalls}`
    );

    // =========================================================================
    // TEST 9 — DUPLICATE NETWORK RETRY (Idempotent return without 2nd refund)
    // =========================================================================
    const retryRes9 = await executeAuthorizedFinanceRefund(req1WithHop, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        test1ProviderCalls += 1;
        return { txId: 'must-not-create-second-tx' };
      },
    });
    assert.equal(retryRes9.status, 'IDEMPOTENT_RETURN');
    assert.equal(retryRes9.executedNewRefund, false);
    assert.equal(retryRes9.executionTxId, 'tx-synth-001');
    assert.equal(test1ProviderCalls, 1);

    // Also test confirmed failure does NOT falsely consume approval: retry #2 succeeds with same providerIdempotencyKey!
    let attempt9b = 0;
    const seenKeys9b: string[] = [];
    const req9FailThenRetry = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-009b',
        customer_email: 'synthetic-09b@example.test',
        amount_usd: 14.0,
        reason: 'Confirmed gateway rejection recovery check',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_009b',
        raw_trigger_payload: '{"ticketId":"tkt_s_009b"}',
        confidence: 0.96,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    const failed9b = await executeAuthorizedFinanceRefund(req9FailThenRetry, {
      keyring,
      replayStore,
      orderStore: testOrderStore,
      paymentProvider: {
        providerName: 'sim-stripe-9b',
        supportsIdempotencyKey: true,
        supportsRefundLookup: true,
        executeRefund: async ({ providerIdempotencyKey }) => {
          attempt9b += 1;
          seenKeys9b.push(providerIdempotencyKey);
          return {
            outcome: 'CONFIRMED_FAILURE',
            reason: 'Confirmed transient rate limit rejection',
            errorCode: 'rate_limit',
            retryable: true,
          };
        },
      },
    });
    assert.equal(failed9b.status, 'PROVIDER_EXECUTION_FAILED');
    assert.equal(failed9b.retryEligible, true);

    const recovered9b = await executeAuthorizedFinanceRefund(req9FailThenRetry, {
      keyring,
      replayStore,
      orderStore: testOrderStore,
      paymentProvider: {
        providerName: 'sim-stripe-9b',
        supportsIdempotencyKey: true,
        supportsRefundLookup: true,
        executeRefund: async ({ providerIdempotencyKey }) => {
          attempt9b += 1;
          seenKeys9b.push(providerIdempotencyKey);
          return { outcome: 'CONFIRMED_SUCCESS', txId: 'tx-synth-009b-recovered' };
        },
      },
    });
    assert.equal(recovered9b.status, 'EXECUTED');
    assert.equal(attempt9b, 2);
    assert.equal(seenKeys9b[0], seenKeys9b[1]);
    recordResult(
      'TEST 9 — Duplicate Network Retry & Failure Recovery',
      `${retryRes9.status} (txId=${retryRes9.executionTxId}, no 2nd refund) + failure retry recovered with immutable provider key`
    );

    // =========================================================================
    // TEST 10 — MODIFIED AUTHORITY OR PROVENANCE IDENTITY
    // =========================================================================
    const req10 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-010',
        customer_email: 'synthetic-10@example.test',
        amount_usd: 20.0,
        reason: 'Recommend only ticket',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_010',
        raw_trigger_payload: '{"ticketId":"tkt_s_010"}',
        confidence: 0.96,
        authority_level: 'recommend_only',
      },
      keyring
    );
    await replayStore.recordProvenanceOrigin(req10.provenance!, req10.order_id);
    const modifiedAuthorityReq: FinanceRefundRequest = {
      ...req10,
      provenance: {
        ...req10.provenance!,
        source_agent: 'marketing', // Modified identity
        authority_level: 'execute_under_policy', // Escalated without owner approval
      },
    };
    const res10 = await executeAuthorizedFinanceRefund(modifiedAuthorityReq, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res10.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(res10.executedNewRefund, false);
    recordResult(
      'TEST 10 — Modified Authority / Provenance Identity',
      `${res10.status} (${res10.reasons.length} violations caught)`
    );

    // =========================================================================
    // TEST 11 — EXPIRED OR REVOKED SIGNING KEY
    // =========================================================================
    const revokedKeyring: ServerKeyring = {
      activeKeyId: 'test-ingest-revoked',
      keys: {
        ...keyring.keys,
        'test-ingest-revoked': {
          ...keyring.keys['test-ingest-revoked'],
          status: 'active', // simulate signed before revocation
        },
      },
    };
    const req11Revoked = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-011a',
        customer_email: 'synthetic-11a@example.test',
        amount_usd: 15.0,
        reason: 'Signed by key later revoked',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_011a',
        raw_trigger_payload: '{"ticketId":"tkt_s_011a"}',
        confidence: 0.95,
        authority_level: 'execute_under_policy',
      },
      revokedKeyring
    );
    const res11Revoked = await executeAuthorizedFinanceRefund(req11Revoked, {
      keyring, // verifier sees key status === 'revoked'
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res11Revoked.status, 'REJECTED_SECURITY_VIOLATION');

    const futureKeyring: ServerKeyring = {
      activeKeyId: 'test-ingest-expired',
      keys: {
        'test-ingest-expired': {
          ...keyring.keys['test-ingest-expired'],
          expiresAt: new Date(Date.now() + 60_000).toISOString(), // signed before expiry
        },
      },
    };
    const req11Expired = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-011b',
        customer_email: 'synthetic-11b@example.test',
        amount_usd: 15.0,
        reason: 'Signed by expired key',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_011b',
        raw_trigger_payload: '{"ticketId":"tkt_s_011b"}',
        confidence: 0.95,
        authority_level: 'execute_under_policy',
      },
      futureKeyring
    );
    const res11Expired = await executeAuthorizedFinanceRefund(req11Expired, {
      keyring, // verifier sees expiresAt in past
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res11Expired.status, 'REJECTED_SECURITY_VIOLATION');
    recordResult(
      'TEST 11 — Expired & Revoked Signing Keys',
      `Revoked=${res11Revoked.status}; Expired=${res11Expired.status}`
    );

    // =========================================================================
    // TEST 12 — VALID REQUEST WITH MISSING SIGNATURE
    // =========================================================================
    const res12 = await executeAuthorizedFinanceRefund(normalRefundRequest, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res12.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(res12.executedNewRefund, false);
    recordResult('TEST 12 — Valid Request Missing Signature', `${res12.status}: ${res12.reasons[0]}`);

    // =========================================================================
    // TEST 13 — INVALID ORDER BINDING (Even with Owner Approval attached!)
    // =========================================================================
    const req13 = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-013-original',
        customer_email: 'synthetic-13@example.test',
        amount_usd: 20.0,
        reason: 'Order mismatch test',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt_s_013',
        raw_trigger_payload: '{"ticketId":"tkt_s_013"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    const mismatchedOrderReq: FinanceRefundRequest = {
      ...req13,
      order_id: 'ord-synth-013-VICTIM-ORDER',
      provenance: {
        ...req13.provenance!,
        owner_approval_id: 'apr-synth-013',
        owner_approval_binding: {
          approval_id: 'apr-synth-013',
          request_id: req13.provenance!.request_id,
          order_id: 'ord-synth-013-original',
          amount_usd: 20.0,
        },
      },
    };
    const res13 = await executeAuthorizedFinanceRefund(mismatchedOrderReq, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res13.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(res13.executedNewRefund, false);
    recordResult('TEST 13 — Invalid Order Binding', `${res13.status}: ${res13.reasons[0]}`);

    // =========================================================================
    // TEST 14 — EXISTING POLICY BYPASS (Validly signed, breaches Finance rules)
    // =========================================================================
    const req14SignedExcessive = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-synth',
        order_id: 'ord-synth-014',
        customer_email: 'synthetic-14@example.test',
        amount_usd: 490.0, // Exceeds $25 cap
        reason: 'Prompt injection attempt inside ticket',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt_s_014',
        raw_trigger_payload: '{"ticketId":"tkt_s_014"}',
        confidence: 0.54, // Below 0.85 confidence floor
        authority_level: 'execute_under_policy',
        policy_version: '2025.04.1', // Stale policy version
      },
      keyring
    );
    const res14 = await executeAuthorizedFinanceRefund(req14SignedExcessive, {
      keyring,
      replayStore,
      executePaymentRefund: async () => {
        throw new Error('Must never execute');
      },
    });
    assert.equal(res14.status, 'ESCALATED_TO_OWNER_APPROVAL');
    assert.equal(res14.executedNewRefund, false);
    assert.equal(res14.reasons.length, 3);
    recordResult(
      'TEST 14 — Existing Policy Bypass (Signed)',
      `${res14.status} (${res14.reasons.join(' | ')})`
    );

    console.log(`\nALL ${passedCount} GOVERNANCE & REPLAY SECURITY TESTS PASSED.\n`);
  } finally {
    replayStore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runAllTests().catch((err) => {
  console.error('\n[FAIL] Finance security verification failed:', err);
  process.exit(1);
});
