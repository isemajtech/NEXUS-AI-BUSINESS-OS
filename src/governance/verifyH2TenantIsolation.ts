import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createGovernanceRouter } from '../../server/governanceRoutes';
import {
  resolveCallerIdentity,
  type GovernanceAuthVerifier,
} from '../../server/governanceAuth';
import {
  ingestAuthenticatedRefundRequest,
  type ServerKeyring,
} from '../../server/provenanceAuth';
import {
  SqlitePersistentReplayStore,
  SupabasePersistentReplayStore,
} from '../../server/replayStore';
import {
  executeAuthorizedFinanceRefund,
  reconcileFinanceRefund,
  type PaymentRefundProviderAdapter,
} from '../../server/financeExecutor';
import {
  createInMemoryAuthoritativeOrderStore,
  createSupabaseAuthoritativeOrderStoreFromEnv,
  type AuthoritativeOrderRecord,
  type AuthoritativeOrderStore,
} from '../../server/orderStore';

interface TestResult {
  name: string;
  detail: string;
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
  const pass = (name: string, detail: string) => {
    results.push({ name, detail });
    console.log(`[PASS] ${name} -> ${detail}`);
  };

  // Ephemeral runtime-only HMAC keyring
  const ephemeralSecret = crypto.randomBytes(32).toString('hex');
  const keyring: ServerKeyring = {
    activeKeyId: 'ephemeral-h2-key',
    keys: {
      'ephemeral-h2-key': {
        keyId: 'ephemeral-h2-key',
        secret: ephemeralSecret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
      },
    },
  };

  const dbPath = `/tmp/h2-verify-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
  const store = new SqlitePersistentReplayStore(dbPath);

  // Runtime ephemeral tokens mapped to verified server identities
  const tokOwnerA = `tok-owner-a-${crypto.randomBytes(10).toString('hex')}`;
  const tokOwnerB = `tok-owner-b-${crypto.randomBytes(10).toString('hex')}`;
  const tokAdminA1Only = `tok-admin-a1-${crypto.randomBytes(10).toString('hex')}`;
  const tokAdminMissingScope = `tok-admin-noscope-${crypto.randomBytes(10).toString('hex')}`;
  const tokAdminEmptyBiz = `tok-admin-emptybiz-${crypto.randomBytes(10).toString('hex')}`;
  const tokAdminMultiTenant = `tok-admin-multitenant-${crypto.randomBytes(10).toString('hex')}`;
  const tokSupportA = `tok-support-a-${crypto.randomBytes(10).toString('hex')}`;
  const tokSupportB = `tok-support-b-${crypto.randomBytes(10).toString('hex')}`;
  const tokFinanceA = `tok-finance-a-${crypto.randomBytes(10).toString('hex')}`;
  const tokFinanceA1Only = `tok-finance-a1-${crypto.randomBytes(10).toString('hex')}`;
  const tokFinanceMissingScope = `tok-finance-noscope-${crypto.randomBytes(10).toString('hex')}`;
  const tokOwnerMismatchedClaim = `tok-owner-mismatch-${crypto.randomBytes(10).toString('hex')}`;

  const ownerAId = '11111111-1111-4111-8111-111111111111';
  const ownerBId = '22222222-2222-4222-8222-222222222222';
  const adminA1Id = '33333333-3333-4333-8333-333333333333';
  const adminNoScopeId = '44444444-4444-4444-8444-444444444444';
  const adminEmptyBizId = '55555555-5555-4555-8555-555555555555';
  const adminMultiTenantId = '66666666-6666-4666-8666-666666666666';
  const supportAId = '77777777-7777-4777-8777-777777777777';
  const supportBId = '88888888-8888-4888-8888-888888888888';
  const financeAId = '99999999-9999-4999-8999-999999999999';
  const financeA1Id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const financeNoScopeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const authVerifier: GovernanceAuthVerifier = {
    configured: true,
    ownerUserIds: new Set([ownerAId, ownerBId]),
    verifyAccessToken: async (token) => {
      switch (token) {
        case tokOwnerA:
          return {
            id: ownerAId,
            email: 'owner-a@example.test',
            appMetadata: { role: 'owner' },
          };
        case tokOwnerB:
          return {
            id: ownerBId,
            email: 'owner-b@example.test',
            appMetadata: { role: 'owner' },
          };
        case tokAdminA1Only:
          return {
            id: adminA1Id,
            email: 'admin-a1@example.test',
            appMetadata: { role: 'admin', tenant_id: ownerAId, business_ids: ['biz-a1'] },
          };
        case tokAdminMissingScope:
          return {
            id: adminNoScopeId,
            email: 'admin-noscope@example.test',
            appMetadata: { role: 'admin' },
          };
        case tokAdminEmptyBiz:
          return {
            id: adminEmptyBizId,
            email: 'admin-emptybiz@example.test',
            appMetadata: { role: 'admin', business_ids: [] },
          };
        case tokAdminMultiTenant:
          return {
            id: adminMultiTenantId,
            email: 'admin-multitenant@example.test',
            appMetadata: {
              role: 'admin',
              tenant_ids: [ownerAId, ownerBId],
            },
          };
        case tokSupportA:
          return {
            id: supportAId,
            email: 'support-a@example.test',
            appMetadata: { role: 'support_operator', tenant_id: ownerAId },
          };
        case tokSupportB:
          return {
            id: supportBId,
            email: 'support-b@example.test',
            appMetadata: { role: 'support_operator', tenant_id: ownerBId },
          };
        case tokFinanceA:
          return {
            id: financeAId,
            email: 'finance-a@example.test',
            appMetadata: { role: 'finance_operator', tenant_id: ownerAId },
          };
        case tokFinanceA1Only:
          return {
            id: financeA1Id,
            email: 'finance-a1@example.test',
            appMetadata: {
              role: 'finance_operator',
              tenant_id: ownerAId,
              business_ids: ['biz-a1'],
            },
          };
        case tokFinanceMissingScope:
          return {
            id: financeNoScopeId,
            email: 'finance-noscope@example.test',
            appMetadata: { role: 'finance_operator' },
          };
        case tokOwnerMismatchedClaim:
          return {
            id: ownerAId,
            email: 'owner-a-mismatch@example.test',
            appMetadata: { role: 'owner', owner_id: ownerBId },
          };
        default:
          return null;
      }
    },
  };

  // Authoritative order fixture table
  const ordersByKey = new Map<string, AuthoritativeOrderRecord>([
    [
      'biz-a1:ord-a1-ok',
      {
        orderId: 'ord-a1-ok',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1800,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-a2:ord-a2-ok',
      {
        orderId: 'ord-a2-ok',
        businessId: 'biz-a2',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1900,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-b1:ord-b1-ok',
      {
        orderId: 'ord-b1-ok',
        businessId: 'biz-b1',
        businessStatus: 'active',
        ownerId: ownerBId,
        tenantId: ownerBId,
        amountCents: 2000,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-a1:ord-shared-100',
      {
        orderId: 'ord-shared-100',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1700,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-b1:ord-shared-100',
      {
        orderId: 'ord-shared-100',
        businessId: 'biz-b1',
        businessStatus: 'active',
        ownerId: ownerBId,
        tenantId: ownerBId,
        amountCents: 1700,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-a1:ord-refunded',
      {
        orderId: 'ord-refunded',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1500,
        refundedAmountCents: 1500,
        currency: 'USD',
        paymentStatus: 'refunded',
        status: 'refunded',
        eligibleForRefund: false,
      },
    ],
    [
      'biz-a1:ord-disputed',
      {
        orderId: 'ord-disputed',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1500,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'disputed',
        status: 'disputed',
        eligibleForRefund: false,
      },
    ],
    [
      'biz-a1:ord-amount-fixed',
      {
        orderId: 'ord-amount-fixed',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1200,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-a1:ord-foreign-owner',
      {
        orderId: 'ord-foreign-owner',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerBId,
        tenantId: ownerBId,
        amountCents: 1500,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-a1:ord-stale-a1',
      {
        orderId: 'ord-stale-a1',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1400,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-a2:ord-stale-a2',
      {
        orderId: 'ord-stale-a2',
        businessId: 'biz-a2',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1400,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-b1:ord-stale-b1',
      {
        orderId: 'ord-stale-b1',
        businessId: 'biz-b1',
        businessStatus: 'active',
        ownerId: ownerBId,
        tenantId: ownerBId,
        amountCents: 1400,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
    [
      'biz-a1:ord-h1-regression',
      {
        orderId: 'ord-h1-regression',
        businessId: 'biz-a1',
        businessStatus: 'active',
        ownerId: ownerAId,
        tenantId: ownerAId,
        amountCents: 1500,
        refundedAmountCents: 0,
        currency: 'USD',
        paymentStatus: 'paid',
        status: 'completed',
        eligibleForRefund: true,
      },
    ],
  ]);

  let forceOrderLookupError = false;
  const orderStore: AuthoritativeOrderStore = {
    configured: true,
    getOrderForBusiness: async ({ orderId, businessId }) => {
      if (forceOrderLookupError) {
        throw new Error('Simulated public.orders connectivity error');
      }
      return ordersByKey.get(`${businessId}:${orderId}`) ?? null;
    },
  };

  let providerExecuteCalls = 0;
  let providerLookupCalls = 0;
  const executedKeys: string[] = [];

  const paymentProvider: PaymentRefundProviderAdapter = {
    providerName: 'h2_test_provider',
    supportsIdempotencyKey: true,
    supportsRefundLookup: true,
    executeRefund: async ({ request, providerIdempotencyKey }) => {
      providerExecuteCalls += 1;
      executedKeys.push(`${request.business_id}:${request.order_id}`);
      return {
        outcome: 'CONFIRMED_SUCCESS',
        txId: `tx-h2-${request.business_id}-${request.order_id}-${providerIdempotencyKey.slice(-6)}`,
      };
    },
    lookupRefundByIdempotencyKey: async () => {
      providerLookupCalls += 1;
      return {
        outcome: 'CONFIRMED_NOT_EXECUTED',
        reason: 'Lookup called in test',
      };
    },
  };

  const server = await startTestServer({
    keyring,
    replayStore: store,
    authVerifier,
    orderStore,
    paymentProvider,
  });

  async function ingestViaHttp(
    token: string,
    payload: {
      business_id?: string;
      order_id: string;
      amount_usd: number;
      confidence?: number;
      authority_level?: 'recommend_only' | 'execute_under_policy' | 'owner_approved';
      extra?: Record<string, unknown>;
    }
  ) {
    return fetch(`${server.baseUrl}/api/governance/provenance/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        business_id: payload.business_id,
        order_id: payload.order_id,
        customer_email: 'buyer@example.test',
        amount_usd: payload.amount_usd,
        reason: 'H2 test refund request',
        source_agent: 'customer_support',
        confidence: payload.confidence ?? 0.96,
        authority_level: payload.authority_level ?? 'execute_under_policy',
        ...(payload.extra ?? {}),
      }),
    });
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Non-owner caller without verifiable tenant/business scope rejected (403)
    // -------------------------------------------------------------------------
    const sampleSignedReq = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-a1',
        order_id: 'ord-a1-ok',
        customer_email: 'buyer@example.test',
        amount_usd: 18.0,
        reason: 'Valid payload for scope denial check',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-h2-1',
        raw_trigger_payload: '{}',
        confidence: 0.95,
        authority_level: 'execute_under_policy',
      },
      keyring
    );

    const noScopeCalls = await Promise.all([
      ingestViaHttp(tokAdminMissingScope, {
        business_id: 'biz-a1',
        order_id: 'ord-a1-ok',
        amount_usd: 18,
      }),
      fetch(`${server.baseUrl}/api/governance/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokAdminMissingScope}`,
        },
        body: JSON.stringify({
          request_id: crypto.randomUUID(),
          order_id: 'ord-a1-ok',
          business_id: 'biz-a1',
          amount_cents: 1800,
        }),
      }),
      fetch(`${server.baseUrl}/api/governance/approvals`, {
        headers: { Authorization: `Bearer ${tokAdminMissingScope}` },
      }),
      fetch(`${server.baseUrl}/api/governance/approvals/apr-any/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokAdminMissingScope}` },
      }),
      fetch(`${server.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokFinanceMissingScope}`,
        },
        body: JSON.stringify(sampleSignedReq),
      }),
      fetch(`${server.baseUrl}/api/governance/finance/refund/stale`, {
        headers: { Authorization: `Bearer ${tokFinanceMissingScope}` },
      }),
      fetch(`${server.baseUrl}/api/governance/finance/refund/reconcile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokFinanceMissingScope}`,
        },
        body: JSON.stringify({ order_id: 'ord-a1-ok', business_id: 'biz-a1' }),
      }),
    ]);

    for (const r of noScopeCalls) {
      assert.equal(r.status, 403);
      const j = (await r.json()) as any;
      assert.equal(j.code, 'CALLER_SCOPE_MISSING');
    }
    assert.equal(providerExecuteCalls, 0);
    pass(
      'H2-1 — Non-owner callers without tenant/business scope fail closed (403)',
      'All 7 financial endpoints rejected admin/finance_operator without scope'
    );

    // -------------------------------------------------------------------------
    // TEST 2: Empty business_ids: [], malformed claims, multi-tenant claims rejected
    // -------------------------------------------------------------------------
    for (const tok of [tokAdminEmptyBiz, tokAdminMultiTenant, tokOwnerMismatchedClaim]) {
      const r = await ingestViaHttp(tok, {
        business_id: 'biz-a1',
        order_id: 'ord-a1-ok',
        amount_usd: 18,
      });
      assert.equal(r.status, 403);
      assert.equal(((await r.json()) as any).code, 'CALLER_SCOPE_MISSING');
    }

    const malformedBiz = resolveCallerIdentity(
      {
        id: adminNoScopeId,
        appMetadata: {
          role: 'admin',
          tenant_id: ownerAId,
          business_ids: 'not-an-array',
        },
      },
      new Set([ownerAId])
    );
    assert.ok(malformedBiz.scopeError);
    pass(
      'H2-2 — Empty business_ids, multi-tenant claims, and mismatched owner claims fail closed',
      'Rejected 403 CALLER_SCOPE_MISSING'
    );

    // -------------------------------------------------------------------------
    // TEST 3: Client user_metadata & body tenant_id/owner_id spoofing ignored
    // -------------------------------------------------------------------------
    // resolveCallerIdentity intentionally only accepts VerifiedGovernanceUser (which carries appMetadata, never user_metadata).
    // Even if a request body supplies fake owner_id, tenant_id, or approved_by_user_id, server ignores them.
    const resolvedSpoofAttempt = resolveCallerIdentity(
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        appMetadata: { role: 'support_operator', tenant_id: ownerAId },
        user_metadata: {
          role: 'owner',
          owner_id: ownerBId,
          tenant_id: ownerBId,
          business_ids: ['biz-b1'],
        },
      } as any,
      new Set([ownerAId, ownerBId])
    );
    assert.equal(resolvedSpoofAttempt.roles.includes('owner'), false);
    assert.equal(resolvedSpoofAttempt.tenantId, ownerAId);
    assert.equal(resolvedSpoofAttempt.ownerId, undefined);

    const rBodySpoof = await ingestViaHttp(tokSupportA, {
      business_id: 'biz-a1',
      order_id: 'ord-a1-ok',
      amount_usd: 18,
      extra: {
        owner_id: ownerBId,
        tenant_id: ownerBId,
        approved_by_user_id: ownerBId,
      },
    });
    assert.equal(rBodySpoof.status, 200);
    // Server must ignore body owner_id/tenant_id claims and store caller's verified scope ownerAId
    const spoofedBodyJson = (await rBodySpoof.json()) as any;
    const savedSpoofReq = await store.getAuthenticatedRefundRequest(
      spoofedBodyJson.request.provenance.request_id
    );
    assert.equal(savedSpoofReq?.ownerId, ownerAId);
    assert.equal(savedSpoofReq?.tenantId, ownerAId);

    // Cross-tenant order ingest must also fail closed (403)
    const rCrossTenantOrderIngest = await ingestViaHttp(tokSupportA, {
      business_id: 'biz-b1',
      order_id: 'ord-b1-ok',
      amount_usd: 20,
      extra: {
        owner_id: ownerBId,
        tenant_id: ownerBId,
      },
    });
    assert.equal(rCrossTenantOrderIngest.status, 403);
    pass(
      'H2-3 — Client user_metadata and body owner_id/tenant_id spoofing ignored & cross-tenant order ingest blocked',
      'Server stored caller verified scope ownerAId and rejected biz-b1/ord-b1-ok ingest (403)'
    );

    // -------------------------------------------------------------------------
    // TEST 4 & TEST 5: Owner vs Admin isolation & Ingest isolation + missing business_id / null-scope records
    // -------------------------------------------------------------------------
    // Missing business_id fails 400 without defaulting to 'biz-prime'
    const rMissingBiz = await ingestViaHttp(tokOwnerA, {
      order_id: 'ord-a1-ok',
      amount_usd: 18,
    });
    assert.equal(rMissingBiz.status, 400);
    assert.equal(((await rMissingBiz.json()) as any).code, 'MISSING_BUSINESS_ID');

    // Admin scoped to biz-a1 allowed for biz-a1, denied for biz-a2
    const rAdminA1Ok = await ingestViaHttp(tokAdminA1Only, {
      business_id: 'biz-a1',
      order_id: 'ord-a1-ok',
      amount_usd: 18,
      authority_level: 'recommend_only',
    });
    assert.equal(rAdminA1Ok.status, 200);
    const reqA1 = ((await rAdminA1Ok.json()) as any).request;

    const rAdminA2Denied = await ingestViaHttp(tokAdminA1Only, {
      business_id: 'biz-a2',
      order_id: 'ord-a2-ok',
      amount_usd: 19,
    });
    assert.equal(rAdminA2Denied.status, 403);
    assert.equal(((await rAdminA2Denied.json()) as any).code, 'BUSINESS_SCOPE_DENIED');

    // Legacy null-scope row injected directly into SQLite MUST fail closed
    const nullScopeReq = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-a1',
        order_id: 'ord-a1-nullscope',
        customer_email: 'buyer@example.test',
        amount_usd: 18,
        reason: 'Null scope legacy record test',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-null',
        raw_trigger_payload: '{}',
        confidence: 0.99,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    await store.recordProvenanceOrigin(nullScopeReq.provenance!, nullScopeReq.order_id, {
      ownerId: null,
      tenantId: null,
    });
    await store.recordAuthenticatedRefundRequest({
      requestId: nullScopeReq.provenance!.request_id,
      ownerId: null,
      tenantId: null,
      businessId: 'biz-a1',
      orderId: 'ord-a1-nullscope',
      amountCents: 1800,
      authorityLevel: 'execute_under_policy',
      expiresAt: nullScopeReq.provenance!.expires_at!,
      createdAt: nullScopeReq.provenance!.created_at,
      provenance: nullScopeReq.provenance!,
    });
    const rNullScopeApprove = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: nullScopeReq.provenance!.request_id,
        order_id: 'ord-a1-nullscope',
        business_id: 'biz-a1',
        amount_cents: 1800,
      }),
    });
    assert.equal(rNullScopeApprove.status, 403);
    pass(
      'H2-4 & H2-5 — Admin business_ids isolation, explicit business_id enforcement, and null-scope record fail-closed',
      'admin-a1 denied for biz-a2, missing business_id 400, null-scope row rejected 403'
    );

    // -------------------------------------------------------------------------
    // TEST 6: Cross-tenant & cross-business approval creation blocked without tenant leak
    // -------------------------------------------------------------------------
    const rCrossCreate = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerB}`,
      },
      body: JSON.stringify({
        request_id: reqA1.provenance.request_id,
        order_id: 'ord-a1-ok',
        business_id: 'biz-a1',
        amount_cents: 1800,
      }),
    });
    assert.equal(rCrossCreate.status, 403);
    const crossCreateText = await rCrossCreate.text();
    assert.equal(crossCreateText.includes(ownerAId), false, 'Must not leak target ownerId');
    assert.equal(JSON.parse(crossCreateText).code, 'CROSS_TENANT_OR_BUSINESS_DENIED');

    // Admin A1 allowed for biz-a1 approval
    const rCreateA1 = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokAdminA1Only}`,
      },
      body: JSON.stringify({
        request_id: reqA1.provenance.request_id,
        order_id: 'ord-a1-ok',
        business_id: 'biz-a1',
        amount_cents: 1800,
      }),
    });
    assert.equal(rCreateA1.status, 201);
    const approvalA1 = ((await rCreateA1.json()) as any).approval;

    // Ingest + approve for Tenant A biz-a2 as Owner A
    const rIngestA2 = await ingestViaHttp(tokOwnerA, {
      business_id: 'biz-a2',
      order_id: 'ord-a2-ok',
      amount_usd: 19,
      authority_level: 'recommend_only',
    });
    assert.equal(rIngestA2.status, 200);
    const reqA2 = ((await rIngestA2.json()) as any).request;
    const rCreateA2 = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        request_id: reqA2.provenance.request_id,
        order_id: 'ord-a2-ok',
        business_id: 'biz-a2',
        amount_cents: 1900,
      }),
    });
    assert.equal(rCreateA2.status, 201);
    const approvalA2 = ((await rCreateA2.json()) as any).approval;

    pass(
      'H2-6 — Cross-tenant approval creation denied (403) with zero tenant/owner leak',
      `Created scoped approvals ${approvalA1.approval_id} & ${approvalA2.approval_id}`
    );

    // -------------------------------------------------------------------------
    // TEST 7: GET /approvals DB-side scoped filtering BEFORE LIMIT 200
    // -------------------------------------------------------------------------
    // Insert 215 newer Tenant B approvals directly so naive LIMIT 200 before scoping would starve Tenant A!
    const rawDb = new DatabaseSync(dbPath);
    const futureBase = Date.now() + 60_000;
    rawDb.exec('BEGIN IMMEDIATE');
    const insApp = rawDb.prepare(
      `INSERT INTO owner_approvals (
        approval_id, owner_id, tenant_id, request_id, order_id, business_id,
        amount_cents, approved_by_user_id, status, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`
    );
    for (let i = 0; i < 215; i++) {
      const ts = new Date(futureBase + i * 1000).toISOString();
      insApp.run(
        `apr-tenantb-flood-${i}`,
        ownerBId,
        ownerBId,
        crypto.randomUUID(),
        `ord-b-flood-${i}`,
        'biz-b1',
        2000,
        ownerBId,
        new Date(futureBase + 900_000).toISOString(),
        ts,
        ts
      );
    }
    rawDb.exec('COMMIT');
    rawDb.close();

    const rListOwnerA = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(rListOwnerA.status, 200);
    const listOwnerA = ((await rListOwnerA.json()) as any).approvals as any[];
    assert.ok(listOwnerA.some((a) => a.approval_id === approvalA1.approval_id));
    assert.ok(listOwnerA.some((a) => a.approval_id === approvalA2.approval_id));
    assert.equal(
      listOwnerA.some((a) => String(a.approval_id).startsWith('apr-tenantb-flood-')),
      false
    );

    // Restricted Admin A1 only sees biz-a1 (NOT biz-a2, NOT biz-b1)
    const rListAdminA1 = await fetch(`${server.baseUrl}/api/governance/approvals`, {
      headers: { Authorization: `Bearer ${tokAdminA1Only}` },
    });
    assert.equal(rListAdminA1.status, 200);
    const listAdminA1 = ((await rListAdminA1.json()) as any).approvals as any[];
    assert.ok(listAdminA1.some((a) => a.approval_id === approvalA1.approval_id));
    assert.equal(
      listAdminA1.some((a) => a.approval_id === approvalA2.approval_id),
      false
    );

    // Restricted Admin A1 querying foreign business_id=biz-a2 returns 403
    const rListAdminForeignBiz = await fetch(
      `${server.baseUrl}/api/governance/approvals?business_id=biz-a2`,
      { headers: { Authorization: `Bearer ${tokAdminA1Only}` } }
    );
    assert.equal(rListAdminForeignBiz.status, 403);
    pass(
      'H2-7 — GET /approvals applies DB-layer tenant & business filter BEFORE LIMIT 200',
      '215 newer Tenant B rows did not evict Tenant A approvals; admin-a1 isolated from biz-a2'
    );

    // -------------------------------------------------------------------------
    // TEST 8: Cross-tenant & cross-business approval revocation blocked (403)
    // -------------------------------------------------------------------------
    const rRevokeCrossTenant = await fetch(
      `${server.baseUrl}/api/governance/approvals/${approvalA1.approval_id}/revoke`,
      { method: 'POST', headers: { Authorization: `Bearer ${tokOwnerB}` } }
    );
    assert.equal(rRevokeCrossTenant.status, 403);
    assert.equal((await store.getOwnerApproval(approvalA1.approval_id))?.status, 'approved');

    const rRevokeCrossBiz = await fetch(
      `${server.baseUrl}/api/governance/approvals/${approvalA2.approval_id}/revoke`,
      { method: 'POST', headers: { Authorization: `Bearer ${tokAdminA1Only}` } }
    );
    assert.equal(rRevokeCrossBiz.status, 403);
    assert.equal((await store.getOwnerApproval(approvalA2.approval_id))?.status, 'approved');
    pass(
      'H2-8 — Cross-tenant and cross-business approval revocation blocked (403)',
      'Target approvals preserved intact'
    );

    // -------------------------------------------------------------------------
    // TEST 9: Cross-tenant & cross-business POST /finance/refund blocked (403, 0 provider calls)
    // -------------------------------------------------------------------------
    const callsBeforeRefundDenied = providerExecuteCalls;
    const rCrossTenantRefund = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerB}`,
      },
      body: JSON.stringify({
        ...reqA1,
        provenance: {
          ...reqA1.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: approvalA1.approval_id,
        },
      }),
    });
    assert.equal(rCrossTenantRefund.status, 403);

    const rCrossBizRefund = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokFinanceA1Only}`,
      },
      body: JSON.stringify({
        ...reqA2,
        provenance: {
          ...reqA2.provenance,
          authority_level: 'owner_approved',
          owner_approval_id: approvalA2.approval_id,
        },
      }),
    });
    assert.equal(rCrossBizRefund.status, 403);
    assert.equal(providerExecuteCalls, callsBeforeRefundDenied);
    pass(
      'H2-9 — Cross-tenant and cross-business refund execution blocked (403, 0 provider calls)',
      'Blocked both foreign owner and business-restricted finance_operator'
    );

    // -------------------------------------------------------------------------
    // TEST 10 & TEST 11: Stale & Reconciliation tenant/business isolation
    // -------------------------------------------------------------------------
    const pastIso = new Date(Date.now() - 180_000).toISOString();
    const expiredLeaseIso = new Date(Date.now() - 60_000).toISOString();
    const futureReqExpIso = new Date(Date.now() + 300_000).toISOString();

    const makeSnap = (businessId: string, orderId: string) =>
      ingestAuthenticatedRefundRequest(
        {
          business_id: businessId,
          order_id: orderId,
          customer_email: 'buyer@example.test',
          amount_usd: 14.0,
          reason: 'Stale reservation test fixture',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: `tkt-${orderId}`,
          raw_trigger_payload: '{}',
          confidence: 0.96,
          authority_level: 'execute_under_policy',
        },
        keyring
      ).provenance!;

    const snapA1Stale = makeSnap('biz-a1', 'ord-stale-a1');
    const resA1Stale = await store.reserveRefundExecution({
      ownerId: ownerAId,
      tenantId: ownerAId,
      requestId: snapA1Stale.request_id,
      nonce: snapA1Stale.nonce!,
      orderId: 'ord-stale-a1',
      businessId: 'biz-a1',
      requireOwnerApproval: false,
      amountCents: 1400,
      idempotencyKey: `idem-stale-a1-${crypto.randomBytes(4).toString('hex')}`,
      canonicalDigest: crypto.randomBytes(32).toString('hex'),
      keyId: 'ephemeral-h2-key',
      providerName: 'h2_test_provider',
      executionLeaseMs: 1000,
      expiresAt: futureReqExpIso,
      nowIso: pastIso,
      provenanceSnapshot: snapA1Stale,
    });
    assert.equal(resA1Stale.status, 'ACQUIRED');
    const a1ResId = resA1Stale.reservationId;

    const snapA2Uncertain = makeSnap('biz-a2', 'ord-stale-a2');
    const resA2Uncertain = await store.reserveRefundExecution({
      ownerId: ownerAId,
      tenantId: ownerAId,
      requestId: snapA2Uncertain.request_id,
      nonce: snapA2Uncertain.nonce!,
      orderId: 'ord-stale-a2',
      businessId: 'biz-a2',
      requireOwnerApproval: false,
      amountCents: 1400,
      idempotencyKey: `idem-stale-a2-${crypto.randomBytes(4).toString('hex')}`,
      canonicalDigest: crypto.randomBytes(32).toString('hex'),
      keyId: 'ephemeral-h2-key',
      providerName: 'h2_test_provider',
      executionLeaseMs: 1000,
      expiresAt: futureReqExpIso,
      nowIso: pastIso,
      provenanceSnapshot: snapA2Uncertain,
    });
    assert.equal(resA2Uncertain.status, 'ACQUIRED');
    await store.markRefundUncertain({
      reservationId: resA2Uncertain.reservationId,
      providerOutcomeStatus: 'timeout_or_unknown',
      reason: 'Timed out for Tenant A biz-a2',
    });

    const snapB1Stale = makeSnap('biz-b1', 'ord-stale-b1');
    const resB1Stale = await store.reserveRefundExecution({
      ownerId: ownerBId,
      tenantId: ownerBId,
      requestId: snapB1Stale.request_id,
      nonce: snapB1Stale.nonce!,
      orderId: 'ord-stale-b1',
      businessId: 'biz-b1',
      requireOwnerApproval: false,
      amountCents: 1400,
      idempotencyKey: `idem-stale-b1-${crypto.randomBytes(4).toString('hex')}`,
      canonicalDigest: crypto.randomBytes(32).toString('hex'),
      keyId: 'ephemeral-h2-key',
      providerName: 'h2_test_provider',
      executionLeaseMs: 1000,
      expiresAt: futureReqExpIso,
      nowIso: expiredLeaseIso,
      provenanceSnapshot: snapB1Stale,
    });
    assert.equal(resB1Stale.status, 'ACQUIRED');

    // FinanceA1Only should ONLY see biz-a1 stale reservation (NOT biz-a2, NOT biz-b1)
    const rStaleA1 = await fetch(`${server.baseUrl}/api/governance/finance/refund/stale`, {
      headers: { Authorization: `Bearer ${tokFinanceA1Only}` },
    });
    assert.equal(rStaleA1.status, 200);
    const staleA1Json = (await rStaleA1.json()) as any;
    assert.ok(staleA1Json.staleExecuting.some((r: any) => r.id === a1ResId));
    assert.equal(
      staleA1Json.staleExecuting.some((r: any) => r.businessId === 'biz-b1'),
      false
    );
    assert.equal(
      staleA1Json.uncertain.some((r: any) => r.businessId === 'biz-a2'),
      false
    );

    // OwnerB sees ONLY biz-b1 stale reservation
    const rStaleB = await fetch(`${server.baseUrl}/api/governance/finance/refund/stale`, {
      headers: { Authorization: `Bearer ${tokOwnerB}` },
    });
    assert.equal(rStaleB.status, 200);
    const staleBJson = (await rStaleB.json()) as any;
    assert.ok(staleBJson.staleExecuting.some((r: any) => r.id === resB1Stale.reservationId));
    assert.equal(
      staleBJson.staleExecuting.some((r: any) => r.ownerId === ownerAId),
      false
    );
    assert.equal(
      staleBJson.uncertain.some((r: any) => r.ownerId === ownerAId),
      false
    );

    // Cross-tenant reconcile returns non-leaking 404 NOT_FOUND & 0 provider lookups
    const lookupCallsBefore = providerLookupCalls;
    const rReconcileCross = await fetch(
      `${server.baseUrl}/api/governance/finance/refund/reconcile`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerB}`,
        },
        body: JSON.stringify({ reservation_id: resA2Uncertain.reservationId }),
      }
    );
    assert.equal(rReconcileCross.status, 404);
    const recCrossJson = (await rReconcileCross.json()) as any;
    assert.equal(recCrossJson.status, 'NOT_FOUND');
    assert.equal(providerLookupCalls, lookupCallsBefore);
    assert.equal(
      (await store.getRefundReservation({ reservationId: resA2Uncertain.reservationId }))?.status,
      'uncertain_reconciliation_required'
    );

    pass(
      'H2-10 & H2-11 — Stale inspection and reconciliation are tenant/business isolated',
      'Foreign reservation reconcile returns non-leaking 404 NOT_FOUND with 0 provider lookups'
    );

    // -------------------------------------------------------------------------
    // TEST 12: Same order_id across two distinct businesses is isolated cleanly
    // -------------------------------------------------------------------------
    const rIngestSharedA = await ingestViaHttp(tokOwnerA, {
      business_id: 'biz-a1',
      order_id: 'ord-shared-100',
      amount_usd: 17,
      authority_level: 'execute_under_policy',
    });
    const rIngestSharedB = await ingestViaHttp(tokOwnerB, {
      business_id: 'biz-b1',
      order_id: 'ord-shared-100',
      amount_usd: 17,
      authority_level: 'execute_under_policy',
    });
    assert.equal(rIngestSharedA.status, 200);
    assert.equal(rIngestSharedB.status, 200);
    const reqSharedA = ((await rIngestSharedA.json()) as any).request;
    const reqSharedB = ((await rIngestSharedB.json()) as any).request;

    const rExecSharedA = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify(reqSharedA),
    });
    const rExecSharedB = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerB}`,
      },
      body: JSON.stringify(reqSharedB),
    });
    assert.equal(rExecSharedA.status, 200);
    assert.equal(rExecSharedB.status, 200);
    assert.equal(((await rExecSharedA.json()) as any).status, 'EXECUTED');
    assert.equal(((await rExecSharedB.json()) as any).status, 'EXECUTED');
    assert.ok(executedKeys.includes('biz-a1:ord-shared-100'));
    assert.ok(executedKeys.includes('biz-b1:ord-shared-100'));
    pass(
      'H2-12 — Same order_id across two businesses executes independently without cross-business lock collision',
      'ord-shared-100 executed separately under biz-a1 and biz-b1'
    );

    // -------------------------------------------------------------------------
    // TEST 13: Authoritative order validation & unconfigured fail-closed checks
    // -------------------------------------------------------------------------
    // 13a. Unconfigured Supabase order store fails closed (503) — never simulates orders
    const unconfiguredOrderStore = createSupabaseAuthoritativeOrderStoreFromEnv({});
    assert.equal(unconfiguredOrderStore.configured, false);
    const unconfServer = await startTestServer({
      keyring,
      replayStore: store,
      authVerifier,
      orderStore: unconfiguredOrderStore,
      paymentProvider,
    });
    try {
      const rIngestUnconf = await ingestViaHttp(tokOwnerA, {
        business_id: 'biz-a1',
        order_id: 'ord-a1-ok',
        amount_usd: 18,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngestUnconf.status, 200);
      const reqUnconf = ((await rIngestUnconf.json()) as any).request;

      const callsBeforeUnconf = providerExecuteCalls;
      const rRefundUnconf = await fetch(`${unconfServer.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerA}`,
        },
        body: JSON.stringify(reqUnconf),
      });
      assert.equal(rRefundUnconf.status, 503);
      assert.equal(((await rRefundUnconf.json()) as any).code, 'AUTHORITATIVE_ORDERS_UNCONFIGURED');
      assert.equal(providerExecuteCalls, callsBeforeUnconf);

      const directUnconfRes = await executeAuthorizedFinanceRefund(reqUnconf, {
        keyring,
        replayStore: store,
        orderStore: unconfiguredOrderStore,
        paymentProvider,
      });
      assert.equal(directUnconfRes.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(directUnconfRes.code, 'AUTHORITATIVE_ORDERS_UNCONFIGURED');
    } finally {
      await unconfServer.close();
    }

    // 13b. Lookup error -> 503 AUTHORITATIVE_ORDER_LOOKUP_FAILED
    const rIngestLookupErr = await ingestViaHttp(tokOwnerA, {
      business_id: 'biz-a1',
      order_id: 'ord-a1-ok',
      amount_usd: 18,
      authority_level: 'execute_under_policy',
    });
    const reqLookupErr = ((await rIngestLookupErr.json()) as any).request;
    forceOrderLookupError = true;
    const rLookupErr = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify(reqLookupErr),
    });
    forceOrderLookupError = false;
    assert.equal(rLookupErr.status, 503);
    assert.equal(((await rLookupErr.json()) as any).code, 'AUTHORITATIVE_ORDER_LOOKUP_FAILED');

    // 13c. Non-existent order in business -> 403 AUTHORITATIVE_ORDER_NOT_FOUND
    const rIngestMissingOrd = await ingestViaHttp(tokOwnerA, {
      business_id: 'biz-a1',
      order_id: 'ord-does-not-exist-999',
      amount_usd: 15,
      authority_level: 'execute_under_policy',
    });
    const reqMissingOrd = ((await rIngestMissingOrd.json()) as any).request;
    const rMissingOrd = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify(reqMissingOrd),
    });
    assert.equal(rMissingOrd.status, 403);
    assert.equal(((await rMissingOrd.json()) as any).code, 'AUTHORITATIVE_ORDER_NOT_FOUND');

    // 13d. Ineligible status ('refunded', 'disputed') -> 409 ORDER_NOT_ELIGIBLE_FOR_REFUND
    for (const badOrder of ['ord-refunded', 'ord-disputed']) {
      const rIng = await ingestViaHttp(tokOwnerA, {
        business_id: 'biz-a1',
        order_id: badOrder,
        amount_usd: 15,
        authority_level: 'execute_under_policy',
      });
      const reqBadOrd = ((await rIng.json()) as any).request;
      const rExecBad = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerA}`,
        },
        body: JSON.stringify(reqBadOrd),
      });
      assert.equal(rExecBad.status, 409);
      assert.equal(((await rExecBad.json()) as any).code, 'ORDER_NOT_ELIGIBLE_FOR_REFUND');
    }

    // 13e. Amount mismatch -> 409 ORDER_AMOUNT_MISMATCH
    const rIngAmt = await ingestViaHttp(tokOwnerA, {
      business_id: 'biz-a1',
      order_id: 'ord-amount-fixed',
      amount_usd: 18, // Order is $12 (1200 cents)
      authority_level: 'execute_under_policy',
    });
    const reqAmt = ((await rIngAmt.json()) as any).request;
    const rExecAmt = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify(reqAmt),
    });
    assert.equal(rExecAmt.status, 409);
    assert.equal(((await rExecAmt.json()) as any).code, 'ORDER_AMOUNT_MISMATCH');

    // 13f. Order owned by OwnerB in biz-a1 rejected for OwnerA on BOTH ingest AND refund -> 403 CROSS_TENANT_OR_BUSINESS_DENIED
    const rIngForeign = await ingestViaHttp(tokOwnerA, {
      business_id: 'biz-a1',
      order_id: 'ord-foreign-owner',
      amount_usd: 15,
      authority_level: 'execute_under_policy',
    });
    assert.equal(rIngForeign.status, 403);
    assert.equal(((await rIngForeign.json()) as any).code, 'CROSS_TENANT_OR_BUSINESS_DENIED');

    const reqForeignPersisted = ingestAuthenticatedRefundRequest(
      {
        business_id: 'biz-a1',
        order_id: 'ord-foreign-owner',
        customer_email: 'buyer@example.test',
        amount_usd: 15,
        reason: 'H2 foreign order ownership check',
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: 'tkt-foreign-ord',
        raw_trigger_payload: '{}',
        confidence: 0.96,
        authority_level: 'execute_under_policy',
      },
      keyring
    );
    await store.recordProvenanceOrigin(reqForeignPersisted.provenance!, 'ord-foreign-owner', {
      ownerId: ownerAId,
      tenantId: ownerAId,
    });
    await store.recordAuthenticatedRefundRequest({
      requestId: reqForeignPersisted.provenance!.request_id,
      ownerId: ownerAId,
      tenantId: ownerAId,
      businessId: 'biz-a1',
      orderId: 'ord-foreign-owner',
      amountCents: 1500,
      authorityLevel: 'execute_under_policy',
      expiresAt: reqForeignPersisted.provenance!.expires_at!,
      createdAt: reqForeignPersisted.provenance!.created_at,
      provenance: reqForeignPersisted.provenance!,
    });
    const rExecForeign = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify(reqForeignPersisted),
    });
    assert.equal(rExecForeign.status, 403);
    assert.equal(((await rExecForeign.json()) as any).code, 'CROSS_TENANT_OR_BUSINESS_DENIED');

    pass(
      'H2-13 — Authoritative order validation & fail-closed behavior verified',
      'Unconfigured 503, lookup error 503, missing order 403, refunded/disputed 409, amount mismatch 409, foreign owner 403'
    );

    // -------------------------------------------------------------------------
    // TEST 14: Combined H1+H2 regression, Supabase filter-before-limit call trace, & SQL migration 000007 audit
    // -------------------------------------------------------------------------
    // H1 confidence tampering inside valid tenant still fails closed
    const rIngH1 = await ingestViaHttp(tokOwnerA, {
      business_id: 'biz-a1',
      order_id: 'ord-h1-regression',
      amount_usd: 15,
      confidence: 0.4,
      authority_level: 'execute_under_policy',
    });
    const reqH1 = ((await rIngH1.json()) as any).request;
    const rExecTamperedConf = await fetch(`${server.baseUrl}/api/governance/finance/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokOwnerA}`,
      },
      body: JSON.stringify({
        ...reqH1,
        provenance: {
          ...reqH1.provenance,
          confidence: 0.99,
        },
      }),
    });
    assert.equal(rExecTamperedConf.status, 403);

    // Verify SupabasePersistentReplayStore applies scope .or(...) BEFORE .limit(200)
    const sbCallTrace: string[] = [];
    const mockSbClient = {
      from(table: string) {
        sbCallTrace.push(`from:${table}`);
        const chain: any = {
          select() {
            sbCallTrace.push('select');
            return chain;
          },
          or(expr: string) {
            sbCallTrace.push(`or:${expr}`);
            return chain;
          },
          in(col: string, vals: string[]) {
            sbCallTrace.push(`in:${col}:${vals.join(',')}`);
            return chain;
          },
          eq(col: string, val: string) {
            sbCallTrace.push(`eq:${col}:${val}`);
            return chain;
          },
          order() {
            sbCallTrace.push('order');
            return chain;
          },
          limit(n: number) {
            sbCallTrace.push(`limit:${n}`);
            return Promise.resolve({ data: [], error: null });
          },
        };
        return chain;
      },
    } as any;
    const sbStore = new SupabasePersistentReplayStore(
      'https://example.supabase.co',
      'service-role-placeholder',
      undefined,
      mockSbClient
    );
    await sbStore.listOwnerApprovals({
      scope: { tenantOrOwnerIds: [ownerAId], allowedBusinessIds: ['biz-a1'] },
    });
    const orIdx = sbCallTrace.findIndex((s) => s.startsWith('or:'));
    const inIdx = sbCallTrace.findIndex((s) => s.startsWith('in:business_id:biz-a1'));
    const limitIdx = sbCallTrace.indexOf('limit:200');
    assert.ok(orIdx >= 0 && inIdx >= 0 && limitIdx > orIdx && limitIdx > inIdx);

    // Static verification of migration 000007 and rollback
    const mig07 = fs
      .readFileSync(
        path.resolve(
          process.cwd(),
          'supabase/migrations/20261117000007_h2_tenant_business_isolation.sql'
        ),
        'utf8'
      )
      .toLowerCase();
    const mig07Rb = fs
      .readFileSync(
        path.resolve(
          process.cwd(),
          'supabase/migrations/20261117000007_h2_tenant_business_isolation_rollback.sql'
        ),
        'utf8'
      )
      .toLowerCase();
    assert.ok(mig07.includes('add column if not exists tenant_id'));
    assert.ok(mig07.includes('on public.refund_authorizations (business_id, order_id)'));
    assert.ok(mig07.includes("hashtext('order:' || p_business_id || ':' || p_order_id)"));
    assert.ok(mig07.includes('p_tenant_id text default null'));
    assert.ok(mig07.includes('revoke all on function public.reserve_refund_execution'));
    assert.ok(mig07.includes('grant execute on function public.reserve_refund_execution'));
    assert.ok(mig07.includes('to service_role'));
    assert.ok(!mig07Rb.includes('drop column'));
    assert.ok(mig07Rb.includes('raise exception'));

    pass(
      'H2-14 — Combined H1+H2 regression, Supabase filter-before-limit query trace, and migration 000007 integrity verified',
      `Passed H2-1..H2-14 suites`
    );

    // =========================================================================
    // H2 FINAL REMEDIATION VERIFICATION SUITE (H2-15 through H2-22)
    // Authoritative Orders, Payment Settlement, Membership Isolation,
    // Separated tenant_id !== owner_id, Reconcile Ambiguity, and Migration 000008
    // =========================================================================
    const tenantX = 'org-tenant-x';
    const tenantY = 'org-tenant-y';
    const ownerXId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const ownerYId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const staffFinanceX1Id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const staffAdminX1Id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const staffSupportX1Id = '12121212-1212-4121-8121-121212121212';
    const staffSuspendedX1Id = '13131313-1313-4131-8131-131313131313';
    const staffRevokedX1Id = '14141414-1414-4141-8141-141414141414';
    const staffMismatchTenantId = '15151515-1515-4151-8151-151515151515';

    const tokOwnerX = `tok-owner-x-${crypto.randomBytes(6).toString('hex')}`;
    const tokOwnerY = `tok-owner-y-${crypto.randomBytes(6).toString('hex')}`;
    const tokStaffFinX1 = `tok-fin-x1-${crypto.randomBytes(6).toString('hex')}`;
    const tokStaffAdmX1 = `tok-adm-x1-${crypto.randomBytes(6).toString('hex')}`;
    const tokStaffSupX1 = `tok-sup-x1-${crypto.randomBytes(6).toString('hex')}`;
    const tokStaffSusp = `tok-susp-x1-${crypto.randomBytes(6).toString('hex')}`;
    const tokStaffRev = `tok-rev-x1-${crypto.randomBytes(6).toString('hex')}`;
    const tokStaffWrongTenant = `tok-wrong-ten-${crypto.randomBytes(6).toString('hex')}`;

    const finalAuthVerifier: GovernanceAuthVerifier = {
      configured: true,
      ownerUserIds: new Set([ownerXId, ownerYId]),
      verifyAccessToken: async (tok) => {
        switch (tok) {
          case tokOwnerX:
            // Notice: Owner has NO explicit tenant_id claim, while business/orders use org-tenant-x !== ownerXId
            return { id: ownerXId, email: 'owner-x@example.test', appMetadata: { role: 'owner' } };
          case tokOwnerY:
            return { id: ownerYId, email: 'owner-y@example.test', appMetadata: { role: 'owner' } };
          case tokStaffFinX1:
            // Staff member belonging to ANOTHER owner's business (userId != ownerXId; tenant_id == org-tenant-x)
            return {
              id: staffFinanceX1Id,
              email: 'fin-x1@example.test',
              appMetadata: { role: 'finance_operator', tenant_id: tenantX },
            };
          case tokStaffAdmX1:
            return {
              id: staffAdminX1Id,
              email: 'adm-x1@example.test',
              appMetadata: { role: 'admin', tenant_id: tenantX },
            };
          case tokStaffSupX1:
            return {
              id: staffSupportX1Id,
              email: 'sup-x1@example.test',
              appMetadata: { role: 'support_operator', tenant_id: tenantX },
            };
          case tokStaffSusp:
            return {
              id: staffSuspendedX1Id,
              email: 'susp-x1@example.test',
              appMetadata: { role: 'finance_operator', tenant_id: tenantX },
            };
          case tokStaffRev:
            return {
              id: staffRevokedX1Id,
              email: 'rev-x1@example.test',
              appMetadata: { role: 'finance_operator', tenant_id: tenantX },
            };
          case tokStaffWrongTenant:
            return {
              id: staffMismatchTenantId,
              email: 'wrong-tenant@example.test',
              appMetadata: { role: 'finance_operator', tenant_id: tenantY },
            };
          default:
            return null;
        }
      },
    };

    const dbFinalPath = `/tmp/h2-final-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
    const finalStore = new SqlitePersistentReplayStore(dbFinalPath);

    let providerBehavior: 'succeed' | 'fail' | 'timeout_after_refund' = 'succeed';
    const providerRefundsByIdemKey = new Map<string, string>();
    let finalProviderCalls = 0;
    const finalProvider: PaymentRefundProviderAdapter = {
      providerName: 'h2_final_mock_provider',
      supportsIdempotencyKey: true,
      supportsRefundLookup: true,
      executeRefund: async ({ request, providerIdempotencyKey }) => {
        finalProviderCalls += 1;
        if (providerBehavior === 'fail') {
          return {
            outcome: 'CONFIRMED_FAILURE',
            reason: 'Simulated transient bank decline',
            errorCode: 'TEMP_DECLINE',
            retryable: true,
          };
        }
        const txId = `tx-final-${request.order_id}-${crypto.randomBytes(3).toString('hex')}`;
        if (providerBehavior === 'timeout_after_refund') {
          providerRefundsByIdemKey.set(providerIdempotencyKey, txId);
          return {
            outcome: 'UNKNOWN_OR_TIMEOUT',
            reason: 'Simulated gateway timeout after processing',
            errorCode: 'TIMEOUT',
          };
        }
        providerRefundsByIdemKey.set(providerIdempotencyKey, txId);
        return { outcome: 'CONFIRMED_SUCCESS', txId };
      },
      lookupRefundByIdempotencyKey: async ({ providerIdempotencyKey }) => {
        const foundTx = providerRefundsByIdemKey.get(providerIdempotencyKey);
        if (foundTx) {
          return { outcome: 'FOUND_SUCCESS', txId: foundTx };
        }
        return { outcome: 'CONFIRMED_NOT_EXECUTED', reason: 'Not found at provider' };
      },
    };

    const inMemOrderStore = createInMemoryAuthoritativeOrderStore({
      businesses: [
        { businessId: 'biz-x1', ownerId: ownerXId, tenantId: tenantX, status: 'active' },
        { businessId: 'biz-x2', ownerId: ownerXId, tenantId: tenantX, status: 'active' },
        { businessId: 'biz-paused', ownerId: ownerXId, tenantId: tenantX, status: 'paused' },
        { businessId: 'biz-y1', ownerId: ownerYId, tenantId: tenantY, status: 'active' },
      ],
      memberships: [
        { businessId: 'biz-x1', userId: staffFinanceX1Id, tenantId: tenantX, role: 'finance_operator', status: 'active' },
        { businessId: 'biz-x1', userId: staffAdminX1Id, tenantId: tenantX, role: 'admin', status: 'active' },
        { businessId: 'biz-x1', userId: staffSupportX1Id, tenantId: tenantX, role: 'support_operator', status: 'active' },
        { businessId: 'biz-x1', userId: staffSuspendedX1Id, tenantId: tenantX, role: 'finance_operator', status: 'suspended' },
        { businessId: 'biz-x1', userId: staffRevokedX1Id, tenantId: tenantX, role: 'finance_operator', status: 'revoked' },
        { businessId: 'biz-x1', userId: staffMismatchTenantId, tenantId: tenantX, role: 'finance_operator', status: 'active' },
      ],
      orders: [
        {
          orderId: 'ord-paid-full',
          businessId: 'biz-x1',
          amountCents: 2000,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-settled-high',
          businessId: 'biz-x1',
          amountCents: 15000,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'settled',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-completed-unpaid',
          businessId: 'biz-x1',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'unpaid',
          status: 'completed', // completed WITHOUT payment settlement -> MUST reject!
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-pending-pay',
          businessId: 'biz-x1',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'pending',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-auth-only',
          businessId: 'biz-x1',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'authorized',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-cancelled',
          businessId: 'biz-x1',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'cancelled',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-partially-refunded',
          businessId: 'biz-x1',
          amountCents: 2000,
          refundedAmountCents: 500,
          currency: 'USD',
          paymentStatus: 'partially_refunded',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-external-refund',
          businessId: 'biz-x1',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          externalRefunded: true,
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-eur-currency',
          businessId: 'biz-x1',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'EUR',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-cad-currency',
          businessId: 'biz-x1',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'CAD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-fail-then-ok',
          businessId: 'biz-x1',
          amountCents: 1600,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-timeout-reconcile',
          businessId: 'biz-x1',
          amountCents: 1700,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-x2-unassigned',
          businessId: 'biz-x2',
          amountCents: 1800,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-paused-biz',
          businessId: 'biz-paused',
          amountCents: 1500,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-y1-foreign',
          businessId: 'biz-y1',
          amountCents: 1500,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-ambig-shared',
          businessId: 'biz-x1',
          amountCents: 1900,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
        {
          orderId: 'ord-ambig-shared',
          businessId: 'biz-x2',
          amountCents: 1900,
          refundedAmountCents: 0,
          currency: 'USD',
          paymentStatus: 'paid',
          status: 'completed',
          eligibleForRefund: true,
        },
      ],
    });

    const finalServer = await startTestServer({
      keyring,
      replayStore: finalStore,
      authVerifier: finalAuthVerifier,
      orderStore: inMemOrderStore,
      paymentProvider: finalProvider,
    });

    const ingestFinal = async (token: string, body: Record<string, unknown>) =>
      fetch(`${finalServer.baseUrl}/api/governance/provenance/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          customer_email: 'buyer@example.test',
          reason: 'H2 final remediation test',
          source_agent: 'customer_support',
          confidence: 0.96,
          trigger_type: 'customer_ticket',
          trigger_id: `tkt-${crypto.randomBytes(4).toString('hex')}`,
          ...body,
        }),
      });

    try {
      // H2-15: Fulfillment status='completed' with unpaid/pending/authorized, cancelled, partial, external, currency, partial amount rejected at /refund and /approvals (409)
      for (const [ordId, amtUsd, currency] of [
        ['ord-completed-unpaid', 18, 'USD'],
        ['ord-pending-pay', 18, 'USD'],
        ['ord-auth-only', 18, 'USD'],
        ['ord-cancelled', 18, 'USD'],
        ['ord-partially-refunded', 15, 'USD'],
        ['ord-external-refund', 18, 'USD'],
        ['ord-eur-currency', 18, 'USD'],
        ['ord-cad-currency', 18, 'USD'],
        ['ord-paid-full', 10, 'USD'], // Partial refund attempt ($10 of $20 paid order)
      ] as const) {
        const rIngBad = await ingestFinal(tokOwnerX, {
          business_id: 'biz-x1',
          order_id: ordId,
          amount_usd: amtUsd,
          currency,
          authority_level: 'execute_under_policy',
        });
        assert.equal(rIngBad.status, 200, `Expected ingest ok for ${ordId}`);
        const badReq = ((await rIngBad.json()) as any).request;

        const rRefundBad = await fetch(`${finalServer.baseUrl}/api/governance/finance/refund`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokOwnerX}`,
          },
          body: JSON.stringify(badReq),
        });
        assert.equal(rRefundBad.status, 409, `Expected /refund 409 for ${ordId}`);

        const rApproveBad = await fetch(`${finalServer.baseUrl}/api/governance/approvals`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokOwnerX}`,
          },
          body: JSON.stringify({
            request_id: badReq.provenance.request_id,
            order_id: ordId,
            business_id: 'biz-x1',
            amount_cents: Math.round(amtUsd * 100),
          }),
        });
        assert.equal(rApproveBad.status, 409, `Expected /approvals 409 for ${ordId}`);
      }
      assert.equal(finalProviderCalls, 0);

      // Direct executor call (bypassing HTTP /ingest) MUST also reject status='completed' + paymentStatus='unpaid' & partial amount
      const directUnpaidReq = ingestAuthenticatedRefundRequest(
        {
          business_id: 'biz-x1',
          order_id: 'ord-completed-unpaid',
          customer_email: 'buyer@example.test',
          amount_usd: 18,
          reason: 'Completed without payment settlement',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-unpaid-direct',
          raw_trigger_payload: '{}',
          confidence: 0.98,
          authority_level: 'execute_under_policy',
        },
        keyring
      );
      const resDirectUnpaid = await executeAuthorizedFinanceRefund(directUnpaidReq, {
        keyring,
        replayStore: finalStore,
        orderStore: inMemOrderStore,
        paymentProvider: finalProvider,
      });
      assert.equal(resDirectUnpaid.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(resDirectUnpaid.code, 'ORDER_NOT_ELIGIBLE_FOR_REFUND');
      assert.equal(finalProviderCalls, 0);

      // Direct unsupported currency 'EUR' in ingest fails with 400
      const rIngEur = await ingestFinal(tokOwnerX, {
        business_id: 'biz-x1',
        order_id: 'ord-eur-currency',
        amount_usd: 18,
        currency: 'EUR',
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngEur.status, 400);

      pass(
        'H2-15 — Unpaid completed, pending, authorized, cancelled, partially-refunded, external-refunded, currency-mismatched, and partial refund amounts fail closed',
        'All ineligible/partial refund attempts rejected with 409/400 and 0 provider calls'
      );

      // H2-16: Inactive business (409) & missing business (403) fail closed; separated tenant_id !== owner_id works for owner across full lifecycle
      const rIngPaused = await ingestFinal(tokOwnerX, {
        business_id: 'biz-paused',
        order_id: 'ord-paused-biz',
        amount_usd: 15,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngPaused.status, 409);
      assert.equal(((await rIngPaused.json()) as any).code, 'BUSINESS_NOT_ACTIVE');

      const rIngMissingBiz = await ingestFinal(tokOwnerX, {
        business_id: 'biz-does-not-exist',
        order_id: 'ord-any',
        amount_usd: 15,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngMissingBiz.status, 403);

      // OwnerX has NO explicit tenant_id claim (business tenant_id='org-tenant-x' !== ownerXId) -> succeeds!
      const rIngSepPaid = await ingestFinal(tokOwnerX, {
        business_id: 'biz-x1',
        order_id: 'ord-paid-full',
        amount_usd: 20,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngSepPaid.status, 200);
      const reqSepPaid = ((await rIngSepPaid.json()) as any).request;
      const rExecSepPaid = await fetch(`${finalServer.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerX}`,
        },
        body: JSON.stringify(reqSepPaid),
      });
      assert.equal(rExecSepPaid.status, 200);
      assert.equal(((await rExecSepPaid.json()) as any).status, 'EXECUTED');

      // Authoritative order is now marked refunded -> new refund attempt on ord-paid-full MUST be rejected (409)
      const ordPaidAfter = await inMemOrderStore.getOrderForBusiness({
        businessId: 'biz-x1',
        orderId: 'ord-paid-full',
      });
      assert.equal(ordPaidAfter?.paymentStatus, 'refunded');
      assert.equal(ordPaidAfter?.status, 'refunded');
      assert.equal(ordPaidAfter?.refundedAmountCents, 2000);
      assert.ok(ordPaidAfter?.refundTxId);

      const rIngDupAfterRefund = await ingestFinal(tokOwnerX, {
        business_id: 'biz-x1',
        order_id: 'ord-paid-full',
        amount_usd: 20,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngDupAfterRefund.status, 200);
      const reqDupAfterRefund = ((await rIngDupAfterRefund.json()) as any).request;
      const rRefundDupAfterRefund = await fetch(
        `${finalServer.baseUrl}/api/governance/finance/refund`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokOwnerX}`,
          },
          body: JSON.stringify(reqDupAfterRefund),
        }
      );
      assert.equal(rRefundDupAfterRefund.status, 409);

      const rApproveDupAfterRefund = await fetch(`${finalServer.baseUrl}/api/governance/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokOwnerX}`,
        },
        body: JSON.stringify({
          request_id: reqDupAfterRefund.provenance.request_id,
          order_id: 'ord-paid-full',
          business_id: 'biz-x1',
          amount_cents: 2000,
        }),
      });
      assert.equal(rApproveDupAfterRefund.status, 409);

      pass(
        'H2-16 — Owner with tenant_id !== owner_id executes full refund, updates order to refunded, and blocks duplicate refund; paused business rejected',
        'Separated org tenant_id authorized via owner ownership and order marked refunded'
      );

      // H2-17: Non-owner staff belonging to ANOTHER owner's business via business_memberships
      // Support X1 ingests high-value order for biz-x1
      const rSupIngest = await ingestFinal(tokStaffSupX1, {
        business_id: 'biz-x1',
        order_id: 'ord-settled-high',
        amount_usd: 150,
        authority_level: 'recommend_only',
      });
      assert.equal(rSupIngest.status, 200);
      const reqHighX1 = ((await rSupIngest.json()) as any).request;

      // Support X1 CANNOT ingest for unassigned biz-x2 -> 403
      const rSupX2Denied = await ingestFinal(tokStaffSupX1, {
        business_id: 'biz-x2',
        order_id: 'ord-x2-unassigned',
        amount_usd: 18,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rSupX2Denied.status, 403);

      // Suspended, revoked, and tenant-mismatched staff denied even with active/matching userId on biz-x1
      for (const tokBadStaff of [tokStaffSusp, tokStaffRev, tokStaffWrongTenant]) {
        const rStaffDeny = await ingestFinal(tokBadStaff, {
          business_id: 'biz-x1',
          order_id: 'ord-settled-high',
          amount_usd: 150,
          authority_level: 'recommend_only',
        });
        assert.equal(rStaffDeny.status, 403);
      }

      // Admin belonging to owner X's biz-x1 approves & reads approvals in separated tenant
      const rAdmCreateApr = await fetch(`${finalServer.baseUrl}/api/governance/approvals`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokStaffAdmX1}`,
        },
        body: JSON.stringify({
          request_id: reqHighX1.provenance.request_id,
          order_id: 'ord-settled-high',
          business_id: 'biz-x1',
          amount_cents: 15000,
        }),
      });
      assert.equal(rAdmCreateApr.status, 201);
      const highApr = ((await rAdmCreateApr.json()) as any).approval;
      assert.equal(highApr.approved_by_user_id, staffAdminX1Id);
      const storedHighApr = await finalStore.getOwnerApprovalDetailed!(highApr.approval_id);
      assert.equal(storedHighApr?.owner_id, ownerXId);
      assert.equal(storedHighApr?.tenant_id, tenantX);

      // Finance operator belonging to biz-x1 CANNOT list/execute approvals or orders for unassigned biz-x2 or ownerY's biz-y1
      const rFinListX1 = await fetch(`${finalServer.baseUrl}/api/governance/approvals`, {
        headers: { Authorization: `Bearer ${tokStaffFinX1}` },
      });
      // finance_operator lacks finance:approval:read permission (only admin/owner have approval read),
      // so let's verify Admin X1 sees highApr and Owner Y sees ZERO approvals!
      assert.equal(rFinListX1.status, 403);
      const rAdmListX1 = await fetch(`${finalServer.baseUrl}/api/governance/approvals`, {
        headers: { Authorization: `Bearer ${tokStaffAdmX1}` },
      });
      assert.equal(rAdmListX1.status, 200);
      assert.ok(
        ((await rAdmListX1.json()) as any).approvals.some(
          (a: any) => a.approval_id === highApr.approval_id
        )
      );
      const rOwnerYList = await fetch(`${finalServer.baseUrl}/api/governance/approvals`, {
        headers: { Authorization: `Bearer ${tokOwnerY}` },
      });
      assert.equal(rOwnerYList.status, 200);
      assert.equal(((await rOwnerYList.json()) as any).approvals.length, 0);

      // Finance operator (active membership on biz-x1, userId != ownerXId) executes owner_approved refund cleanly!
      const rFinExecX1 = await fetch(`${finalServer.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokStaffFinX1}`,
        },
        body: JSON.stringify({
          ...reqHighX1,
          provenance: {
            ...reqHighX1.provenance,
            authority_level: 'owner_approved',
            owner_approval_id: highApr.approval_id,
          },
        }),
      });
      assert.equal(rFinExecX1.status, 200);
      assert.equal(((await rFinExecX1.json()) as any).status, 'EXECUTED');

      const settledOrdAfter = await inMemOrderStore.getOrderForBusiness({
        businessId: 'biz-x1',
        orderId: 'ord-settled-high',
      });
      assert.equal(settledOrdAfter?.paymentStatus, 'refunded');
      assert.equal(settledOrdAfter?.refundedAmountCents, 15000);

      pass(
        'H2-17 — Membership-based staff (admin/finance/support) authorized across owner boundary ONLY for active assigned business & matching tenant',
        'Unassigned, suspended, revoked, and tenant-mismatched staff rejected (403)'
      );

      // H2-18: Failed provider does NOT mark order refunded; subsequent retry succeeds & updates order
      providerBehavior = 'fail';
      const rIngFailThenOk = await ingestFinal(tokStaffSupX1, {
        business_id: 'biz-x1',
        order_id: 'ord-fail-then-ok',
        amount_usd: 16,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngFailThenOk.status, 200);
      const reqFailThenOk = ((await rIngFailThenOk.json()) as any).request;

      const rExecFail = await fetch(`${finalServer.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokStaffFinX1}`,
        },
        body: JSON.stringify(reqFailThenOk),
      });
      assert.equal(rExecFail.status, 502);
      const ordAfterFail = await inMemOrderStore.getOrderForBusiness({
        businessId: 'biz-x1',
        orderId: 'ord-fail-then-ok',
      });
      assert.equal(ordAfterFail?.paymentStatus, 'paid');
      assert.equal(ordAfterFail?.refundedAmountCents, 0);

      providerBehavior = 'succeed';
      const rExecRecover = await fetch(`${finalServer.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokStaffFinX1}`,
        },
        body: JSON.stringify(reqFailThenOk),
      });
      assert.equal(rExecRecover.status, 200);
      const ordAfterRecover = await inMemOrderStore.getOrderForBusiness({
        businessId: 'biz-x1',
        orderId: 'ord-fail-then-ok',
      });
      assert.equal(ordAfterRecover?.paymentStatus, 'refunded');
      assert.equal(ordAfterRecover?.refundedAmountCents, 1600);
      pass(
        'H2-18 — Failed provider leaves order paid (0 refunded); retry updates order only after confirmed provider success',
        'Retry transitioned order paymentStatus=refunded cleanly'
      );

      // H2-19: Provider timeout preserves uncertain reservation & paid order; reconciliation marks BOTH reservation AND order refunded
      providerBehavior = 'timeout_after_refund';
      const rIngTimeout = await ingestFinal(tokStaffSupX1, {
        business_id: 'biz-x1',
        order_id: 'ord-timeout-reconcile',
        amount_usd: 17,
        authority_level: 'execute_under_policy',
      });
      assert.equal(rIngTimeout.status, 200);
      const reqTimeout = ((await rIngTimeout.json()) as any).request;

      const rExecTimeout = await fetch(`${finalServer.baseUrl}/api/governance/finance/refund`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokStaffFinX1}`,
        },
        body: JSON.stringify(reqTimeout),
      });
      assert.equal(rExecTimeout.status, 409);
      const timeoutBody = (await rExecTimeout.json()) as any;
      assert.equal(timeoutBody.status, 'UNCERTAIN_RECONCILIATION_REQUIRED');
      const ordWhileUncertain = await inMemOrderStore.getOrderForBusiness({
        businessId: 'biz-x1',
        orderId: 'ord-timeout-reconcile',
      });
      assert.equal(ordWhileUncertain?.paymentStatus, 'paid');
      assert.equal(ordWhileUncertain?.refundedAmountCents, 0);

      providerBehavior = 'succeed';
      const rRecTimeout = await fetch(
        `${finalServer.baseUrl}/api/governance/finance/refund/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokStaffFinX1}`,
          },
          body: JSON.stringify({
            order_id: 'ord-timeout-reconcile',
            business_id: 'biz-x1',
          }),
        }
      );
      assert.equal(rRecTimeout.status, 200);
      const recTimeoutBody = (await rRecTimeout.json()) as any;
      assert.equal(recTimeoutBody.status, 'RECONCILED_EXECUTED');

      const ordAfterReconcile = await inMemOrderStore.getOrderForBusiness({
        businessId: 'biz-x1',
        orderId: 'ord-timeout-reconcile',
      });
      assert.equal(ordAfterReconcile?.paymentStatus, 'refunded');
      assert.equal(ordAfterReconcile?.status, 'refunded');
      assert.equal(ordAfterReconcile?.refundedAmountCents, 1700);
      pass(
        'H2-19 — Uncertain timeout holds order lock without false refund mark; reconciliation updates both reservation and authoritative order',
        'RECONCILED_EXECUTED marked order paymentStatus=refunded'
      );

      // H2-20: Reconcile by order_id WITHOUT business_id rejected across HTTP (400), executor, and replayStore
      const rRecAmbigHttp = await fetch(
        `${finalServer.baseUrl}/api/governance/finance/refund/reconcile`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokOwnerX}`,
          },
          body: JSON.stringify({ order_id: 'ord-ambig-shared' }),
        }
      );
      assert.equal(rRecAmbigHttp.status, 400);
      assert.equal(
        ((await rRecAmbigHttp.json()) as any).code,
        'BUSINESS_ID_REQUIRED_FOR_ORDER_RECONCILIATION'
      );

      const recAmbigExec = await reconcileFinanceRefund(
        { orderId: 'ord-ambig-shared' },
        { replayStore: finalStore, orderStore: inMemOrderStore, paymentProvider: finalProvider }
      );
      assert.equal(recAmbigExec.status, 'AMBIGUOUS_ORDER_REQUIRES_BUSINESS_ID');

      await assert.rejects(
        () => finalStore.getRefundReservation({ orderId: 'ord-ambig-shared' }),
        /business_id is required/i
      );
      pass(
        'H2-20 — Ambiguous order_id-only reconciliation rejected at HTTP route (400), executor, and replayStore',
        'business_id enforced at all 3 layers'
      );

      // H2-21: DB-level reserve_refund_execution enforces owner/tenant match against stored request & approval
      const crossOwnerSeed = ingestAuthenticatedRefundRequest(
        {
          business_id: 'biz-x1',
          order_id: 'ord-db-owner-check',
          customer_email: 'buyer@example.test',
          amount_usd: 15,
          reason: 'DB owner/tenant boundary check',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-db-chk',
          raw_trigger_payload: '{}',
          confidence: 0.96,
          authority_level: 'execute_under_policy',
        },
        keyring
      );
      await finalStore.recordProvenanceOrigin(crossOwnerSeed.provenance!, 'ord-db-owner-check', {
        ownerId: ownerXId,
        tenantId: tenantX,
      });
      await finalStore.recordAuthenticatedRefundRequest({
        requestId: crossOwnerSeed.provenance!.request_id,
        ownerId: ownerXId,
        tenantId: tenantX,
        businessId: 'biz-x1',
        orderId: 'ord-db-owner-check',
        amountCents: 1500,
        authorityLevel: 'execute_under_policy',
        expiresAt: crossOwnerSeed.provenance!.expires_at!,
        createdAt: crossOwnerSeed.provenance!.created_at,
        provenance: crossOwnerSeed.provenance!,
      });
      const rsvOwnerMismatch = await finalStore.reserveRefundExecution({
        requestId: crossOwnerSeed.provenance!.request_id,
        nonce: crossOwnerSeed.provenance!.nonce!,
        orderId: 'ord-db-owner-check',
        businessId: 'biz-x1',
        ownerId: ownerYId,
        tenantId: tenantY,
        approvalId: null,
        requireOwnerApproval: false,
        amountCents: 1500,
        idempotencyKey: `idem-mismatch-${crypto.randomBytes(4).toString('hex')}`,
        canonicalDigest: 'digest-mismatch',
        keyId: 'ephemeral-h2-key',
        providerName: 'h2_final_mock_provider',
        executionLeaseMs: 60_000,
        expiresAt: crossOwnerSeed.provenance!.expires_at!,
        provenanceSnapshot: crossOwnerSeed.provenance!,
      });
      assert.equal(rsvOwnerMismatch.status, 'REPLAY_CONFLICT');
      assert.match(rsvOwnerMismatch.reason, /owner or tenant scope/i);

      pass(
        'H2-21 — SQLite reserveRefundExecution enforces DB-level owner/tenant verification',
        'Rejected cross-owner/cross-tenant reservation attempt inside DB tx'
      );

      // H2-22: Static verification of migration 000008, conservative backfill, RLS lockdown, and rollback
      const mig08 = fs
        .readFileSync(
          path.resolve(
            process.cwd(),
            'supabase/migrations/20261118000008_h2_authoritative_orders_and_memberships.sql'
          ),
          'utf8'
        )
        .toLowerCase();
      const mig08Rb = fs
        .readFileSync(
          path.resolve(
            process.cwd(),
            'supabase/migrations/20261118000008_h2_authoritative_orders_and_memberships_rollback.sql'
          ),
          'utf8'
        )
        .toLowerCase();
      assert.ok(mig08.includes('create table if not exists public.orders'));
      assert.ok(mig08.includes('create table if not exists public.business_memberships'));
      assert.ok(mig08.includes('alter table public.orders enable row level security'));
      assert.ok(
        mig08.includes('drop policy if exists "owners view and manage their orders" on public.orders')
      );
      // Conservative backfill NEVER blindly marks completed -> paid
      assert.ok(
        mig08.includes("'unpaid'") &&
          mig08.includes('manual verified backfill procedure') &&
          mig08.includes("never invent payment_status='paid'"),
        '000008 backfill must default legacy unknown rows conservatively to unpaid with manual backfill guide'
      );
      assert.ok(
        mig08.includes('create or replace function public.record_authoritative_order_refund')
      );
      assert.ok(mig08Rb.includes('raise exception'));

      pass(
        'H2-22 — Migration 000008 schema, conservative payment_status backfill, RLS lockdown, and fail-safe rollback statically verified',
        'Confirmed orders/business_memberships tables, strict payment_status defaults, and fail-safe rollback'
      );
    } finally {
      await finalServer.close();
      finalStore.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          if (fs.existsSync(dbFinalPath + suffix)) fs.unlinkSync(dbFinalPath + suffix);
        } catch {}
      }
    }

    console.log(`\nSummary: ${results.length}/${results.length} H2 tests passed.`);
  } finally {
    await server.close();
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
      } catch {}
    }
  }
}

runTests().catch((err) => {
  console.error('\n[FAIL] H2 Tenant & Business Isolation suite failed:', err);
  process.exit(1);
});
