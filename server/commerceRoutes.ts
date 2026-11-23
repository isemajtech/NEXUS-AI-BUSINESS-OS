import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import { parseStrictIsoTimestamp } from '../src/governance/provenance';
import {
  type AuthenticatedGovernanceRequest,
  type GovernanceAuthVerifier,
  createSupabaseGovernanceAuthFromEnv,
  isCallerAuthorizedForScope,
  requireAuthenticatedCaller,
  requireGovernancePermission,
  validateCallerHasScope,
} from './governanceAuth';
import {
  SUPPORTED_REFUND_CURRENCIES,
  createSupabaseAuthoritativeOrderStoreFromEnv,
  type AuthoritativeOrderStore,
} from './orderStore';
import {
  createSupabaseAuthoritativeCommerceStoreFromEnv,
  type AuthoritativeCommerceStore,
} from './commerceStore';
import {
  fetchGumroadProducts,
  fetchGumroadSales,
  getGumroadStatus,
  publishProductToGumroad,
  verifyGumroadSaleById,
  type GumroadRemoteProduct,
  type GumroadStatusResult,
  type NormalizedGumroadSale,
  type PublishGumroadInput,
  type PublishGumroadResult,
} from './gumroad';
import {
  SlidingFixedWindowRateLimiter,
  createRateLimitMiddleware,
  type RateLimiterBackend,
} from './rateLimiter';

const DEFAULT_APPROVED_APP_ORIGINS: ReadonlyArray<string> = [
  'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app',
  'https://ais-pre-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const PUBLISH_APPROVAL_TTL_MS = 15 * 60 * 1000;
const CHECKOUT_SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_REGEX = /^cs_[a-zA-Z0-9_]{8,200}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTERNAL_SCOPED_ROLES = new Set<string>([
  'owner',
  'admin',
  'finance_operator',
  'support_operator',
]);

export interface StripeClientAdapter {
  createCheckoutSession(params: {
    mode: 'payment' | 'subscription';
    successUrl: string;
    cancelUrl: string;
    currency: string;
    unitAmountCents: number;
    productName: string;
    productDescription?: string;
    stripePriceId?: string | null;
    recurringInterval?: 'month' | 'year';
    metadata: Record<string, string>;
  }): Promise<{ id: string; url: string | null }>;
  retrieveCheckoutSession(sessionId: string): Promise<{
    id: string;
    payment_status?: string | null;
    amount_total?: number | null;
    currency?: string | null;
    payment_intent?: string | { id?: string } | null;
    metadata?: Record<string, string> | null;
    customer_details?: { email?: string | null; name?: string | null } | null;
  }>;
  expireCheckoutSession?(sessionId: string): Promise<void>;
  retrievePrice?(priceId: string): Promise<{
    id: string;
    active: boolean;
    currency: string;
    unit_amount: number | null;
    recurring_interval?: 'day' | 'week' | 'month' | 'year' | null;
  }>;
  constructWebhookEvent?(
    rawBody: Buffer | string,
    signature: string,
    webhookSecret: string
  ): Stripe.Event;
}

export interface GumroadAdapter {
  getStatus(verifyRemote?: boolean): Promise<GumroadStatusResult>;
  publishProduct(input: PublishGumroadInput): Promise<PublishGumroadResult>;
  fetchSales(afterDate?: string): Promise<{
    success: boolean;
    sales: NormalizedGumroadSale[];
    missingSecret?: boolean;
    error?: string;
  }>;
  fetchProducts(): Promise<{
    success: boolean;
    products: GumroadRemoteProduct[];
    missingSecret?: boolean;
    error?: string;
  }>;
  verifySaleById?(saleId: string): Promise<{
    verified: boolean;
    sellerId?: string;
    sale?: NormalizedGumroadSale;
    error?: string;
  }>;
}

export interface CommerceRouterDeps {
  getAuthVerifier?: () => GovernanceAuthVerifier;
  getOrderStore?: () => AuthoritativeOrderStore;
  getCommerceStore?: () => AuthoritativeCommerceStore;
  getNow?: () => Date;
  getStripeSecretKey?: () => string | null;
  getStripeWebhookSecret?: () => string | null;
  getGumroadWebhookSecret?: () => string | null;
  getGumroadSellerId?: () => string | null;
  getAllowedOrigins?: () => ReadonlyArray<string>;
  stripeClientFactory?: (secretKey: string) => StripeClientAdapter;
  gumroadAdapter?: GumroadAdapter;
  limiter?: RateLimiterBackend;
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

export function resolveApprovedAppOrigins(
  env: NodeJS.ProcessEnv = process.env,
  port = Number(env.PORT || 3000)
): ReadonlyArray<string> {
  const isProduction = env.NODE_ENV === 'production';
  const allowLocalhost = env.ALLOW_LOCALHOST_ORIGINS === 'true';

  const candidates: string[] = DEFAULT_APPROVED_APP_ORIGINS.filter(
    (origin) => !isProduction || allowLocalhost || !isLocalhostOrigin(origin)
  );
  if ((!isProduction || allowLocalhost) && Number.isInteger(port) && port > 0) {
    candidates.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  }
  if (typeof env.APP_URL === 'string' && env.APP_URL.trim()) {
    candidates.push(env.APP_URL.trim());
  }
  if (typeof env.ALLOWED_APP_ORIGINS === 'string' && env.ALLOWED_APP_ORIGINS.trim()) {
    for (const part of env.ALLOWED_APP_ORIGINS.split(',')) {
      if (part.trim()) candidates.push(part.trim());
    }
  }

  const origins = new Set<string>();
  for (const raw of candidates) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (isProduction && !allowLocalhost && isLocalhostOrigin(parsed.origin)) {
          continue;
        }
        origins.add(parsed.origin);
      }
    } catch {
      // Ignore malformed origin config
    }
  }
  return Array.from(origins);
}

export function validateApprovedRedirectUrl(
  rawUrl: string,
  allowedOrigins: ReadonlyArray<string>
): { valid: boolean; normalizedUrl?: string; reason?: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048) {
    return { valid: false, reason: 'Redirect URL is empty or exceeds maximum length.' };
  }
  if (trimmed.startsWith('//') || /^javascript:/i.test(trimmed) || /^data:/i.test(trimmed)) {
    return { valid: false, reason: 'Unsafe or protocol-relative redirect URL is prohibited.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: 'Malformed redirect URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Redirect URL must use http or https protocol.' };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'Credentials inside redirect URL are prohibited.' };
  }

  const originSet = new Set(allowedOrigins.map((o) => o.toLowerCase()));
  if (!originSet.has(parsed.origin.toLowerCase())) {
    return {
      valid: false,
      reason: `Redirect origin "${parsed.origin}" is not in the approved application origins allowlist.`,
    };
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

function timingSafeCompareSecret(expected: string, provided: string): boolean {
  const digestExpected = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const digestProvided = crypto.createHash('sha256').update(provided, 'utf8').digest();
  return crypto.timingSafeEqual(digestExpected, digestProvided);
}

function extractHeaderSecret(req: Request): string {
  const xSecret = req.headers['x-gumroad-secret'];
  if (typeof xSecret === 'string' && xSecret.trim()) {
    return xSecret.trim();
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const bearer = auth.match(/^Bearer\s+(.+)$/i);
    if (bearer && bearer[1]?.trim()) {
      return bearer[1].trim();
    }
    const basic = auth.match(/^Basic\s+(.+)$/i);
    if (basic && basic[1]?.trim()) {
      try {
        const decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8');
        const idx = decoded.indexOf(':');
        return idx >= 0 ? decoded.slice(idx + 1).trim() : decoded.trim();
      } catch {
        return '';
      }
    }
  }
  return '';
}

function createDefaultStripeAdapter(secretKey: string): StripeClientAdapter {
  const stripe = new Stripe(secretKey);
  return {
    createCheckoutSession: async (params) => {
      const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = params.stripePriceId
        ? { price: params.stripePriceId, quantity: 1 }
        : {
            price_data: {
              currency: params.currency.toLowerCase(),
              product_data: {
                name: params.productName,
                description: params.productDescription
                  ? params.productDescription.slice(0, 300)
                  : undefined,
              },
              unit_amount: params.unitAmountCents,
              ...(params.mode === 'subscription' && params.recurringInterval
                ? {
                    recurring: {
                      interval: params.recurringInterval,
                    },
                  }
                : {}),
            },
            quantity: 1,
          };

      const session = await stripe.checkout.sessions.create({
        mode: params.mode,
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        line_items: [lineItem],
        billing_address_collection: 'auto',
        allow_promotion_codes: false,
        metadata: params.metadata,
      });

      return { id: session.id, url: session.url };
    },
    retrieveCheckoutSession: async (sessionId) => {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      return {
        id: session.id,
        payment_status: session.payment_status,
        amount_total: session.amount_total,
        currency: session.currency,
        payment_intent: session.payment_intent as any,
        metadata: (session.metadata as Record<string, string> | null) ?? null,
        customer_details: session.customer_details
          ? {
              email: session.customer_details.email,
              name: session.customer_details.name,
            }
          : null,
      };
    },
    expireCheckoutSession: async (sessionId) => {
      await stripe.checkout.sessions.expire(sessionId).catch(() => {});
    },
    retrievePrice: async (priceId) => {
      const price = await stripe.prices.retrieve(priceId);
      const rawInterval = price.recurring?.interval;
      const recurringInterval: 'day' | 'week' | 'month' | 'year' | null =
        rawInterval === 'day'
          ? 'day'
          : rawInterval === 'week'
          ? 'week'
          : rawInterval === 'month'
          ? 'month'
          : rawInterval === 'year'
          ? 'year'
          : null;
      return {
        id: price.id,
        active: Boolean(price.active),
        currency: String(price.currency || '').toUpperCase(),
        unit_amount: price.unit_amount ?? null,
        recurring_interval: recurringInterval,
      };
    },
    constructWebhookEvent: (rawBody, signature, webhookSecret) => {
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}

function isScopedInternalCaller(caller: AuthenticatedGovernanceRequest['governanceCaller']): boolean {
  if (!caller) return false;
  return (
    caller.roles.some((r) => INTERNAL_SCOPED_ROLES.has(r)) ||
    caller.hasExplicitTenantClaim ||
    caller.hasExplicitOwnerClaim ||
    caller.allowedBusinessIds !== undefined ||
    caller.hasExplicitEmptyBusinessList ||
    Boolean(caller.scopeError)
  );
}

export function createCommerceRouter(deps: CommerceRouterDeps = {}): Router {
  const router = Router();
  const getAuthVerifier =
    deps.getAuthVerifier ?? (() => createSupabaseGovernanceAuthFromEnv());
  const getOrderStore =
    deps.getOrderStore ?? (() => createSupabaseAuthoritativeOrderStoreFromEnv());
  const getCommerceStore =
    deps.getCommerceStore ?? (() => createSupabaseAuthoritativeCommerceStoreFromEnv());
  const getNow = deps.getNow ?? (() => new Date());
  const getStripeSecretKey =
    deps.getStripeSecretKey ?? (() => process.env.STRIPE_SECRET_KEY?.trim() || null);
  const getStripeWebhookSecret =
    deps.getStripeWebhookSecret ??
    (() => process.env.STRIPE_WEBHOOK_SECRET?.trim() || null);
  const getGumroadWebhookSecret =
    deps.getGumroadWebhookSecret ??
    (() => process.env.GUMROAD_WEBHOOK_SECRET?.trim() || null);
  const getGumroadSellerId =
    deps.getGumroadSellerId ?? (() => process.env.GUMROAD_SELLER_ID?.trim() || null);
  const getAllowedOrigins =
    deps.getAllowedOrigins ?? (() => resolveApprovedAppOrigins());
  const stripeFactory = deps.stripeClientFactory ?? createDefaultStripeAdapter;
  const limiter: RateLimiterBackend = deps.limiter ?? new SlidingFixedWindowRateLimiter();
  const gumroad: GumroadAdapter = deps.gumroadAdapter ?? {
    getStatus: getGumroadStatus,
    publishProduct: publishProductToGumroad,
    fetchSales: fetchGumroadSales,
    fetchProducts: fetchGumroadProducts,
    verifySaleById: verifyGumroadSaleById,
  };

  const commerceWriteLimit = createRateLimitMiddleware(limiter, {
    bucket: 'commerce-write',
    windowMs: 60_000,
    maxRequests: 60,
  });
  const commerceReadLimit = createRateLimitMiddleware(limiter, {
    bucket: 'commerce-read',
    windowMs: 60_000,
    maxRequests: 120,
  });
  const webhookLimit = createRateLimitMiddleware(limiter, {
    bucket: 'commerce-webhook',
    windowMs: 60_000,
    maxRequests: 240,
  });

  // ---------------------------------------------------------------------------
  // H4-A & C2: Gumroad Status, Publish Approvals (Create/Replace/Revoke) & Publish
  // ---------------------------------------------------------------------------
  router.get(
    '/api/gumroad/status',
    requireAuthenticatedCaller(getAuthVerifier),
    commerceReadLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const verifyRemote = req.query.verify === '1';
      const caller = req.governanceCaller;

      if (verifyRemote) {
        if (!caller || !caller.permissions.includes('commerce:gumroad:read')) {
          res.status(403).json({
            success: false,
            code: 'INSUFFICIENT_ROLE_OR_PERMISSION',
            error:
              'Verified commerce:gumroad:read permission is required to verify Gumroad account.',
          });
          return;
        }
        const scopeCheck = validateCallerHasScope(caller);
        if (!scopeCheck.authorized) {
          res.status(403).json({
            success: false,
            code: 'CALLER_SCOPE_MISSING',
            error: scopeCheck.reason || 'Caller lacks verifiable tenant or business scope.',
          });
          return;
        }
      }

      const status = await gumroad.getStatus(verifyRemote);
      res.json(status);
    }
  );

  router.post(
    '/api/commerce/publish-approvals',
    requireGovernancePermission(getAuthVerifier, 'commerce:gumroad:publish'),
    commerceWriteLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error: callerScope.reason || 'Caller lacks verifiable owner or tenant scope.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !commerceStore.configured
      ) {
        res.status(503).json({
          success: false,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error:
            orderStore.reason ||
            commerceStore.reason ||
            'Authoritative order and commerce stores are not configured (fail-closed).',
        });
        return;
      }

      const body = (req.body || {}) as Record<string, any>;
      const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
      const requestedBusinessId =
        typeof body.businessId === 'string' ? body.businessId.trim() : '';
      const decisionNote =
        typeof body.decisionNote === 'string'
          ? body.decisionNote.trim().slice(0, 300)
          : 'Approved by verified business owner';
      const replaceExisting = body.replaceExisting !== false;

      if (!productId) {
        res.status(400).json({
          success: false,
          code: 'INVALID_REQUEST',
          error: 'productId is required to create a product publish approval.',
        });
        return;
      }

      const product = await commerceStore.getProductById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          code: 'PRODUCT_NOT_FOUND',
          error: 'Authoritative product record not found.',
        });
        return;
      }

      if (
        requestedBusinessId &&
        requestedBusinessId !== product.businessId &&
        requestedBusinessId !== product.businessRecordId
      ) {
        res.status(403).json({
          success: false,
          code: 'BUSINESS_MISMATCH',
          error: 'Requested businessId does not match authoritative product business.',
        });
        return;
      }

      const membership = await orderStore.verifyCallerBusinessAccess({
        businessId: product.businessId,
        caller,
      });
      if (!membership.authorized || membership.membershipRole !== 'owner') {
        res.status(403).json({
          success: false,
          code: 'OWNER_MEMBERSHIP_REQUIRED',
          error:
            membership.reason ||
            'Active owner business membership is required to approve product publishing.',
        });
        return;
      }

      const scopeAuth = isCallerAuthorizedForScope(
        caller,
        {
          ownerId: product.ownerId ?? membership.ownerId,
          tenantId: product.tenantId ?? membership.tenantId,
          businessId: product.businessId,
          requireStoredTenantOrOwnerScope: true,
        },
        membership
      );
      if (!scopeAuth.authorized) {
        res.status(403).json({
          success: false,
          code: 'CROSS_TENANT_FORBIDDEN',
          error: scopeAuth.reason || 'Caller is not authorized for target product scope.',
        });
        return;
      }

      const now = getNow();
      const expiresAt = new Date(now.getTime() + PUBLISH_APPROVAL_TTL_MS).toISOString();
      const effectiveTenant =
        product.tenantId || membership.tenantId || membership.ownerId || caller.userId;

      try {
        const approval = await commerceStore.createProductPublishApproval({
          productId: product.productId,
          businessId: product.businessRecordId || product.businessId,
          ownerId: product.ownerId ?? membership.ownerId,
          tenantId: effectiveTenant,
          approvedByUserId: caller.userId,
          decisionNote,
          expiresAt,
          nowIso: now.toISOString(),
          replaceExisting,
        });

        res.status(201).json({ success: true, approval });
      } catch (err: any) {
        res.status(409).json({
          success: false,
          code: 'APPROVAL_CONFLICT',
          error: err?.message || 'Could not create product publish approval.',
        });
      }
    }
  );

  router.post(
    '/api/commerce/publish-approvals/:approvalId/revoke',
    requireGovernancePermission(getAuthVerifier, 'commerce:gumroad:publish'),
    commerceWriteLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error: callerScope.reason || 'Caller lacks verifiable owner/tenant scope.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !commerceStore.configured ||
        !commerceStore.revokeProductPublishApproval
      ) {
        res.status(503).json({
          success: false,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error: 'Authoritative commerce/order stores are not configured (fail-closed).',
        });
        return;
      }

      const approvalId = String(req.params.approvalId || '').trim();
      if (!approvalId) {
        res.status(400).json({ success: false, code: 'INVALID_REQUEST', error: 'approvalId is required.' });
        return;
      }

      const approval = await commerceStore.getProductPublishApproval(approvalId);
      if (!approval) {
        res.status(404).json({ success: false, code: 'APPROVAL_NOT_FOUND', error: 'Publish approval not found.' });
        return;
      }

      const membership = await orderStore.verifyCallerBusinessAccess({
        businessId: approval.businessId,
        caller,
      });
      if (!membership.authorized || membership.membershipRole !== 'owner') {
        res.status(403).json({
          success: false,
          code: 'OWNER_MEMBERSHIP_REQUIRED',
          error: 'Active owner membership on the target business is required to revoke publish approvals.',
        });
        return;
      }

      const scopeAuth = isCallerAuthorizedForScope(
        caller,
        {
          ownerId: approval.ownerId ?? membership.ownerId,
          tenantId: approval.tenantId ?? membership.tenantId,
          businessId: approval.businessId,
          requireStoredTenantOrOwnerScope: true,
        },
        membership
      );
      if (!scopeAuth.authorized) {
        res.status(403).json({
          success: false,
          code: 'CROSS_TENANT_FORBIDDEN',
          error: scopeAuth.reason || 'Cross-tenant publish approval revocation denied.',
        });
        return;
      }

      const revokeRes = await commerceStore.revokeProductPublishApproval({
        approvalId,
        businessId: approval.businessId,
        nowIso: getNow().toISOString(),
      });

      if (revokeRes.status === 'already_consumed') {
        res.status(409).json({
          success: false,
          code: 'APPROVAL_ALREADY_CONSUMED',
          error: 'Publish approval was already consumed and cannot be revoked.',
        });
        return;
      }
      if (revokeRes.status === 'not_found') {
        res.status(404).json({ success: false, code: 'APPROVAL_NOT_FOUND', error: 'Publish approval not found.' });
        return;
      }

      res.json({ success: true, status: revokeRes.status, approval: revokeRes.approval });
    }
  );

  // ---------------------------------------------------------------------------
  // C3 & H1: Server-Authoritative Product Pricing Update & Stripe/Direct Publish
  // ---------------------------------------------------------------------------
  router.patch(
    '/api/commerce/products/:productId/pricing',
    requireGovernancePermission(getAuthVerifier, 'commerce:gumroad:publish'),
    commerceWriteLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error: callerScope.reason || 'Caller lacks verifiable owner/tenant scope.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !commerceStore.configured ||
        !commerceStore.updateProductPricing
      ) {
        res.status(503).json({
          success: false,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error: 'Authoritative commerce/order stores are not configured (fail-closed).',
        });
        return;
      }

      const productId = String(req.params.productId || '').trim();
      const product = await commerceStore.getProductById(productId);
      if (!product) {
        res.status(404).json({ success: false, code: 'PRODUCT_NOT_FOUND', error: 'Product not found.' });
        return;
      }

      const membership = await orderStore.verifyCallerBusinessAccess({
        businessId: product.businessId,
        caller,
      });
      if (!membership.authorized || membership.membershipRole !== 'owner') {
        res.status(403).json({
          success: false,
          code: 'OWNER_MEMBERSHIP_REQUIRED',
          error: 'Active owner membership is required to modify authoritative pricing.',
        });
        return;
      }

      const scopeAuth = isCallerAuthorizedForScope(
        caller,
        {
          ownerId: product.ownerId ?? membership.ownerId,
          tenantId: product.tenantId ?? membership.tenantId,
          businessId: product.businessId,
          requireStoredTenantOrOwnerScope: true,
        },
        membership
      );
      if (!scopeAuth.authorized) {
        res.status(403).json({
          success: false,
          code: 'CROSS_TENANT_FORBIDDEN',
          error: scopeAuth.reason || 'Cross-tenant pricing mutation denied.',
        });
        return;
      }

      const body = (req.body || {}) as Record<string, any>;
      const rawPriceCents =
        body.priceCents !== undefined
          ? Number(body.priceCents)
          : body.price !== undefined
          ? Math.round(Number(body.price) * 100)
          : NaN;
      if (!Number.isInteger(rawPriceCents) || rawPriceCents < 0 || rawPriceCents > 100_000_000) {
        res.status(400).json({
          success: false,
          code: 'INVALID_PRICE',
          error: 'priceCents must be a valid non-negative integer.',
        });
        return;
      }

      const currency =
        typeof body.currency === 'string' && body.currency.trim()
          ? body.currency.trim().toUpperCase()
          : product.currency || 'USD';
      if (!SUPPORTED_REFUND_CURRENCIES.has(currency)) {
        res.status(400).json({
          success: false,
          code: 'UNSUPPORTED_CURRENCY',
          error: `Unsupported currency "${currency}".`,
        });
        return;
      }

      const billingType =
        body.billingType === 'monthly' ||
        body.billingType === 'yearly' ||
        body.billingType === 'free'
          ? body.billingType
          : body.billingType === 'one_time' || !body.billingType
          ? (rawPriceCents === 0 ? 'free' : 'one_time')
          : null;
      if (!billingType) {
        res.status(400).json({
          success: false,
          code: 'INVALID_BILLING_TYPE',
          error: 'billingType must be one_time, monthly, yearly, or free.',
        });
        return;
      }

      const stripePriceId =
        body.stripePriceId === null
          ? null
          : typeof body.stripePriceId === 'string' && body.stripePriceId.trim()
          ? body.stripePriceId.trim()
          : undefined;

      if (stripePriceId) {
        const stripeKey = getStripeSecretKey();
        if (stripeKey) {
          const stripe = stripeFactory(stripeKey);
          if (stripe.retrievePrice) {
            const remotePrice = await stripe.retrievePrice(stripePriceId);
            const expectedInterval =
              billingType === 'monthly' ? 'month' : billingType === 'yearly' ? 'year' : null;
            if (
              !remotePrice.active ||
              remotePrice.currency !== currency ||
              remotePrice.unit_amount !== rawPriceCents ||
              (remotePrice.recurring_interval ?? null) !== expectedInterval
            ) {
              res.status(409).json({
                success: false,
                code: 'STRIPE_PRICE_MISMATCH',
                error:
                  'Configured stripe_price_id does not match authoritative price_cents, currency, or billing interval.',
              });
              return;
            }
          }
        }
      }

      const updated = await commerceStore.updateProductPricing({
        productId: product.productId,
        businessId: product.businessRecordId || product.businessId,
        priceCents: rawPriceCents,
        currency,
        billingType,
        stripePriceId,
        updatedAt: getNow().toISOString(),
      });

      res.json({ success: true, product: updated });
    }
  );

  router.post(
    '/api/commerce/products/publish',
    requireGovernancePermission(getAuthVerifier, 'commerce:gumroad:publish'),
    commerceWriteLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'CALLER_SCOPE_MISSING',
          error: callerScope.reason || 'Caller lacks verifiable owner/tenant scope.',
        });
        return;
      }

      const body = (req.body || {}) as Record<string, any>;
      if (
        body.ownerApproved !== undefined ||
        body.productStatus !== undefined ||
        body.priceDollars !== undefined ||
        body.priceCents !== undefined
      ) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'CLIENT_APPROVAL_CLAIMS_FORBIDDEN',
          error:
            'Client-supplied approval/status/price overrides are prohibited; publishing requires server-verified records.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !commerceStore.configured ||
        !commerceStore.consumeAndPublishProduct
      ) {
        res.status(503).json({
          success: false,
          governanceBlocked: true,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error: 'Authoritative order/commerce stores are not configured (fail-closed).',
        });
        return;
      }

      const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
      const requestedBusinessId =
        typeof body.businessId === 'string' ? body.businessId.trim() : '';
      const stripePriceId =
        typeof body.stripePriceId === 'string' && body.stripePriceId.trim()
          ? body.stripePriceId.trim()
          : null;

      if (!productId || !approvalId) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'MISSING_PRODUCT_OR_APPROVAL',
          error: 'Authoritative productId and server approvalId are required to publish products.',
        });
        return;
      }

      const product = await commerceStore.getProductById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          governanceBlocked: true,
          code: 'PRODUCT_NOT_FOUND',
          error: 'Authoritative product record not found.',
        });
        return;
      }

      if (
        requestedBusinessId &&
        requestedBusinessId !== product.businessId &&
        requestedBusinessId !== product.businessRecordId
      ) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'BUSINESS_MISMATCH',
          error: 'Requested businessId does not match product business.',
        });
        return;
      }

      const membership = await orderStore.verifyCallerBusinessAccess({
        businessId: product.businessId,
        caller,
      });
      if (!membership.authorized || membership.membershipRole !== 'owner') {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'OWNER_MEMBERSHIP_REQUIRED',
          error:
            membership.reason ||
            'Active owner membership on the target business is required to publish products.',
        });
        return;
      }

      const scopeAuth = isCallerAuthorizedForScope(
        caller,
        {
          ownerId: product.ownerId ?? membership.ownerId,
          tenantId: product.tenantId ?? membership.tenantId,
          businessId: product.businessId,
          requireStoredTenantOrOwnerScope: true,
        },
        membership
      );
      if (!scopeAuth.authorized) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'CROSS_TENANT_FORBIDDEN',
          error: scopeAuth.reason || 'Cross-tenant publish denied.',
        });
        return;
      }

      const approval = await commerceStore.getProductPublishApproval(approvalId);
      if (!approval) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_NOT_FOUND',
          error: 'Server-verified publish approval record not found.',
        });
        return;
      }
      if (approval.status !== 'approved' || approval.consumedAt) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_INVALID_OR_CONSUMED',
          error: `Publish approval is not active (status="${approval.status}").`,
        });
        return;
      }

      const nowMs = getNow().getTime();
      const approvalExpiresMs = parseStrictIsoTimestamp(approval.expiresAt);
      if (approvalExpiresMs === null || nowMs >= approvalExpiresMs) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_EXPIRED',
          error: 'Publish approval has expired or has an invalid expiration timestamp.',
        });
        return;
      }

      if (
        approval.productId !== product.productId ||
        (approval.businessId !== product.businessId &&
          approval.businessId !== product.businessRecordId)
      ) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_BINDING_MISMATCH',
          error: 'Publish approval is bound to a different product or business.',
        });
        return;
      }

      const targetStripePrice = stripePriceId ?? product.stripePriceId ?? null;
      if (targetStripePrice) {
        const stripeKey = getStripeSecretKey();
        if (stripeKey) {
          const stripe = stripeFactory(stripeKey);
          if (stripe.retrievePrice) {
            const remotePrice = await stripe.retrievePrice(targetStripePrice);
            const expectedInterval =
              product.billingType === 'monthly'
                ? 'month'
                : product.billingType === 'yearly'
                ? 'year'
                : null;
            if (
              !remotePrice.active ||
              remotePrice.currency !== String(product.currency || 'USD').toUpperCase() ||
              remotePrice.unit_amount !== product.priceCents ||
              (remotePrice.recurring_interval ?? null) !== expectedInterval
            ) {
              res.status(409).json({
                success: false,
                code: 'STRIPE_PRICE_MISMATCH',
                error:
                  'Configured stripe_price_id mismatches authoritative product price, currency, or interval.',
              });
              return;
            }
          }
        }
      }

      const consumedAt = getNow().toISOString();
      const pubRes = await commerceStore.consumeAndPublishProduct({
        approvalId: approval.approvalId,
        productId: product.productId,
        businessId: product.businessRecordId || product.businessId,
        stripePriceId: targetStripePrice,
        consumedAt,
      });

      if (!pubRes.ok) {
        res.status(409).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_CONSUME_FAILED',
          error: pubRes.reason || 'Failed to finalize publish approval.',
        });
        return;
      }

      res.json({
        success: true,
        productId: product.productId,
        businessId: product.businessId,
        approvalId: approval.approvalId,
        publishedAt: consumedAt,
      });
    }
  );

  router.post(
    '/api/gumroad/publish',
    requireGovernancePermission(getAuthVerifier, 'commerce:gumroad:publish'),
    commerceWriteLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'CALLER_SCOPE_MISSING',
          error: callerScope.reason || 'Caller lacks verifiable owner/tenant scope.',
        });
        return;
      }

      const body = (req.body || {}) as Record<string, any>;

      if (
        body.ownerApproved !== undefined ||
        body.productStatus !== undefined ||
        body.priceDollars !== undefined
      ) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'CLIENT_APPROVAL_CLAIMS_FORBIDDEN',
          error:
            'Client-supplied ownerApproved, productStatus, and priceDollars overrides are prohibited; publishing requires server-verified product and approval records.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !commerceStore.configured
      ) {
        res.status(503).json({
          success: false,
          governanceBlocked: true,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error:
            orderStore.reason ||
            commerceStore.reason ||
            'Authoritative order/commerce stores are not configured (fail-closed).',
        });
        return;
      }

      const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
      const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
      const requestedBusinessId =
        typeof body.businessId === 'string' ? body.businessId.trim() : '';

      if (!productId || !approvalId) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'MISSING_PRODUCT_OR_APPROVAL',
          error:
            'Authoritative productId and server approvalId are required to publish to Gumroad.',
        });
        return;
      }

      const product = await commerceStore.getProductById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          governanceBlocked: true,
          code: 'PRODUCT_NOT_FOUND',
          error: 'Authoritative product record not found.',
        });
        return;
      }

      if (
        requestedBusinessId &&
        requestedBusinessId !== product.businessId &&
        requestedBusinessId !== product.businessRecordId
      ) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'BUSINESS_MISMATCH',
          error: 'Requested businessId does not match product business.',
        });
        return;
      }

      const membership = await orderStore.verifyCallerBusinessAccess({
        businessId: product.businessId,
        caller,
      });
      if (!membership.authorized || membership.membershipRole !== 'owner') {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'OWNER_MEMBERSHIP_REQUIRED',
          error:
            membership.reason ||
            'Active owner membership on the target business is required to publish products.',
        });
        return;
      }

      const scopeAuth = isCallerAuthorizedForScope(
        caller,
        {
          ownerId: product.ownerId ?? membership.ownerId,
          tenantId: product.tenantId ?? membership.tenantId,
          businessId: product.businessId,
          requireStoredTenantOrOwnerScope: true,
        },
        membership
      );
      if (!scopeAuth.authorized) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'CROSS_TENANT_FORBIDDEN',
          error: scopeAuth.reason || 'Cross-tenant publish denied.',
        });
        return;
      }

      const approval = await commerceStore.getProductPublishApproval(approvalId);
      if (!approval) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_NOT_FOUND',
          error: 'Server-verified publish approval record not found.',
        });
        return;
      }
      if (approval.status !== 'approved' || approval.consumedAt) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_INVALID_OR_CONSUMED',
          error: `Publish approval is not active (status="${approval.status}").`,
        });
        return;
      }

      const nowMs = getNow().getTime();
      const approvalExpiresMs = parseStrictIsoTimestamp(approval.expiresAt);
      if (approvalExpiresMs === null || nowMs >= approvalExpiresMs) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_EXPIRED',
          error: 'Publish approval has expired or has an invalid expiration timestamp.',
        });
        return;
      }

      if (
        approval.productId !== product.productId ||
        (approval.businessId !== product.businessId &&
          approval.businessId !== product.businessRecordId)
      ) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_BINDING_MISMATCH',
          error: 'Publish approval is bound to a different product or business.',
        });
        return;
      }

      if (
        (approval.ownerId && membership.ownerId && approval.ownerId !== membership.ownerId) ||
        (approval.tenantId && membership.tenantId && approval.tenantId !== membership.tenantId)
      ) {
        res.status(403).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_TENANT_MISMATCH',
          error: 'Publish approval owner/tenant binding mismatch.',
        });
        return;
      }

      const publishResult = await gumroad.publishProduct({
        name: product.name,
        description: product.description || product.name,
        priceDollars: product.priceCents / 100,
        slug: product.slug || '',
        gumroadProductId: product.gumroadProductId || undefined,
        customDeliverySummary: product.customDeliverySummary || undefined,
      });

      if (!publishResult.success || !publishResult.gumroadProductId) {
        res.status(publishResult.missingSecret ? 400 : 502).json(publishResult);
        return;
      }

      const consumedAt = getNow().toISOString();
      const linkRes = await commerceStore.consumeAndLinkGumroadPublish({
        approvalId: approval.approvalId,
        productId: product.productId,
        businessId: product.businessRecordId || product.businessId,
        gumroadProductId: publishResult.gumroadProductId,
        gumroadUrl: publishResult.gumroadUrl || '',
        consumedAt,
      });

      if (!linkRes.ok) {
        res.status(409).json({
          success: false,
          governanceBlocked: true,
          code: 'APPROVAL_CONSUME_FAILED',
          error: linkRes.reason || 'Failed to finalize publish approval.',
        });
        return;
      }

      res.json({
        ...publishResult,
        productId: product.productId,
        businessId: product.businessId,
        approvalId: approval.approvalId,
      });
    }
  );

  router.get(
    '/api/gumroad/sales',
    requireGovernancePermission(getAuthVerifier, 'commerce:gumroad:read'),
    commerceReadLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error: callerScope.reason || 'Caller lacks verifiable tenant or business scope.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !orderStore.listAuthorizedBusinessesForCaller ||
        !commerceStore.configured
      ) {
        res.status(503).json({
          success: false,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error:
            orderStore.reason ||
            commerceStore.reason ||
            'Authoritative order/commerce stores are not configured (fail-closed).',
        });
        return;
      }

      const requestedBusinessId =
        typeof req.query.business_id === 'string'
          ? req.query.business_id.trim()
          : typeof req.query.businessId === 'string'
          ? req.query.businessId.trim()
          : '';

      let targetBusinessIds: string[] = [];
      if (requestedBusinessId) {
        const membership = await orderStore.verifyCallerBusinessAccess({
          businessId: requestedBusinessId,
          caller,
        });
        if (!membership.authorized) {
          res.status(403).json({
            success: false,
            code: 'BUSINESS_ACCESS_DENIED',
            error: membership.reason || 'Caller is not authorized for requested business.',
          });
          return;
        }
        targetBusinessIds = [membership.businessRecordId || membership.businessId];
      } else {
        const authorizedBusinesses = await orderStore.listAuthorizedBusinessesForCaller(caller);
        if (authorizedBusinesses.length === 0) {
          res.status(403).json({
            success: false,
            code: 'NO_AUTHORIZED_BUSINESSES',
            error: 'Caller has no active authorized business scope.',
          });
          return;
        }
        targetBusinessIds = Array.from(new Set(authorizedBusinesses.map((b) => b.businessId)));
      }

      const linkedProducts =
        await commerceStore.listGumroadLinkedProductsForBusinesses(targetBusinessIds);
      const authorizedGumroadIds = new Set(
        linkedProducts.map((p) => p.gumroadProductId?.trim() || '').filter(Boolean)
      );

      if (authorizedGumroadIds.size === 0) {
        res.json({ success: true, sales: [] });
        return;
      }

      const after = typeof req.query.after === 'string' ? req.query.after.trim() : undefined;
      const apiRes = await gumroad.fetchSales(after);
      const webhookSales = await commerceStore.listGumroadWebhookSalesForProducts(
        Array.from(authorizedGumroadIds)
      );

      const seen = new Set<string>();
      const scopedSales: NormalizedGumroadSale[] = [];

      for (const s of apiRes.sales) {
        if (
          s.gumroadProductId &&
          authorizedGumroadIds.has(s.gumroadProductId) &&
          !seen.has(s.saleId)
        ) {
          seen.add(s.saleId);
          scopedSales.push(s);
        }
      }
      for (const ws of webhookSales) {
        if (
          ws.gumroadProductId &&
          authorizedGumroadIds.has(ws.gumroadProductId) &&
          !seen.has(ws.saleId)
        ) {
          seen.add(ws.saleId);
          scopedSales.push(ws);
        }
      }

      if (!apiRes.success && scopedSales.length === 0) {
        res.json({
          success: false,
          sales: [],
          missingSecret: apiRes.missingSecret,
          error: apiRes.error,
        });
        return;
      }

      res.json({ success: true, sales: scopedSales });
    }
  );

  router.get(
    '/api/gumroad/products',
    requireGovernancePermission(getAuthVerifier, 'commerce:gumroad:read'),
    commerceReadLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error: callerScope.reason || 'Caller lacks verifiable tenant or business scope.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !orderStore.listAuthorizedBusinessesForCaller ||
        !commerceStore.configured
      ) {
        res.status(503).json({
          success: false,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error:
            orderStore.reason ||
            commerceStore.reason ||
            'Authoritative order/commerce stores are not configured (fail-closed).',
        });
        return;
      }

      const requestedBusinessId =
        typeof req.query.business_id === 'string'
          ? req.query.business_id.trim()
          : typeof req.query.businessId === 'string'
          ? req.query.businessId.trim()
          : '';

      let targetBusinessIds: string[] = [];
      if (requestedBusinessId) {
        const membership = await orderStore.verifyCallerBusinessAccess({
          businessId: requestedBusinessId,
          caller,
        });
        if (!membership.authorized) {
          res.status(403).json({
            success: false,
            code: 'BUSINESS_ACCESS_DENIED',
            error: membership.reason || 'Caller is not authorized for requested business.',
          });
          return;
        }
        targetBusinessIds = [membership.businessRecordId || membership.businessId];
      } else {
        const authorizedBusinesses = await orderStore.listAuthorizedBusinessesForCaller(caller);
        if (authorizedBusinesses.length === 0) {
          res.status(403).json({
            success: false,
            code: 'NO_AUTHORIZED_BUSINESSES',
            error: 'Caller has no active authorized business scope.',
          });
          return;
        }
        targetBusinessIds = Array.from(new Set(authorizedBusinesses.map((b) => b.businessId)));
      }

      const linkedProducts =
        await commerceStore.listGumroadLinkedProductsForBusinesses(targetBusinessIds);
      const authorizedGumroadIds = new Set(
        linkedProducts.map((p) => p.gumroadProductId?.trim() || '').filter(Boolean)
      );

      if (authorizedGumroadIds.size === 0) {
        res.json({ success: true, products: [], totalRemoteCount: 0 });
        return;
      }

      const productIdsParam =
        typeof req.query.productIds === 'string' ? req.query.productIds.trim() : '';
      const requestedSet = productIdsParam
        ? new Set(
            productIdsParam
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          )
        : null;

      const result = await gumroad.fetchProducts();
      if (!result.success) {
        res.json({
          success: false,
          products: [],
          missingSecret: result.missingSecret,
          error: result.error,
        });
        return;
      }

      const scopedProducts = result.products.filter((p) => {
        if (!authorizedGumroadIds.has(p.gumroadProductId)) {
          return false;
        }
        if (requestedSet && !requestedSet.has(p.gumroadProductId)) {
          return false;
        }
        return true;
      });

      res.json({
        success: true,
        products: scopedProducts,
        totalRemoteCount: scopedProducts.length,
      });
    }
  );

  // ---------------------------------------------------------------------------
  // H4-B & C3: Stripe Status, Buyer-Authorized Checkout, Verify & Signed Webhook
  // ---------------------------------------------------------------------------
  router.get(
    '/api/stripe/status',
    requireAuthenticatedCaller(getAuthVerifier),
    commerceReadLimit,
    (_req: AuthenticatedGovernanceRequest, res: Response) => {
      const stripeKey = getStripeSecretKey();
      const isValidSecretFormat = Boolean(
        stripeKey && (stripeKey.startsWith('sk_') || stripeKey.startsWith('rk_'))
      );
      res.json({
        configured: isValidSecretFormat,
        invalidFormat: Boolean(stripeKey && !isValidSecretFormat),
        webhookConfigured: Boolean(getStripeWebhookSecret()),
        mode:
          stripeKey?.startsWith('sk_live_') || stripeKey?.startsWith('rk_live_')
            ? 'live'
            : stripeKey?.startsWith('sk_test_') || stripeKey?.startsWith('rk_test_')
            ? 'test'
            : 'unconfigured',
      });
    }
  );

  router.post(
    '/api/create-checkout-session',
    requireAuthenticatedCaller(getAuthVerifier),
    commerceWriteLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      const scopedOperator = isScopedInternalCaller(caller);

      if (caller.scopeError || caller.hasExplicitEmptyBusinessList) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error: caller.scopeError || 'Caller has invalid or empty business scope.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !commerceStore.configured
      ) {
        res.status(503).json({
          success: false,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error:
            orderStore.reason ||
            commerceStore.reason ||
            'Authoritative commerce/order stores are not configured (fail-closed).',
        });
        return;
      }

      const stripeKey = getStripeSecretKey();
      if (!stripeKey) {
        res.status(503).json({
          success: false,
          code: 'STRIPE_UNCONFIGURED',
          missingSecret: true,
          error: 'STRIPE_SECRET_KEY is not configured in server environment secrets.',
        });
        return;
      }

      const body = (req.body || {}) as Record<string, any>;

      // Reject arbitrary client-supplied pricing, currency, or Stripe priceId overrides
      if (
        body.priceAmount !== undefined ||
        body.priceId !== undefined ||
        body.amount !== undefined ||
        body.amountCents !== undefined ||
        body.unit_amount !== undefined ||
        body.currency !== undefined
      ) {
        res.status(400).json({
          success: false,
          code: 'CLIENT_PRICE_OVERRIDE_FORBIDDEN',
          error:
            'Client-supplied priceAmount, priceId, amount, and currency overrides are prohibited; checkout pricing is derived strictly from authoritative server records.',
        });
        return;
      }

      const productId = typeof body.productId === 'string' ? body.productId.trim() : '';
      const requestedBusinessId =
        typeof body.businessId === 'string' ? body.businessId.trim() : '';

      if (!productId) {
        res.status(400).json({
          success: false,
          code: 'MISSING_PRODUCT_ID',
          error: 'Authoritative productId is required to create a checkout session.',
        });
        return;
      }

      const product = await commerceStore.getProductById(productId);
      if (!product) {
        res.status(404).json({
          success: false,
          code: 'PRODUCT_NOT_FOUND',
          error: 'Authoritative product record not found.',
        });
        return;
      }

      if (
        requestedBusinessId &&
        requestedBusinessId !== product.businessId &&
        requestedBusinessId !== product.businessRecordId
      ) {
        res.status(403).json({
          success: false,
          code: 'BUSINESS_MISMATCH',
          error: 'Requested businessId does not match authoritative product business.',
        });
        return;
      }

      let effectiveOwnerId = product.ownerId ?? caller.userId;
      let effectiveTenantId = product.tenantId || effectiveOwnerId || caller.userId;
      let effectiveBusinessId = product.businessRecordId || product.businessId;

      if (scopedOperator) {
        const callerScope = validateCallerHasScope(caller);
        if (!callerScope.authorized) {
          res.status(403).json({
            success: false,
            code: 'CALLER_SCOPE_MISSING',
            error: callerScope.reason || 'Caller lacks verifiable tenant or business scope.',
          });
          return;
        }

        const membership = await orderStore.verifyCallerBusinessAccess({
          businessId: product.businessId,
          caller,
        });
        if (!membership.authorized) {
          res.status(403).json({
            success: false,
            code: 'BUSINESS_ACCESS_DENIED',
            error: membership.reason || 'Caller is not authorized for the target business.',
          });
          return;
        }

        const scopeAuth = isCallerAuthorizedForScope(
          caller,
          {
            ownerId: product.ownerId ?? membership.ownerId,
            tenantId: product.tenantId ?? membership.tenantId,
            businessId: product.businessId,
            requireStoredTenantOrOwnerScope: true,
          },
          membership
        );
        if (!scopeAuth.authorized) {
          res.status(403).json({
            success: false,
            code: 'CROSS_TENANT_FORBIDDEN',
            error: scopeAuth.reason || 'Cross-tenant checkout creation denied.',
          });
          return;
        }

        effectiveBusinessId = membership.businessRecordId || product.businessRecordId || product.businessId;
        effectiveOwnerId = product.ownerId ?? membership.ownerId ?? caller.userId;
        effectiveTenantId =
          product.tenantId || membership.tenantId || effectiveOwnerId || caller.userId;
      } else {
        // C3: External buyer path requires valid published product with verifiable business scope
        if (!product.ownerId && !product.tenantId) {
          res.status(403).json({
            success: false,
            code: 'PRODUCT_SCOPE_MISSING',
            error: 'Product lacks verifiable business ownership scope.',
          });
          return;
        }
      }

      if (product.status !== 'published') {
        res.status(403).json({
          success: false,
          code: 'PRODUCT_NOT_PUBLISHED',
          error: `Product "${product.productId}" cannot be purchased in status "${product.status}".`,
        });
        return;
      }

      if (product.billingType === 'free' || product.priceCents < 50) {
        res.status(400).json({
          success: false,
          code: 'INVALID_PRODUCT_PRICE',
          error: 'Checkout requires an authoritative product price of at least 50 cents.',
        });
        return;
      }

      const productCurrency = String(product.currency || 'USD').trim().toUpperCase();
      if (!SUPPORTED_REFUND_CURRENCIES.has(productCurrency)) {
        res.status(400).json({
          success: false,
          code: 'UNSUPPORTED_CURRENCY',
          error: `Unsupported product currency "${productCurrency}".`,
        });
        return;
      }

      const allowedOrigins = getAllowedOrigins();
      const defaultOrigin = allowedOrigins[0] || 'http://localhost:3000';

      let resolvedSuccessUrl = `${defaultOrigin}/success?productId=${encodeURIComponent(product.productId)}&session_id={CHECKOUT_SESSION_ID}`;
      let resolvedCancelUrl = `${defaultOrigin}/?checkout=cancelled&productId=${encodeURIComponent(product.productId)}`;

      if (body.successUrl !== undefined) {
        if (typeof body.successUrl !== 'string') {
          res.status(400).json({
            success: false,
            code: 'INVALID_REDIRECT_URL',
            error: 'successUrl must be a string URL within an approved origin.',
          });
          return;
        }
        const check = validateApprovedRedirectUrl(body.successUrl, allowedOrigins);
        if (!check.valid || !check.normalizedUrl) {
          res.status(400).json({
            success: false,
            code: 'INVALID_REDIRECT_URL',
            error: check.reason || 'Disallowed successUrl origin.',
          });
          return;
        }
        resolvedSuccessUrl = check.normalizedUrl;
      }

      if (body.cancelUrl !== undefined) {
        if (typeof body.cancelUrl !== 'string') {
          res.status(400).json({
            success: false,
            code: 'INVALID_REDIRECT_URL',
            error: 'cancelUrl must be a string URL within an approved origin.',
          });
          return;
        }
        const check = validateApprovedRedirectUrl(body.cancelUrl, allowedOrigins);
        if (!check.valid || !check.normalizedUrl) {
          res.status(400).json({
            success: false,
            code: 'INVALID_REDIRECT_URL',
            error: check.reason || 'Disallowed cancelUrl origin.',
          });
          return;
        }
        resolvedCancelUrl = check.normalizedUrl;
      }

      const billingType: 'one_time' | 'monthly' | 'yearly' =
        product.billingType === 'monthly'
          ? 'monthly'
          : product.billingType === 'yearly'
          ? 'yearly'
          : 'one_time';
      const isRecurring = billingType === 'monthly' || billingType === 'yearly';

      const stripe = stripeFactory(stripeKey);

      // C3: Validate stripe_price_id parity with authoritative DB product pricing/currency/billingType
      if (product.stripePriceId && stripe.retrievePrice) {
        try {
          const remotePrice = await stripe.retrievePrice(product.stripePriceId);
          const expectedInterval =
            billingType === 'monthly' ? 'month' : billingType === 'yearly' ? 'year' : null;
          if (
            !remotePrice.active ||
            remotePrice.currency !== productCurrency ||
            remotePrice.unit_amount !== product.priceCents ||
            (remotePrice.recurring_interval ?? null) !== expectedInterval
          ) {
            res.status(409).json({
              success: false,
              code: 'STRIPE_PRICE_MISMATCH',
              error:
                'Product stripe_price_id does not match authoritative database amount, currency, or interval.',
            });
            return;
          }
        } catch (priceErr: any) {
          res.status(502).json({
            success: false,
            code: 'STRIPE_PRICE_LOOKUP_FAILED',
            error: priceErr?.message || 'Failed to validate configured Stripe Price ID.',
          });
          return;
        }
      }

      const orderId = commerceStore.reserveOrderId();
      const orderNumber = `ORD-STR-${orderId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;

      let createdStripeSessionId: string | null = null;
      try {
        const stripeSession = await stripe.createCheckoutSession({
          mode: isRecurring ? 'subscription' : 'payment',
          successUrl: resolvedSuccessUrl,
          cancelUrl: resolvedCancelUrl,
          currency: productCurrency,
          unitAmountCents: product.priceCents,
          productName: product.name,
          productDescription: product.description,
          stripePriceId: product.stripePriceId || null,
          recurringInterval:
            billingType === 'yearly' ? 'year' : billingType === 'monthly' ? 'month' : undefined,
          metadata: {
            userId: caller.userId,
            businessId: effectiveBusinessId,
            productId: product.productId,
            orderId,
            tenantId: effectiveTenantId,
            expectedAmountCents: String(product.priceCents),
            currency: productCurrency,
          },
        });

        createdStripeSessionId = stripeSession.id;
        const now = getNow();

        await commerceStore.createCheckoutSessionRecord({
          sessionId: stripeSession.id,
          orderId,
          orderNumber,
          createdByUserId: caller.userId,
          createdByEmail: caller.email ?? null,
          ownerId: effectiveOwnerId,
          tenantId: effectiveTenantId,
          businessId: effectiveBusinessId,
          productId: product.productId,
          expectedAmountCents: product.priceCents,
          currency: productCurrency,
          billingType,
          expiresAt: new Date(now.getTime() + CHECKOUT_SESSION_EXPIRY_MS).toISOString(),
          nowIso: now.toISOString(),
        });

        res.json({
          success: true,
          url: stripeSession.url,
          sessionId: stripeSession.id,
          orderId,
          businessId: effectiveBusinessId,
          productId: product.productId,
          amountCents: product.priceCents,
          currency: productCurrency,
        });
      } catch (err: any) {
        // C3: Compensating expire so a DB failure never leaves an orphan live Stripe Checkout Session
        if (createdStripeSessionId && stripe.expireCheckoutSession) {
          await stripe.expireCheckoutSession(createdStripeSessionId).catch(() => {});
        }
        res.status(500).json({
          success: false,
          error: err?.message || 'Failed to create Stripe checkout session.',
        });
      }
    }
  );

  router.get(
    '/api/verify-session',
    requireAuthenticatedCaller(getAuthVerifier),
    commerceReadLimit,
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller!;
      if (caller.scopeError || caller.hasExplicitEmptyBusinessList) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error: caller.scopeError || 'Caller has invalid or empty business scope.',
        });
        return;
      }

      const sessionId =
        typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
      if (!sessionId || !SESSION_ID_REGEX.test(sessionId)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_SESSION_ID',
          error: 'Missing or malformed Stripe checkout session_id.',
        });
        return;
      }

      const orderStore = getOrderStore();
      const commerceStore = getCommerceStore();
      if (
        !orderStore.configured ||
        !orderStore.verifyCallerBusinessAccess ||
        !commerceStore.configured
      ) {
        res.status(503).json({
          success: false,
          code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
          error:
            orderStore.reason ||
            commerceStore.reason ||
            'Authoritative order/commerce stores are not configured (fail-closed).',
        });
        return;
      }

      const stripeKey = getStripeSecretKey();
      if (!stripeKey) {
        res.status(503).json({
          success: false,
          code: 'STRIPE_UNCONFIGURED',
          missingSecret: true,
          error: 'STRIPE_SECRET_KEY is not configured in server environment secrets.',
        });
        return;
      }

      // Check local authoritative session binding BEFORE hitting Stripe API (blocks enumeration)
      const stored = await commerceStore.getCheckoutSessionById(sessionId);
      if (!stored) {
        res.status(404).json({
          success: false,
          code: 'SESSION_NOT_FOUND',
          error: 'Checkout session not found or unauthorized.',
        });
        return;
      }

      const isCreator = stored.createdByUserId === caller.userId;
      const scopedOperator = isScopedInternalCaller(caller);

      let membershipBusinessRecordId: string | undefined;

      if (scopedOperator || !isCreator) {
        const callerScope = validateCallerHasScope(caller);
        if (!callerScope.authorized) {
          res.status(403).json({
            success: false,
            code: 'SESSION_OWNERSHIP_REQUIRED',
            error: 'Only the session creator or verified business owner may verify this checkout session.',
          });
          return;
        }

        const membership = await orderStore.verifyCallerBusinessAccess({
          businessId: stored.businessId,
          caller,
        });
        if (!membership.authorized) {
          res.status(403).json({
            success: false,
            code: 'CROSS_TENANT_FORBIDDEN',
            error: 'Caller is not authorized to verify sessions for this business.',
          });
          return;
        }

        membershipBusinessRecordId = membership.businessRecordId;

        const scopeAuth = isCallerAuthorizedForScope(
          caller,
          {
            ownerId: stored.ownerId ?? membership.ownerId,
            tenantId: stored.tenantId ?? membership.tenantId,
            businessId: stored.businessId,
            requireStoredTenantOrOwnerScope: true,
          },
          membership
        );
        if (!scopeAuth.authorized) {
          res.status(403).json({
            success: false,
            code: 'CROSS_TENANT_FORBIDDEN',
            error: scopeAuth.reason || 'Cross-tenant session verification denied.',
          });
          return;
        }

        const isBusinessOwner =
          caller.roles.includes('owner') &&
          membership.membershipRole === 'owner' &&
          (stored.ownerId === caller.userId || membership.ownerId === caller.userId);
        if (!isCreator && !isBusinessOwner) {
          res.status(403).json({
            success: false,
            code: 'SESSION_OWNERSHIP_REQUIRED',
            error: 'Only the session creator or verified business owner may verify this checkout session.',
          });
          return;
        }
      }

      try {
        const stripe = stripeFactory(stripeKey);
        const stripeSession = await stripe.retrieveCheckoutSession(sessionId);

        if (stripeSession.payment_status !== 'paid') {
          res.status(400).json({
            success: false,
            paymentStatus: stripeSession.payment_status || 'unpaid',
            error: 'Payment has not been completed in Stripe.',
          });
          return;
        }

        const stripeCurrency = String(stripeSession.currency || '').trim().toUpperCase();
        const stripeAmount = stripeSession.amount_total;
        const meta = stripeSession.metadata || {};

        if (
          typeof stripeAmount !== 'number' ||
          !Number.isInteger(stripeAmount) ||
          stripeAmount !== stored.expectedAmountCents
        ) {
          res.status(409).json({
            success: false,
            code: 'PAYMENT_AMOUNT_MISMATCH',
            error: 'Verified Stripe amount does not match bound product price.',
          });
          return;
        }

        if (!stripeCurrency || stripeCurrency !== stored.currency.toUpperCase()) {
          res.status(409).json({
            success: false,
            code: 'PAYMENT_CURRENCY_MISMATCH',
            error: 'Verified Stripe currency does not match bound product currency.',
          });
          return;
        }

        if (
          (meta.businessId &&
            meta.businessId !== stored.businessId &&
            meta.businessId !== membershipBusinessRecordId) ||
          (meta.productId && meta.productId !== stored.productId) ||
          (meta.orderId && meta.orderId !== stored.orderId) ||
          (meta.userId && meta.userId !== stored.createdByUserId)
        ) {
          res.status(409).json({
            success: false,
            code: 'SESSION_BINDING_MISMATCH',
            error:
              'Stripe session metadata does not match server-bound user, business, product, or order.',
          });
          return;
        }

        const paymentIntentId =
          typeof stripeSession.payment_intent === 'string'
            ? stripeSession.payment_intent
            : stripeSession.payment_intent?.id || null;

        const paidRes = await commerceStore.markCheckoutSessionPaid({
          sessionId,
          paymentIntentId,
          paidAt: getNow().toISOString(),
          amountTotalCents: stripeAmount,
          currency: stripeCurrency,
        });

        if (!paidRes.ok) {
          res.status(409).json({
            success: false,
            code: 'SETTLEMENT_PERSISTENCE_FAILED',
            error: paidRes.reason || 'Failed to finalize verified checkout session.',
          });
          return;
        }

        res.json({
          success: true,
          paymentStatus: 'paid',
          customerEmail: stripeSession.customer_details?.email || null,
          customerName: stripeSession.customer_details?.name || null,
          contentId: stored.productId,
          productId: stored.productId,
          orderId: stored.orderId,
          businessId: stored.businessId,
          currency: stored.currency,
          amountTotal: stored.expectedAmountCents / 100,
        });
      } catch (err: any) {
        res.status(502).json({
          success: false,
          error: err?.message || 'Stripe session verification failed.',
        });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // C3: Signed Stripe Webhook Fulfillment, Expiry & Refund Sync
  // ---------------------------------------------------------------------------
  const handleStripeWebhook = async (req: Request, res: Response) => {
    const stripeKey = getStripeSecretKey();
    const webhookSecret = getStripeWebhookSecret();
    if (!stripeKey || !webhookSecret) {
      res.status(503).json({
        success: false,
        code: 'STRIPE_WEBHOOK_UNCONFIGURED',
        error: 'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required (fail-closed).',
      });
      return;
    }

    const commerceStore = getCommerceStore();
    if (!commerceStore.configured) {
      res.status(503).json({
        success: false,
        code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
        error: commerceStore.reason || 'Authoritative commerce store is not configured.',
      });
      return;
    }

    const signature =
      typeof req.headers['stripe-signature'] === 'string'
        ? req.headers['stripe-signature'].trim()
        : '';
    if (!signature) {
      res.status(401).json({
        success: false,
        code: 'MISSING_STRIPE_SIGNATURE',
        error: 'Missing Stripe-Signature header.',
      });
      return;
    }

    const rawBody = (req as any).rawBody as Buffer | string | undefined;
    if (!rawBody) {
      res.status(400).json({
        success: false,
        code: 'MISSING_RAW_BODY',
        error: 'Raw request body buffer is required for Stripe webhook verification.',
      });
      return;
    }

    const stripe = stripeFactory(stripeKey);
    if (!stripe.constructWebhookEvent) {
      res.status(503).json({
        success: false,
        code: 'WEBHOOK_VERIFIER_UNAVAILABLE',
        error: 'Stripe webhook signature verifier is unavailable.',
      });
      return;
    }

    let event: Stripe.Event;
    try {
      event = stripe.constructWebhookEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      res.status(401).json({
        success: false,
        code: 'INVALID_STRIPE_SIGNATURE',
        error: err?.message || 'Stripe webhook signature verification failed.',
      });
      return;
    }

    const nowIso = getNow().toISOString();

    try {
      if (
        event.type === 'checkout.session.completed' ||
        event.type === 'checkout.session.async_payment_succeeded'
      ) {
        const sessionObj = event.data.object as Stripe.Checkout.Session;
        const stored = await commerceStore.getCheckoutSessionById(sessionObj.id);
        if (!stored) {
          res.status(200).json({ received: true, ignored: 'UNKNOWN_SESSION' });
          return;
        }

        if (commerceStore.recordStripeWebhookEvent) {
          const idem = await commerceStore.recordStripeWebhookEvent({
            eventId: event.id,
            eventType: event.type,
            stripeObjectId: sessionObj.id,
            sessionId: sessionObj.id,
            paymentIntentId:
              typeof sessionObj.payment_intent === 'string'
                ? sessionObj.payment_intent
                : sessionObj.payment_intent?.id || null,
            businessId: stored.businessId,
            orderId: stored.orderId,
            status: 'processed',
          });
          if (idem.alreadyProcessed) {
            res.json({ received: true, duplicate: true });
            return;
          }
        }

        if (sessionObj.payment_status === 'paid') {
          const paidAmount = Number(sessionObj.amount_total ?? -1);
          const paidCurrency = String(sessionObj.currency || '').trim().toUpperCase();
          const paymentIntentId =
            typeof sessionObj.payment_intent === 'string'
              ? sessionObj.payment_intent
              : sessionObj.payment_intent?.id || null;

          const settleRes = await commerceStore.markCheckoutSessionPaid({
            sessionId: sessionObj.id,
            paymentIntentId,
            paidAt: nowIso,
            amountTotalCents: paidAmount,
            currency: paidCurrency,
          });
          if (!settleRes.ok) {
            res.status(409).json({
              success: false,
              code: 'WEBHOOK_SETTLEMENT_CONFLICT',
              error: settleRes.reason || 'Webhook settlement failed.',
            });
            return;
          }
        }

        res.json({ received: true, eventId: event.id, handled: event.type });
        return;
      }

      if (
        event.type === 'checkout.session.expired' ||
        event.type === 'checkout.session.async_payment_failed'
      ) {
        const sessionObj = event.data.object as Stripe.Checkout.Session;
        const stored = await commerceStore.getCheckoutSessionById(sessionObj.id);
        if (stored) {
          if (commerceStore.recordStripeWebhookEvent) {
            const idem = await commerceStore.recordStripeWebhookEvent({
              eventId: event.id,
              eventType: event.type,
              stripeObjectId: sessionObj.id,
              sessionId: sessionObj.id,
              businessId: stored.businessId,
              orderId: stored.orderId,
              status: 'processed',
            });
            if (idem.alreadyProcessed) {
              res.json({ received: true, duplicate: true });
              return;
            }
          }

          if (commerceStore.markCheckoutSessionTerminal) {
            await commerceStore.markCheckoutSessionTerminal({
              sessionId: sessionObj.id,
              status:
                event.type === 'checkout.session.expired' ? 'expired' : 'failed',
              updatedAt: nowIso,
            });
          }
        }
        res.json({ received: true, eventId: event.id, handled: event.type });
        return;
      }

      if (event.type === 'charge.refunded') {
        const chargeObj = event.data.object as Stripe.Charge;
        const paymentIntentId =
          typeof chargeObj.payment_intent === 'string'
            ? chargeObj.payment_intent
            : chargeObj.payment_intent?.id || '';
        const refundedCents = Number(chargeObj.amount_refunded ?? 0);

        if (commerceStore.recordStripeWebhookEvent) {
          const idem = await commerceStore.recordStripeWebhookEvent({
            eventId: event.id,
            eventType: event.type,
            stripeObjectId: chargeObj.id,
            paymentIntentId: paymentIntentId || null,
            status: 'processed',
          });
          if (idem.alreadyProcessed) {
            res.json({ received: true, duplicate: true });
            return;
          }
        }

        if (paymentIntentId && commerceStore.recordStripeChargeRefunded) {
          await commerceStore.recordStripeChargeRefunded({
            paymentIntentId,
            refundedAmountCents: refundedCents,
            refundTxId: chargeObj.id,
            refundedAt: nowIso,
          });
        }
        res.json({ received: true, eventId: event.id, handled: event.type });
        return;
      }

      res.json({ received: true, eventId: event.id, ignored: event.type });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err?.message || 'Stripe webhook processing error.',
      });
    }
  };

  router.post('/api/stripe/webhook', webhookLimit, handleStripeWebhook);
  router.post('/api/webhooks/stripe', webhookLimit, handleStripeWebhook);

  // ---------------------------------------------------------------------------
  // H4-C & C4: Hardened Gumroad Webhook (Header Secret OR Seller ID + API Verify)
  // ---------------------------------------------------------------------------
  router.post('/api/gumroad/webhook', webhookLimit, async (req: Request, res: Response) => {
    // Strictly reject query-string secrets (?secret=...) to prevent URL/log leakage
    if (req.query && Object.prototype.hasOwnProperty.call(req.query, 'secret')) {
      res.status(401).json({
        success: false,
        code: 'QUERY_SECRET_PROHIBITED',
        error: 'Query-string webhook secrets are not accepted; provide x-gumroad-secret header or Seller API verification.',
      });
      return;
    }

    const configuredSecret = getGumroadWebhookSecret();
    const configuredSellerId = getGumroadSellerId();
    const verifySaleByIdFn = gumroad.verifySaleById;

    const pingApiVerifyConfigured = Boolean(configuredSellerId && verifySaleByIdFn);
    if (!configuredSecret && !pingApiVerifyConfigured) {
      res.status(503).json({
        success: false,
        code: 'WEBHOOK_SECRET_UNCONFIGURED',
        error:
          'Neither GUMROAD_WEBHOOK_SECRET nor GUMROAD_SELLER_ID + Gumroad API verification is configured (fail-closed).',
      });
      return;
    }

    const body = (req.body || {}) as Record<string, any>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({
        success: false,
        code: 'INVALID_WEBHOOK_PAYLOAD',
        error: 'Webhook body must be a JSON/form object.',
      });
      return;
    }

    const providedHeaderSecret = extractHeaderSecret(req);
    const providedSellerId =
      typeof body.seller_id === 'string' ? body.seller_id.trim() : '';

    let authenticatedVia: 'header_secret' | 'gumroad_ping_api' | null = null;
    let verifiedRemoteSale: NormalizedGumroadSale | undefined;

    if (providedHeaderSecret) {
      if (configuredSecret && timingSafeCompareSecret(configuredSecret, providedHeaderSecret)) {
        authenticatedVia = 'header_secret';
      } else {
        res.status(401).json({
          success: false,
          code: 'INVALID_WEBHOOK_SECRET',
          error: 'Invalid or missing x-gumroad-secret header.',
        });
        return;
      }
    } else if (
      pingApiVerifyConfigured &&
      providedSellerId &&
      timingSafeCompareSecret(configuredSellerId!, providedSellerId)
    ) {
      const candidateSaleId =
        typeof body.sale_id === 'string'
          ? body.sale_id.trim()
          : typeof body.order_number === 'string'
          ? body.order_number.trim()
          : '';
      if (!candidateSaleId) {
        res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_PAYLOAD',
          error: 'Valid sale_id (or order_number) is required for Gumroad Ping verification.',
        });
        return;
      }

      const verifyRes = await verifySaleByIdFn!(candidateSaleId);
      if (
        !verifyRes.verified ||
        !verifyRes.sale ||
        (verifyRes.sellerId &&
          !timingSafeCompareSecret(configuredSellerId!, verifyRes.sellerId))
      ) {
        res.status(401).json({
          success: false,
          code: 'INVALID_GUMROAD_PING',
          error: verifyRes.error || 'Gumroad Ping could not be verified against Gumroad Sales API.',
        });
        return;
      }
      authenticatedVia = 'gumroad_ping_api';
      verifiedRemoteSale = verifyRes.sale;
    }

    if (!authenticatedVia) {
      res.status(401).json({
        success: false,
        code: 'INVALID_WEBHOOK_SECRET',
        error: 'Missing valid x-gumroad-secret header or verifiable Gumroad Ping seller_id.',
      });
      return;
    }

    const commerceStore = getCommerceStore();
    if (!commerceStore.configured) {
      res.status(503).json({
        success: false,
        code: 'AUTHORITATIVE_STORE_UNCONFIGURED',
        error:
          commerceStore.reason ||
          'Authoritative commerce store is not configured (fail-closed).',
      });
      return;
    }

    let normalized: NormalizedGumroadSale;
    if (verifiedRemoteSale) {
      // Authoritative remote sale takes precedence for product_id, price, refunded state
      normalized = {
        ...verifiedRemoteSale,
        refunded:
          verifiedRemoteSale.refunded ||
          body.refunded === true ||
          body.refunded === 'true',
        source: 'webhook',
      };
    } else {
      const rawSaleId =
        typeof body.sale_id === 'string'
          ? body.sale_id.trim()
          : typeof body.order_number === 'string'
          ? body.order_number.trim()
          : '';
      const rawProductId = typeof body.product_id === 'string' ? body.product_id.trim() : '';
      const rawEmail = typeof body.email === 'string' ? body.email.trim() : '';

      if (
        !rawSaleId ||
        rawSaleId.length > 128 ||
        !rawProductId ||
        rawProductId.length > 128
      ) {
        res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_PAYLOAD',
          error: 'Valid sale_id (or order_number) and product_id are required.',
        });
        return;
      }

      if (rawEmail && (rawEmail.length > 254 || !EMAIL_REGEX.test(rawEmail))) {
        res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_PAYLOAD',
          error: 'Malformed buyer email in webhook payload.',
        });
        return;
      }

      const parsedPriceCents = Number(body.price);
      if (
        body.price === undefined ||
        !Number.isFinite(parsedPriceCents) ||
        parsedPriceCents < 0 ||
        parsedPriceCents > 100_000_000
      ) {
        res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_PAYLOAD',
          error: 'Valid non-negative numeric price (cents) is required.',
        });
        return;
      }

      const rawCurrency =
        typeof body.currency === 'string' && body.currency.trim()
          ? body.currency.trim().toUpperCase()
          : 'USD';
      if (!/^[A-Z]{3}$/.test(rawCurrency)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_PAYLOAD',
          error: 'Invalid 3-letter ISO currency code.',
        });
        return;
      }

      const rawRefunded = body.refunded;
      if (
        rawRefunded !== undefined &&
        rawRefunded !== true &&
        rawRefunded !== false &&
        rawRefunded !== 'true' &&
        rawRefunded !== 'false'
      ) {
        res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_PAYLOAD',
          error: 'refunded must be a boolean if provided.',
        });
        return;
      }

      const createdAtRaw =
        typeof body.sale_timestamp === 'string' && body.sale_timestamp.trim()
          ? body.sale_timestamp.trim()
          : getNow().toISOString();
      if (parseStrictIsoTimestamp(createdAtRaw) === null) {
        res.status(400).json({
          success: false,
          code: 'INVALID_WEBHOOK_PAYLOAD',
          error: 'Malformed ISO-8601 sale_timestamp.',
        });
        return;
      }

      normalized = {
        saleId: rawSaleId,
        gumroadProductId: rawProductId,
        productName:
          typeof body.product_name === 'string' && body.product_name.trim()
            ? body.product_name.trim().slice(0, 200)
            : 'Gumroad Digital Product',
        buyerName:
          typeof body.full_name === 'string' && body.full_name.trim()
            ? body.full_name.trim().slice(0, 160)
            : typeof body.purchaser_id === 'string' && body.purchaser_id.trim()
            ? body.purchaser_id.trim().slice(0, 160)
            : 'Gumroad Buyer',
        buyerEmail: rawEmail || 'buyer@gumroad.verified',
        amountDollars: Math.round(parsedPriceCents) / 100,
        currency: rawCurrency,
        refunded: rawRefunded === true || rawRefunded === 'true',
        createdAt: createdAtRaw,
        source: 'webhook',
      };
    }

    try {
      await commerceStore.recordGumroadWebhookSale(normalized);
      res.json({
        success: true,
        saleId: normalized.saleId,
        gumroadProductId: normalized.gumroadProductId,
        authenticatedVia,
      });
    } catch (err: any) {
      const msg = String(err?.message || '');
      if (err?.code === 'UNLINKED_GUMROAD_PRODUCT' || msg.includes('UNLINKED_GUMROAD_PRODUCT')) {
        res.status(404).json({
          success: false,
          code: 'UNLINKED_GUMROAD_PRODUCT',
          error: msg || 'No authoritative product is bound to this Gumroad product_id.',
        });
        return;
      }
      res.status(500).json({
        success: false,
        error: msg || 'Failed to record Gumroad webhook sale.',
      });
    }
  });

  return router;
}
