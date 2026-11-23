import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_INGESTION_FRESHNESS_MS,
  DEFAULT_OWNER_APPROVAL_TTL_MS,
  DEFAULT_PERSISTED_REQUEST_TTL_MS,
  type FinanceRefundRequest,
  type ProvenanceRecord,
} from './provenance';
import {
  DEFAULT_FINANCE_REFUND_POLICY,
  evaluateFinanceRefund,
  type AuthoritativeOwnerApprovalRecord,
} from './financeRefundGate';
import { createGovernanceRouter } from '../../server/governanceRoutes';
import type { GovernanceAuthVerifier, GovernanceCallerIdentity } from '../../server/governanceAuth';
import {
  createKeyringSignatureVerifier,
  ingestAuthenticatedRefundRequest,
  verifyIngestionPayloadFreshness,
  type ServerKeyring,
} from '../../server/provenanceAuth';
import { SqlitePersistentReplayStore } from '../../server/replayStore';
import {
  executeAuthorizedFinanceRefund,
  type PaymentRefundProviderAdapter,
} from '../../server/financeExecutor';
import {
  createInMemoryAuthoritativeOrderStore,
  type AuthoritativeOrderRecord,
  type AuthoritativeOrderStore,
} from '../../server/orderStore';

interface TestResult {
  name: string;
  detail: string;
}

type SignedRefundRequest = FinanceRefundRequest & {
  provenance: ProvenanceRecord & { nonce: string; expires_at: string };
};

async function startClockControlledServer(opts: {
  keyring: ServerKeyring;
  replayStore: SqlitePersistentReplayStore;
  authVerifier: GovernanceAuthVerifier;
  orderStore: AuthoritativeOrderStore;
  paymentProvider: PaymentRefundProviderAdapter;
  getNow: () => Date;
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
      getNow: opts.getNow,
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

async function postJson(
  url: string,
  token: string,
  body: Record<string, any>
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function runTests() {
  const results: TestResult[] = [];
  const pass = (name: string, detail: string) => {
    results.push({ name, detail });
    console.log(`[PASS] ${name} -> ${detail}`);
  };

  // Ensure default env overrides don't interfere with default policy verification
  delete process.env.GOVERNANCE_APPROVAL_TTL_MS;
  delete process.env.GOVERNANCE_REQUEST_TTL_MS;

  const secret = crypto.randomBytes(32).toString('hex');
  const keyring: ServerKeyring = {
    activeKeyId: 'ephemeral-h3-key',
    keys: {
      'ephemeral-h3-key': {
        keyId: 'ephemeral-h3-key',
        secret,
        status: 'active',
        allowedComponent: 'nexus-ingestion-api',
      },
    },
  };
  const verifySig = createKeyringSignatureVerifier(keyring);

  const dbPath = `/tmp/h3-verify-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
  const store = new SqlitePersistentReplayStore(dbPath);

  const ownerAId = '11111111-1111-4111-8111-111111111111';
  const ownerBId = '22222222-2222-4222-8222-222222222222';
  const supportAId = '33333333-3333-4333-8333-333333333333';
  const financeAId = '44444444-4444-4444-8444-444444444444';

  const tokOwnerA = `tok-owner-a-${crypto.randomBytes(8).toString('hex')}`;
  const tokOwnerB = `tok-owner-b-${crypto.randomBytes(8).toString('hex')}`;
  const tokSupportA = `tok-support-a-${crypto.randomBytes(8).toString('hex')}`;
  const tokFinanceA = `tok-finance-a-${crypto.randomBytes(8).toString('hex')}`;

  const authVerifier: GovernanceAuthVerifier = {
    configured: true,
    ownerUserIds: new Set([ownerAId, ownerBId]),
    verifyAccessToken: async (token) => {
      if (token === tokOwnerA) {
        return {
          id: ownerAId,
          email: 'owner-a@example.test',
          appMetadata: { role: 'owner', tenant_id: ownerAId },
        };
      }
      if (token === tokOwnerB) {
        return {
          id: ownerBId,
          email: 'owner-b@example.test',
          appMetadata: { role: 'owner', tenant_id: ownerBId },
        };
      }
      if (token === tokSupportA) {
        return {
          id: supportAId,
          email: 'support-a@example.test',
          appMetadata: {
            role: 'support_operator',
            tenant_id: ownerAId,
            owner_id: ownerAId,
            business_ids: ['biz-a'],
          },
        };
      }
      if (token === tokFinanceA) {
        return {
          id: financeAId,
          email: 'finance-a@example.test',
          appMetadata: {
            role: 'finance_operator',
            tenant_id: ownerAId,
            owner_id: ownerAId,
            business_ids: ['biz-a'],
          },
        };
      }
      return null;
    },
  };

  const callerOwnerA: GovernanceCallerIdentity = {
    userId: ownerAId,
    email: 'owner-a@example.test',
    roles: ['owner'],
    permissions: [
      'provenance:ingest',
      'finance:refund:execute',
      'finance:approval:create',
      'finance:approval:read',
      'finance:approval:revoke',
    ],
    tenantId: ownerAId,
    ownerId: ownerAId,
    allowedBusinessIds: ['biz-a'],
    authProvider: 'supabase_auth',
  };

  const makePaidOrder = (
    orderId: string,
    amountCents = 8900,
    businessId = 'biz-a',
    ownerId = ownerAId
  ): AuthoritativeOrderRecord => ({
    orderRecordId: crypto.randomUUID(),
    orderId,
    businessId,
    ownerId,
    tenantId: ownerId,
    amountCents,
    currency: 'USD',
    paymentStatus: 'paid',
    status: 'completed',
    refundedAmountCents: 0,
    externalRefunded: false,
    eligibleForRefund: true,
  });

  const orders: AuthoritativeOrderRecord[] = [];
  for (let i = 1; i <= 25; i++) {
    orders.push(makePaidOrder(`ORD-H3-${i}`, 8900, 'biz-a', ownerAId));
  }
  orders.push(makePaidOrder('ORD-H3-SMALL', 1500, 'biz-a', ownerAId));
  orders.push(makePaidOrder('ORD-H3-BIZ-B', 8900, 'biz-b', ownerBId));

  const orderStore = createInMemoryAuthoritativeOrderStore({
    businesses: [
      { businessId: 'biz-a', ownerId: ownerAId, tenantId: ownerAId, status: 'active' },
      { businessId: 'biz-b', ownerId: ownerBId, tenantId: ownerBId, status: 'active' },
    ],
    memberships: [
      {
        businessId: 'biz-a',
        tenantId: ownerAId,
        userId: supportAId,
        role: 'support_operator',
        status: 'active',
      },
      {
        businessId: 'biz-a',
        tenantId: ownerAId,
        userId: financeAId,
        role: 'finance_operator',
        status: 'active',
      },
    ],
    orders,
  });

  let providerCalls = 0;
  let lastProviderAmountCents = 0;
  const paymentProvider: PaymentRefundProviderAdapter = {
    providerName: 'h3_test_provider',
    supportsIdempotencyKey: true,
    supportsRefundLookup: true,
    executeRefund: async ({ amountCents }) => {
      providerCalls += 1;
      lastProviderAmountCents = amountCents;
      return {
        outcome: 'CONFIRMED_SUCCESS',
        txId: `tx-h3-${providerCalls}`,
      };
    },
  };

  const BASE_TIME = Date.parse('2026-11-18T12:00:00.000Z');
  let nowMs = BASE_TIME;
  const getNow = () => new Date(nowMs);

  const server = await startClockControlledServer({
    keyring,
    replayStore: store,
    authVerifier,
    orderStore,
    paymentProvider,
    getNow,
  });

  async function ingestViaApi(
    orderId: string,
    amountUsd = 89,
    confidence = 0.92,
    extraBody: Record<string, any> = {},
    token = tokSupportA,
    businessId = 'biz-a'
  ): Promise<{ status: number; request?: SignedRefundRequest; json: any }> {
    const res = await postJson(`${server.baseUrl}/api/governance/provenance/ingest`, token, {
      business_id: businessId,
      order_id: orderId,
      customer_email: 'buyer@example.test',
      amount_usd: amountUsd,
      currency: 'USD',
      reason: 'H3 expiration verification test',
      confidence,
      authority_level: 'execute_under_policy',
      ...extraBody,
    });
    return { status: res.status, request: res.json?.request as SignedRefundRequest | undefined, json: res.json };
  }

  async function approveViaApi(
    req: SignedRefundRequest,
    extraBody: Record<string, any> = {},
    token = tokOwnerA
  ): Promise<{ status: number; json: any }> {
    return postJson(`${server.baseUrl}/api/governance/approvals`, token, {
      request_id: req.provenance.request_id,
      order_id: req.order_id,
      business_id: req.business_id,
      amount_cents: Math.round(req.amount_usd * 100),
      decision_note: 'Approved in H3 test',
      ...extraBody,
    });
  }

  async function executeViaApi(
    req: SignedRefundRequest,
    approval?: AuthoritativeOwnerApprovalRecord,
    token = tokFinanceA
  ): Promise<{ status: number; json: any }> {
    const payload: FinanceRefundRequest = approval
      ? {
          ...req,
          provenance: {
            ...req.provenance,
            authority_level: 'owner_approved',
            owner_approval_id: approval.approval_id,
            owner_approval_binding: {
              approval_id: approval.approval_id,
              request_id: req.provenance.request_id,
              order_id: req.order_id,
              amount_usd: req.amount_usd,
              approved_by_user_id: approval.approved_by_user_id,
              approved_at: approval.created_at ?? new Date(nowMs).toISOString(),
            },
          },
        }
      : req;
    return postJson(`${server.baseUrl}/api/governance/finance/refund`, token, payload);
  }

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Default policy compatibility (original 5m vs 15m mismatch fixed)
    // Ingest at t=0, approve at t=2m, execute at t=14m under DEFAULT policy!
    // -------------------------------------------------------------------------
    {
      assert.equal(DEFAULT_FINANCE_REFUND_POLICY.maxRequestAgeMs, 5 * 60 * 1000);
      assert.equal(DEFAULT_FINANCE_REFUND_POLICY.maxPersistedRequestAgeMs, 60 * 60 * 1000);
      assert.equal(DEFAULT_OWNER_APPROVAL_TTL_MS, 15 * 60 * 1000);

      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing = await ingestViaApi('ORD-H3-1', 89, 0.92);
      assert.equal(ing.status, 200);
      const req1 = ing.request!;
      assert.equal(
        Date.parse(req1.provenance.expires_at!) - Date.parse(req1.provenance.created_at),
        DEFAULT_PERSISTED_REQUEST_TTL_MS
      );

      nowMs = BASE_TIME + 2 * 60 * 1000;
      const apr = await approveViaApi(req1);
      assert.equal(apr.status, 201);
      const approval = apr.json.approval as AuthoritativeOwnerApprovalRecord;
      assert.equal(
        Date.parse(approval.expires_at) - nowMs,
        DEFAULT_OWNER_APPROVAL_TTL_MS
      );

      // Execute at t=14m (well past old 5m maxRequestAgeMs, still inside 15m approval & 60m request window)
      nowMs = BASE_TIME + 14 * 60 * 1000;
      const execRes = await executeViaApi(req1, approval);
      assert.equal(execRes.status, 200, `Expected 200 EXECUTED, got ${JSON.stringify(execRes.json)}`);
      assert.equal(execRes.json.status, 'EXECUTED');
      assert.equal(providerCalls, callsBefore + 1);
      assert.equal(lastProviderAmountCents, 8900);

      pass(
        'Test 1: Default policy compatibility (t=0 ingest, t=2m approve, t=14m execute)',
        `Executed refund under default policy without overrides; tx=${execRes.json.executionTxId}`
      );
    }

    // -------------------------------------------------------------------------
    // TEST 2: Ingestion rejects stale timestamps or future-dated manipulation
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const staleSigned = ingestAuthenticatedRefundRequest(
        {
          business_id: 'biz-a',
          order_id: 'ORD-H3-2',
          customer_email: 'buyer@example.test',
          amount_usd: 15,
          reason: 'Stale test',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-stale',
          raw_trigger_payload: '{"t":"stale"}',
          confidence: 0.95,
          authority_level: 'execute_under_policy',
          now: new Date(BASE_TIME - 6 * 60 * 1000),
          ttlMs: DEFAULT_PERSISTED_REQUEST_TTL_MS,
        },
        keyring
      );
      const staleFresh = verifyIngestionPayloadFreshness(staleSigned.provenance!, {
        now: new Date(BASE_TIME),
      });
      assert.equal(staleFresh.valid, false);
      assert.equal(staleFresh.code, 'STALE_INGESTION_SIGNATURE');

      const futureSigned = ingestAuthenticatedRefundRequest(
        {
          business_id: 'biz-a',
          order_id: 'ORD-H3-2',
          customer_email: 'buyer@example.test',
          amount_usd: 15,
          reason: 'Future test',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-future',
          raw_trigger_payload: '{"t":"future"}',
          confidence: 0.95,
          authority_level: 'execute_under_policy',
          now: new Date(BASE_TIME + 5 * 60 * 1000),
          ttlMs: DEFAULT_PERSISTED_REQUEST_TTL_MS,
        },
        keyring
      );
      const futureFresh = verifyIngestionPayloadFreshness(futureSigned.provenance!, {
        now: new Date(BASE_TIME),
      });
      assert.equal(futureFresh.valid, false);
      assert.equal(futureFresh.code, 'FUTURE_PROVENANCE_TIMESTAMP');

      const gateFuture = evaluateFinanceRefund(futureSigned, {
        verifyIngestionSignature: verifySig,
        now: new Date(BASE_TIME),
      });
      assert.equal(gateFuture.decision, 'REJECT_SECURITY_VIOLATION');
      assert.equal(gateFuture.securityCode, 'FUTURE_PROVENANCE_TIMESTAMP');

      pass(
        'Test 2: Stale and future-dated ingestion timestamps rejected',
        'Rejected 6m stale signature (STALE_INGESTION_SIGNATURE) and +5m future provenance (FUTURE_PROVENANCE_TIMESTAMP)'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 3: Client-supplied expires_at, ttl, ttlMs, created_at ignored / rejected
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const clientFakeIng = await ingestViaApi('ORD-H3-3', 89, 0.92, {
        created_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
        ttl: 999999999,
        ttlMs: 999999999,
        ingested_at: '2099-01-01T00:00:00.000Z',
      });
      assert.equal(clientFakeIng.status, 200);
      const req3 = clientFakeIng.request!;
      assert.equal(req3.provenance.created_at, new Date(nowMs).toISOString());
      assert.equal(
        req3.provenance.expires_at,
        new Date(nowMs + DEFAULT_PERSISTED_REQUEST_TTL_MS).toISOString()
      );
      assert.equal(req3.provenance.ingestion_auth?.ingested_at, new Date(nowMs).toISOString());

      nowMs = BASE_TIME + 60_000;
      const clientFakeApr = await approveViaApi(req3, {
        created_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
        ttl: 999999999,
        ttlMs: 999999999,
      });
      assert.equal(clientFakeApr.status, 201);
      const apr3 = clientFakeApr.json.approval as AuthoritativeOwnerApprovalRecord;
      assert.equal(apr3.created_at, new Date(nowMs).toISOString());
      assert.equal(
        apr3.expires_at,
        new Date(nowMs + DEFAULT_OWNER_APPROVAL_TTL_MS).toISOString()
      );

      // Tampering provenance expires_at or created_at at execution fails closed
      const tamperedExec = await executeViaApi(
        {
          ...req3,
          provenance: {
            ...req3.provenance,
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        },
        apr3
      );
      assert.equal(tamperedExec.status, 403);
      assert.equal(tamperedExec.json.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(providerCalls, callsBefore);

      pass(
        'Test 3: Client expires_at/ttl/ttlMs/created_at overrides ignored & provenance tampering rejected',
        'Server ignored client TTL/timestamps on ingest & approval; tampered provenance.expires_at rejected with 403'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 4: Persisted authenticated refund request stays eligible across 60m window
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing4 = await ingestViaApi('ORD-H3-4', 89, 0.92);
      assert.equal(ing4.status, 200);
      const req4 = ing4.request!;

      nowMs = BASE_TIME + 40 * 60 * 1000;
      const apr4Res = await approveViaApi(req4);
      assert.equal(apr4Res.status, 201);
      const apr4 = apr4Res.json.approval as AuthoritativeOwnerApprovalRecord;
      assert.equal(apr4.expires_at, new Date(BASE_TIME + 55 * 60 * 1000).toISOString());

      nowMs = BASE_TIME + 50 * 60 * 1000;
      const exec4 = await executeViaApi(req4, apr4);
      assert.equal(exec4.status, 200);
      assert.equal(exec4.json.status, 'EXECUTED');
      assert.equal(providerCalls, callsBefore + 1);

      pass(
        'Test 4: Persisted request remains eligible across 60m workflow window',
        'Ingested t=0, approved t=40m, executed t=50m -> 200 EXECUTED under default policy'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 5: Request expired before approval (rejected at POST /approvals)
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const ing5 = await ingestViaApi('ORD-H3-5', 89, 0.92);
      assert.equal(ing5.status, 200);
      const req5 = ing5.request!;

      nowMs = BASE_TIME + DEFAULT_PERSISTED_REQUEST_TTL_MS + 1000; // t = 60m + 1s
      const apr5 = await approveViaApi(req5);
      assert.equal(apr5.status, 409);
      assert.equal(apr5.json.code, 'REFUND_REQUEST_EXPIRED');

      pass(
        'Test 5: Expired refund request cannot be approved',
        'Approval at t=60m1s rejected with 409 REFUND_REQUEST_EXPIRED'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 6: Request expired after approval (rejected at execution)
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing6 = await ingestViaApi('ORD-H3-6', 89, 0.92);
      assert.equal(ing6.status, 200);
      const req6 = ing6.request!;

      // Even if a stored approval has later expires_at (seeded legacy row),
      // expired request still blocks execution fail-closed.
      await store.recordOwnerApproval({
        approvalId: 'apr-h3-expired-req-6',
        requestId: req6.provenance.request_id,
        orderId: req6.order_id,
        businessId: req6.business_id,
        amountCents: 8900,
        approvedByUserId: ownerAId,
        expiresAt: new Date(BASE_TIME + 75 * 60 * 1000).toISOString(),
        nowIso: new Date(BASE_TIME + 55 * 60 * 1000).toISOString(),
        status: 'approved',
        ownerId: ownerAId,
        tenantId: ownerAId,
      });

      nowMs = BASE_TIME + DEFAULT_PERSISTED_REQUEST_TTL_MS + 1000;
      const exec6 = await executeViaApi(req6, {
        approval_id: 'apr-h3-expired-req-6',
        request_id: req6.provenance.request_id,
        order_id: req6.order_id,
        business_id: req6.business_id,
        amount_cents: 8900,
        approved_by_user_id: ownerAId,
        status: 'approved',
        expires_at: new Date(BASE_TIME + 75 * 60 * 1000).toISOString(),
        created_at: new Date(BASE_TIME + 55 * 60 * 1000).toISOString(),
      });
      assert.equal(exec6.status, 403);
      assert.equal(exec6.json.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(exec6.json.code, 'REFUND_REQUEST_EXPIRED');
      assert.equal(providerCalls, callsBefore);

      pass(
        'Test 6: Request expired after approval is rejected fail-closed at execution',
        'Execution rejected with 403 REFUND_REQUEST_EXPIRED and 0 provider calls'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 7: Approval expiration capped to request expiration (5m remaining -> 5m approval)
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing7 = await ingestViaApi('ORD-H3-7', 89, 0.92);
      assert.equal(ing7.status, 200);
      const req7 = ing7.request!;

      // Approve at t=55m -> only 5m remaining on 60m request!
      nowMs = BASE_TIME + 55 * 60 * 1000;
      const apr7Res = await approveViaApi(req7);
      assert.equal(apr7Res.status, 201);
      const apr7 = apr7Res.json.approval as AuthoritativeOwnerApprovalRecord;
      assert.equal(
        apr7.expires_at,
        req7.provenance.expires_at,
        'Approval expires_at must be capped to request.expires_at (t=60m), not t=70m'
      );

      nowMs = BASE_TIME + 59 * 60 * 1000;
      const exec7 = await executeViaApi(req7, apr7);
      assert.equal(exec7.status, 200);
      assert.equal(exec7.json.status, 'EXECUTED');
      assert.equal(providerCalls, callsBefore + 1);

      pass(
        'Test 7: Approval expiration strictly capped to remaining request lifetime',
        'Approved at t=55m -> approval.expires_at capped at t=60m (5m remaining instead of 15m); executed at t=59m'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 8: Approval expired before execution (request still valid!)
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing8 = await ingestViaApi('ORD-H3-8', 89, 0.92);
      assert.equal(ing8.status, 200);
      const req8 = ing8.request!;

      nowMs = BASE_TIME + 60_000; // t=1m
      const apr8Res = await approveViaApi(req8);
      assert.equal(apr8Res.status, 201);
      const apr8 = apr8Res.json.approval as AuthoritativeOwnerApprovalRecord; // expires t=16m

      nowMs = BASE_TIME + 20 * 60 * 1000; // t=20m: request valid (60m), approval expired (16m)
      const exec8 = await executeViaApi(req8, apr8);
      assert.equal(exec8.status, 403);
      assert.equal(exec8.json.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(exec8.json.code, 'OWNER_APPROVAL_EXPIRED');
      assert.equal(providerCalls, callsBefore);

      // Direct replayStore enforcement check
      const rsvExpired = await store.reserveRefundExecution({
        ownerId: ownerAId,
        tenantId: ownerAId,
        requestId: req8.provenance.request_id,
        nonce: req8.provenance.nonce,
        orderId: req8.order_id,
        businessId: req8.business_id,
        approvalId: apr8.approval_id,
        requireOwnerApproval: true,
        amountCents: 8900,
        idempotencyKey: `idem-${req8.provenance.request_id}`,
        canonicalDigest: 'digest-8',
        keyId: 'ephemeral-h3-key',
        expiresAt: req8.provenance.expires_at!,
        nowIso: new Date(nowMs).toISOString(),
        provenanceSnapshot: req8.provenance,
      });
      assert.equal(rsvExpired.status, 'APPROVAL_EXPIRED');

      pass(
        'Test 8: Expired approval fails closed even when request is still active',
        'Rejected at both HTTP executor (403 OWNER_APPROVAL_EXPIRED) and DB replayStore (APPROVAL_EXPIRED)'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 9: Re-approval / approval extension bypass attempts
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing9 = await ingestViaApi('ORD-H3-9', 89, 0.92);
      assert.equal(ing9.status, 200);
      const req9 = ing9.request!;

      nowMs = BASE_TIME + 60_000;
      const apr9aRes = await approveViaApi(req9);
      assert.equal(apr9aRes.status, 201);
      const apr9a = apr9aRes.json.approval as AuthoritativeOwnerApprovalRecord;

      // (a) Duplicate approval without revoking rejected
      const dupApr = await approveViaApi(req9);
      assert.equal(dupApr.status, 409);
      assert.equal(dupApr.json.code, 'DUPLICATE_ACTIVE_APPROVAL');

      // (b) Revoke and re-approve at t=55m -> new approval STILL capped to request t=60m
      const rev9a = await postJson(
        `${server.baseUrl}/api/governance/approvals/${apr9a.approval_id}/revoke`,
        tokOwnerA,
        {}
      );
      assert.equal(rev9a.status, 200);

      nowMs = BASE_TIME + 55 * 60 * 1000;
      const apr9bRes = await approveViaApi(req9);
      assert.equal(apr9bRes.status, 201);
      const apr9b = apr9bRes.json.approval as AuthoritativeOwnerApprovalRecord;
      assert.equal(apr9b.expires_at, req9.provenance.expires_at);

      // Revoke again after request expires -> re-approval blocked
      await postJson(
        `${server.baseUrl}/api/governance/approvals/${apr9b.approval_id}/revoke`,
        tokOwnerA,
        {}
      );
      nowMs = BASE_TIME + 61 * 60 * 1000;
      const lateApr = await approveViaApi(req9);
      assert.equal(lateApr.status, 409);
      assert.equal(lateApr.json.code, 'REFUND_REQUEST_EXPIRED');

      // (c) Cannot borrow valid approval from another request/order
      nowMs = BASE_TIME + 120_000;
      const ingOther = await ingestViaApi('ORD-H3-10', 89, 0.92);
      const reqOther = ingOther.request!;
      const aprOtherRes = await approveViaApi(reqOther);
      const aprOther = aprOtherRes.json.approval as AuthoritativeOwnerApprovalRecord;
      const borrowAttempt = await executeViaApi(req9, aprOther);
      assert.equal(borrowAttempt.status, 403);
      assert.equal(providerCalls, callsBefore);

      pass(
        'Test 9: Re-approval and extension bypass attempts blocked',
        'Blocked duplicate approval (409), capped re-approval at request.expires_at, blocked post-expiry re-approval, blocked foreign approval reuse'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 10: Initial ingestion signature freshness (short 5m window vs 60m persisted)
    // -------------------------------------------------------------------------
    {
      const signedAt = new Date(BASE_TIME);
      const directSigned = ingestAuthenticatedRefundRequest(
        {
          business_id: 'biz-a',
          order_id: 'ORD-H3-SMALL',
          customer_email: 'buyer@example.test',
          amount_usd: 15,
          reason: 'Direct freshness check',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-fresh-10',
          raw_trigger_payload: '{"t":10}',
          confidence: 0.95,
          authority_level: 'execute_under_policy',
          now: signedAt,
        },
        keyring
      );

      // 4m59.999s -> valid unpersisted freshness
      const before5m = new Date(BASE_TIME + DEFAULT_INGESTION_FRESHNESS_MS - 1);
      assert.equal(
        verifyIngestionPayloadFreshness(directSigned.provenance!, { now: before5m }).valid,
        true
      );
      const gateOk = evaluateFinanceRefund(directSigned, {
        verifyIngestionSignature: verifySig,
        now: before5m,
      });
      assert.equal(gateOk.decision, 'EXECUTE');

      // Exactly 5m -> rejected as STALE_INGESTION_SIGNATURE when unpersisted
      const exact5m = new Date(BASE_TIME + DEFAULT_INGESTION_FRESHNESS_MS);
      const freshFail = verifyIngestionPayloadFreshness(directSigned.provenance!, {
        now: exact5m,
      });
      assert.equal(freshFail.valid, false);
      assert.equal(freshFail.code, 'STALE_INGESTION_SIGNATURE');

      const gateStale = evaluateFinanceRefund(directSigned, {
        verifyIngestionSignature: verifySig,
        now: exact5m,
      });
      assert.equal(gateStale.decision, 'REJECT_SECURITY_VIOLATION');
      assert.equal(gateStale.securityCode, 'STALE_INGESTION_SIGNATURE');

      pass(
        'Test 10: Initial ingestion freshness strictly enforced at 5m boundary',
        'Unpersisted provenance valid at 5m-1ms and rejected at 5m with STALE_INGESTION_SIGNATURE'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 11: Exact boundary consistency (now === expires_at fails; now === expires_at - 1ms succeeds)
    // -------------------------------------------------------------------------
    {
      // 11a: Request boundary on approval creation & execution
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing11a = await ingestViaApi('ORD-H3-11', 89, 0.92);
      const req11a = ing11a.request!;
      const reqExpMs = Date.parse(req11a.provenance.expires_at!);

      // At now === request.expires_at -> approval creation rejected
      nowMs = reqExpMs;
      const aprAtExactExp = await approveViaApi(req11a);
      assert.equal(aprAtExactExp.status, 409);
      assert.equal(aprAtExactExp.json.code, 'REFUND_REQUEST_EXPIRED');

      // At now === request.expires_at - 1ms -> approval creation succeeds & capped to exact request expiry!
      nowMs = reqExpMs - 1;
      const apr1MsBefore = await approveViaApi(req11a);
      assert.equal(apr1MsBefore.status, 201);
      const apr11a = apr1MsBefore.json.approval as AuthoritativeOwnerApprovalRecord;
      assert.equal(apr11a.expires_at, req11a.provenance.expires_at);

      // Evaluate at exact expiry -> fails
      const evalExact = evaluateFinanceRefund(
        {
          ...req11a,
          provenance: {
            ...req11a.provenance,
            authority_level: 'owner_approved',
            owner_approval_id: apr11a.approval_id,
          },
        },
        {
          priorProvenance: req11a.provenance,
          persistedRequest: {
            requestId: req11a.provenance.request_id,
            orderId: req11a.order_id,
            businessId: req11a.business_id,
            amountCents: 8900,
            createdAt: req11a.provenance.created_at,
            expiresAt: req11a.provenance.expires_at!,
            provenance: req11a.provenance,
          },
          authoritativeOwnerApproval: apr11a,
          verifyIngestionSignature: verifySig,
          now: new Date(reqExpMs),
        }
      );
      assert.equal(evalExact.decision, 'REJECT_SECURITY_VIOLATION');
      assert.equal(evalExact.securityCode, 'REFUND_REQUEST_EXPIRED');

      // SQLite direct reserve at exact approval expiry -> fails
      const rsvExact = await store.reserveRefundExecution({
        ownerId: ownerAId,
        tenantId: ownerAId,
        requestId: req11a.provenance.request_id,
        nonce: req11a.provenance.nonce,
        orderId: req11a.order_id,
        businessId: req11a.business_id,
        approvalId: apr11a.approval_id,
        requireOwnerApproval: true,
        amountCents: 8900,
        idempotencyKey: `idem-${req11a.provenance.request_id}`,
        canonicalDigest: 'digest-11a',
        keyId: 'ephemeral-h3-key',
        expiresAt: req11a.provenance.expires_at!,
        nowIso: new Date(reqExpMs).toISOString(),
        provenanceSnapshot: req11a.provenance,
      });
      assert.equal(rsvExact.status, 'REFUND_REQUEST_EXPIRED');

      // Execute at reqExpMs - 1 -> SUCCEEDS!
      nowMs = reqExpMs - 1;
      const exec1MsBefore = await executeViaApi(req11a, apr11a);
      assert.equal(exec1MsBefore.status, 200);
      assert.equal(exec1MsBefore.json.status, 'EXECUTED');
      assert.equal(providerCalls, callsBefore + 1);

      // 11b: Approval boundary (request still valid, now === approval.expires_at vs -1ms)
      nowMs = BASE_TIME;
      const ing11b = await ingestViaApi('ORD-H3-12', 89, 0.92);
      const req11b = ing11b.request!;
      nowMs = BASE_TIME + 60_000;
      const apr11bRes = await approveViaApi(req11b);
      const apr11b = apr11bRes.json.approval as AuthoritativeOwnerApprovalRecord;
      const aprExpMs = Date.parse(apr11b.expires_at);

      // Exact approval expiry -> FAIL
      nowMs = aprExpMs;
      const execAprExact = await executeViaApi(req11b, apr11b);
      assert.equal(execAprExact.status, 403);
      assert.equal(execAprExact.json.code, 'OWNER_APPROVAL_EXPIRED');

      const rsvAprExact = await store.reserveRefundExecution({
        ownerId: ownerAId,
        tenantId: ownerAId,
        requestId: req11b.provenance.request_id,
        nonce: req11b.provenance.nonce,
        orderId: req11b.order_id,
        businessId: req11b.business_id,
        approvalId: apr11b.approval_id,
        requireOwnerApproval: true,
        amountCents: 8900,
        idempotencyKey: `idem-${req11b.provenance.request_id}`,
        canonicalDigest: 'digest-11b',
        keyId: 'ephemeral-h3-key',
        expiresAt: req11b.provenance.expires_at!,
        nowIso: new Date(aprExpMs).toISOString(),
        provenanceSnapshot: req11b.provenance,
      });
      assert.equal(rsvAprExact.status, 'APPROVAL_EXPIRED');

      // 1ms before approval expiry -> SUCCEED!
      nowMs = aprExpMs - 1;
      const execApr1MsBefore = await executeViaApi(req11b, apr11b);
      assert.equal(execApr1MsBefore.status, 200);
      assert.equal(execApr1MsBefore.json.status, 'EXECUTED');
      assert.equal(providerCalls, callsBefore + 2);

      pass(
        'Test 11: Exact boundary consistency (now >= expires_at rejected; expires_at - 1ms allowed)',
        'Verified identical boundary across POST /approvals, evaluateFinanceRefund, executeAuthorizedFinanceRefund, and SQLite reserveRefundExecution'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 12: Missing/malformed timestamps fail closed across gate & store
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const ing12 = await ingestViaApi('ORD-H3-13', 15, 0.95);
      const req12 = ing12.request!;

      const malformedProvGate = evaluateFinanceRefund(
        {
          ...req12,
          provenance: {
            ...req12.provenance,
            expires_at: 'not-a-timestamp',
          },
        },
        {
          verifyIngestionSignature: verifySig,
          now: new Date(BASE_TIME + 1000),
        }
      );
      assert.equal(malformedProvGate.decision, 'REJECT_SECURITY_VIOLATION');
      assert.equal(malformedProvGate.securityCode, 'MISSING_OR_MALFORMED_TIMESTAMP');

      const invertedWindowGate = evaluateFinanceRefund(
        {
          ...req12,
          provenance: {
            ...req12.provenance,
            expires_at: req12.provenance.created_at,
          },
        },
        {
          verifyIngestionSignature: verifySig,
          now: new Date(BASE_TIME),
        }
      );
      assert.equal(invertedWindowGate.decision, 'REJECT_SECURITY_VIOLATION');
      assert.equal(invertedWindowGate.securityCode, 'MISSING_OR_MALFORMED_TIMESTAMP');

      const malformedAprGate = evaluateFinanceRefund(
        {
          ...req12,
          provenance: {
            ...req12.provenance,
            authority_level: 'owner_approved',
            owner_approval_id: 'apr-bad-ts',
          },
        },
        {
          priorProvenance: req12.provenance,
          authoritativeOwnerApproval: {
            approval_id: 'apr-bad-ts',
            request_id: req12.provenance.request_id,
            order_id: req12.order_id,
            business_id: req12.business_id,
            amount_cents: 1500,
            approved_by_user_id: ownerAId,
            status: 'approved',
            expires_at: 'invalid-iso',
            created_at: new Date(BASE_TIME).toISOString(),
          },
          verifyIngestionSignature: verifySig,
          now: new Date(BASE_TIME + 1000),
        }
      );
      assert.equal(malformedAprGate.decision, 'REJECT_SECURITY_VIOLATION');
      assert.equal(malformedAprGate.securityCode, 'MISSING_OR_MALFORMED_TIMESTAMP');

      await assert.rejects(
        () =>
          store.recordOwnerApproval({
            approvalId: 'apr-malformed-store',
            requestId: req12.provenance.request_id,
            orderId: req12.order_id,
            businessId: req12.business_id,
            amountCents: 1500,
            approvedByUserId: ownerAId,
            expiresAt: 'bad-date',
            ownerId: ownerAId,
            tenantId: ownerAId,
          }),
        /malformed expiresAt/i
      );

      const badRsv = await store.reserveRefundExecution({
        ownerId: ownerAId,
        tenantId: ownerAId,
        requestId: req12.provenance.request_id,
        nonce: req12.provenance.nonce,
        orderId: req12.order_id,
        businessId: req12.business_id,
        amountCents: 1500,
        idempotencyKey: 'idem-bad-ts',
        canonicalDigest: 'digest-bad-ts',
        keyId: 'ephemeral-h3-key',
        expiresAt: '',
        nowIso: new Date(BASE_TIME + 1000).toISOString(),
        provenanceSnapshot: req12.provenance,
      });
      assert.equal(badRsv.status, 'MISSING_OR_MALFORMED_TIMESTAMP');

      pass(
        'Test 12: Missing, malformed, and inverted timestamps fail closed',
        'Rejected invalid provenance/approval timestamps in gate, recordOwnerApproval, and reserveRefundExecution'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 13: Legacy/tampered row with approval.expires_at > request.expires_at fails closed
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;
      const ing13 = await ingestViaApi('ORD-H3-14', 89, 0.92);
      const req13 = ing13.request!;
      const reqExpMs = Date.parse(req13.provenance.expires_at!);

      // Directly insert an inconsistent legacy/tampered owner_approvals row whose
      // expires_at exceeds parent request.expires_at by 10 minutes
      const tooLongExpiresIso = new Date(reqExpMs + 10 * 60 * 1000).toISOString();
      const createdIso = new Date(BASE_TIME + 60_000).toISOString();
      const inconsistentApr = await store.recordOwnerApproval({
        approvalId: 'apr-h3-exceeds-13',
        requestId: req13.provenance.request_id,
        orderId: req13.order_id,
        businessId: req13.business_id,
        amountCents: 8900,
        approvedByUserId: ownerAId,
        expiresAt: tooLongExpiresIso,
        nowIso: createdIso,
        status: 'approved',
        ownerId: ownerAId,
        tenantId: ownerAId,
      });

      nowMs = BASE_TIME + 2 * 60 * 1000; // Both still in future!
      const exec13 = await executeViaApi(req13, inconsistentApr);
      assert.equal(exec13.status, 403);
      assert.equal(exec13.json.status, 'REJECTED_SECURITY_VIOLATION');
      assert.equal(exec13.json.code, 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION');
      assert.equal(providerCalls, callsBefore);

      // Direct DB replayStore check as well
      const rsvExceeds = await store.reserveRefundExecution({
        ownerId: ownerAId,
        tenantId: ownerAId,
        requestId: req13.provenance.request_id,
        nonce: req13.provenance.nonce,
        orderId: req13.order_id,
        businessId: req13.business_id,
        approvalId: inconsistentApr.approval_id,
        requireOwnerApproval: true,
        amountCents: 8900,
        idempotencyKey: `idem-${req13.provenance.request_id}`,
        canonicalDigest: 'digest-13',
        keyId: 'ephemeral-h3-key',
        expiresAt: req13.provenance.expires_at!,
        nowIso: new Date(nowMs).toISOString(),
        provenanceSnapshot: req13.provenance,
      });
      assert.equal(rsvExceeds.status, 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION');

      pass(
        'Test 13: Inconsistent row with approval.expires_at > request.expires_at fails closed',
        'Rejected at HTTP executor & replayStore with APPROVAL_EXCEEDS_REQUEST_EXPIRATION (0 provider calls)'
      );
    }

    // -------------------------------------------------------------------------
    // TEST 14: Regressions (H1, H2, single-use, post-expiry idempotent replay, SQL 000009)
    // -------------------------------------------------------------------------
    {
      nowMs = BASE_TIME;
      const callsBefore = providerCalls;

      // (a) H1 regression: tampered confidence rejected
      const ing14 = await ingestViaApi('ORD-H3-SMALL', 15, 0.45);
      const req14 = ing14.request!;
      const h1Tamper = await executeViaApi({
        ...req14,
        provenance: { ...req14.provenance, confidence: 0.99 },
      });
      assert.equal(h1Tamper.status, 403);
      assert.equal(providerCalls, callsBefore);

      // (b) H2 regression: cross-tenant owner B cannot approve owner A request
      const crossApr = await approveViaApi(req14, {}, tokOwnerB);
      assert.equal(crossApr.status, 403);

      // (c) Execute ORD-H3-15 under owner approval, advance PAST request expiry, verify idempotent replay returns 200 IDEMPOTENT_RETURN without calling provider again!
      const ing15 = await ingestViaApi('ORD-H3-15', 89, 0.92);
      const req15 = ing15.request!;
      nowMs = BASE_TIME + 60_000;
      const apr15Res = await approveViaApi(req15);
      const apr15 = apr15Res.json.approval as AuthoritativeOwnerApprovalRecord;

      const exec15First = await executeViaApi(req15, apr15);
      assert.equal(exec15First.status, 200);
      assert.equal(exec15First.json.status, 'EXECUTED');
      assert.equal(providerCalls, callsBefore + 1);

      // Retry exact same request+idempotency_key 2 hours later (after both approval & request expired)
      nowMs = BASE_TIME + 120 * 60 * 1000;
      const exec15RetryAfterExpiry = await executeViaApi(req15, apr15);
      assert.equal(exec15RetryAfterExpiry.status, 200);
      assert.equal(exec15RetryAfterExpiry.json.status, 'IDEMPOTENT_RETURN');
      assert.equal(exec15RetryAfterExpiry.json.executionTxId, exec15First.json.executionTxId);
      assert.equal(providerCalls, callsBefore + 1);

      // (d) SQLite direct verify raw stored table has no invalid timestamps
      const rawDb = new DatabaseSync(dbPath);
      const row = rawDb
        .prepare('SELECT expires_at FROM authenticated_refund_requests WHERE request_id = ?')
        .get(req15.provenance.request_id) as { expires_at: string } | undefined;
      rawDb.close();
      assert.equal(row?.expires_at, req15.provenance.expires_at);

      // (e) Static SQL migration 000009 boundary & enforcement checks
      const m0009Sql = fs.readFileSync(
        path.resolve(process.cwd(), 'supabase/migrations/20261118000009_h3_expiration_consistency.sql'),
        'utf8'
      );
      const norm09 = m0009Sql.toLowerCase();
      assert(norm09.includes('v_effective_req_expires <= v_now'));
      assert(norm09.includes('v_approval.expires_at <= v_now'));
      assert(norm09.includes('v_approval.expires_at > v_effective_req_expires'));
      assert(norm09.includes("'refund_request_expired'"));
      assert(norm09.includes("'approval_exceeds_request_expiration'"));

      pass(
        'Test 14: H1/H2 regressions, post-expiry idempotent replay, & SQL 000009 consistency',
        'H1 confidence tampering blocked, H2 cross-tenant approval blocked, idempotent retry after 120m returned stored tx without re-executing provider, SQL 000009 boundary checks verified'
      );
    }

    // Direct executeAuthorizedFinanceRefund smoke check with caller identity
    nowMs = BASE_TIME;
    const directExecCheck = await executeAuthorizedFinanceRefund(
      ingestAuthenticatedRefundRequest(
        {
          business_id: 'biz-a',
          order_id: 'ORD-H3-16',
          customer_email: 'buyer@example.test',
          amount_usd: 89,
          reason: 'Direct executor test',
          source_agent: 'customer_support',
          trigger_type: 'customer_ticket',
          trigger_id: 'tkt-direct-16',
          raw_trigger_payload: '{"t":16}',
          confidence: 0.92,
          authority_level: 'execute_under_policy',
          now: new Date(nowMs),
          ttlMs: DEFAULT_PERSISTED_REQUEST_TTL_MS,
        },
        keyring
      ),
      {
        keyring,
        replayStore: store,
        orderStore,
        caller: callerOwnerA,
        paymentProvider,
        now: new Date(nowMs),
      }
    );
    assert.equal(directExecCheck.status, 'ESCALATED_TO_OWNER_APPROVAL');
  } finally {
    await server.close();
    store.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  }

  console.log(`\nSummary: ${results.length}/${results.length} H3 expiration consistency checks passed.`);
}

runTests().catch((err) => {
  console.error('H3 verification failed:', err);
  process.exit(1);
});
