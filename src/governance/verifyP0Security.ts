import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import {
  DEFAULT_FINANCE_REFUND_POLICY,
  evaluateFinanceRefund,
} from './financeRefundGate';
import {
  type ServerKeyring,
  createKeyringSignatureVerifier,
  ingestAuthenticatedRefundRequest,
} from '../../server/provenanceAuth';
import { SqlitePersistentReplayStore } from '../../server/replayStore';
import { executeAuthorizedFinanceRefund } from '../../server/financeExecutor';
import { createGovernanceRouter } from '../../server/governanceRoutes';
import type { GovernanceAuthVerifier } from '../../server/governanceAuth';
import type { AuthoritativeOrderStore } from '../../server/orderStore';

function createEphemeralKeyring(): ServerKeyring {
  const secret = crypto.randomBytes(32).toString('hex');
  return {
    activeKeyId: 'ephemeral-p0-key',
    keys: {
      'ephemeral-p0-key': {
        keyId: 'ephemeral-p0-key',
        secret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    },
  };
}

async function startTestHttpServer(deps: {
  keyring: ServerKeyring;
  replayStore: SqlitePersistentReplayStore;
  authVerifier: GovernanceAuthVerifier;
  orderStore?: AuthoritativeOrderStore;
  onPayment: () => void;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    createGovernanceRouter({
      replayStore: deps.replayStore,
      getKeyring: () => deps.keyring,
      getAuthVerifier: () => deps.authVerifier,
      orderStore: deps.orderStore,
      executePaymentRefund: async (req) => {
        deps.onPayment();
        return { txId: `sim-tx-${req.order_id}` };
      },
    })
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

async function runP0SecurityTests() {
  const keyring = createEphemeralKeyring();
  const verifySig = createKeyringSignatureVerifier(keyring);
  const store = new SqlitePersistentReplayStore(':memory:');
  const ownerUserId = '11111111-1111-4111-8111-111111111111';
  const supportUserId = '22222222-2222-4222-8222-222222222222';
  const unprivUserId = '33333333-3333-4333-8333-333333333333';

  const testOrders = new Map<
    string,
    { amountCents: number; ownerId: string; tenantId: string }
  >([
    ['biz-prime:ord-p0-legit-1', { amountCents: 30000, ownerId: 'usr-owner-real-1', tenantId: 'usr-owner-real-1' }],
    ['biz-prime:ord-p0-race-1', { amountCents: 11000, ownerId: 'usr-owner-real-1', tenantId: 'usr-owner-real-1' }],
    ['biz-prime:ord-http-owner-approved-1', { amountCents: 45000, ownerId: ownerUserId, tenantId: ownerUserId }],
    ['biz-prime:ord-http-support-1', { amountCents: 1800, ownerId: ownerUserId, tenantId: ownerUserId }],
  ]);

  const testOrderStore: AuthoritativeOrderStore = {
    configured: true,
    getOrderForBusiness: async ({ orderId, businessId }) => {
      const rec = testOrders.get(`${businessId}:${orderId}`);
      if (!rec) return null;
      return {
        orderId,
        businessId,
        businessStatus: 'active',
        ownerId: rec.ownerId,
        tenantId: rec.tenantId,
        amountCents: rec.amountCents,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      };
    },
  };

  let paymentCallbackCalls = 0;

  let passed = 0;
  const pass = (name: string, detail: string) => {
    passed += 1;
    console.log(`[PASS] ${name} -> ${detail}`);
  };

  try {
    // 1. Default verifier must fail closed on any apr- token
    assert.equal(
      DEFAULT_FINANCE_REFUND_POLICY.verifyOwnerApprovalToken(
        'apr-fabricated',
        '550e8400-e29b-41d4-a716-446655440001',
        'ord-1',
        490
      ),
      false
    );
    pass('P0-1 — Default verifyOwnerApprovalToken fails closed', 'returns false for apr-*');

    // 2. Forged "apr-" approval ID rejected (no authoritative record in DB)
    const reqForgedId = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-prime',
        order_id: 'ord-p0-forged-id',
        customer_email: 'synthetic-buyer@example.test',
        amount_usd: 490.0,
        reason: 'High value refund',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt-p0-1',
        raw_trigger_payload: '{"t":"1"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    const resForgedId = await executeAuthorizedFinanceRefund(
      {
        ...reqForgedId,
        provenance: {
          ...reqForgedId.provenance!,
          owner_approval_id: 'apr-forged-attacker-001',
        },
      },
      {
        keyring,
        replayStore: store,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'must-not-run' };
        },
      }
    );
    assert.equal(resForgedId.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(resForgedId.executedNewRefund, false);
    assert.equal(paymentCallbackCalls, 0);
    pass('P0-2 — Forged apr- approval ID rejected', `${resForgedId.status} (${resForgedId.code})`);

    // 3. Forged client-supplied owner_approval_binding rejected
    const resForgedBinding = await executeAuthorizedFinanceRefund(
      {
        ...reqForgedId,
        provenance: {
          ...reqForgedId.provenance!,
          owner_approval_id: 'apr-forged-binding-002',
          owner_approval_binding: {
            approval_id: 'apr-forged-binding-002',
            request_id: reqForgedId.provenance!.request_id,
            order_id: reqForgedId.order_id,
            amount_usd: 490.0,
            approved_by_user_id: 'spoofed-owner-uuid',
            approved_at: new Date().toISOString(),
          },
        },
      },
      {
        keyring,
        replayStore: store,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'must-not-run' };
        },
      }
    );
    assert.equal(resForgedBinding.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(resForgedBinding.executedNewRefund, false);
    assert.equal(paymentCallbackCalls, 0);
    pass(
      'P0-3 — Forged owner_approval_binding rejected',
      `${resForgedBinding.status} (${resForgedBinding.code})`
    );

    // Direct evaluateFinanceRefund without authoritative store also fails closed
    const directNoStore = evaluateFinanceRefund(
      {
        ...reqForgedId,
        provenance: {
          ...reqForgedId.provenance!,
          owner_approval_id: 'apr-direct-bypass',
          owner_approval_binding: {
            approval_id: 'apr-direct-bypass',
            request_id: reqForgedId.provenance!.request_id,
            order_id: reqForgedId.order_id,
            amount_usd: 490.0,
          },
        },
      },
      { verifyIngestionSignature: verifySig }
    );
    assert.equal(directNoStore.decision, 'REJECT_SECURITY_VIOLATION');
    pass(
      'P0-3b — No authoritative approval store/verifier fails closed',
      `${directNoStore.decision} (${directNoStore.securityCode})`
    );

    // 4. Recommend-only request cannot self-escalate to owner_approved
    const reqRecommendOnly = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-prime',
        order_id: 'ord-p0-self-escalate',
        customer_email: 'synthetic-buyer@example.test',
        amount_usd: 490.0,
        reason: 'Marketing refund attempt',
        source_agent: 'marketing',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-p0-4',
        raw_trigger_payload: '{"t":"4"}',
        confidence: 0.2,
        authority_level: 'recommend_only',
      },
      keyring
    );
    await store.recordProvenanceOrigin(reqRecommendOnly.provenance!, reqRecommendOnly.order_id);
    const selfEscalatedRes = await executeAuthorizedFinanceRefund(
      {
        ...reqRecommendOnly,
        provenance: {
          ...reqRecommendOnly.provenance!,
          authority_level: 'owner_approved',
          owner_approval_id: 'apr-self-escalated',
          owner_approval_binding: {
            approval_id: 'apr-self-escalated',
            request_id: reqRecommendOnly.provenance!.request_id,
            order_id: reqRecommendOnly.order_id,
            amount_usd: 490.0,
            approved_by_user_id: 'attacker',
          },
        },
      },
      {
        keyring,
        replayStore: store,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'must-not-run' };
        },
      }
    );
    assert.equal(selfEscalatedRes.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(selfEscalatedRes.executedNewRefund, false);
    assert.equal(paymentCallbackCalls, 0);
    pass(
      'P0-4 — Recommend-only self-escalation to owner_approved rejected',
      `${selfEscalatedRes.status} (${selfEscalatedRes.code})`
    );

    // 5. Missing approval record / omitted approval_id rejected
    const resMissingApproval = await executeAuthorizedFinanceRefund(reqForgedId, {
      keyring,
      replayStore: store,
      executePaymentRefund: async () => {
        paymentCallbackCalls += 1;
        return { txId: 'must-not-run' };
      },
    });
    assert.equal(resMissingApproval.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(resMissingApproval.code, 'OWNER_APPROVAL_MISSING');
    assert.equal(paymentCallbackCalls, 0);
    pass('P0-5 — Missing approval record / ID rejected', resMissingApproval.code);

    // 6. Expired approval rejected
    const reqExpired = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-prime',
        order_id: 'ord-p0-expired',
        customer_email: 'synthetic-buyer@example.test',
        amount_usd: 120.0,
        reason: 'Expired approval test',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt-p0-6',
        raw_trigger_payload: '{"t":"6"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    await store.recordOwnerApproval({
      approvalId: 'apr-p0-expired-01',
      requestId: reqExpired.provenance!.request_id,
      orderId: reqExpired.order_id,
      businessId: reqExpired.business_id,
      amountCents: 12000,
      approvedByUserId: 'usr-owner-real-1',
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
      ownerId: 'usr-owner-real-1',
      tenantId: 'usr-owner-real-1',
    });
    const resExpired = await executeAuthorizedFinanceRefund(
      {
        ...reqExpired,
        provenance: {
          ...reqExpired.provenance!,
          owner_approval_id: 'apr-p0-expired-01',
        },
      },
      {
        keyring,
        replayStore: store,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'must-not-run' };
        },
      }
    );
    assert.equal(resExpired.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(resExpired.code, 'OWNER_APPROVAL_EXPIRED');
    assert.equal(paymentCallbackCalls, 0);
    pass('P0-6 — Expired approval rejected', resExpired.code);

    // 7. Approval for a different order rejected
    const reqDiffOrder = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-prime',
        order_id: 'ord-p0-victim-order',
        customer_email: 'synthetic-buyer@example.test',
        amount_usd: 95.0,
        reason: 'Order mismatch test',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt-p0-7',
        raw_trigger_payload: '{"t":"7"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    await store.recordOwnerApproval({
      approvalId: 'apr-p0-diff-order',
      requestId: reqDiffOrder.provenance!.request_id,
      orderId: 'ord-p0-approved-other-order',
      businessId: reqDiffOrder.business_id,
      amountCents: 9500,
      approvedByUserId: 'usr-owner-real-1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      ownerId: 'usr-owner-real-1',
      tenantId: 'usr-owner-real-1',
    });
    const resDiffOrder = await executeAuthorizedFinanceRefund(
      {
        ...reqDiffOrder,
        provenance: {
          ...reqDiffOrder.provenance!,
          owner_approval_id: 'apr-p0-diff-order',
        },
      },
      {
        keyring,
        replayStore: store,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'must-not-run' };
        },
      }
    );
    assert.equal(resDiffOrder.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(resDiffOrder.code, 'OWNER_APPROVAL_MISMATCH');
    assert.equal(paymentCallbackCalls, 0);
    pass('P0-7 — Approval for different order rejected', resDiffOrder.code);

    // 8. Approval for a different amount rejected
    const reqDiffAmount = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-prime',
        order_id: 'ord-p0-diff-amount',
        customer_email: 'synthetic-buyer@example.test',
        amount_usd: 250.0,
        reason: 'Amount mismatch test',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt-p0-8',
        raw_trigger_payload: '{"t":"8"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    await store.recordOwnerApproval({
      approvalId: 'apr-p0-diff-amount',
      requestId: reqDiffAmount.provenance!.request_id,
      orderId: reqDiffAmount.order_id,
      businessId: reqDiffAmount.business_id,
      amountCents: 2500, // Approved for $25, request is $250
      approvedByUserId: 'usr-owner-real-1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      ownerId: 'usr-owner-real-1',
      tenantId: 'usr-owner-real-1',
    });
    const resDiffAmount = await executeAuthorizedFinanceRefund(
      {
        ...reqDiffAmount,
        provenance: {
          ...reqDiffAmount.provenance!,
          owner_approval_id: 'apr-p0-diff-amount',
        },
      },
      {
        keyring,
        replayStore: store,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'must-not-run' };
        },
      }
    );
    assert.equal(resDiffAmount.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(resDiffAmount.code, 'OWNER_APPROVAL_AMOUNT_MISMATCH');
    assert.equal(paymentCallbackCalls, 0);
    pass('P0-8 — Approval for different amount rejected', resDiffAmount.code);

    // 9. Already-consumed approval rejected (plus non-approved status & single-use concurrency)
    const reqLegit = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-prime',
        order_id: 'ord-p0-legit-1',
        customer_email: 'synthetic-buyer@example.test',
        amount_usd: 300.0,
        reason: 'Valid owner approved refund',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt-p0-9',
        raw_trigger_payload: '{"t":"9"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    await store.recordOwnerApproval({
      approvalId: 'apr-p0-legit-01',
      requestId: reqLegit.provenance!.request_id,
      orderId: reqLegit.order_id,
      businessId: reqLegit.business_id,
      amountCents: 30000,
      approvedByUserId: 'usr-owner-real-1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      ownerId: 'usr-owner-real-1',
      tenantId: 'usr-owner-real-1',
    });
    const resLegit = await executeAuthorizedFinanceRefund(
      {
        ...reqLegit,
        provenance: {
          ...reqLegit.provenance!,
          owner_approval_id: 'apr-p0-legit-01',
        },
      },
      {
        keyring,
        replayStore: store,
        orderStore: testOrderStore,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'tx-p0-legit-01' };
        },
      }
    );
    assert.equal(resLegit.status, 'EXECUTED');
    assert.equal(paymentCallbackCalls, 1);

    const consumedRow = await store.getOwnerApproval('apr-p0-legit-01');
    assert.equal(consumedRow?.status, 'consumed');
    assert.ok(consumedRow?.consumed_at);

    // Attempt reuse of consumed approval with new idempotency key
    const resReusedSameReq = await executeAuthorizedFinanceRefund(
      {
        ...reqLegit,
        idempotency_key: 'idem-replay-different-key',
        provenance: {
          ...reqLegit.provenance!,
          owner_approval_id: 'apr-p0-legit-01',
        },
      },
      {
        keyring,
        replayStore: store,
        executePaymentRefund: async () => {
          paymentCallbackCalls += 1;
          return { txId: 'must-not-run' };
        },
      }
    );
    assert.equal(resReusedSameReq.status, 'REJECTED_SECURITY_VIOLATION');
    assert.equal(resReusedSameReq.code, 'OWNER_APPROVAL_ALREADY_CONSUMED');
    assert.equal(paymentCallbackCalls, 1);

    // Concurrent race on a fresh valid approval -> at most 1 execution
    const reqRace = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-prime',
        order_id: 'ord-p0-race-1',
        customer_email: 'synthetic-buyer@example.test',
        amount_usd: 110.0,
        reason: 'Concurrency single-use test',
        source_agent: 'customer_support',
        trigger_type: 'owner_command',
        trigger_id: 'tkt-p0-race',
        raw_trigger_payload: '{"t":"race"}',
        confidence: 1.0,
        authority_level: 'owner_approved',
      },
      keyring
    );
    await store.recordOwnerApproval({
      approvalId: 'apr-p0-race-01',
      requestId: reqRace.provenance!.request_id,
      orderId: reqRace.order_id,
      businessId: reqRace.business_id,
      amountCents: 11000,
      approvedByUserId: 'usr-owner-real-1',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      ownerId: 'usr-owner-real-1',
      tenantId: 'usr-owner-real-1',
    });
    const raceResults = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        executeAuthorizedFinanceRefund(
          {
            ...reqRace,
            idempotency_key: `idem-race-${i}`,
            provenance: {
              ...reqRace.provenance!,
              owner_approval_id: 'apr-p0-race-01',
            },
          },
          {
            keyring,
            replayStore: store,
            orderStore: testOrderStore,
            executePaymentRefund: async () => {
              paymentCallbackCalls += 1;
              await new Promise((r) => setTimeout(r, 15));
              return { txId: 'tx-p0-race-01' };
            },
          }
        )
      )
    );
    assert.equal(raceResults.filter((r) => r.executedNewRefund).length, 1);
    assert.equal(paymentCallbackCalls, 2);
    pass(
      'P0-9 — Already-consumed approval rejected & atomic single-use concurrency enforced',
      'consumed status persisted, reuse blocked, 5 parallel -> 1 executed'
    );

    // 10–14. HTTP Endpoint Authentication, Authorization, Fail-Closed, & End-to-End Tests
    let httpPaymentCalls = 0;

    // 10a. Unconfigured auth disables endpoints by default (503)
    const disabledServer = await startTestHttpServer({
      keyring,
      replayStore: store,
      authVerifier: {
        configured: false,
        ownerUserIds: new Set(),
        reason: 'Auth unconfigured in test',
      },
      onPayment: () => {
        httpPaymentCalls += 1;
      },
    });
    try {
      const rIngestDisabled = await fetch(
        `${disabledServer.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: 'ord-disabled' }),
        }
      );
      assert.equal(rIngestDisabled.status, 503);

      const rRefundDisabled = await fetch(
        `${disabledServer.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqLegit),
        }
      );
      assert.equal(rRefundDisabled.status, 503);
      assert.equal(httpPaymentCalls, 0);
      pass(
        'P0-10a — Endpoints disabled by default (503) when auth unconfigured',
        'both /ingest and /refund return 503'
      );
    } finally {
      await disabledServer.close();
    }

    // Configured verifier with distinct test tokens (ephemeral runtime strings)
    const tokenOwner = `tok-owner-${crypto.randomBytes(12).toString('hex')}`;
    const tokenSupport = `tok-support-${crypto.randomBytes(12).toString('hex')}`;
    const tokenNoRole = `tok-norole-${crypto.randomBytes(12).toString('hex')}`;

    const authVerifier: GovernanceAuthVerifier = {
      configured: true,
      ownerUserIds: new Set([ownerUserId]),
      verifyAccessToken: async (token) => {
        if (token === tokenOwner) {
          return {
            id: ownerUserId,
            email: 'owner@example.test',
            appMetadata: { role: 'owner' },
          };
        }
        if (token === tokenSupport) {
          return {
            id: supportUserId,
            email: 'support@example.test',
            appMetadata: { role: 'support_operator', tenant_id: ownerUserId },
          };
        }
        if (token === tokenNoRole) {
          // Intentionally no appMetadata role (even if attacker claims owner in user_metadata!)
          return {
            id: unprivUserId,
            email: 'random-user@example.test',
            appMetadata: {},
          };
        }
        return null;
      },
    };

    const httpServer = await startTestHttpServer({
      keyring,
      replayStore: store,
      authVerifier,
      orderStore: testOrderStore,
      onPayment: () => {
        httpPaymentCalls += 1;
      },
    });

    try {
      // 10b. Unauthenticated ingestion rejected (401)
      const rNoAuthIngest = await fetch(
        `${httpServer.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_id: 'ord-http-1', amount_usd: 15 }),
        }
      );
      assert.equal(rNoAuthIngest.status, 401);

      const rBadTokIngest = await fetch(
        `${httpServer.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer invalid-forged-jwt',
          },
          body: JSON.stringify({ order_id: 'ord-http-1', amount_usd: 15 }),
        }
      );
      assert.equal(rBadTokIngest.status, 401);
      pass('P0-10b — Unauthenticated ingestion rejected', 'missing & forged Bearer -> 401');

      // 11. Unauthenticated refund execution rejected (401)
      const rNoAuthRefund = await fetch(
        `${httpServer.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqLegit),
        }
      );
      assert.equal(rNoAuthRefund.status, 401);
      assert.equal(httpPaymentCalls, 0);
      pass('P0-11 — Unauthenticated refund execution rejected', '401 & 0 payment calls');

      // 12. Unauthorized callers rejected (403) & client sender_auth claims ignored
      const rUnprivIngest = await fetch(
        `${httpServer.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenNoRole}`,
          },
          body: JSON.stringify({ order_id: 'ord-http-2', amount_usd: 15 }),
        }
      );
      assert.equal(rUnprivIngest.status, 403);

      // support_operator CAN ingest execute_under_policy, CANNOT ingest owner_approved, CANNOT execute refund
      const rSupportOwnerApprovedIngest = await fetch(
        `${httpServer.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenSupport}`,
          },
          body: JSON.stringify({
            order_id: 'ord-http-support-esc',
            amount_usd: 200,
            authority_level: 'owner_approved',
          }),
        }
      );
      assert.equal(rSupportOwnerApprovedIngest.status, 403);

      const rSupportIngestClean = await fetch(
        `${httpServer.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenSupport}`,
          },
          body: JSON.stringify({
            business_id: 'biz-prime',
            order_id: 'ord-http-support-1',
            customer_email: 'synthetic-buyer@example.test',
            amount_usd: 18.0,
            reason: 'Legitimate support ingest',
            source_agent: 'customer_support',
            confidence: 0.95,
            authority_level: 'execute_under_policy',
            // Attempted client-side spoofing of sender_auth must be ignored!
            sender_auth_verified: false,
            sender_actor_id: 'spoofed-attacker-actor',
          }),
        }
      );
      assert.equal(rSupportIngestClean.status, 200);
      const supportIngestBody = (await rSupportIngestClean.json()) as any;
      assert.equal(supportIngestBody.request.provenance.sender_auth.actor_id, supportUserId);
      assert.equal(supportIngestBody.request.provenance.sender_auth.verified, true);

      // support_operator calling /finance/refund must be rejected (403)
      const rSupportRefund = await fetch(
        `${httpServer.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenSupport}`,
          },
          body: JSON.stringify(supportIngestBody.request),
        }
      );
      assert.equal(rSupportRefund.status, 403);
      assert.equal(httpPaymentCalls, 0);
      pass(
        'P0-12 — Unauthorized callers rejected & client sender_auth claims ignored',
        'unprivileged 403, support->refund 403, server-derived sender_auth verified'
      );

      // 13. Legitimately authenticated & owner-approved HTTP workflow succeeds end-to-end
      const rOwnerIngest = await fetch(
        `${httpServer.baseUrl}/api/governance/provenance/ingest`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOwner}`,
          },
          body: JSON.stringify({
            business_id: 'biz-prime',
            order_id: 'ord-http-owner-approved-1',
            customer_email: 'synthetic-vip@example.test',
            amount_usd: 450.0,
            reason: 'Owner authorized enterprise refund',
            source_agent: 'customer_support',
            trigger_type: 'owner_command',
            confidence: 0.99,
            authority_level: 'owner_approved',
          }),
        }
      );
      assert.equal(rOwnerIngest.status, 200);
      const ownerIngestJson = (await rOwnerIngest.json()) as any;
      const ingestedReq = ownerIngestJson.request;

      // Without authoritative approval row in store, even authenticated owner is rejected (403)
      const rBeforeApproval = await fetch(
        `${httpServer.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOwner}`,
          },
          body: JSON.stringify({
            ...ingestedReq,
            provenance: {
              ...ingestedReq.provenance,
              owner_approval_id: 'apr-http-missing-1',
            },
          }),
        }
      );
      assert.equal(rBeforeApproval.status, 403);
      assert.equal(httpPaymentCalls, 0);

      // Record authoritative approval in server store and execute refund
      await store.recordOwnerApproval({
        approvalId: 'apr-http-real-001',
        requestId: ingestedReq.provenance.request_id,
        orderId: ingestedReq.order_id,
        businessId: ingestedReq.business_id,
        amountCents: 45000,
        approvedByUserId: ownerUserId,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        ownerId: ownerUserId,
        tenantId: ownerUserId,
      });

      const rOwnerRefund = await fetch(
        `${httpServer.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOwner}`,
          },
          body: JSON.stringify({
            ...ingestedReq,
            provenance: {
              ...ingestedReq.provenance,
              owner_approval_id: 'apr-http-real-001',
            },
          }),
        }
      );
      assert.equal(rOwnerRefund.status, 200);
      const refundJson = (await rOwnerRefund.json()) as any;
      assert.equal(refundJson.status, 'EXECUTED');
      assert.equal(refundJson.executedNewRefund, true);
      assert.equal(httpPaymentCalls, 1);

      // Policy execute_under_policy (<= $25) also works via authenticated owner
      const rSmallRefund = await fetch(
        `${httpServer.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenOwner}`,
          },
          body: JSON.stringify(supportIngestBody.request),
        }
      );
      assert.equal(rSmallRefund.status, 200);
      assert.equal(httpPaymentCalls, 2);

      pass(
        'P0-13 — Legitimately authenticated & approved HTTP flow executes',
        'owner_approved & execute_under_policy both verified'
      );
    } finally {
      await httpServer.close();
    }

    console.log(`\nALL ${passed} P0 SECURITY REGRESSION CHECKS PASSED.\n`);
  } finally {
    store.close();
  }
}

runP0SecurityTests().catch((err) => {
  console.error('\n[FAIL] P0 security regression suite failed:', err);
  process.exit(1);
});
