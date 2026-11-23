import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createGovernanceRouter } from '../../server/governanceRoutes';
import type { GovernanceAuthVerifier } from '../../server/governanceAuth';
import type { ServerKeyring } from '../../server/provenanceAuth';
import { SqlitePersistentReplayStore } from '../../server/replayStore';
import type { PaymentRefundProviderAdapter } from '../../server/financeExecutor';
import type { AuthoritativeOrderStore } from '../../server/orderStore';

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

async function startTestServer(opts: {
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

  // Ephemeral runtime-generated secret — never hardcoded or logged
  const ephemeralSecret = crypto.randomBytes(32).toString('hex');
  const keyring: ServerKeyring = {
    activeKeyId: 'ephemeral-p0c-key',
    keys: {
      'ephemeral-p0c-key': {
        keyId: 'ephemeral-p0c-key',
        secret: ephemeralSecret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
      },
    },
  };

  const store = new SqlitePersistentReplayStore(':memory:');

  // Ephemeral test bearer tokens mapped to server-controlled identities
  const tokOwnerA = `tok-owner-a-${crypto.randomBytes(10).toString('hex')}`;
  const tokOwnerB = `tok-owner-b-${crypto.randomBytes(10).toString('hex')}`;
  const tokAdminRestricted = `tok-admin-restr-${crypto.randomBytes(10).toString('hex')}`;
  const tokSupportA = `tok-support-a-${crypto.randomBytes(10).toString('hex')}`;
  const tokFinanceA = `tok-finance-a-${crypto.randomBytes(10).toString('hex')}`;
  const tokNoRole = `tok-norole-${crypto.randomBytes(10).toString('hex')}`;

  const ownerAId = '11111111-1111-4111-8111-111111111111';
  const ownerBId = '22222222-2222-4222-8222-222222222222';
  const adminRestrId = '33333333-3333-4333-8333-333333333333';
  const supportAId = '44444444-4444-4444-8444-444444444444';
  const financeAId = '55555555-5555-4555-8555-555555555555';
  const noRoleId = '66666666-6666-4666-8666-666666666666';

  const authVerifier: GovernanceAuthVerifier = {
    configured: true,
    ownerUserIds: new Set([ownerAId, ownerBId]),
    verifyAccessToken: async (token) => {
      if (token === tokOwnerA) {
        return {
          id: ownerAId,
          email: 'owner-a@example.test',
          appMetadata: { role: 'owner', tenant_id: 'tenant-a' },
        };
      }
      if (token === tokOwnerB) {
        return {
          id: ownerBId,
          email: 'owner-b@example.test',
          appMetadata: { role: 'owner', tenant_id: 'tenant-b' },
        };
      }
      if (token === tokAdminRestricted) {
        return {
          id: adminRestrId,
          email: 'admin-biz2@example.test',
          appMetadata: {
            role: 'admin',
            tenant_id: 'tenant-a',
            owner_id: ownerAId,
            business_ids: ['biz-other-only'],
          },
        };
      }
      if (token === tokSupportA) {
        return {
          id: supportAId,
          email: 'support-a@example.test',
          appMetadata: { role: 'support_operator', tenant_id: 'tenant-a', owner_id: ownerAId },
        };
      }
      if (token === tokFinanceA) {
        return {
          id: financeAId,
          email: 'finance-a@example.test',
          appMetadata: { role: 'finance_operator', tenant_id: 'tenant-a', owner_id: ownerAId },
        };
      }
      if (token === tokNoRole) {
        return {
          id: noRoleId,
          email: 'unpriv@example.test',
          appMetadata: {},
        };
      }
      return null;
    },
  };

  let providerExecutions = 0;
  const providerExecutionsByOrder = new Map<string, number>();
  let forceTimeoutForOrder: string | null = null;

  const paymentProvider: PaymentRefundProviderAdapter = {
    providerName: 'p0c_test_provider',
    supportsIdempotencyKey: true,
    supportsRefundLookup: true,
    executeRefund: async ({ request, providerIdempotencyKey }) => {
      if (forceTimeoutForOrder && request.order_id === forceTimeoutForOrder) {
        return {
          outcome: 'UNKNOWN_OR_TIMEOUT',
          reason: 'Simulated gateway timeout after charge dispatch',
        };
      }
      providerExecutions += 1;
      providerExecutionsByOrder.set(
        request.order_id,
        (providerExecutionsByOrder.get(request.order_id) ?? 0) + 1
      );
      return {
        outcome: 'CONFIRMED_SUCCESS',
        txId: `tx-p0c-${request.order_id}-${providerIdempotencyKey.slice(-6)}`,
      };
    },
    lookupRefundByIdempotencyKey: async () => ({
      outcome: 'UNKNOWN_OR_UNSUPPORTED',
      reason: 'Still unresolved in test stub',
    }),
  };

  const p0cOrderAmounts = new Map<string, number>([
    ['biz-alpha:ord-p0c-1', 14900],
    ['biz-alpha:ord-p0c-roles', 8000],
    ['biz-alpha:ord-p0c-bind', 7500],
    ['biz-alpha:ord-p0c-expired', 6000],
    ['biz-alpha:ord-p0c-revoke', 9500],
    ['biz-alpha:ord-p0c-reuse-target', 14900],
    ['biz-alpha:ord-p0c-uncertain', 11000],
    ['biz-alpha:ord-p0c-forged', 5500],
  ]);

  const testP0COrderStore: AuthoritativeOrderStore = {
    configured: true,
    getOrderForBusiness: async ({ orderId, businessId }) => {
      const amountCents = p0cOrderAmounts.get(`${businessId}:${orderId}`);
      if (amountCents === undefined) return null;
      return {
        orderId,
        businessId,
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: 'tenant-a',
        amountCents,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      };
    },
  };

  const server = await startTestServer({
    keyring,
    replayStore: store,
    authVerifier,
    orderStore: testP0COrderStore,
    paymentProvider,
  });

  async function ingestAsSupportA(orderId: string, amountUsd = 149.0, businessId = 'biz-alpha') {
    const resp = await fetch(`${server.baseUrl}/api/governance/provenance/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokSupportA}`,
      },
      body: JSON.stringify({
        business_id: businessId,
        order_id: orderId,
        customer_email: 'buyer@example.test',
        amount_usd: amountUsd,
        reason: `Refund requested for ${orderId}`,
        source_agent: 'customer_support',
        confidence: 0.94,
        authority_level: 'recommend_only',
      }),
    });
    assert.equal(resp.status, 200, `Ingest failed for ${orderId}`);
    const body = (await resp.json()) as any;
    return body.request;
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1 & 4: Authenticated owner creates approval & ignores spoofed client fields
    // -------------------------------------------------------------------------
    const req1 = await ingestAsSupportA('ord-p0c-1', 149.0, 'biz-alpha');
    const rCreate1 = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: req1.provenance.request_id,
        order_id: 'ord-p0c-1',
        business_id: 'biz-alpha',
        amount_cents: 14900,
        // Attempted spoofing must ALL be ignored!
        approved_by_user_id: 'spoofed-attacker-id',
        approval_id: 'apr-spoofed-client-id',
        expires_at: '2099-01-01T00:00:00.000Z',
        status: 'consumed',
        decision_note: 'Verified order duplicate',
      }),
    });
    assert.equal(rCreate1.status, 201);
    const created1 = ((await rCreate1.json()) as any).approval;
    assert.ok(created1.approval_id.startsWith('apr-'));
    assert.notEqual(created1.approval_id, 'apr-spoofed-client-id');
    assert.equal(created1.approved_by_user_id, ownerAId);
    assert.equal(created1.status, 'approved');
    assert.equal(created1.amount_cents, 14900);
    assert.notEqual(created1.expires_at, '2099-01-01T00:00:00.000Z');

    // Verify GET /api/governance/approvals returns it to Owner A
    const rListA = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(rListA.status, 200);
    const listABody = (await rListA.json()) as any;
    assert.ok(
      listABody.approvals.some((a: any) => a.approval_id === created1.approval_id)
    );
    pass(
      'P0C-1 & P0C-4 — Authenticated owner creates authoritative approval; client-spoofed approver/ID/expiry ignored',
      `approval_id=${created1.approval_id}, approver=${created1.approved_by_user_id}`
    );

    // -------------------------------------------------------------------------
    // TEST 2: Unauthenticated requests denied (401)
    // -------------------------------------------------------------------------
    const rNoAuthPost = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_id: req1.provenance.request_id,
        order_id: 'ord-p0c-1',
        business_id: 'biz-alpha',
        amount_cents: 14900,
      }),
    });
    assert.equal(rNoAuthPost.status, 401);

    const rNoAuthGet = await fetch(`${server.baseUrl}/api/governance/approvals`);
    assert.equal(rNoAuthGet.status, 401);

    const rNoAuthRevoke = await fetch(
      `${server.baseUrl}/api/governance/approvals/${created1.approval_id}/revoke`,
      { method: 'POST' }
    );
    assert.equal(rNoAuthRevoke.status, 401);
    pass('P0C-2 — Unauthenticated approval create/list/revoke rejected (401)');

    // -------------------------------------------------------------------------
    // TEST 3: Non-owner callers (support_operator, finance_operator, no-role) denied (403)
    // -------------------------------------------------------------------------
    const reqRoleTest = await ingestAsSupportA('ord-p0c-roles', 80.0, 'biz-alpha');
    for (const [label, tok] of [
      ['support_operator', tokSupportA],
      ['finance_operator', tokFinanceA],
      ['unprivileged', tokNoRole],
    ] as const) {
      const rPost = await fetch(`${server.baseUrl}/api/governance/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tok}`,
        },
        body: JSON.stringify({
          request_id: reqRoleTest.provenance.request_id,
          order_id: 'ord-p0c-roles',
          business_id: 'biz-alpha',
          amount_cents: 8000,
        }),
      });
      assert.equal(rPost.status, 403, `${label} must not be able to create approvals`);

      const rGet = await fetch(`${server.baseUrl}/api/governance/approvals`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      assert.equal(rGet.status, 403, `${label} must not be able to list approvals`);

      const rRev = await fetch(
        `${server.baseUrl}/api/governance/approvals/${created1.approval_id}/revoke`,
        { method: 'POST', headers: { Authorization: `Bearer ${tok}` } }
      );
      assert.equal(rRev.status, 403, `${label} must not be able to revoke approvals`);
    }
    pass(
      'P0C-3 — Non-owner callers (support_operator, finance_operator, unprivileged) denied (403)'
    );

    // -------------------------------------------------------------------------
    // TEST 5: Cross-tenant and business-scope isolation enforced
    // -------------------------------------------------------------------------
    const rCrossTenantCreate = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerB}`,
      },
      body: JSON.stringify({
        request_id: reqRoleTest.provenance.request_id,
        order_id: 'ord-p0c-roles',
        business_id: 'biz-alpha',
        amount_cents: 8000,
      }),
    });
    assert.equal(rCrossTenantCreate.status, 403);

    const rBizDeniedCreate = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokAdminRestricted}`,
      },
      body: JSON.stringify({
        request_id: reqRoleTest.provenance.request_id,
        order_id: 'ord-p0c-roles',
        business_id: 'biz-alpha',
        amount_cents: 8000,
      }),
    });
    assert.equal(rBizDeniedCreate.status, 403);

    const rCrossTenantRevoke = await fetch(
      `${server.baseUrl}/api/governance/approvals/${created1.approval_id}/revoke`,
      { method: 'POST', headers: { Authorization: `Bearer ${tokOwnerB}` } }
    );
    assert.equal(rCrossTenantRevoke.status, 403);

    const rListB = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      headers: { Authorization: `Bearer ${tokOwnerB}` },
    });
    assert.equal(rListB.status, 200);
    const listBBody = (await rListB.json()) as any;
    assert.equal(
      listBBody.approvals.some((a: any) => a.approval_id === created1.approval_id),
      false,
      'Owner B must never see Owner A approvals'
    );
    pass('P0C-5 — Cross-tenant and business-scope isolation enforced on create/list/revoke');

    // -------------------------------------------------------------------------
    // TEST 6: Mismatched order_id / business_id / amount_cents & unknown request_id rejected
    // -------------------------------------------------------------------------
    const reqBind = await ingestAsSupportA('ord-p0c-bind', 75.0, 'biz-alpha');
    for (const [label, patch] of [
      ['wrong order_id', { order_id: 'ord-different' }],
      ['wrong business_id', { business_id: 'biz-different' }],
      ['wrong amount_cents', { amount_cents: 7501 }],
    ] as const) {
      const rMismatch = await fetch(`${server.baseUrl}/api/governance/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerA}`,
        },
        body: JSON.stringify({
          request_id: reqBind.provenance.request_id,
          order_id: 'ord-p0c-bind',
          business_id: 'biz-alpha',
          amount_cents: 7500,
          ...patch,
        }),
      });
      assert.equal(rMismatch.status, 409, `${label} must return 409`);
    }

    const rNotFound = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        order_id: 'ord-nonexistent',
        business_id: 'biz-alpha',
        amount_cents: 5000,
      }),
    });
    assert.equal(rNotFound.status, 404);
    pass('P0C-6 — Wrong order_id, business_id, amount_cents, and unknown request_id rejected');

    // -------------------------------------------------------------------------
    // TEST 7: Duplicate approval creation rejected (sequential & concurrent)
    // -------------------------------------------------------------------------
    const rDup = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: req1.provenance.request_id,
        order_id: 'ord-p0c-1',
        business_id: 'biz-alpha',
        amount_cents: 14900,
      }),
    });
    assert.equal(rDup.status, 409);

    // Concurrent race on reqBind
    const [raceA, raceB] = await Promise.all([
      fetch(`${server.baseUrl}/api/governance/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerA}`,
        },
        body: JSON.stringify({
          request_id: reqBind.provenance.request_id,
          order_id: 'ord-p0c-bind',
          business_id: 'biz-alpha',
          amount_cents: 7500,
        }),
      }),
      fetch(`${server.baseUrl}/api/governance/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerA}`,
        },
        body: JSON.stringify({
          request_id: reqBind.provenance.request_id,
          order_id: 'ord-p0c-bind',
          business_id: 'biz-alpha',
          amount_cents: 7500,
        }),
      }),
    ]);
    const raceStatuses = [raceA.status, raceB.status].sort();
    assert.deepEqual(raceStatuses, [201, 409]);
    pass('P0C-7 — Duplicate sequential and concurrent approval creations rejected (409)');

    // -------------------------------------------------------------------------
    // TEST 8: Expired approval cannot execute refund
    // -------------------------------------------------------------------------
    const reqExp = await ingestAsSupportA('ord-p0c-expired', 60.0, 'biz-alpha');
    const expiredApprovalId = `apr-${crypto.randomUUID()}`;
    await store.recordOwnerApproval({
      approvalId: expiredApprovalId,
      requestId: reqExp.provenance.request_id,
      orderId: 'ord-p0c-expired',
      businessId: 'biz-alpha',
      amountCents: 6000,
      approvedByUserId: ownerAId,
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
      ownerId: ownerAId,
      tenantId: 'tenant-a',
    });
    const rExecExpired = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA}`,
      },
      body: JSON.stringify({
        ...reqExp,
        provenance: {
          ...reqExp.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: expiredApprovalId,
        },
      }),
    });
    assert.equal(rExecExpired.status, 403);
    const execExpBody = (await rExecExpired.json()) as any;
    assert.equal(execExpBody.code, 'OWNER_APPROVAL_EXPIRED');
    assert.equal(providerExecutionsByOrder.get('ord-p0c-expired') ?? 0, 0);
    pass('P0C-8 — Expired approval cannot execute refund (403, 0 provider calls)');

    // -------------------------------------------------------------------------
    // TEST 9: Revoked approval cannot execute refund
    // -------------------------------------------------------------------------
    const reqRev = await ingestAsSupportA('ord-p0c-revoke', 95.0, 'biz-alpha');
    const rCreateRev = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: reqRev.provenance.request_id,
        order_id: 'ord-p0c-revoke',
        business_id: 'biz-alpha',
        amount_cents: 9500,
      }),
    });
    assert.equal(rCreateRev.status, 201);
    const revApproval = ((await rCreateRev.json()) as any).approval;

    const rDoRevoke = await fetch(
      `${server.baseUrl}/api/governance/approvals/${revApproval.approval_id}/revoke`,
      { method: 'POST', headers: { Authorization: `Bearer ${tokOwnerA}` } }
    );
    assert.equal(rDoRevoke.status, 200);
    assert.equal(((await rDoRevoke.json()) as any).approval.status, 'revoked');

    const rExecRevoked = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA}`,
      },
      body: JSON.stringify({
        ...reqRev,
        provenance: {
          ...reqRev.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: revApproval.approval_id,
        },
      }),
    });
    assert.equal(rExecRevoked.status, 403);
    assert.equal(((await rExecRevoked.json()) as any).code, 'OWNER_APPROVAL_NOT_APPROVED');
    assert.equal(providerExecutionsByOrder.get('ord-p0c-revoke') ?? 0, 0);
    pass('P0C-9 — Revoked approval cannot execute refund (403, 0 provider calls)');

    // -------------------------------------------------------------------------
    // TEST 10 & 11: Valid owner approval executes EXACTLY ONE refund & cannot be reused or revoked once consumed
    // -------------------------------------------------------------------------
    const rExecValid = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA}`,
      },
      body: JSON.stringify({
        ...req1,
        provenance: {
          ...req1.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: created1.approval_id,
        },
      }),
    });
    assert.equal(rExecValid.status, 200);
    const execValidBody = (await rExecValid.json()) as any;
    assert.equal(execValidBody.status, 'EXECUTED');
    assert.equal(providerExecutionsByOrder.get('ord-p0c-1'), 1);

    const consumedRec = await store.getOwnerApproval(created1.approval_id);
    assert.equal(consumedRec?.status, 'consumed');
    assert.equal(consumedRec?.consumed_by_request_id, req1.provenance.request_id);

    // Consumed approval cannot be revoked
    const rRevokeConsumed = await fetch(
      `${server.baseUrl}/api/governance/approvals/${created1.approval_id}/revoke`,
      { method: 'POST', headers: { Authorization: `Bearer ${tokOwnerA}` } }
    );
    assert.equal(rRevokeConsumed.status, 409);

    // Second different refund request attempting to reuse consumed approval_id MUST fail
    const reqReuse = await ingestAsSupportA('ord-p0c-reuse-target', 149.0, 'biz-alpha');
    const rExecReuse = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA}`,
      },
      body: JSON.stringify({
        ...reqReuse,
        provenance: {
          ...reqReuse.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: created1.approval_id,
        },
      }),
    });
    assert.equal(rExecReuse.status, 403);
    assert.equal(providerExecutionsByOrder.get('ord-p0c-reuse-target') ?? 0, 0);

    // New approval for already-refunded order MUST fail (409)
    const reqDupOrder = await ingestAsSupportA('ord-p0c-1', 149.0, 'biz-alpha');
    const rApproveAlreadyRefunded = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: reqDupOrder.provenance.request_id,
        order_id: 'ord-p0c-1',
        business_id: 'biz-alpha',
        amount_cents: 14900,
      }),
    });
    assert.equal(rApproveAlreadyRefunded.status, 409);
    pass(
      'P0C-10 & P0C-11 — Owner approval authorizes exactly 1 refund; consumed approval cannot be reused or revoked'
    );

    // -------------------------------------------------------------------------
    // TEST 12: Uncertain refund recovery cannot create duplicate approval or reuse approval
    // -------------------------------------------------------------------------
    const reqUncertain = await ingestAsSupportA('ord-p0c-uncertain', 110.0, 'biz-alpha');
    const rCreateUnc = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: reqUncertain.provenance.request_id,
        order_id: 'ord-p0c-uncertain',
        business_id: 'biz-alpha',
        amount_cents: 11000,
      }),
    });
    assert.equal(rCreateUnc.status, 201);
    const uncApproval = ((await rCreateUnc.json()) as any).approval;

    forceTimeoutForOrder = 'ord-p0c-uncertain';
    const rExecUnc = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA}`,
      },
      body: JSON.stringify({
        ...reqUncertain,
        provenance: {
          ...reqUncertain.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: uncApproval.approval_id,
        },
      }),
    });
    forceTimeoutForOrder = null;
    assert.equal(rExecUnc.status, 409);
    assert.equal(((await rExecUnc.json()) as any).status, 'UNCERTAIN_RECONCILIATION_REQUIRED');

    // Another request on locked uncertain order cannot obtain a new approval or reuse uncApproval
    const reqUncRetry = await ingestAsSupportA('ord-p0c-uncertain', 110.0, 'biz-alpha');
    const rApproveUncDup = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: reqUncRetry.provenance.request_id,
        order_id: 'ord-p0c-uncertain',
        business_id: 'biz-alpha',
        amount_cents: 11000,
      }),
    });
    assert.equal(rApproveUncDup.status, 409);

    const rExecUncReuse = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA}`,
      },
      body: JSON.stringify({
        ...reqUncRetry,
        provenance: {
          ...reqUncRetry.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: uncApproval.approval_id,
        },
      }),
    });
    assert.equal(rExecUncReuse.status, 403);
    pass('P0C-12 — Uncertain refund reservation blocks duplicate approval & approval reuse');

    // -------------------------------------------------------------------------
    // TEST 13: Forged client owner_approval_binding without server record fails closed
    // -------------------------------------------------------------------------
    const reqForged = await ingestAsSupportA('ord-p0c-forged', 55.0, 'biz-alpha');
    const rExecForged = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA}`,
      },
      body: JSON.stringify({
        ...reqForged,
        provenance: {
          ...reqForged.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: 'apr-forged-local-only',
          owner_approval_binding: {
            approval_id: 'apr-forged-local-only',
            request_id: reqForged.provenance.request_id,
            order_id: 'ord-p0c-forged',
            amount_usd: 55.0,
            approved_by_user_id: ownerAId,
            approved_at: new Date().toISOString(),
          },
        },
      }),
    });
    assert.equal(rExecForged.status, 403);
    assert.equal(((await rExecForged.json()) as any).code, 'OWNER_APPROVAL_NOT_FOUND');
    assert.equal(providerExecutionsByOrder.get('ord-p0c-forged') ?? 0, 0);
    pass('P0C-13 — Client-forged owner_approval_binding without server record fails closed');

    // -------------------------------------------------------------------------
    // TEST 14: Static SQL verification of migration 000006 & rollback safety
    // -------------------------------------------------------------------------
    const sql06 = fs
      .readFileSync(
        path.resolve(
          process.cwd(),
          'supabase/migrations/20261117000006_p0c_authoritative_approval_requests.sql'
        ),
        'utf8'
      )
      .toLowerCase();
    const sql06Rb = fs
      .readFileSync(
        path.resolve(
          process.cwd(),
          'supabase/migrations/20261117000006_p0c_authoritative_approval_requests_rollback.sql'
        ),
        'utf8'
      )
      .toLowerCase();
    assert(sql06.includes('alter table public.authenticated_refund_requests enable row level security'));
    assert(!/for\s+(insert|update|delete|all)/.test(sql06), '000006 must not expose client write RLS');
    assert(sql06.includes('uq_owner_approvals_active_request'));
    assert(sql06Rb.includes('select count(*) into v_req_count from public.authenticated_refund_requests'));
    assert(sql06Rb.includes('raise exception'));
    pass('P0C-14 — Migration 000006 RLS, active-request unique index, and non-destructive rollback verified');
  } finally {
    await server.close();
    store.close();
  }

  console.log('\n=== P0-C Authoritative Owner Approval Verification ===');
  let failures = 0;
  for (const r of results) {
    if (r.passed) {
      console.log(`PASS: ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    } else {
      failures++;
      console.error(`FAIL: ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
    }
  }
  console.log(`\nSummary: ${results.length - failures}/${results.length} P0-C tests passed.`);
  assert.equal(providerExecutions, 1);
  if (failures > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
