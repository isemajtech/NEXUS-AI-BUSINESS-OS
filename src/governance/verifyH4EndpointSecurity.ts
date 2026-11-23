import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  createCommerceRouter,
  resolveApprovedAppOrigins,
  validateApprovedRedirectUrl,
  type GumroadAdapter,
  type StripeClientAdapter,
} from '../../server/commerceRoutes';
import {
  createAiFactoryRouter,
  ALLOWED_GEMINI_MODELS,
  type AiFactoryRouterDeps,
  type GeminiKeyInfo,
} from '../../server/aiFactoryRoutes';
import {
  createInMemoryAuthoritativeCommerceStore,
  createSupabaseAuthoritativeCommerceStoreFromEnv,
  type AuthoritativeProductRecord,
} from '../../server/commerceStore';
import {
  createInMemoryAuthoritativeOrderStore,
  type AuthoritativeBusinessRecord,
  type AuthoritativeOrderRecord,
} from '../../server/orderStore';
import {
  resolveCallerIdentity,
  type GovernanceAuthVerifier,
  type VerifiedGovernanceUser,
} from '../../server/governanceAuth';
import { SlidingFixedWindowRateLimiter } from '../../server/rateLimiter';
import { buildScopedCorsHeaders } from '../../supabase/functions/ai-assistant/index';

interface TestResult {
  name: string;
  detail: string;
}

async function startH4TestServer(opts: {
  authVerifier: GovernanceAuthVerifier;
  orderStore: ReturnType<typeof createInMemoryAuthoritativeOrderStore>;
  commerceStore: ReturnType<typeof createInMemoryAuthoritativeCommerceStore>;
  stripeFactory: (key: string) => StripeClientAdapter;
  gumroadAdapter: GumroadAdapter;
  getStripeSecretKey?: () => string | null;
  getGumroadWebhookSecret?: () => string | null;
  getGeminiKeyInfo?: () => GeminiKeyInfo | null;
  nowRef?: { current: Date };
  limiter?: SlidingFixedWindowRateLimiter;
  rateLimits?: AiFactoryRouterDeps['rateLimits'];
}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use(
    createAiFactoryRouter({
      getAuthVerifier: () => opts.authVerifier,
      getGeminiKeyInfo:
        opts.getGeminiKeyInfo ??
        (() => ({
          key: 'AIzaSyFakeTestServerKeyNotExposedToClients',
          source: 'GEMINI_API_KEY_2',
          masked: 'AIzaSy...ents',
        })),
      limiter: opts.limiter ?? new SlidingFixedWindowRateLimiter(),
      rateLimits: opts.rateLimits,
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: 'Executive Google Gemini link confirmed operational.' }] } },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as any,
      generateGeminiText: async ({ model, prompt }) => ({
        model,
        text: prompt.includes('ONLY valid JSON')
          ? JSON.stringify({
              name: 'Server Generated Digital Playbook',
              description: 'Authoritative server-generated product summary.',
              deliverableFormat: 'pdf_guide',
              deliverableContent: '# Server Playbook\n\nComplete operational guide for founders.',
            })
          : 'Executive directive processed via server Gemini adapter.',
      }),
    })
  );

  app.use(
    createCommerceRouter({
      getAuthVerifier: () => opts.authVerifier,
      getOrderStore: () => opts.orderStore,
      getCommerceStore: () => opts.commerceStore,
      getNow: () => opts.nowRef?.current ?? new Date('2026-11-18T12:00:00.000Z'),
      getStripeSecretKey: opts.getStripeSecretKey ?? (() => 'sk_test_h4_server_secret_mock'),
      getGumroadWebhookSecret:
        opts.getGumroadWebhookSecret ?? (() => 'gr_whsec_h4_server_secret_value'),
      getAllowedOrigins: () =>
        resolveApprovedAppOrigins({
          APP_URL: 'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app',
        }),
      stripeClientFactory: opts.stripeFactory,
      gumroadAdapter: opts.gumroadAdapter,
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

  // IDs & tokens
  const ownerAId = '11111111-1111-4111-8111-111111111111';
  const ownerBId = '22222222-2222-4222-8222-222222222222';
  const adminAId = '33333333-3333-4333-8333-333333333333';
  const financeAId = '44444444-4444-4444-8444-444444444444';
  const supportAId = '55555555-5555-4555-8555-555555555555';
  const buyerAId = '66666666-6666-4666-8666-666666666666';
  const noScopeAdminId = '77777777-7777-4777-8777-777777777777';

  const bizAId = 'aaaa1111-1111-4111-8111-111111111111';
  const bizBId = 'bbbb2222-2222-4222-8222-222222222222';
  const tenantA = 'tenant-alpha';
  const tenantB = 'tenant-beta';

  const prodADraftId = 'aaaa0001-0001-4001-8001-000000000001';
  const prodAPublishedId = 'aaaa0002-0002-4002-8002-000000000002';
  const prodBPublishedId = 'bbbb0001-0001-4001-8001-000000000001';

  const tokOwnerA = `tok-owner-a-${crypto.randomBytes(8).toString('hex')}`;
  const tokOwnerB = `tok-owner-b-${crypto.randomBytes(8).toString('hex')}`;
  const tokAdminA = `tok-admin-a-${crypto.randomBytes(8).toString('hex')}`;
  const tokFinanceA = `tok-finance-a-${crypto.randomBytes(8).toString('hex')}`;
  const tokSupportA = `tok-support-a-${crypto.randomBytes(8).toString('hex')}`;
  const tokBuyerA = `tok-buyer-a-${crypto.randomBytes(8).toString('hex')}`;
  const tokNoScopeAdmin = `tok-noscope-admin-${crypto.randomBytes(8).toString('hex')}`;
  const tokExpired = `tok-expired-${crypto.randomBytes(8).toString('hex')}`;

  const tokenMap = new Map<string, VerifiedGovernanceUser>([
    [
      tokOwnerA,
      {
        id: ownerAId,
        email: 'owner.a@alpha.test',
        appMetadata: { role: 'owner', tenant_id: tenantA },
      },
    ],
    [
      tokOwnerB,
      {
        id: ownerBId,
        email: 'owner.b@beta.test',
        appMetadata: { role: 'owner', tenant_id: tenantB },
      },
    ],
    [
      tokAdminA,
      {
        id: adminAId,
        email: 'admin.a@alpha.test',
        appMetadata: { role: 'admin', tenant_id: tenantA, owner_id: ownerAId },
      },
    ],
    [
      tokFinanceA,
      {
        id: financeAId,
        email: 'finance.a@alpha.test',
        appMetadata: { role: 'finance_operator', tenant_id: tenantA, owner_id: ownerAId },
      },
    ],
    [
      tokSupportA,
      {
        id: supportAId,
        email: 'support.a@alpha.test',
        appMetadata: { role: 'support_operator', tenant_id: tenantA, owner_id: ownerAId },
      },
    ],
    [
      tokBuyerA,
      {
        id: buyerAId,
        email: 'buyer.a@alpha.test',
        appMetadata: {
          role: 'support_operator',
          tenant_id: tenantA,
          owner_id: ownerAId,
          business_ids: [bizAId],
        },
      },
    ],
    [
      tokNoScopeAdmin,
      {
        id: noScopeAdminId,
        email: 'noscope@test.local',
        appMetadata: { role: 'admin' },
      },
    ],
  ]);

  const authVerifier: GovernanceAuthVerifier = {
    configured: true,
    ownerUserIds: new Set([ownerAId, ownerBId]),
    verifyAccessToken: async (token: string) => tokenMap.get(token) ?? null,
  };

  const businesses: AuthoritativeBusinessRecord[] = [
    {
      businessId: bizAId,
      businessRecordId: bizAId,
      slug: 'alpha-venture',
      ownerId: ownerAId,
      tenantId: tenantA,
      status: 'active',
    },
    {
      businessId: bizBId,
      businessRecordId: bizBId,
      slug: 'beta-venture',
      ownerId: ownerBId,
      tenantId: tenantB,
      status: 'active',
    },
  ];

  const memberships = [
    { businessId: bizAId, userId: ownerAId, role: 'owner' as const, status: 'active' as const, tenantId: tenantA },
    { businessId: bizAId, userId: adminAId, role: 'admin' as const, status: 'active' as const, tenantId: tenantA },
    { businessId: bizAId, userId: financeAId, role: 'finance_operator' as const, status: 'active' as const, tenantId: tenantA },
    { businessId: bizAId, userId: supportAId, role: 'support_operator' as const, status: 'active' as const, tenantId: tenantA },
    { businessId: bizAId, userId: buyerAId, role: 'support_operator' as const, status: 'active' as const, tenantId: tenantA },
    { businessId: bizBId, userId: ownerBId, role: 'owner' as const, status: 'active' as const, tenantId: tenantB },
  ];

  const initialOrders: AuthoritativeOrderRecord[] = [];
  const orderStore = createInMemoryAuthoritativeOrderStore({
    businesses,
    memberships,
    orders: initialOrders,
  });

  const seededProducts: AuthoritativeProductRecord[] = [
    {
      productId: prodADraftId,
      businessId: bizAId,
      businessRecordId: bizAId,
      ownerId: ownerAId,
      tenantId: tenantA,
      name: 'Alpha AI Security Audit Kit',
      slug: 'alpha-audit-kit',
      description: 'Draft product awaiting owner publish approval.',
      type: 'digital_download',
      priceCents: 4900,
      currency: 'USD',
      billingType: 'one_time',
      status: 'draft',
    },
    {
      productId: prodAPublishedId,
      businessId: bizAId,
      businessRecordId: bizAId,
      ownerId: ownerAId,
      tenantId: tenantA,
      name: 'Alpha Sovereign Playbook',
      slug: 'alpha-sovereign-playbook',
      description: 'Published Alpha product.',
      type: 'digital_download',
      priceCents: 7900,
      currency: 'USD',
      billingType: 'one_time',
      status: 'published',
      gumroadProductId: 'gr_prod_alpha_1',
      gumroadUrl: 'https://gumroad.com/l/alpha-sovereign-playbook',
      publishedApprovalId: 'pubappr_seed_alpha',
    },
    {
      productId: prodBPublishedId,
      businessId: bizBId,
      businessRecordId: bizBId,
      ownerId: ownerBId,
      tenantId: tenantB,
      name: 'Beta Secret Enterprise Suite',
      slug: 'beta-secret-suite',
      description: 'Published Beta tenant product.',
      type: 'saas',
      priceCents: 19900,
      currency: 'USD',
      billingType: 'monthly',
      status: 'published',
      gumroadProductId: 'gr_prod_beta_1',
      gumroadUrl: 'https://gumroad.com/l/beta-secret-suite',
      publishedApprovalId: 'pubappr_seed_beta',
    },
  ];

  const commerceStore = createInMemoryAuthoritativeCommerceStore({
    products: seededProducts,
    publishApprovals: [
      {
        approvalId: 'pubappr_expired_alpha',
        productId: prodADraftId,
        businessId: bizAId,
        ownerId: ownerAId,
        tenantId: tenantA,
        approvedByUserId: ownerAId,
        status: 'approved',
        decisionNote: 'Already expired approval',
        expiresAt: '2026-11-18T11:00:00.000Z',
        createdAt: '2026-11-18T10:45:00.000Z',
      },
      {
        approvalId: 'pubappr_revoked_alpha',
        productId: prodADraftId,
        businessId: bizAId,
        ownerId: ownerAId,
        tenantId: tenantA,
        approvedByUserId: ownerAId,
        status: 'revoked',
        decisionNote: 'Revoked by owner',
        expiresAt: '2026-11-18T13:00:00.000Z',
        createdAt: '2026-11-18T11:50:00.000Z',
      },
    ],
  });

  // Track Stripe adapter calls & allow dynamic session behaviors
  const stripeCreateCalls: Array<Parameters<StripeClientAdapter['createCheckoutSession']>[0]> = [];
  let stripeRetrieveCallCount = 0;
  const mockStripeSessions = new Map<string, {
    id: string;
    payment_status: string;
    amount_total: number;
    currency: string;
    payment_intent: string;
    metadata: Record<string, string>;
    customer_details: { email: string; name: string };
  }>();

  const stripeFactory = (_secretKey: string): StripeClientAdapter => ({
    createCheckoutSession: async (params) => {
      stripeCreateCalls.push(params);
      const id = `cs_test_${crypto.randomBytes(8).toString('hex')}`;
      mockStripeSessions.set(id, {
        id,
        payment_status: 'paid',
        amount_total: params.unitAmountCents,
        currency: params.currency.toLowerCase(),
        payment_intent: `pi_test_${crypto.randomBytes(6).toString('hex')}`,
        metadata: params.metadata,
        customer_details: {
          email: 'alpha-buyer@alpha.test',
          name: 'Alpha Verified Buyer',
        },
      });
      return { id, url: `https://checkout.stripe.com/pay/${id}` };
    },
    retrieveCheckoutSession: async (sessionId) => {
      stripeRetrieveCallCount += 1;
      const found = mockStripeSessions.get(sessionId);
      if (!found) {
        return {
          id: sessionId,
          payment_status: 'unpaid',
          amount_total: 0,
          currency: 'usd',
          metadata: {},
          customer_details: null,
        };
      }
      return found;
    },
  });

  const gumroadPublishCalls: Array<{ name: string; priceDollars: number }> = [];
  const gumroadAdapter: GumroadAdapter = {
    getStatus: async () => ({
      configured: true,
      hasAccessToken: true,
      hasWebhookSecret: true,
      verified: true,
    }),
    publishProduct: async (input) => {
      gumroadPublishCalls.push({ name: input.name, priceDollars: input.priceDollars });
      return {
        success: true,
        gumroadProductId: `gr_prod_created_${gumroadPublishCalls.length}`,
        gumroadUrl: `https://gumroad.com/l/${input.slug || 'product'}`,
        name: input.name,
        priceDollars: input.priceDollars,
        published: true,
        action: 'created',
      };
    },
    fetchSales: async () => ({
      success: true,
      sales: [
        {
          saleId: 'sale_alpha_1',
          gumroadProductId: 'gr_prod_alpha_1',
          productName: 'Alpha Sovereign Playbook',
          buyerName: 'Alice Alpha',
          buyerEmail: 'alice.pii@alpha-customer.test',
          amountDollars: 79,
          currency: 'USD',
          refunded: false,
          createdAt: '2026-11-18T11:30:00.000Z',
          source: 'api',
        },
        {
          saleId: 'sale_beta_secret',
          gumroadProductId: 'gr_prod_beta_1',
          productName: 'Beta Secret Enterprise Suite',
          buyerName: 'Bob Beta Secret PII',
          buyerEmail: 'bob.secret.pii@beta-enterprise.test',
          amountDollars: 199,
          currency: 'USD',
          refunded: false,
          createdAt: '2026-11-18T11:35:00.000Z',
          source: 'api',
        },
      ],
    }),
    fetchProducts: async () => ({
      success: true,
      products: [
        {
          gumroadProductId: 'gr_prod_alpha_1',
          gumroadUrl: 'https://gumroad.com/l/alpha-sovereign-playbook',
          name: 'Alpha Sovereign Playbook',
          description: 'Published Alpha product',
          priceCents: 7900,
          priceDollars: 79,
          currency: 'USD',
          published: true,
          salesCount: 1,
          salesUsdCents: 7900,
          revenueDollars: 79,
          viewCount: null,
        },
        {
          gumroadProductId: 'gr_prod_beta_1',
          gumroadUrl: 'https://gumroad.com/l/beta-secret-suite',
          name: 'Beta Secret Enterprise Suite',
          description: 'Published Beta product',
          priceCents: 19900,
          priceDollars: 199,
          currency: 'USD',
          published: true,
          salesCount: 9,
          salesUsdCents: 179100,
          revenueDollars: 1791,
          viewCount: null,
        },
      ],
    }),
  };

  const nowRef = { current: new Date('2026-11-18T12:00:00.000Z') };
  const srv = await startH4TestServer({
    authVerifier,
    orderStore,
    commerceStore,
    stripeFactory,
    gumroadAdapter,
    nowRef,
    rateLimits: {
      testGemini: { bucket: 'ai:test-gemini', windowMs: 60_000, maxRequests: 2 },
      coordinator: { bucket: 'ai:coordinator', windowMs: 60_000, maxRequests: 2 },
      generateProduct: { bucket: 'ai:generate-product', windowMs: 60_000, maxRequests: 2 },
      factory: { bucket: 'factory:assets', windowMs: 60_000, maxRequests: 2 },
    },
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Anonymous & Invalid/Expired Token Rejection across ALL protected routes
    // -------------------------------------------------------------------------
    const protectedRequests: Array<{ method: string; path: string; body?: any }> = [
      { method: 'GET', path: '/api/gumroad/status' },
      { method: 'POST', path: '/api/commerce/publish-approvals', body: { productId: prodADraftId } },
      { method: 'POST', path: '/api/gumroad/publish', body: { productId: prodADraftId, approvalId: 'x' } },
      { method: 'GET', path: '/api/gumroad/sales' },
      { method: 'GET', path: '/api/gumroad/products' },
      { method: 'GET', path: '/api/stripe/status' },
      { method: 'POST', path: '/api/create-checkout-session', body: { productId: prodAPublishedId } },
      { method: 'GET', path: '/api/verify-session?session_id=cs_test_1234567890' },
      { method: 'GET', path: '/api/ai/test-gemini' },
      { method: 'POST', path: '/api/ai/coordinator', body: { message: 'hello' } },
      { method: 'POST', path: '/api/ai/generate-product', body: { topic: 'Security Guide' } },
      { method: 'POST', path: '/api/factory/build-pdf', body: { title: 'Guide' } },
      { method: 'POST', path: '/api/factory/generate-cover', body: { title: 'Guide' } },
      { method: 'POST', path: '/api/factory/research', body: { topic: 'Guide' } },
      { method: 'POST', path: '/api/factory/launch-kit', body: { title: 'Guide' } },
    ];

    for (const ep of protectedRequests) {
      const anonResp = await fetch(`${srv.baseUrl}${ep.path}`, {
        method: ep.method,
        headers: ep.body ? { 'Content-Type': 'application/json' } : undefined,
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(anonResp.status, 401, `Anonymous ${ep.method} ${ep.path} must return 401`);

      const badTokResp = await fetch(`${srv.baseUrl}${ep.path}`, {
        method: ep.method,
        headers: {
          Authorization: `Bearer ${tokExpired}`,
          ...(ep.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: ep.body ? JSON.stringify(ep.body) : undefined,
      });
      assert.equal(badTokResp.status, 401, `Invalid/expired ${ep.method} ${ep.path} must return 401`);
    }
    pass(
      'H4-F.1 & F.2: Fail-closed auth on all commerce/AI/factory endpoints',
      `All ${protectedRequests.length} endpoints rejected anonymous and invalid/expired Bearer tokens with HTTP 401`
    );

    // Fail-closed 503 when auth verifier is unconfigured (never bypasses)
    const unconfiguredSrv = await startH4TestServer({
      authVerifier: { configured: false, ownerUserIds: new Set(), reason: 'Missing SUPABASE_URL' },
      orderStore,
      commerceStore,
      stripeFactory,
      gumroadAdapter,
    });
    try {
      const r1 = await fetch(`${unconfiguredSrv.baseUrl}/api/create-checkout-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: prodAPublishedId }),
      });
      assert.equal(r1.status, 503);
      const r2 = await fetch(`${unconfiguredSrv.baseUrl}/api/ai/coordinator`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      });
      assert.equal(r2.status, 503);
      pass(
        'H4 Fail-Closed Auth Config',
        'Missing server auth configuration returns 503 instead of bypassing auth'
      );
    } finally {
      await unconfiguredSrv.close();
    }

    // -------------------------------------------------------------------------
    // 2. Gumroad Publish Security (H4-A / F.3 / F.4 / F.5)
    // -------------------------------------------------------------------------
    // Non-owner roles cannot approve or publish
    for (const [label, tok] of [
      ['admin', tokAdminA],
      ['finance_operator', tokFinanceA],
      ['support_operator', tokSupportA],
      ['cross-tenant owner B', tokOwnerB],
    ]) {
      const apprAttempt = await fetch(`${srv.baseUrl}/api/commerce/publish-approvals`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: prodADraftId }),
      });
      assert.equal(apprAttempt.status, 403, `${label} publish approval must be denied 403`);

      const pubAttempt = await fetch(`${srv.baseUrl}/api/gumroad/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: prodADraftId, approvalId: 'pubappr_any' }),
      });
      assert.equal(pubAttempt.status, 403, `${label} Gumroad publish must be denied 403`);
    }

    // Forged client-side approval/status/price overrides rejected outright
    const forgedResp = await fetch(`${srv.baseUrl}/api/gumroad/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: prodADraftId,
        ownerApproved: true,
        productStatus: 'published',
        priceDollars: 0.01,
      }),
    });
    assert.equal(forgedResp.status, 403);
    const forgedJson = await forgedResp.json();
    assert.equal(forgedJson.code, 'CLIENT_APPROVAL_CLAIMS_FORBIDDEN');

    // Missing, expired, and revoked publish approvals rejected
    for (const badApprId of ['nonexistent', 'pubappr_expired_alpha', 'pubappr_revoked_alpha']) {
      const r = await fetch(`${srv.baseUrl}/api/gumroad/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: prodADraftId, approvalId: badApprId }),
      });
      assert.equal(r.status, 403, `Approval "${badApprId}" must fail 403`);
    }

    // Legitimate Owner A creates server publish approval and publishes using server product price ($49.00)
    const createApprResp = await fetch(`${srv.baseUrl}/api/commerce/publish-approvals`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodADraftId, decisionNote: 'Owner verified release' }),
    });
    assert.equal(createApprResp.status, 201);
    const createdApprData = await createApprResp.json();
    const validApprovalId = createdApprData.approval.approvalId;

    // Cross-tenant Owner B cannot consume Owner A's valid approvalId
    const crossConsume = await fetch(`${srv.baseUrl}/api/gumroad/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodADraftId, approvalId: validApprovalId }),
    });
    assert.equal(crossConsume.status, 403);

    const publishOkResp = await fetch(`${srv.baseUrl}/api/gumroad/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodADraftId, approvalId: validApprovalId }),
    });
    assert.equal(publishOkResp.status, 200);
    const publishOkJson = await publishOkResp.json();
    assert.equal(publishOkJson.success, true);
    assert.equal(gumroadPublishCalls.length, 1);
    assert.equal(gumroadPublishCalls[0].priceDollars, 49);
    assert.equal(gumroadPublishCalls[0].name, 'Alpha AI Security Audit Kit');

    // Replay of consumed approvalId must be rejected
    const replayPublish = await fetch(`${srv.baseUrl}/api/gumroad/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodADraftId, approvalId: validApprovalId }),
    });
    assert.equal(replayPublish.status, 403);
    pass(
      'H4-A / F.3 / F.4 / F.5: Gumroad publish authorization & approval binding',
      'Blocked non-owners, cross-tenant owners, forged client claims, expired/revoked approvals, and consumed approval replay'
    );

    // -------------------------------------------------------------------------
    // 3. Cross-Tenant Gumroad Sales & Product Isolation (H4-A / F.9)
    // -------------------------------------------------------------------------
    const noScopeSales = await fetch(`${srv.baseUrl}/api/gumroad/sales`, {
      headers: { Authorization: `Bearer ${tokNoScopeAdmin}` },
    });
    assert.equal(noScopeSales.status, 403);

    const alphaSalesResp = await fetch(`${srv.baseUrl}/api/gumroad/sales`, {
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(alphaSalesResp.status, 200);
    const alphaSalesJson = await alphaSalesResp.json();
    assert.equal(alphaSalesJson.sales.length, 1);
    assert.equal(alphaSalesJson.sales[0].gumroadProductId, 'gr_prod_alpha_1');
    assert.ok(!JSON.stringify(alphaSalesJson).includes('bob.secret.pii@beta-enterprise.test'));

    // Explicit cross-business query rejected
    const crossBizSales = await fetch(`${srv.baseUrl}/api/gumroad/sales?business_id=${bizBId}`, {
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(crossBizSales.status, 403);

    const alphaProductsResp = await fetch(`${srv.baseUrl}/api/gumroad/products`, {
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(alphaProductsResp.status, 200);
    const alphaProductsJson = await alphaProductsResp.json();
    assert.equal(alphaProductsJson.products.length, 1);
    assert.equal(alphaProductsJson.products[0].gumroadProductId, 'gr_prod_alpha_1');
    pass(
      'H4-A / F.9: Gumroad sales & products tenant/business scoping',
      'Zero cross-tenant buyer PII or remote products leaked across business boundaries'
    );

    // -------------------------------------------------------------------------
    // 4. Stripe Checkout Integrity & Redirect Validation (H4-B / F.6 / F.7)
    // -------------------------------------------------------------------------
    // Client price / priceId / currency manipulation rejected
    for (const badBody of [
      { productId: prodAPublishedId, priceAmount: 0.5 },
      { productId: prodAPublishedId, priceId: 'price_tampered_123' },
      { productId: prodAPublishedId, amountCents: 100 },
      { productId: prodAPublishedId, currency: 'EUR' },
    ]) {
      const r = await fetch(`${srv.baseUrl}/api/create-checkout-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokBuyerA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(badBody),
      });
      assert.equal(r.status, 400);
      const j = await r.json();
      assert.equal(j.code, 'CLIENT_PRICE_OVERRIDE_FORBIDDEN');
    }

    // Unsafe/off-origin redirect URLs rejected
    for (const badUrl of [
      'https://attacker-phishing.example/steal-session',
      'http://evil.local:3000/redirect',
      'javascript:alert(1)',
      '//evil.example/protocol-relative',
      'https://user:pass@ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app/success',
    ]) {
      const r = await fetch(`${srv.baseUrl}/api/create-checkout-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokBuyerA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: prodAPublishedId, successUrl: badUrl }),
      });
      assert.equal(r.status, 400, `Redirect "${badUrl}" must fail 400`);
      const j = await r.json();
      assert.equal(j.code, 'INVALID_REDIRECT_URL');
    }

    // Also unit-check redirect validator helper directly
    assert.equal(
      validateApprovedRedirectUrl(
        'https://ais-pre-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app/success?session_id={CHECKOUT_SESSION_ID}',
        resolveApprovedAppOrigins()
      ).valid,
      true
    );

    // Cross-tenant checkout attempt on Beta's product denied 403
    const crossCheckout = await fetch(`${srv.baseUrl}/api/create-checkout-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokBuyerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodBPublishedId }),
    });
    assert.equal(crossCheckout.status, 403);

    // Legitimate checkout derives unitAmountCents=7900 from server product record
    const okCheckoutResp = await fetch(`${srv.baseUrl}/api/create-checkout-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokBuyerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: prodAPublishedId,
        successUrl:
          'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app/success?session_id={CHECKOUT_SESSION_ID}',
        cancelUrl:
          'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app/?cancelled=1',
      }),
    });
    assert.equal(okCheckoutResp.status, 200);
    const okCheckoutJson = await okCheckoutResp.json();
    assert.equal(okCheckoutJson.amountCents, 7900);
    assert.equal(stripeCreateCalls.at(-1)?.unitAmountCents, 7900);
    assert.equal(stripeCreateCalls.at(-1)?.metadata.userId, buyerAId);
    assert.equal(stripeCreateCalls.at(-1)?.metadata.businessId, bizAId);
    const alphaSessionId = okCheckoutJson.sessionId;
    pass(
      'H4-B / F.6 / F.7: Stripe server-authoritative pricing & redirect allowlist',
      'Rejected price/currency overrides and off-origin redirects; bound Stripe session strictly to 7900 cents & caller userId'
    );

    // -------------------------------------------------------------------------
    // 5. Stripe /api/verify-session Enumeration & Cross-Tenant/User Protection (H4-B / F.8 / F.9)
    // -------------------------------------------------------------------------
    const callsBeforeUnknown = stripeRetrieveCallCount;
    const unknownVerify = await fetch(
      `${srv.baseUrl}/api/verify-session?session_id=cs_test_unknown_session_999`,
      { headers: { Authorization: `Bearer ${tokOwnerA}` } }
    );
    assert.equal(unknownVerify.status, 404);
    assert.equal(
      stripeRetrieveCallCount,
      callsBeforeUnknown,
      'Must NOT query Stripe API for unknown/unbound session IDs'
    );

    // Owner B (cross-tenant) cannot verify Alpha's session
    const crossVerifyB = await fetch(
      `${srv.baseUrl}/api/verify-session?session_id=${alphaSessionId}`,
      { headers: { Authorization: `Bearer ${tokOwnerB}` } }
    );
    assert.equal(crossVerifyB.status, 403);

    // Support operator in same business who is NOT the session creator cannot verify another user's session
    const otherUserSameBizVerify = await fetch(
      `${srv.baseUrl}/api/verify-session?session_id=${alphaSessionId}`,
      { headers: { Authorization: `Bearer ${tokSupportA}` } }
    );
    assert.equal(otherUserSameBizVerify.status, 403);

    // Amount mismatch tampering in Stripe response detected (409)
    const tamperedSessionId = `cs_test_${crypto.randomBytes(8).toString('hex')}`;
    await commerceStore.createCheckoutSessionRecord({
      sessionId: tamperedSessionId,
      orderId: commerceStore.reserveOrderId(),
      orderNumber: 'ORD-TAMPER-1',
      createdByUserId: buyerAId,
      ownerId: ownerAId,
      tenantId: tenantA,
      businessId: bizAId,
      productId: prodAPublishedId,
      expectedAmountCents: 7900,
      currency: 'USD',
      billingType: 'one_time',
      nowIso: nowRef.current.toISOString(),
    });
    mockStripeSessions.set(tamperedSessionId, {
      id: tamperedSessionId,
      payment_status: 'paid',
      amount_total: 100, // tampered! expected 7900
      currency: 'usd',
      payment_intent: 'pi_tampered',
      metadata: {
        businessId: bizAId,
        productId: prodAPublishedId,
        userId: buyerAId,
      },
      customer_details: { email: 'tamper@test.local', name: 'Tamper' },
    });
    const tamperVerify = await fetch(
      `${srv.baseUrl}/api/verify-session?session_id=${tamperedSessionId}`,
      { headers: { Authorization: `Bearer ${tokBuyerA}` } }
    );
    assert.equal(tamperVerify.status, 409);
    assert.equal((await tamperVerify.json()).code, 'PAYMENT_AMOUNT_MISMATCH');

    // Legitimate creator verification succeeds
    const okVerify = await fetch(
      `${srv.baseUrl}/api/verify-session?session_id=${alphaSessionId}`,
      { headers: { Authorization: `Bearer ${tokBuyerA}` } }
    );
    assert.equal(okVerify.status, 200);
    const okVerifyJson = await okVerify.json();
    assert.equal(okVerifyJson.paymentStatus, 'paid');
    assert.equal(okVerifyJson.amountTotal, 79);
    pass(
      'H4-B / F.8 / F.9: /api/verify-session authorization & settlement integrity',
      'Blocked unauthenticated/cross-tenant/cross-user verification, prevented Stripe session enumeration, and caught amount tampering'
    );

    // -------------------------------------------------------------------------
    // 6. Gumroad Webhook Fail-Closed Secret & Validation (H4-C / F.10)
    // -------------------------------------------------------------------------
    const validWebhookPayload = {
      sale_id: 'gr_sale_verified_1',
      product_id: 'gr_prod_alpha_1',
      product_name: 'Alpha Sovereign Playbook',
      full_name: 'Verified Buyer',
      email: 'verified.buyer@example.com',
      price: 7900,
      currency: 'USD',
      refunded: false,
      sale_timestamp: '2026-11-18T11:59:00.000Z',
    };

    // Query-string secret rejected outright even if matching
    const querySecretResp = await fetch(
      `${srv.baseUrl}/api/gumroad/webhook?secret=gr_whsec_h4_server_secret_value`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validWebhookPayload),
      }
    );
    assert.equal(querySecretResp.status, 401);

    // Missing or invalid header secret rejected
    const missingSecretResp = await fetch(`${srv.baseUrl}/api/gumroad/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validWebhookPayload),
    });
    assert.equal(missingSecretResp.status, 401);

    const wrongSecretResp = await fetch(`${srv.baseUrl}/api/gumroad/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gumroad-secret': 'wrong_secret_value',
      },
      body: JSON.stringify(validWebhookPayload),
    });
    assert.equal(wrongSecretResp.status, 401);

    // Unconfigured webhook secret fails closed with 503
    const noWebhookSecretSrv = await startH4TestServer({
      authVerifier,
      orderStore,
      commerceStore,
      stripeFactory,
      gumroadAdapter,
      getGumroadWebhookSecret: () => null,
    });
    try {
      const failClosedWh = await fetch(`${noWebhookSecretSrv.baseUrl}/api/gumroad/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gumroad-secret': 'anything',
        },
        body: JSON.stringify(validWebhookPayload),
      });
      assert.equal(failClosedWh.status, 503);
    } finally {
      await noWebhookSecretSrv.close();
    }

    // Valid header secret + malformed payload rejected 400
    const malformedWh = await fetch(`${srv.baseUrl}/api/gumroad/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gumroad-secret': 'gr_whsec_h4_server_secret_value',
      },
      body: JSON.stringify({ ...validWebhookPayload, email: 'not-an-email' }),
    });
    assert.equal(malformedWh.status, 400);

    // Valid header secret + valid payload accepted and persisted
    const validWh = await fetch(`${srv.baseUrl}/api/gumroad/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gumroad-secret': 'gr_whsec_h4_server_secret_value',
      },
      body: JSON.stringify(validWebhookPayload),
    });
    assert.equal(validWh.status, 200);
    const storedWhSales = await commerceStore.listGumroadWebhookSalesForProducts(['gr_prod_alpha_1']);
    assert.equal(storedWhSales.length, 1);
    assert.equal(storedWhSales[0].saleId, 'gr_sale_verified_1');
    pass(
      'H4-C / F.10: Gumroad webhook timing-safe header auth & validation',
      'Rejected query secrets, missing/invalid secrets, unconfigured secret (503), and malformed payloads'
    );

    // -------------------------------------------------------------------------
    // 7. AI & Factory Hardening: Rate Limit, Model Allowlist, No Key Leaks (H4-D / F.11)
    // -------------------------------------------------------------------------
    // Non-admin blocked from /api/ai/test-gemini (403)
    const nonAdminTestGem = await fetch(`${srv.baseUrl}/api/ai/test-gemini`, {
      headers: { Authorization: `Bearer ${tokFinanceA}` },
    });
    assert.equal(nonAdminTestGem.status, 403);

    // Client key override rejected (400)
    const keyOverrideResp = await fetch(`${srv.baseUrl}/api/ai/test-gemini?key=AIzaInjected`, {
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(keyOverrideResp.status, 400);

    // Disallowed model name rejected (400)
    const badModelResp = await fetch(
      `${srv.baseUrl}/api/ai/test-gemini?model=gemini-evil-custom-model`,
      { headers: { Authorization: `Bearer ${tokOwnerA}` } }
    );
    assert.equal(badModelResp.status, 400);

    const badCoordModel = await fetch(`${srv.baseUrl}/api/ai/coordinator`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', model: 'unapproved-model' }),
    });
    assert.equal(badCoordModel.status, 400);

    // Verify /api/health and /api/ai/test-gemini NEVER leak keySource, maskedKey, or env var names
    const healthResp = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthResp.status, 200);
    const healthText = await healthResp.text();
    for (const forbidden of ['keySource', 'maskedKey', 'GEMINI_API_KEY', 'availableEnvVars', 'AIza']) {
      assert.ok(!healthText.includes(forbidden), `/api/health must not expose ${forbidden}`);
    }

    const adminTestGem1 = await fetch(`${srv.baseUrl}/api/ai/test-gemini`, {
      headers: { Authorization: `Bearer ${tokAdminA}` },
    });
    assert.equal(adminTestGem1.status, 200);
    const adminTestGemText = await adminTestGem1.text();
    for (const forbidden of ['keySource', 'maskedKey', 'GEMINI_API_KEY', 'availableEnvVars', 'AIza']) {
      assert.ok(
        !adminTestGemText.includes(forbidden),
        `/api/ai/test-gemini must not expose ${forbidden}`
      );
    }

    // Also verify tokOwnerA's 3rd /api/ai/test-gemini request hits 429 rate limit
    const testGemRateLimited = await fetch(`${srv.baseUrl}/api/ai/test-gemini`, {
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(testGemRateLimited.status, 429);

    // Rate limiting enforcement (maxRequests: 2 in test config)
    const coord1 = await fetch(`${srv.baseUrl}/api/ai/coordinator`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokSupportA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Summarize portfolio', model: Array.from(ALLOWED_GEMINI_MODELS)[0] }),
    });
    assert.equal(coord1.status, 200);
    const coord2 = await fetch(`${srv.baseUrl}/api/ai/coordinator`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokSupportA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Summarize marketing' }),
    });
    assert.equal(coord2.status, 200);
    const coord3 = await fetch(`${srv.baseUrl}/api/ai/coordinator`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokSupportA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Burst request 3' }),
    });
    assert.equal(coord3.status, 429);
    assert.ok(coord3.headers.get('retry-after'), '429 must include Retry-After header');

    // Factory PDF size limit (> 120,000 chars rejected 413)
    const hugePdfResp = await fetch(`${srv.baseUrl}/api/factory/build-pdf`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Oversized Guide',
        deliverableContent: 'X'.repeat(120_005),
      }),
    });
    assert.equal(hugePdfResp.status, 413);
    pass(
      'H4-D / F.11: AI & Factory auth, rate limiting, model allowlist, size limits & zero key leaks',
      'Enforced RBAC, 429 rate limits, model allowlist, payload bounds, and removed key metadata exposure'
    );

    // -------------------------------------------------------------------------
    // 8. Edge Function Hardening & Fail-Closed Store Checks (H4-E)
    // -------------------------------------------------------------------------
    const evilCors = buildScopedCorsHeaders('https://evil-attacker.example');
    assert.equal(evilCors.allowed, false);
    assert.equal(evilCors.headers['Access-Control-Allow-Origin'], undefined);

    const devOriginCors = buildScopedCorsHeaders(
      'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app'
    );
    assert.equal(devOriginCors.allowed, true);
    assert.equal(
      devOriginCors.headers['Access-Control-Allow-Origin'],
      'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app'
    );
    assert.equal(devOriginCors.headers.Vary, 'Origin');

    const configToml = fs.readFileSync(path.resolve('supabase/config.toml'), 'utf8');
    const aiFnSection = configToml.match(/\[functions\.ai-assistant\][\s\S]*?(?=\n\[|$)/)?.[0] || '';
    assert.ok(
      /verify_jwt\s*=\s*true/.test(aiFnSection),
      'supabase/config.toml [functions.ai-assistant] must enforce verify_jwt = true'
    );

    const edgeFnCode = fs.readFileSync(path.resolve('supabase/functions/ai-assistant/index.ts'), 'utf8');
    assert.ok(!edgeFnCode.includes("'Access-Control-Allow-Origin': '*'"), 'No wildcard CORS in edge function');
    assert.ok(!edgeFnCode.includes('keySource'), 'No keySource exposure in edge function');
    assert.ok(!edgeFnCode.includes('maskedKey'), 'No maskedKey exposure in edge function');

    const unconfiguredCommerceStore = createSupabaseAuthoritativeCommerceStoreFromEnv({});
    assert.equal(unconfiguredCommerceStore.configured, false);

    // Verify user_metadata is ignored by resolveCallerIdentity
    const spoofedCaller = resolveCallerIdentity(
      {
        id: '88888888-8888-4888-8888-888888888888',
        appMetadata: { role: 'support_operator', tenant_id: tenantA, owner_id: ownerAId },
      },
      new Set()
    );
    assert.equal(spoofedCaller.permissions.includes('commerce:gumroad:publish'), false);
    pass(
      'H4-E: Edge Function CORS/JWT hardening & fail-closed commerce store verification',
      'Confirmed verify_jwt=true, scoped CORS allowlist, zero key leaks, and fail-closed Supabase commerce store'
    );

    // -------------------------------------------------------------------------
    // 9. Verify H4 SQL migration + rollback invariants statically
    // -------------------------------------------------------------------------
    const migSql = fs.readFileSync(
      path.resolve('supabase/migrations/20261118000010_h4_endpoint_security_and_authoritative_commerce.sql'),
      'utf8'
    ).toLowerCase();
    const rbSql = fs.readFileSync(
      path.resolve('supabase/migrations/20261118000010_h4_endpoint_security_and_authoritative_commerce_rollback.sql'),
      'utf8'
    ).toLowerCase();
    assert.ok(migSql.includes('create table if not exists public.product_publish_approvals'));
    assert.ok(migSql.includes('create table if not exists public.stripe_checkout_sessions'));
    assert.ok(migSql.includes('create table if not exists public.gumroad_webhook_events'));
    assert.ok(migSql.includes('trg_guard_products_authoritative_fields'));
    assert.ok(rbSql.includes('drop trigger if exists trg_guard_products_authoritative_fields'));
    pass(
      'H4 SQL Migration & Rollback Integrity',
      'Verified product_publish_approvals, stripe_checkout_sessions, gumroad_webhook_events, and product authority trigger'
    );
  } finally {
    await srv.close();
  }

  console.log(`\nALL H4 ENDPOINT SECURITY TESTS PASSED (${results.length}/${results.length})`);
}

runTests().catch((err) => {
  console.error('H4 verification failed:', err);
  process.exit(1);
});
