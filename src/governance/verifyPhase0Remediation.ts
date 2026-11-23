import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import {
  createCommerceRouter,
  resolveApprovedAppOrigins,
  type GumroadAdapter,
  type StripeClientAdapter,
} from '../../server/commerceRoutes';
import {
  createAiFactoryRouter,
  type GeminiKeyInfo,
} from '../../server/aiFactoryRoutes';
import {
  createGovernanceRouter,
} from '../../server/governanceRoutes';
import {
  createInMemoryAuthoritativeCommerceStore,
} from '../../server/commerceStore';
import {
  createInMemoryAuthoritativeOrderStore,
  type AuthoritativeBusinessRecord,
  type AuthoritativeOrderRecord,
} from '../../server/orderStore';
import { createServerPaymentRefundProvider } from '../../server/paymentProvider';
import {
  SlidingFixedWindowRateLimiter,
  SupabasePostgresRateLimiter,
} from '../../server/rateLimiter';
import { SqlitePersistentReplayStore } from '../../server/replayStore';
import {
  type GovernanceAuthVerifier,
  type VerifiedGovernanceUser,
} from '../../server/governanceAuth';
import { buildScopedCorsHeaders } from '../../supabase/functions/ai-assistant/index';

interface TestResult {
  name: string;
  detail: string;
}

async function runTests() {
  const results: TestResult[] = [];
  const pass = (name: string, detail: string) => {
    results.push({ name, detail });
    console.log(`[PASS] ${name} -> ${detail}`);
  };

  // =========================================================================
  // 1. C1: Production runtime configuration checks
  // =========================================================================
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.ok(!pkg.dependencies?.tsx, 'tsx should not remain in production dependencies');
  assert.ok(pkg.devDependencies?.tsx, 'tsx should be in devDependencies');
  assert.ok(
    String(pkg.scripts?.build || '').includes('esbuild server.ts') &&
      String(pkg.scripts?.build || '').includes('--outfile=dist/server.js'),
    'npm build script must bundle server.ts with esbuild into dist/server.js'
  );
  assert.equal(pkg.scripts?.start, 'node dist/server.js', 'npm start script must run node dist/server.js');

  const serverSource = fs.readFileSync(path.resolve('server.ts'), 'utf8');
  assert.ok(serverSource.includes("app.set('trust proxy'"), 'server.ts must configure Express trust proxy');
  assert.ok(
    !serverSource.includes("import { createServer as createViteServer } from 'vite'"),
    'server.ts must not statically import vite at top level'
  );
  assert.ok(
    serverSource.includes("await import('vite')"),
    'server.ts must lazy-load vite only in non-production'
  );
  assert.ok(
    serverSource.includes('req.rawBody = buf'),
    'server.ts must preserve rawBody buffer for Stripe webhook signature verification'
  );
  pass('C1_RUNTIME_HARDENING', 'tsx moved to devDependencies, esbuild dist/server.js start, lazy vite, trust proxy & rawBody capture verified');

  // =========================================================================
  // 2. Shared Test Setup for C2, C3, C4, C5, H1, H3
  // =========================================================================
  const ownerAId = '11111111-1111-4111-8111-111111111111';
  const ownerBId = '22222222-2222-4222-8222-222222222222';
  const buyerExtId = '66666666-6666-4666-8666-666666666666';
  const buyerScopedId = '77777777-7777-4777-8777-777777777777';

  const bizAId = 'aaaa1111-1111-4111-8111-111111111111';
  const bizBId = 'bbbb2222-2222-4222-8222-222222222222';
  const tenantA = 'tenant-alpha';
  const tenantB = 'tenant-beta';

  const tokOwnerA = 'tok-p0-owner-a';
  const tokOwnerB = 'tok-p0-owner-b';
  const tokBuyerExt = 'tok-p0-buyer-ext';
  const tokBuyerScopedB = 'tok-p0-buyer-scoped-b';

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
      // External marketplace customer without internal business operator role or tenant claims
      tokBuyerExt,
      {
        id: buyerExtId,
        email: 'external.buyer@customer.test',
        appMetadata: {},
      },
    ],
    [
      // Scoped internal operator belonging strictly to Beta venture
      tokBuyerScopedB,
      {
        id: buyerScopedId,
        email: 'support.b@beta.test',
        appMetadata: { role: 'support_operator', tenant_id: tenantB, owner_id: ownerBId, business_ids: [bizBId] },
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
    { businessId: bizBId, userId: ownerBId, role: 'owner' as const, status: 'active' as const, tenantId: tenantB },
    { businessId: bizBId, userId: buyerScopedId, role: 'support_operator' as const, status: 'active' as const, tenantId: tenantB },
  ];

  const prodDraftId = 'aaaa0001-0001-4001-8001-000000000001';
  const prodPublishedId = 'aaaa0002-0002-4002-8002-000000000002';
  const prodMismatchPriceId = 'aaaa0003-0003-4003-8003-000000000003';

  const seededOrders: AuthoritativeOrderRecord[] = [
    {
      orderId: 'ord-stripe-p0-1',
      businessId: bizAId,
      ownerId: ownerAId,
      tenantId: tenantA,
      amountCents: 4900,
      refundedAmountCents: 0,
      currency: 'USD',
      paymentStatus: 'paid',
      status: 'completed',
      eligibleForRefund: true,
      paymentProvider: 'stripe',
      paymentIntentId: 'pi_p0_refundable_1',
    },
  ];

  const orderStore = createInMemoryAuthoritativeOrderStore({
    businesses,
    memberships,
    orders: seededOrders,
  });

  const commerceStore = createInMemoryAuthoritativeCommerceStore({
    products: [
      {
        productId: prodDraftId,
        businessId: bizAId,
        businessRecordId: bizAId,
        ownerId: ownerAId,
        tenantId: tenantA,
        name: 'Alpha Draft Playbook',
        slug: 'alpha-draft-playbook',
        description: 'Draft waiting for owner publish approval',
        type: 'digital_download',
        priceCents: 3900,
        currency: 'USD',
        billingType: 'one_time',
        status: 'draft',
        salesCount: 0,
        totalRevenueCents: 0,
      },
      {
        productId: prodPublishedId,
        businessId: bizAId,
        businessRecordId: bizAId,
        ownerId: ownerAId,
        tenantId: tenantA,
        name: 'Alpha Sovereign Toolkit',
        slug: 'alpha-sovereign-toolkit',
        description: 'Published flagship product',
        type: 'digital_download',
        priceCents: 7900,
        currency: 'USD',
        billingType: 'one_time',
        status: 'published',
        stripePriceId: 'price_alpha_valid_7900',
        gumroadProductId: 'gr_alpha_linked_1',
        salesCount: 0,
        totalRevenueCents: 0,
      },
      {
        productId: prodMismatchPriceId,
        businessId: bizAId,
        businessRecordId: bizAId,
        ownerId: ownerAId,
        tenantId: tenantA,
        name: 'Alpha Bad Price Sync',
        slug: 'alpha-bad-price',
        description: 'Has mismatched remote Stripe price',
        type: 'digital_download',
        priceCents: 5000,
        currency: 'USD',
        billingType: 'one_time',
        status: 'published',
        stripePriceId: 'price_mismatched_9999',
        salesCount: 0,
        totalRevenueCents: 0,
      },
    ],
  });

  const nowRef = { current: new Date('2026-11-19T12:00:00.000Z') };
  const expiredStripeSessions: string[] = [];
  let failNextCheckoutRecordCreate = false;

  const originalCreateCheckoutSessionRecord = commerceStore.createCheckoutSessionRecord.bind(commerceStore);
  commerceStore.createCheckoutSessionRecord = async (input) => {
    if (failNextCheckoutRecordCreate) {
      failNextCheckoutRecordCreate = false;
      throw new Error('SIMULATED_DB_PERSISTENCE_FAILURE');
    }
    return originalCreateCheckoutSessionRecord(input);
  };

  const stripeAdapter: StripeClientAdapter = {
    createCheckoutSession: async (params) => ({
      id: `cs_test_${crypto.randomBytes(8).toString('hex')}`,
      url: `https://checkout.stripe.com/c/pay/${params.metadata.orderId}`,
    }),
    retrieveCheckoutSession: async (sessionId) => ({
      id: sessionId,
      payment_status: 'paid',
      amount_total: 7900,
      currency: 'usd',
      payment_intent: 'pi_verified_session_1',
      metadata: {
        userId: buyerExtId,
        businessId: bizAId,
        productId: prodPublishedId,
      },
      customer_details: { email: 'external.buyer@customer.test', name: 'External Buyer' },
    }),
    expireCheckoutSession: async (sessionId) => {
      expiredStripeSessions.push(sessionId);
    },
    retrievePrice: async (priceId) => {
      if (priceId === 'price_alpha_valid_7900') {
        return { id: priceId, active: true, currency: 'USD', unit_amount: 7900, recurring_interval: null };
      }
      return { id: priceId, active: true, currency: 'USD', unit_amount: 9999, recurring_interval: null };
    },
    constructWebhookEvent: (rawBody, signature, webhookSecret) => {
      if (signature !== `sig_valid_${webhookSecret}`) {
        throw new Error('Webhook signature verification failed');
      }
      return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    },
  };

  const sellerIdConfigured = 'seller_gumroad_p0_valid';
  const gumroadAdapter: GumroadAdapter = {
    getStatus: async () => ({ configured: true, connected: true, source: 'env' }),
    publishProduct: async () => ({
      success: true,
      gumroadProductId: 'gr_published_new_1',
      gumroadUrl: 'https://gumroad.com/l/gr_published_new_1',
    }),
    fetchSales: async () => ({ success: true, sales: [] }),
    fetchProducts: async () => ({ success: true, products: [] }),
    verifySaleById: async (saleId) => {
      if (saleId === 'sale_ping_verified_1') {
        return {
          verified: true,
          sellerId: sellerIdConfigured,
          sale: {
            saleId: 'sale_ping_verified_1',
            gumroadProductId: 'gr_alpha_linked_1',
            productName: 'Alpha Sovereign Toolkit',
            buyerName: 'Ping Verified Buyer',
            buyerEmail: 'ping.buyer@example.com',
            amountDollars: 79,
            currency: 'USD',
            refunded: false,
            createdAt: '2026-11-19T12:00:00.000Z',
            source: 'webhook',
          },
        };
      }
      if (saleId === 'sale_ping_unlinked_1') {
        return {
          verified: true,
          sellerId: sellerIdConfigured,
          sale: {
            saleId: 'sale_ping_unlinked_1',
            gumroadProductId: 'gr_unlinked_orphan_999',
            productName: 'Unlinked Product',
            buyerName: 'Orphan Buyer',
            buyerEmail: 'orphan@example.com',
            amountDollars: 10,
            currency: 'USD',
            refunded: false,
            createdAt: '2026-11-19T12:00:00.000Z',
            source: 'webhook',
          },
        };
      }
      return { verified: false, error: 'Sale ID not found in Gumroad API' };
    },
  };

  const app = express();
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as any).rawBody = buf;
      },
    })
  );

  app.use(
    createAiFactoryRouter({
      getAuthVerifier: () => authVerifier,
      getOrderStore: () => orderStore,
      getGeminiKeyInfo: (): GeminiKeyInfo => ({
        key: 'AIzaSyFakeServerKey',
        source: 'GEMINI_API_KEY_2',
        masked: 'AIza...rKey',
      }),
      limiter: new SlidingFixedWindowRateLimiter(),
      generateGeminiText: async ({ model }) => ({ model, text: 'Scoped AI reply' }),
    })
  );

  app.use(
    createCommerceRouter({
      getAuthVerifier: () => authVerifier,
      getOrderStore: () => orderStore,
      getCommerceStore: () => commerceStore,
      getNow: () => nowRef.current,
      getStripeSecretKey: () => 'sk_test_p0_mock',
      getStripeWebhookSecret: () => 'whsec_p0_test',
      getGumroadWebhookSecret: () => 'gr_whsec_p0_test',
      getGumroadSellerId: () => sellerIdConfigured,
      getAllowedOrigins: () =>
        resolveApprovedAppOrigins(
          { APP_URL: 'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app' },
          3000
        ),
      stripeClientFactory: () => stripeAdapter,
      gumroadAdapter,
    })
  );

  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    // =========================================================================
    // Test 2: C2 Publishing lifecycle (replace expired, revoke, single-use consume)
    // =========================================================================
    const appr1Res = await fetch(`${baseUrl}/api/commerce/publish-approvals`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodDraftId, businessId: bizAId }),
    });
    assert.equal(appr1Res.status, 201);
    const appr1Body = await appr1Res.json();
    const appr1Id = appr1Body.approval.approvalId;

    // Advance past 15-min TTL -> expired approval can be safely replaced
    nowRef.current = new Date('2026-11-19T12:20:00.000Z');
    const appr2Res = await fetch(`${baseUrl}/api/commerce/publish-approvals`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodDraftId, businessId: bizAId, replaceExisting: true }),
    });
    assert.equal(appr2Res.status, 201);
    const appr2Body = await appr2Res.json();
    const appr2Id = appr2Body.approval.approvalId;
    assert.notEqual(appr2Id, appr1Id);

    // Explicitly revoke appr2 via new route and verify non-owner cannot revoke
    const crossRevoke = await fetch(`${baseUrl}/api/commerce/publish-approvals/${appr2Id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerB}` },
    });
    assert.equal(crossRevoke.status, 403);

    const revokeRes = await fetch(`${baseUrl}/api/commerce/publish-approvals/${appr2Id}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}` },
    });
    assert.equal(revokeRes.status, 200);

    // Replace again -> publish Stripe/Direct product atomically -> single-use consumption blocks reuse
    const appr3Res = await fetch(`${baseUrl}/api/commerce/publish-approvals`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodDraftId, businessId: bizAId, replaceExisting: true }),
    });
    assert.equal(appr3Res.status, 201);
    const appr3Id = (await appr3Res.json()).approval.approvalId;

    const pubRes = await fetch(`${baseUrl}/api/commerce/products/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodDraftId, businessId: bizAId, approvalId: appr3Id }),
    });
    assert.equal(pubRes.status, 200);

    const pubReuseRes = await fetch(`${baseUrl}/api/commerce/products/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodDraftId, businessId: bizAId, approvalId: appr3Id }),
    });
    assert.equal(pubReuseRes.status, 403);
    pass('C2_PUBLISH_APPROVAL_LIFECYCLE', 'Expired & revoked publish approvals replace cleanly; owner publish consumes once and blocks reuse');

    // =========================================================================
    // Test 3: M2 Owner refund approval replacement after expiration
    // =========================================================================
    const replayStore = new SqlitePersistentReplayStore(':memory:');
    await replayStore.recordOwnerApproval({
      approvalId: 'appr_m2_expired_1',
      ownerId: ownerAId,
      tenantId: tenantA,
      requestId: 'req_m2_1',
      orderId: 'ord-stripe-p0-1',
      businessId: bizAId,
      amountCents: 4900,
      approvedByUserId: ownerAId,
      expiresAt: '2026-11-19T12:05:00.000Z',
      nowIso: '2026-11-19T12:00:00.000Z',
    });
    // Replace after expiration at 12:10:00Z -> old approval transitions to 'expired' instead of failing DUPLICATE_ACTIVE_APPROVAL
    const replacementApproval = await replayStore.recordOwnerApproval({
      approvalId: 'appr_m2_replacement_2',
      ownerId: ownerAId,
      tenantId: tenantA,
      requestId: 'req_m2_1',
      orderId: 'ord-stripe-p0-1',
      businessId: bizAId,
      amountCents: 4900,
      approvedByUserId: ownerAId,
      expiresAt: '2026-11-19T12:25:00.000Z',
      nowIso: '2026-11-19T12:10:00.000Z',
    });
    const oldAfterReplace = await replayStore.getOwnerApprovalDetailed('appr_m2_expired_1');
    assert.equal(oldAfterReplace?.status, 'expired');
    assert.equal(replacementApproval.status, 'approved');
    replayStore.close();
    pass('M2_EXPIRED_OWNER_APPROVAL_REPLACEMENT', 'Expired unused owner refund approval auto-transitions to expired and allows replacement');

    // =========================================================================
    // Test 4: C3 Stripe Checkout, Price Parity, Compensating Expire & Signed Webhook
    // =========================================================================
    // External buyer can purchase published product
    const extCheckout = await fetch(`${baseUrl}/api/create-checkout-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokBuyerExt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodPublishedId, businessId: bizAId }),
    });
    assert.equal(extCheckout.status, 200);
    const extCheckoutBody = await extCheckout.json();
    assert.ok(extCheckoutBody.sessionId?.startsWith('cs_test_'));

    // Scoped internal Beta operator still denied cross-tenant Alpha checkout (H4 preserved)
    const crossScopedCheckout = await fetch(`${baseUrl}/api/create-checkout-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokBuyerScopedB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodPublishedId, businessId: bizAId }),
    });
    assert.equal(crossScopedCheckout.status, 403);

    // Mismatched stripe_price_id vs authoritative DB price_cents blocks checkout with 409
    const priceMismatchRes = await fetch(`${baseUrl}/api/create-checkout-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokBuyerExt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodMismatchPriceId, businessId: bizAId }),
    });
    assert.equal(priceMismatchRes.status, 409);

    // Simulated DB failure during session creation triggers compensating expireCheckoutSession
    failNextCheckoutRecordCreate = true;
    const dbFailCheckout = await fetch(`${baseUrl}/api/create-checkout-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokBuyerExt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: prodPublishedId, businessId: bizAId }),
    });
    assert.equal(dbFailCheckout.status, 500);
    assert.equal(expiredStripeSessions.length, 1, 'Compensating expireCheckoutSession must fire on DB error');

    // Signed Stripe webhook fulfills checkout even without browser return + rejects invalid sig
    const webhookEvent = {
      id: 'evt_p0_paid_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: extCheckoutBody.sessionId,
          payment_status: 'paid',
          amount_total: 7900,
          currency: 'usd',
          payment_intent: 'pi_webhook_settled_1',
        },
      },
    };
    const badSigRes = await fetch(`${baseUrl}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig_forged' },
      body: JSON.stringify(webhookEvent),
    });
    assert.equal(badSigRes.status, 401);

    const goodSigRes = await fetch(`${baseUrl}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig_valid_whsec_p0_test' },
      body: JSON.stringify(webhookEvent),
    });
    assert.equal(goodSigRes.status, 200);
    const updatedProduct = await commerceStore.getProductById(prodPublishedId);
    assert.equal(updatedProduct?.salesCount, 1);
    assert.equal(updatedProduct?.totalRevenueCents, 7900);
    pass('C3_STRIPE_CHECKOUT_AND_WEBHOOK', 'External buyer checkout, cross-tenant 403, price parity 409, compensating expire, and signed webhook fulfillment verified');

    // =========================================================================
    // Test 5: C4 Gumroad Ping Seller Verification & Orphan Blocking
    // =========================================================================
    const querySecretReject = await fetch(`${baseUrl}/api/gumroad/webhook?secret=gr_whsec_p0_test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_id: 'sale_ping_verified_1', seller_id: sellerIdConfigured }),
    });
    assert.equal(querySecretReject.status, 401);

    const pingValidRes = await fetch(`${baseUrl}/api/gumroad/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_id: 'sale_ping_verified_1', seller_id: sellerIdConfigured }),
    });
    assert.equal(pingValidRes.status, 200);
    const pingValidBody = await pingValidRes.json();
    assert.equal(pingValidBody.authenticatedVia, 'gumroad_ping_api');

    const unlinkedRes = await fetch(`${baseUrl}/api/gumroad/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sale_id: 'sale_ping_unlinked_1', seller_id: sellerIdConfigured }),
    });
    assert.equal(unlinkedRes.status, 404);
    assert.equal((await unlinkedRes.json()).code, 'UNLINKED_GUMROAD_PRODUCT');
    pass('C4_GUMROAD_PING_AND_LINKAGE', 'Genuine Gumroad Ping API verification, query-secret rejection (401), and orphan product blocking (404) verified');

    // =========================================================================
    // Test 6: C5 Real Payment Refund Provider Adapter
    // =========================================================================
    let capturedStripeRefundCreate: any = null;
    const mockStripeClient = {
      refunds: {
        create: async (params: any, opts: any) => {
          capturedStripeRefundCreate = { params, opts };
          return {
            id: 're_p0_stripe_1',
            status: 'succeeded',
            amount: params.amount,
            currency: 'usd',
            payment_intent: params.payment_intent,
          };
        },
        list: async () => ({
          data: [
            {
              id: 're_p0_stripe_1',
              status: 'succeeded',
              amount: 4900,
              currency: 'usd',
              metadata: {
                nexus_provider_idempotency_key: 'idem-p0-refund-1',
                nexus_request_id: 'req-p0-refund-1',
                nexus_order_id: 'ord-stripe-p0-1',
              },
            },
          ],
        }),
      },
    } as any;

    const paymentProvider = createServerPaymentRefundProvider({
      orderStore,
      stripeClient: mockStripeClient,
    });
    const execRes = await paymentProvider.executeRefund({
      request: {
        action: 'issue_refund',
        business_id: bizAId,
        order_id: 'ord-stripe-p0-1',
        customer_email: 'buyer@example.com',
        amount_usd: 49,
        reason: 'Customer requested refund',
        provenance: { request_id: 'req-p0-refund-1' },
      } as any,
      providerIdempotencyKey: 'idem-p0-refund-1',
      reservationId: 'res-p0-1',
      amountCents: 4900,
    });
    assert.equal(execRes.outcome, 'CONFIRMED_SUCCESS');
    assert.equal(execRes.txId, 're_p0_stripe_1');
    assert.equal(capturedStripeRefundCreate.opts.idempotencyKey, 'idem-p0-refund-1');

    const lookupRes = await paymentProvider.lookupRefundByIdempotencyKey!({
      providerIdempotencyKey: 'idem-p0-refund-1',
      reservationId: 'res-p0-1',
      requestId: 'req-p0-refund-1',
      orderId: 'ord-stripe-p0-1',
      amountCents: 4900,
    });
    assert.equal(lookupRes.outcome, 'FOUND_SUCCESS');
    assert.equal(lookupRes.txId, 're_p0_stripe_1');
    pass('C5_REAL_PAYMENT_PROVIDER', 'Server Stripe refund adapter executes with provider idempotency key and reconciles existing refunds');

    // =========================================================================
    // Test 7: H1 Authoritative Pricing Endpoint & PayPal Bypass Removal
    // =========================================================================
    const nonOwnerPricing = await fetch(`${baseUrl}/api/commerce/products/${prodPublishedId}/pricing`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokOwnerB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceCents: 100 }),
    });
    assert.equal(nonOwnerPricing.status, 403);

    const ownerPricing = await fetch(`${baseUrl}/api/commerce/products/${prodDraftId}/pricing`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ priceCents: 4500, currency: 'USD', billingType: 'one_time' }),
    });
    assert.equal(ownerPricing.status, 200);
    assert.equal((await ownerPricing.json()).product.priceCents, 4500);

    const packagerSource = fs.readFileSync(
      path.resolve('src/components/modals/ProductPackagerModal.tsx'),
      'utf8'
    );
    assert.ok(
      !packagerSource.includes('Record Payment & Unlock Instant Download') &&
        !packagerSource.includes('recordCustomerPurchase('),
      'ProductPackagerModal must not permit client-side fake PayPal payment completion'
    );
    pass('H1_AUTHORITATIVE_PRICING_AND_PAYPAL', 'Owner-only PATCH pricing enforced (cross-tenant 403) and client PayPal bypass removed');

    // =========================================================================
    // Test 8: H3 AI Business Scope, Distributed Rate Limiter & Prod Origin Hardening
    // =========================================================================
    const crossTenantAiRes = await fetch(`${baseUrl}/api/ai/coordinator`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Hello', businessId: bizBId }),
    });
    assert.equal(crossTenantAiRes.status, 403);

    let rpcCalled = false;
    const mockRpcClient = {
      rpc: async (fnName: string, params: Record<string, any>) => {
        rpcCalled =
          fnName === 'consume_api_rate_limit' &&
          params.p_bucket === 'ai-coordinator' &&
          typeof params.p_subject_key === 'string';
        return { data: { allowed: true, remaining: 9, retry_after_ms: 60000 }, error: null };
      },
    } as any;
    const pgLimiter = new SupabasePostgresRateLimiter(mockRpcClient);
    const pgCheck = await pgLimiter.checkAndConsume('user:ownerA', {
      bucket: 'ai-coordinator',
      windowMs: 60_000,
      maxRequests: 10,
    });
    assert.equal(rpcCalled, true);
    assert.equal(pgCheck.allowed, true);
    assert.equal(pgCheck.remaining, 9);

    const prodOrigins = resolveApprovedAppOrigins(
      { NODE_ENV: 'production', APP_URL: 'https://nexus.example.com' },
      3000
    );
    assert.ok(!prodOrigins.includes('http://localhost:3000'), 'Production origins must exclude localhost by default');
    assert.ok(prodOrigins.includes('https://nexus.example.com'));

    const prodCors = buildScopedCorsHeaders('http://localhost:3000', { isProduction: true });
    assert.equal(prodCors.allowed, false);
    assert.equal(
      prodCors.headers['Access-Control-Allow-Origin'],
      undefined,
      'Production Edge CORS must not reflect localhost unless ALLOW_LOCALHOST_ORIGINS=true'
    );
    pass('H3_SCOPED_AI_RATE_LIMIT_AND_ORIGINS', 'AI cross-tenant 403, Postgres RPC rate limiter, and production localhost origin stripping verified');

    // =========================================================================
    // Test 9: H2, M1, M3, M4 Migration & Frontend Hygiene Checks
    // =========================================================================
    const migrationSql = fs
      .readFileSync(
        path.resolve('supabase/migrations/20261119000011_phase0_security_and_commerce_hardening.sql'),
        'utf8'
      )
      .toLowerCase();
    const rollbackSql = fs
      .readFileSync(
        path.resolve('supabase/migrations/20261119000011_phase0_security_and_commerce_hardening_rollback.sql'),
        'utf8'
      )
      .toLowerCase();
    for (const token of [
      'create table if not exists public.customers',
      'create table if not exists public.stripe_webhook_events',
      'create table if not exists public.api_rate_limits',
      'create or replace function public.consume_api_rate_limit',
      'create or replace function public.guard_products_authoritative_fields',
      'uq_products_gumroad_product_id',
      'drop policy if exists "owners process approvals" on public.approvals',
      'drop policy if exists "authenticated users inspect key metadata" on public.provenance_signing_keys',
    ]) {
      assert.ok(migrationSql.includes(token), `Migration 000011 missing expected DDL: ${token}`);
    }
    assert.ok(rollbackSql.includes('drop function if exists public.consume_api_rate_limit'));
    assert.ok(rollbackSql.includes('drop function if exists public.record_gumroad_sale_and_sync_order'));
    assert.ok(rollbackSql.includes('drop function if exists public.settle_stripe_checkout_session'));
    assert.ok(rollbackSql.includes('drop table if exists public.api_rate_limits'));

    const settingsSource = fs.readFileSync(path.resolve('src/components/sections/Settings.tsx'), 'utf8');
    assert.ok(!settingsSource.includes('window.alert'), 'Settings.tsx must not use window.alert');
    assert.ok(settingsSource.includes('gemini-3.1-flash-lite'), 'Settings.tsx must use current gemini-3.1-flash-lite model');

    const osContextSource = fs.readFileSync(path.resolve('src/context/OSContext.tsx'), 'utf8');
    assert.ok(osContextSource.includes('onAuthStateChange'), 'OSContext.tsx must clear transient caches on auth state change');
    assert.ok(
      osContextSource.includes("'/api/commerce/products/publish'") &&
        osContextSource.includes('authoritativeSynced: undefined'),
      'OSContext.tsx must publish through /api/commerce/products/publish and strip spoofed flags on JSON import'
    );
    pass('H2_M1_M3_M4_SCHEMA_AND_CLIENT_HYGIENE', 'Migration 000011 + rollback DDL, approvals/keys RLS, Settings M1, and OSContext M3 verified');

    console.log(`\nALL PHASE 0 REMEDIATION CHECKS PASSED (${results.length}/${results.length})`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

runTests().catch((err) => {
  console.error('PHASE 0 VERIFICATION FAILED:', err);
  process.exit(1);
});
