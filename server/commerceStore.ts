import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedGumroadSale } from './gumroad';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuthoritativeProductRecord {
  readonly productId: string;
  readonly businessId: string;
  readonly businessRecordId?: string;
  readonly ownerId: string | null;
  readonly tenantId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly type: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly billingType: 'one_time' | 'monthly' | 'yearly' | 'free' | string;
  readonly status: 'draft' | 'awaiting_approval' | 'published' | 'archived' | string;
  readonly stripePriceId?: string | null;
  readonly gumroadProductId?: string | null;
  readonly gumroadUrl?: string | null;
  readonly publishedApprovalId?: string | null;
  readonly customDeliverySummary?: string | null;
  readonly salesCount?: number;
  readonly totalRevenueCents?: number;
}

export interface AuthoritativePublishApprovalRecord {
  readonly approvalId: string;
  readonly productId: string;
  readonly businessId: string;
  readonly ownerId: string | null;
  readonly tenantId: string | null;
  readonly approvedByUserId: string;
  readonly status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'revoked'
    | 'consumed'
    | 'expired'
    | string;
  readonly decisionNote?: string | null;
  readonly expiresAt: string;
  readonly consumedAt?: string | null;
  readonly createdAt: string;
}

export interface AuthoritativeCheckoutSessionRecord {
  readonly sessionId: string;
  readonly createdByUserId: string;
  readonly ownerId: string | null;
  readonly tenantId: string;
  readonly businessId: string;
  readonly productId: string;
  readonly orderId: string;
  readonly expectedAmountCents: number;
  readonly currency: string;
  readonly billingType: 'one_time' | 'monthly' | 'yearly' | string;
  readonly status: 'created' | 'paid' | 'expired' | 'failed' | 'cancelled' | string;
  readonly stripePaymentIntentId?: string | null;
  readonly verifiedAt?: string | null;
  readonly expiresAt?: string | null;
  readonly createdAt: string;
}

export interface CreatePublishApprovalInput {
  readonly approvalId?: string;
  readonly productId: string;
  readonly businessId: string;
  readonly ownerId: string | null;
  readonly tenantId: string;
  readonly approvedByUserId: string;
  readonly decisionNote?: string | null;
  readonly expiresAt: string;
  readonly nowIso: string;
  readonly replaceExisting?: boolean;
}

export interface ConsumeGumroadPublishInput {
  readonly approvalId: string;
  readonly productId: string;
  readonly businessId: string;
  readonly gumroadProductId: string;
  readonly gumroadUrl: string;
  readonly consumedAt: string;
}

export interface ConsumeProductPublishInput {
  readonly approvalId: string;
  readonly productId: string;
  readonly businessId: string;
  readonly stripePriceId?: string | null;
  readonly consumedAt: string;
}

export interface UpdateProductPricingInput {
  readonly productId: string;
  readonly businessId: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly billingType: 'one_time' | 'monthly' | 'yearly' | 'free';
  readonly stripePriceId?: string | null;
  readonly updatedAt: string;
}

export interface CreateCheckoutSessionBindingInput {
  readonly sessionId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly createdByUserId: string;
  readonly createdByEmail?: string | null;
  readonly ownerId: string | null;
  readonly tenantId: string;
  readonly businessId: string;
  readonly productId: string;
  readonly expectedAmountCents: number;
  readonly currency: string;
  readonly billingType: 'one_time' | 'monthly' | 'yearly';
  readonly expiresAt?: string | null;
  readonly nowIso: string;
}

export interface MarkCheckoutSessionPaidInput {
  readonly sessionId: string;
  readonly paymentIntentId?: string | null;
  readonly paidAt: string;
  readonly amountTotalCents: number;
  readonly currency: string;
}

export interface AuthoritativeCommerceStore {
  readonly configured: boolean;
  readonly reason?: string;
  getProductById(productId: string): Promise<AuthoritativeProductRecord | null>;
  listGumroadLinkedProductsForBusinesses(
    businessIds: ReadonlyArray<string>
  ): Promise<AuthoritativeProductRecord[]>;
  findProductByGumroadProductId(
    gumroadProductId: string
  ): Promise<AuthoritativeProductRecord | null>;
  createProductPublishApproval(
    input: CreatePublishApprovalInput
  ): Promise<AuthoritativePublishApprovalRecord>;
  getProductPublishApproval(
    approvalId: string
  ): Promise<AuthoritativePublishApprovalRecord | null>;
  revokeProductPublishApproval?(input: {
    approvalId: string;
    businessId: string;
    nowIso?: string;
  }): Promise<{
    status: 'revoked' | 'not_found' | 'already_consumed' | 'already_revoked' | 'invalid_state';
    approval?: AuthoritativePublishApprovalRecord;
  }>;
  consumeAndLinkGumroadPublish(
    input: ConsumeGumroadPublishInput
  ): Promise<{ ok: boolean; reason?: string }>;
  consumeAndPublishProduct?(
    input: ConsumeProductPublishInput
  ): Promise<{ ok: boolean; reason?: string }>;
  updateProductPricing?(
    input: UpdateProductPricingInput
  ): Promise<AuthoritativeProductRecord>;
  reserveOrderId(): string;
  createCheckoutSessionRecord(
    input: CreateCheckoutSessionBindingInput
  ): Promise<AuthoritativeCheckoutSessionRecord>;
  getCheckoutSessionById(
    sessionId: string
  ): Promise<AuthoritativeCheckoutSessionRecord | null>;
  markCheckoutSessionPaid(
    input: MarkCheckoutSessionPaidInput
  ): Promise<{ ok: boolean; session?: AuthoritativeCheckoutSessionRecord; reason?: string }>;
  markCheckoutSessionTerminal?(input: {
    sessionId: string;
    status: 'expired' | 'failed' | 'cancelled';
    updatedAt: string;
  }): Promise<{ ok: boolean; reason?: string }>;
  recordStripeWebhookEvent?(input: {
    eventId: string;
    eventType: string;
    stripeObjectId?: string | null;
    sessionId?: string | null;
    paymentIntentId?: string | null;
    businessId?: string | null;
    orderId?: string | null;
    status?: 'processed' | 'ignored' | 'failed';
    payloadSummary?: Record<string, unknown>;
  }): Promise<{ alreadyProcessed: boolean }>;
  recordStripeChargeRefunded?(input: {
    paymentIntentId: string;
    refundedAmountCents: number;
    refundTxId?: string | null;
    refundedAt: string;
  }): Promise<{ ok: boolean; reason?: string }>;
  recordGumroadWebhookSale(sale: NormalizedGumroadSale): Promise<void>;
  listGumroadWebhookSalesForProducts(
    gumroadProductIds: ReadonlyArray<string>
  ): Promise<NormalizedGumroadSale[]>;
}

/**
 * Deterministic in-memory authoritative commerce store for automated H4 / Phase 0 tests.
 * Never used as a default fallback in server runtime.
 */
export function createInMemoryAuthoritativeCommerceStore(seed?: {
  products?: ReadonlyArray<AuthoritativeProductRecord>;
  publishApprovals?: ReadonlyArray<AuthoritativePublishApprovalRecord>;
  checkoutSessions?: ReadonlyArray<AuthoritativeCheckoutSessionRecord>;
  webhookSales?: ReadonlyArray<NormalizedGumroadSale>;
}): AuthoritativeCommerceStore {
  const products = new Map<string, AuthoritativeProductRecord>();
  for (const p of seed?.products ?? []) {
    products.set(p.productId, { ...p });
  }

  const approvals = new Map<string, AuthoritativePublishApprovalRecord>();
  for (const a of seed?.publishApprovals ?? []) {
    approvals.set(a.approvalId, { ...a });
  }

  const sessions = new Map<string, AuthoritativeCheckoutSessionRecord>();
  for (const s of seed?.checkoutSessions ?? []) {
    sessions.set(s.sessionId, { ...s });
  }

  const stripeEvents = new Set<string>();
  const webhookSales = new Map<string, NormalizedGumroadSale>();
  for (const w of seed?.webhookSales ?? []) {
    webhookSales.set(w.saleId, { ...w });
  }

  return {
    configured: true,

    getProductById: async (productId: string) => {
      const p = products.get(productId.trim());
      return p ? { ...p } : null;
    },

    listGumroadLinkedProductsForBusinesses: async (businessIds) => {
      const idSet = new Set(businessIds.map((b) => b.trim()).filter(Boolean));
      const out: AuthoritativeProductRecord[] = [];
      for (const p of products.values()) {
        if (
          p.gumroadProductId &&
          (idSet.has(p.businessId) ||
            (p.businessRecordId ? idSet.has(p.businessRecordId) : false))
        ) {
          out.push({ ...p });
        }
      }
      return out;
    },

    findProductByGumroadProductId: async (gumroadProductId) => {
      const clean = gumroadProductId.trim();
      for (const p of products.values()) {
        if (p.gumroadProductId === clean) {
          return { ...p };
        }
      }
      return null;
    },

    createProductPublishApproval: async (input) => {
      // C2: Always expire stale unconsumed approvals first
      for (const [id, existing] of approvals.entries()) {
        if (
          existing.productId === input.productId &&
          existing.businessId === input.businessId &&
          (existing.status === 'pending' || existing.status === 'approved')
        ) {
          if (existing.expiresAt <= input.nowIso) {
            approvals.set(id, { ...existing, status: 'expired' });
          } else if (input.replaceExisting !== false) {
            approvals.set(id, { ...existing, status: 'revoked' });
          } else {
            throw new Error(
              `Active publish approval already exists for product "${input.productId}".`
            );
          }
        }
      }

      const approvalId = input.approvalId?.trim() || `pubappr_${crypto.randomUUID()}`;
      const record: AuthoritativePublishApprovalRecord = {
        approvalId,
        productId: input.productId,
        businessId: input.businessId,
        ownerId: input.ownerId,
        tenantId: input.tenantId,
        approvedByUserId: input.approvedByUserId,
        status: 'approved',
        decisionNote: input.decisionNote ?? 'Approved for publish',
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: input.nowIso,
      };
      approvals.set(approvalId, record);
      return { ...record };
    },

    getProductPublishApproval: async (approvalId) => {
      const a = approvals.get(approvalId.trim());
      return a ? { ...a } : null;
    },

    revokeProductPublishApproval: async ({ approvalId, businessId }) => {
      const existing = approvals.get(approvalId.trim());
      if (!existing || existing.businessId !== businessId) {
        return { status: 'not_found' };
      }
      if (existing.status === 'consumed' || existing.consumedAt) {
        return { status: 'already_consumed', approval: { ...existing } };
      }
      if (existing.status === 'revoked') {
        return { status: 'already_revoked', approval: { ...existing } };
      }
      if (existing.status !== 'pending' && existing.status !== 'approved') {
        return { status: 'invalid_state', approval: { ...existing } };
      }
      const updated: AuthoritativePublishApprovalRecord = {
        ...existing,
        status: 'revoked',
      };
      approvals.set(existing.approvalId, updated);
      return { status: 'revoked', approval: { ...updated } };
    },

    consumeAndLinkGumroadPublish: async (input) => {
      const approval = approvals.get(input.approvalId.trim());
      if (!approval) {
        return { ok: false, reason: 'Publish approval record not found.' };
      }
      if (approval.status !== 'approved' || approval.consumedAt) {
        return { ok: false, reason: 'Publish approval is not in consumable approved state.' };
      }
      if (approval.expiresAt <= input.consumedAt) {
        approvals.set(approval.approvalId, { ...approval, status: 'expired' });
        return { ok: false, reason: 'Publish approval has expired.' };
      }
      if (
        approval.productId !== input.productId ||
        approval.businessId !== input.businessId
      ) {
        return { ok: false, reason: 'Publish approval binding mismatch.' };
      }

      const product = products.get(input.productId);
      if (!product) {
        return { ok: false, reason: 'Authoritative product record not found.' };
      }

      approvals.set(approval.approvalId, {
        ...approval,
        status: 'consumed',
        consumedAt: input.consumedAt,
      });

      products.set(product.productId, {
        ...product,
        status: 'published',
        gumroadProductId: input.gumroadProductId,
        gumroadUrl: input.gumroadUrl,
        publishedApprovalId: approval.approvalId,
      });

      return { ok: true };
    },

    consumeAndPublishProduct: async (input) => {
      const approval = approvals.get(input.approvalId.trim());
      if (!approval) {
        return { ok: false, reason: 'Publish approval record not found.' };
      }
      if (approval.status !== 'approved' || approval.consumedAt) {
        return { ok: false, reason: 'Publish approval is not in consumable approved state.' };
      }
      if (approval.expiresAt <= input.consumedAt) {
        approvals.set(approval.approvalId, { ...approval, status: 'expired' });
        return { ok: false, reason: 'Publish approval has expired.' };
      }
      if (
        approval.productId !== input.productId ||
        approval.businessId !== input.businessId
      ) {
        return { ok: false, reason: 'Publish approval binding mismatch.' };
      }

      const product = products.get(input.productId);
      if (!product) {
        return { ok: false, reason: 'Authoritative product record not found.' };
      }

      approvals.set(approval.approvalId, {
        ...approval,
        status: 'consumed',
        consumedAt: input.consumedAt,
      });

      products.set(product.productId, {
        ...product,
        status: 'published',
        stripePriceId: input.stripePriceId ?? product.stripePriceId ?? null,
        publishedApprovalId: approval.approvalId,
      });

      return { ok: true };
    },

    updateProductPricing: async (input) => {
      const product = products.get(input.productId.trim());
      if (!product || product.businessId !== input.businessId) {
        throw new Error('Authoritative product record not found.');
      }
      const updated: AuthoritativeProductRecord = {
        ...product,
        priceCents: input.priceCents,
        currency: input.currency.toUpperCase(),
        billingType: input.billingType,
        stripePriceId:
          input.stripePriceId !== undefined
            ? input.stripePriceId
            : product.stripePriceId ?? null,
      };
      products.set(product.productId, updated);
      return { ...updated };
    },

    reserveOrderId: () => crypto.randomUUID(),

    createCheckoutSessionRecord: async (input) => {
      const rec: AuthoritativeCheckoutSessionRecord = {
        sessionId: input.sessionId,
        createdByUserId: input.createdByUserId,
        ownerId: input.ownerId,
        tenantId: input.tenantId,
        businessId: input.businessId,
        productId: input.productId,
        orderId: input.orderId,
        expectedAmountCents: input.expectedAmountCents,
        currency: input.currency.toUpperCase(),
        billingType: input.billingType,
        status: 'created',
        stripePaymentIntentId: null,
        verifiedAt: null,
        expiresAt: input.expiresAt ?? null,
        createdAt: input.nowIso,
      };
      sessions.set(rec.sessionId, rec);
      return { ...rec };
    },

    getCheckoutSessionById: async (sessionId) => {
      const s = sessions.get(sessionId.trim());
      return s ? { ...s } : null;
    },

    markCheckoutSessionPaid: async (input) => {
      const existing = sessions.get(input.sessionId.trim());
      if (!existing) {
        return { ok: false, reason: 'Checkout session binding record not found.' };
      }
      if (existing.expectedAmountCents !== input.amountTotalCents) {
        return {
          ok: false,
          reason: `Stripe amount_total (${input.amountTotalCents}) does not match expected amount (${existing.expectedAmountCents}).`,
        };
      }
      if (existing.currency.toUpperCase() !== input.currency.toUpperCase()) {
        return {
          ok: false,
          reason: `Stripe currency (${input.currency}) does not match expected currency (${existing.currency}).`,
        };
      }
      const wasAlreadyPaid = existing.status === 'paid';
      const updated: AuthoritativeCheckoutSessionRecord = {
        ...existing,
        status: 'paid',
        stripePaymentIntentId: input.paymentIntentId ?? existing.stripePaymentIntentId ?? null,
        verifiedAt: existing.verifiedAt ?? input.paidAt,
      };
      sessions.set(updated.sessionId, updated);
      if (!wasAlreadyPaid) {
        const linkedProd = products.get(existing.productId);
        if (linkedProd) {
          products.set(existing.productId, {
            ...linkedProd,
            salesCount: (linkedProd.salesCount || 0) + 1,
            totalRevenueCents: (linkedProd.totalRevenueCents || 0) + existing.expectedAmountCents,
          });
        }
      }
      return { ok: true, session: { ...updated } };
    },

    markCheckoutSessionTerminal: async (input) => {
      const existing = sessions.get(input.sessionId.trim());
      if (!existing) {
        return { ok: false, reason: 'Checkout session binding record not found.' };
      }
      if (existing.status === 'paid') {
        return { ok: true };
      }
      sessions.set(existing.sessionId, {
        ...existing,
        status: input.status,
      });
      return { ok: true };
    },

    recordStripeWebhookEvent: async (input) => {
      if (stripeEvents.has(input.eventId)) {
        return { alreadyProcessed: true };
      }
      stripeEvents.add(input.eventId);
      return { alreadyProcessed: false };
    },

    recordStripeChargeRefunded: async () => ({ ok: true }),

    recordGumroadWebhookSale: async (sale) => {
      let linked: AuthoritativeProductRecord | null = null;
      if (sale.gumroadProductId) {
        for (const p of products.values()) {
          if (p.gumroadProductId === sale.gumroadProductId) {
            linked = p;
            break;
          }
        }
      }
      if (!linked) {
        throw new Error(
          `UNLINKED_GUMROAD_PRODUCT: No Nexus product is linked to Gumroad product_id "${sale.gumroadProductId}".`
        );
      }
      const prevSale = webhookSales.get(sale.saleId);
      webhookSales.set(sale.saleId, { ...sale });
      const amountCents = Math.round((sale.amountDollars || 0) * 100);
      if (!prevSale && !sale.refunded) {
        products.set(linked.productId, {
          ...linked,
          salesCount: (linked.salesCount || 0) + 1,
          totalRevenueCents: (linked.totalRevenueCents || 0) + amountCents,
        });
      }
    },

    listGumroadWebhookSalesForProducts: async (gumroadProductIds) => {
      const set = new Set(gumroadProductIds.map((id) => id.trim()).filter(Boolean));
      const out: NormalizedGumroadSale[] = [];
      for (const sale of webhookSales.values()) {
        if (sale.gumroadProductId && set.has(sale.gumroadProductId)) {
          out.push({ ...sale });
        }
      }
      return out;
    },
  };
}

/**
 * Authoritative Supabase server-side commerce store using service_role against:
 * `public.products`, `public.product_publish_approvals`, `public.stripe_checkout_sessions`,
 * `public.stripe_webhook_events`, `public.orders`, `public.customers`, and `public.gumroad_webhook_events`.
 * Fails closed (`configured: false`) whenever Supabase service_role credentials are missing.
 */
export function createSupabaseAuthoritativeCommerceStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  clientOverride?: SupabaseClient
): AuthoritativeCommerceStore {
  const supabaseUrl = env.SUPABASE_URL?.trim() || env.VITE_SUPABASE_URL?.trim() || '';
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';

  if (!clientOverride && (!supabaseUrl || !serviceRoleKey)) {
    return {
      configured: false,
      reason:
        'Authoritative server-side commerce store is not configured (fail-closed): SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.',
      getProductById: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      listGumroadLinkedProductsForBusinesses: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      findProductByGumroadProductId: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      createProductPublishApproval: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      getProductPublishApproval: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      revokeProductPublishApproval: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      consumeAndLinkGumroadPublish: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      consumeAndPublishProduct: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      updateProductPricing: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      reserveOrderId: () => crypto.randomUUID(),
      createCheckoutSessionRecord: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      getCheckoutSessionById: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      markCheckoutSessionPaid: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      markCheckoutSessionTerminal: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      recordStripeWebhookEvent: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      recordStripeChargeRefunded: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      recordGumroadWebhookSale: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
      listGumroadWebhookSalesForProducts: async () => {
        throw new Error('Authoritative commerce store is not configured.');
      },
    };
  }

  let client: SupabaseClient;
  try {
    client =
      clientOverride ??
      createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
  } catch (err: any) {
    return {
      configured: false,
      reason: `Authoritative commerce store failed initialization: ${err?.message || 'invalid config'}`,
      getProductById: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      listGumroadLinkedProductsForBusinesses: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      findProductByGumroadProductId: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      createProductPublishApproval: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      getProductPublishApproval: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      revokeProductPublishApproval: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      consumeAndLinkGumroadPublish: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      consumeAndPublishProduct: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      updateProductPricing: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      reserveOrderId: () => crypto.randomUUID(),
      createCheckoutSessionRecord: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      getCheckoutSessionById: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      markCheckoutSessionPaid: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      markCheckoutSessionTerminal: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      recordStripeWebhookEvent: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      recordStripeChargeRefunded: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      recordGumroadWebhookSale: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
      listGumroadWebhookSalesForProducts: async () => {
        throw new Error('Authoritative commerce store unavailable.');
      },
    };
  }

  function mapProductRow(row: Record<string, any>): AuthoritativeProductRecord | null {
    if (!row?.id || !row?.business_id) return null;
    const priceCents =
      row.price_cents !== null && row.price_cents !== undefined
        ? Number(row.price_cents)
        : Math.round(Number(row.price ?? 0) * 100);
    if (!Number.isInteger(priceCents) || priceCents < 0) {
      return null;
    }
    return {
      productId: String(row.id),
      businessId: String(row.business_id),
      businessRecordId: String(row.business_id),
      ownerId: row.owner_id ? String(row.owner_id) : null,
      tenantId: row.tenant_id ? String(row.tenant_id).trim() || null : null,
      name: String(row.name || ''),
      slug: String(row.slug || ''),
      description: String(row.description || ''),
      type: String(row.type || 'digital_download'),
      priceCents,
      currency: String(row.currency || 'USD').trim().toUpperCase(),
      billingType: String(row.billing_type || 'one_time'),
      status: String(row.status || 'draft').trim().toLowerCase(),
      stripePriceId: row.stripe_price_id ? String(row.stripe_price_id) : null,
      gumroadProductId: row.gumroad_product_id ? String(row.gumroad_product_id) : null,
      gumroadUrl: row.gumroad_url ? String(row.gumroad_url) : null,
      publishedApprovalId: row.published_approval_id ? String(row.published_approval_id) : null,
      customDeliverySummary:
        row.factory_metadata && typeof row.factory_metadata === 'object'
          ? (row.factory_metadata as any).pdfFilename
            ? `Digital package ready: ${String((row.factory_metadata as any).pdfFilename)}`
            : null
          : null,
      salesCount: row.sales_count != null ? Number(row.sales_count) : undefined,
      totalRevenueCents:
        row.total_revenue_cents != null
          ? Number(row.total_revenue_cents)
          : row.total_revenue != null
          ? Math.round(Number(row.total_revenue) * 100)
          : undefined,
    };
  }

  function mapPublishApprovalRow(data: Record<string, any>): AuthoritativePublishApprovalRecord {
    return {
      approvalId: String(data.approval_id),
      productId: String(data.product_id),
      businessId: String(data.business_id),
      ownerId: data.owner_id ? String(data.owner_id) : null,
      tenantId: data.tenant_id ? String(data.tenant_id) : null,
      approvedByUserId: String(data.approved_by_user_id),
      status: String(data.status),
      decisionNote: data.decision_note ? String(data.decision_note) : null,
      expiresAt: String(data.expires_at),
      consumedAt: data.consumed_at ? String(data.consumed_at) : null,
      createdAt: String(data.created_at),
    };
  }

  function mapCheckoutSessionRow(data: Record<string, any>): AuthoritativeCheckoutSessionRecord {
    return {
      sessionId: String(data.session_id),
      createdByUserId: String(data.created_by_user_id),
      ownerId: data.owner_id ? String(data.owner_id) : null,
      tenantId: String(data.tenant_id),
      businessId: String(data.business_id),
      productId: String(data.product_id),
      orderId: String(data.order_id),
      expectedAmountCents: Number(data.expected_amount_cents),
      currency: String(data.currency),
      billingType: String(data.billing_type),
      status: String(data.status),
      stripePaymentIntentId: data.stripe_payment_intent_id
        ? String(data.stripe_payment_intent_id)
        : null,
      verifiedAt: data.verified_at ? String(data.verified_at) : null,
      expiresAt: data.expires_at ? String(data.expires_at) : null,
      createdAt: String(data.created_at),
    };
  }

  const productSelectCols =
    'id, owner_id, tenant_id, business_id, name, slug, description, type, price, price_cents, currency, billing_type, status, stripe_price_id, gumroad_product_id, gumroad_url, published_approval_id, factory_metadata';

  return {
    configured: true,

    getProductById: async (productId: string) => {
      const cleanId = productId.trim();
      if (!UUID_REGEX.test(cleanId)) {
        return null;
      }
      const { data, error } = await client
        .from('products')
        .select(productSelectCols)
        .eq('id', cleanId)
        .maybeSingle();

      if (error) {
        throw new Error(`Authoritative product lookup failed: ${error.message}`);
      }
      return data ? mapProductRow(data) : null;
    },

    listGumroadLinkedProductsForBusinesses: async (businessIds) => {
      const uuidIds = businessIds.map((b) => b.trim()).filter((b) => UUID_REGEX.test(b));
      if (uuidIds.length === 0) return [];

      const { data, error } = await client
        .from('products')
        .select(productSelectCols)
        .in('business_id', uuidIds)
        .not('gumroad_product_id', 'is', null);

      if (error) {
        throw new Error(`Authoritative Gumroad-linked products lookup failed: ${error.message}`);
      }

      const out: AuthoritativeProductRecord[] = [];
      for (const row of data || []) {
        const mapped = mapProductRow(row);
        if (mapped && mapped.gumroadProductId) {
          out.push(mapped);
        }
      }
      return out;
    },

    findProductByGumroadProductId: async (gumroadProductId: string) => {
      const clean = gumroadProductId.trim();
      if (!clean) return null;
      const { data, error } = await client
        .from('products')
        .select(productSelectCols)
        .eq('gumroad_product_id', clean)
        .limit(1)
        .maybeSingle();

      if (error) {
        throw new Error(`Authoritative product by Gumroad ID lookup failed: ${error.message}`);
      }
      return data ? mapProductRow(data) : null;
    },

    createProductPublishApproval: async (input) => {
      const approvalId = input.approvalId?.trim() || `pubappr_${crypto.randomUUID()}`;
      const { data, error } = await client.rpc(
        'create_or_replace_product_publish_approval',
        {
          p_approval_id: approvalId,
          p_owner_id: input.ownerId,
          p_tenant_id: input.tenantId,
          p_business_id: input.businessId,
          p_product_id: input.productId,
          p_approved_by_user_id: input.approvedByUserId,
          p_expires_at: input.expiresAt,
          p_decision_note: input.decisionNote ?? 'Approved for publish',
          p_replace_existing: input.replaceExisting !== false,
          p_now: input.nowIso,
        }
      );

      if (error || !data) {
        throw new Error(
          `Failed to create authoritative publish approval: ${error?.message || 'unknown error'}`
        );
      }

      const res = data as Record<string, any>;
      if (res.status !== 'CREATED' || !res.approval) {
        throw new Error(
          res.reason || `Publish approval creation blocked (${String(res.status || 'UNKNOWN')}).`
        );
      }

      return mapPublishApprovalRow(res.approval as Record<string, any>);
    },

    getProductPublishApproval: async (approvalId: string) => {
      const clean = approvalId.trim();
      if (!clean) return null;

      const { data, error } = await client
        .from('product_publish_approvals')
        .select('*')
        .eq('approval_id', clean)
        .maybeSingle();

      if (error) {
        throw new Error(`Publish approval lookup failed: ${error.message}`);
      }
      if (!data) return null;

      return mapPublishApprovalRow(data);
    },

    revokeProductPublishApproval: async ({ approvalId, businessId, nowIso }) => {
      const { data, error } = await client.rpc('revoke_product_publish_approval', {
        p_approval_id: approvalId.trim(),
        p_business_id: businessId,
        p_now: nowIso ?? new Date().toISOString(),
      });
      if (error || !data) {
        throw new Error(
          `Publish approval revocation failed: ${error?.message || 'empty response'}`
        );
      }
      const res = data as Record<string, any>;
      const statusRaw = String(res.status || '').toLowerCase();
      const mappedApproval = res.approval
        ? mapPublishApprovalRow(res.approval as Record<string, any>)
        : undefined;
      if (statusRaw === 'revoked') {
        return { status: 'revoked', approval: mappedApproval };
      }
      if (statusRaw === 'already_consumed') {
        return { status: 'already_consumed', approval: mappedApproval };
      }
      if (statusRaw === 'already_revoked') {
        return { status: 'already_revoked', approval: mappedApproval };
      }
      if (statusRaw === 'not_found') {
        return { status: 'not_found' };
      }
      return { status: 'invalid_state', approval: mappedApproval };
    },

    consumeAndLinkGumroadPublish: async (input) => {
      const { data, error } = await client.rpc('consume_product_publish_approval', {
        p_approval_id: input.approvalId.trim(),
        p_business_id: input.businessId,
        p_product_id: input.productId,
        p_gumroad_product_id: input.gumroadProductId,
        p_gumroad_url: input.gumroadUrl,
        p_stripe_price_id: null,
        p_consumed_at: input.consumedAt,
      });

      if (error || !data) {
        return {
          ok: false,
          reason: `Atomic publish RPC failed: ${error?.message || 'empty response'}`,
        };
      }
      const res = data as Record<string, any>;
      if (res.status !== 'PUBLISHED') {
        return { ok: false, reason: String(res.reason || 'Publish approval not consumable.') };
      }
      return { ok: true };
    },

    consumeAndPublishProduct: async (input) => {
      const { data, error } = await client.rpc('consume_product_publish_approval', {
        p_approval_id: input.approvalId.trim(),
        p_business_id: input.businessId,
        p_product_id: input.productId,
        p_gumroad_product_id: null,
        p_gumroad_url: null,
        p_stripe_price_id: input.stripePriceId ?? null,
        p_consumed_at: input.consumedAt,
      });

      if (error || !data) {
        return {
          ok: false,
          reason: `Atomic product publish RPC failed: ${error?.message || 'empty response'}`,
        };
      }
      const res = data as Record<string, any>;
      if (res.status !== 'PUBLISHED') {
        return { ok: false, reason: String(res.reason || 'Publish approval not consumable.') };
      }
      return { ok: true };
    },

    updateProductPricing: async (input) => {
      const { data, error } = await client
        .from('products')
        .update({
          price_cents: input.priceCents,
          price: Number((input.priceCents / 100).toFixed(2)),
          currency: input.currency.toUpperCase(),
          billing_type: input.billingType,
          stripe_price_id:
            input.stripePriceId !== undefined ? input.stripePriceId : undefined,
          updated_at: input.updatedAt,
        })
        .eq('id', input.productId.trim())
        .eq('business_id', input.businessId)
        .select(productSelectCols)
        .single();

      if (error || !data) {
        throw new Error(
          `Failed to update product pricing: ${error?.message || 'unknown error'}`
        );
      }
      const mapped = mapProductRow(data);
      if (!mapped) {
        throw new Error('Updated product row had invalid pricing fields.');
      }
      return mapped;
    },

    reserveOrderId: () => crypto.randomUUID(),

    createCheckoutSessionRecord: async (input) => {
      const { data: sessionRow, error: sessErr } = await client.rpc(
        'create_stripe_checkout_order_and_session',
        {
          p_session_id: input.sessionId,
          p_order_id: input.orderId,
          p_order_number: input.orderNumber,
          p_created_by_user_id: input.createdByUserId,
          p_created_by_email: input.createdByEmail ?? null,
          p_owner_id: input.ownerId ?? input.createdByUserId,
          p_tenant_id: input.tenantId,
          p_business_id: input.businessId,
          p_product_id: input.productId,
          p_expected_amount_cents: input.expectedAmountCents,
          p_currency: input.currency.toUpperCase(),
          p_billing_type: input.billingType,
          p_expires_at: input.expiresAt ?? null,
          p_now: input.nowIso,
        }
      );

      if (sessErr || !sessionRow) {
        throw new Error(
          `Failed transactional checkout persistence: ${sessErr?.message || 'unknown error'}`
        );
      }

      return mapCheckoutSessionRow(sessionRow as Record<string, any>);
    },

    getCheckoutSessionById: async (sessionId: string) => {
      const clean = sessionId.trim();
      if (!clean) return null;

      const { data, error } = await client
        .from('stripe_checkout_sessions')
        .select('*')
        .eq('session_id', clean)
        .maybeSingle();

      if (error) {
        throw new Error(`Stripe checkout session lookup failed: ${error.message}`);
      }
      if (!data) return null;

      return mapCheckoutSessionRow(data);
    },

    markCheckoutSessionPaid: async (input) => {
      const { data, error } = await client.rpc('settle_stripe_checkout_session', {
        p_session_id: input.sessionId.trim(),
        p_payment_intent_id: input.paymentIntentId ?? null,
        p_amount_total_cents: input.amountTotalCents,
        p_currency: input.currency.toUpperCase(),
        p_paid_at: input.paidAt,
      });

      if (error || !data) {
        return {
          ok: false,
          reason: `Failed to settle checkout session: ${error?.message || 'empty response'}`,
        };
      }

      const res = data as Record<string, any>;
      if (!res.ok || !res.session) {
        return {
          ok: false,
          reason: String(res.reason || 'Checkout session settlement rejected.'),
        };
      }

      return {
        ok: true,
        session: mapCheckoutSessionRow(res.session as Record<string, any>),
      };
    },

    markCheckoutSessionTerminal: async (input) => {
      const { data, error } = await client.rpc('mark_stripe_checkout_session_terminal', {
        p_session_id: input.sessionId.trim(),
        p_terminal_status: input.status,
        p_updated_at: input.updatedAt,
      });
      if (error || !data) {
        return { ok: false, reason: error?.message || 'Failed to mark session terminal.' };
      }
      const res = data as Record<string, any>;
      return { ok: Boolean(res.ok), reason: res.reason ? String(res.reason) : undefined };
    },

    recordStripeWebhookEvent: async (input) => {
      const { data: existing } = await client
        .from('stripe_webhook_events')
        .select('event_id')
        .eq('event_id', input.eventId)
        .maybeSingle();

      if (existing) {
        return { alreadyProcessed: true };
      }

      const { error } = await client.from('stripe_webhook_events').insert({
        event_id: input.eventId,
        event_type: input.eventType,
        stripe_object_id: input.stripeObjectId ?? null,
        session_id: input.sessionId ?? null,
        payment_intent_id: input.paymentIntentId ?? null,
        business_id: input.businessId ?? null,
        order_id: input.orderId ?? null,
        status: input.status ?? 'processed',
        payload_summary: input.payloadSummary ?? {},
      });

      if (error) {
        if (error.code === '23505') {
          return { alreadyProcessed: true };
        }
        throw new Error(`Failed to log stripe_webhook_events: ${error.message}`);
      }

      return { alreadyProcessed: false };
    },

    recordStripeChargeRefunded: async (input) => {
      const { data, error } = await client.rpc('sync_stripe_charge_refunded', {
        p_payment_intent_id: input.paymentIntentId,
        p_refunded_amount_cents: input.refundedAmountCents,
        p_refund_tx_id: input.refundTxId ?? null,
        p_refunded_at: input.refundedAt,
      });

      if (error || !data) {
        return {
          ok: false,
          reason: error?.message || 'Stripe charge refund sync failed.',
        };
      }
      const res = data as Record<string, any>;
      return { ok: Boolean(res.ok), reason: res.reason ? String(res.reason) : undefined };
    },

    recordGumroadWebhookSale: async (sale) => {
      const amountCents = Math.max(0, Math.round(Number(sale.amountDollars || 0) * 100));
      const { data, error } = await client.rpc('record_gumroad_sale_and_sync_order', {
        p_sale_id: sale.saleId,
        p_gumroad_product_id: sale.gumroadProductId,
        p_product_name: sale.productName,
        p_buyer_name: sale.buyerName,
        p_buyer_email: sale.buyerEmail,
        p_amount_cents: amountCents,
        p_currency: sale.currency.toUpperCase(),
        p_refunded: sale.refunded,
        p_sale_created_at: sale.createdAt,
        p_now: new Date().toISOString(),
      });

      if (error || !data) {
        throw new Error(
          `Failed to persist Gumroad webhook sale: ${error?.message || 'empty response'}`
        );
      }

      const res = data as Record<string, any>;
      if (!res.ok) {
        const err: any = new Error(
          `${String(res.code || 'GUMROAD_SYNC_FAILED')}: ${String(res.reason || 'Gumroad sale sync rejected.')}`
        );
        err.code = res.code;
        throw err;
      }
    },

    listGumroadWebhookSalesForProducts: async (gumroadProductIds) => {
      const cleanIds = gumroadProductIds.map((id) => id.trim()).filter(Boolean);
      if (cleanIds.length === 0) return [];

      const { data, error } = await client
        .from('gumroad_webhook_events')
        .select('*')
        .in('gumroad_product_id', cleanIds)
        .order('sale_created_at', { ascending: false })
        .limit(200);

      if (error) {
        throw new Error(`Gumroad webhook events lookup failed: ${error.message}`);
      }

      return (data || []).map((r: any) => ({
        saleId: String(r.sale_id),
        gumroadProductId: String(r.gumroad_product_id),
        productName: String(r.product_name),
        buyerName: String(r.buyer_name || 'Gumroad Buyer'),
        buyerEmail: String(r.buyer_email || 'buyer@gumroad.verified'),
        amountDollars: Number(r.amount_cents || 0) / 100,
        currency: String(r.currency || 'USD').toUpperCase(),
        refunded: Boolean(r.refunded),
        createdAt: String(r.sale_created_at),
        source: 'webhook' as const,
      }));
    },
  };
}
