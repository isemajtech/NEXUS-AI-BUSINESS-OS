import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { GovernanceCallerIdentity } from './governanceAuth';

export const SUPPORTED_REFUND_CURRENCIES = new Set<string>(['USD']);

export interface AuthoritativeBusinessRecord {
  readonly businessId: string; // canonical request key or UUID/slug
  readonly businessRecordId?: string; // public.businesses.id UUID
  readonly slug?: string;
  readonly ownerId: string | null;
  readonly tenantId: string | null;
  readonly status: 'active' | 'planning' | 'paused' | 'archived' | string;
}

export interface AuthoritativeBusinessMembership {
  readonly businessId: string;
  readonly businessRecordId?: string;
  readonly businessStatus: string;
  readonly ownerId: string | null;
  readonly tenantId: string | null;
  readonly authorized: boolean;
  readonly membershipRole?: string | null;
  readonly membershipStatus?: string | null;
  readonly reason?: string;
}

export interface AuthoritativeBusinessMembershipRecord {
  readonly businessId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly role: 'owner' | 'admin' | 'finance_operator' | 'support_operator' | string;
  readonly status: 'active' | 'suspended' | 'revoked' | string;
}

export interface AuthoritativeOrderRecord {
  readonly orderRecordId?: string;
  readonly orderId: string;
  readonly businessId: string;
  readonly businessRecordId?: string;
  readonly ownerId?: string | null;
  readonly tenantId?: string | null;
  readonly businessStatus?: 'active' | 'planning' | 'paused' | 'archived' | string;
  readonly amountCents: number;
  readonly refundedAmountCents: number;
  readonly remainingRefundableCents?: number;
  readonly currency: string;
  readonly paymentStatus:
    | 'unpaid'
    | 'pending'
    | 'authorized'
    | 'paid'
    | 'settled'
    | 'partially_refunded'
    | 'refunded'
    | 'failed'
    | 'disputed'
    | 'cancelled'
    | string;
  readonly status: 'completed' | 'processing' | 'pending' | 'refunded' | 'disputed' | 'cancelled' | string;
  readonly externalRefunded?: boolean;
  readonly eligibleForRefund: boolean;
  readonly paymentProvider?: string | null;
  readonly paymentIntentId?: string | null;
  readonly refundTxId?: string | null;
  readonly refundReservationId?: string | null;
  readonly refundedAt?: string | null;
}

export interface AuthoritativeOrderLookupInput {
  readonly orderId: string;
  readonly businessId: string;
}

export interface MarkOrderRefundedInput {
  readonly orderId: string;
  readonly businessId: string;
  readonly refundAmountCents: number;
  readonly refundTxId: string;
  readonly reservationId: string;
  readonly refundedAt?: string;
}

export interface MarkOrderRefundedResult {
  readonly updated: boolean;
  readonly alreadyRefunded?: boolean;
  readonly reason?: string;
}

export interface AuthoritativeOrderStore {
  readonly configured: boolean;
  readonly reason?: string;
  getOrderForBusiness: (
    input: AuthoritativeOrderLookupInput
  ) => Promise<AuthoritativeOrderRecord | null>;
  verifyCallerBusinessAccess?: (input: {
    businessId: string;
    caller: GovernanceCallerIdentity;
  }) => Promise<AuthoritativeBusinessMembership>;
  listAuthorizedBusinessesForCaller?: (
    caller: GovernanceCallerIdentity
  ) => Promise<
    ReadonlyArray<{
      businessId: string;
      ownerId: string | null;
      tenantId: string | null;
    }>
  >;
  markOrderRefunded?: (
    input: MarkOrderRefundedInput
  ) => Promise<MarkOrderRefundedResult>;
}

export interface OrderRefundEligibilityResult {
  readonly eligible: boolean;
  readonly code?:
    | 'BUSINESS_NOT_ACTIVE'
    | 'UNSUPPORTED_ORDER_CURRENCY'
    | 'ORDER_CURRENCY_MISMATCH'
    | 'ORDER_NOT_ELIGIBLE_FOR_REFUND'
    | 'ORDER_AMOUNT_MISMATCH';
  readonly reason?: string;
  readonly remainingRefundableCents: number;
}

/**
 * Single authoritative refund eligibility validator (FULL REFUNDS ONLY).
 * - Requires an active business.
 * - Requires explicit settled payment (`paymentStatus === 'paid' | 'settled'`).
 *   Fulfillment `status === 'completed'` alone is NEVER sufficient proof of settlement.
 * - Blocks cancelled, disputed, already refunded, externally refunded, or partially refunded orders.
 * - Requires explicit supported currency & exact match to remaining refundable amount.
 */
export function validateOrderRefundEligibility(
  order: AuthoritativeOrderRecord,
  requestedAmountCents: number,
  requestedCurrency?: string
): OrderRefundEligibilityResult {
  const bizStatus = String(order.businessStatus || '').trim().toLowerCase();
  if (bizStatus !== 'active') {
    return {
      eligible: false,
      code: 'BUSINESS_NOT_ACTIVE',
      reason: `Business "${order.businessId}" is not active (status="${order.businessStatus || 'unknown'}").`,
      remainingRefundableCents: 0,
    };
  }

  const orderCurrency = String(order.currency || '').trim().toUpperCase();
  if (!orderCurrency || !SUPPORTED_REFUND_CURRENCIES.has(orderCurrency)) {
    return {
      eligible: false,
      code: 'UNSUPPORTED_ORDER_CURRENCY',
      reason: `Order currency "${order.currency || 'missing'}" is not supported for automated refunds.`,
      remainingRefundableCents: 0,
    };
  }

  const reqCurrency = String(requestedCurrency || 'USD').trim().toUpperCase();
  if (!reqCurrency || !SUPPORTED_REFUND_CURRENCIES.has(reqCurrency) || reqCurrency !== orderCurrency) {
    return {
      eligible: false,
      code: 'ORDER_CURRENCY_MISMATCH',
      reason: `Requested refund currency "${reqCurrency || 'missing'}" does not match authoritative order currency "${orderCurrency}".`,
      remainingRefundableCents: 0,
    };
  }

  const orderStatus = String(order.status || '').trim().toLowerCase();
  const paymentStatus = String(order.paymentStatus || '').trim().toLowerCase();

  if (order.externalRefunded === true) {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: 'Order was already refunded externally.',
      remainingRefundableCents: 0,
    };
  }

  if (
    orderStatus === 'cancelled' ||
    orderStatus === 'disputed' ||
    orderStatus === 'refunded'
  ) {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: `Order is not eligible for refund in status "${order.status}".`,
      remainingRefundableCents: 0,
    };
  }

  if (
    paymentStatus === 'refunded' ||
    paymentStatus === 'partially_refunded' ||
    paymentStatus === 'disputed' ||
    paymentStatus === 'cancelled'
  ) {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: `Order payment_status "${order.paymentStatus}" is not eligible for refund.`,
      remainingRefundableCents: 0,
    };
  }

  if (paymentStatus !== 'paid' && paymentStatus !== 'settled') {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: `Order payment_status "${order.paymentStatus || 'unpaid'}" is not settled/paid (fulfillment status "${order.status}" does not establish payment settlement).`,
      remainingRefundableCents: 0,
    };
  }

  if (!order.eligibleForRefund) {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: 'Order is marked ineligible for refund.',
      remainingRefundableCents: 0,
    };
  }

  const amountCents = order.amountCents;
  const refundedCents = order.refundedAmountCents;
  if (
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    !Number.isInteger(refundedCents) ||
    refundedCents < 0
  ) {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: 'Order has invalid amount_cents or refunded_amount_cents.',
      remainingRefundableCents: 0,
    };
  }

  if (refundedCents > 0) {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: `Order already has ${refundedCents} cents refunded; partial or duplicate refunds are not permitted.`,
      remainingRefundableCents: Math.max(0, amountCents - refundedCents),
    };
  }

  const remaining =
    order.remainingRefundableCents !== undefined
      ? order.remainingRefundableCents
      : amountCents - refundedCents;

  if (!Number.isInteger(remaining) || remaining <= 0 || remaining !== amountCents) {
    return {
      eligible: false,
      code: 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reason: 'Order has insufficient remaining refundable balance for full refund.',
      remainingRefundableCents: Math.max(0, remaining),
    };
  }

  if (!Number.isInteger(requestedAmountCents) || requestedAmountCents !== remaining) {
    return {
      eligible: false,
      code: 'ORDER_AMOUNT_MISMATCH',
      reason: `Requested refund amount (${requestedAmountCents} cents) must exactly match remaining refundable order amount (${remaining} cents).`,
      remainingRefundableCents: remaining,
    };
  }

  return {
    eligible: true,
    remainingRefundableCents: remaining,
  };
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function evaluateMembershipAccess(input: {
  requestedBusinessId: string;
  business: AuthoritativeBusinessRecord | null;
  membership: AuthoritativeBusinessMembershipRecord | null;
  caller: GovernanceCallerIdentity;
}): AuthoritativeBusinessMembership {
  const { requestedBusinessId, business, membership, caller } = input;
  if (!business) {
    return {
      businessId: requestedBusinessId,
      businessStatus: 'missing',
      ownerId: null,
      tenantId: null,
      authorized: false,
      membershipStatus: 'missing',
      reason: `Authoritative business "${requestedBusinessId}" was not found.`,
    };
  }

  const bizStatus = String(business.status || '').trim().toLowerCase();
  if (bizStatus !== 'active') {
    return {
      businessId: requestedBusinessId,
      businessRecordId: business.businessRecordId,
      businessStatus: business.status,
      ownerId: business.ownerId,
      tenantId: business.tenantId,
      authorized: false,
      membershipStatus: membership?.status ?? 'missing',
      reason: `Business "${requestedBusinessId}" is not active (status="${business.status}").`,
    };
  }

  if (!business.ownerId && !business.tenantId) {
    return {
      businessId: requestedBusinessId,
      businessRecordId: business.businessRecordId,
      businessStatus: business.status,
      ownerId: null,
      tenantId: null,
      authorized: false,
      membershipStatus: membership?.status ?? 'missing',
      reason: `Business "${requestedBusinessId}" lacks verifiable owner_id or tenant_id (fail-closed).`,
    };
  }

  if (caller.allowedBusinessIds !== undefined) {
    const allowedMatch =
      caller.allowedBusinessIds.includes(requestedBusinessId) ||
      (business.businessRecordId
        ? caller.allowedBusinessIds.includes(business.businessRecordId)
        : false) ||
      (business.slug ? caller.allowedBusinessIds.includes(business.slug) : false);
    if (!allowedMatch) {
      return {
        businessId: requestedBusinessId,
        businessRecordId: business.businessRecordId,
        businessStatus: business.status,
        ownerId: business.ownerId,
        tenantId: business.tenantId,
        authorized: false,
        membershipStatus: membership?.status ?? 'missing',
        reason: 'Caller allowed_business_ids claim excludes this business.',
      };
    }
  }

  if (caller.hasExplicitTenantClaim && caller.tenantId) {
    if (!business.tenantId || caller.tenantId !== business.tenantId) {
      return {
        businessId: requestedBusinessId,
        businessRecordId: business.businessRecordId,
        businessStatus: business.status,
        ownerId: business.ownerId,
        tenantId: business.tenantId,
        authorized: false,
        membershipStatus: membership?.status ?? 'missing',
        reason: 'Cross-tenant access denied: caller tenant_id does not match business tenant_id.',
      };
    }
  }

  if (caller.hasExplicitOwnerClaim && caller.ownerId) {
    if (!business.ownerId || caller.ownerId !== business.ownerId) {
      return {
        businessId: requestedBusinessId,
        businessRecordId: business.businessRecordId,
        businessStatus: business.status,
        ownerId: business.ownerId,
        tenantId: business.tenantId,
        authorized: false,
        membershipStatus: membership?.status ?? 'missing',
        reason: 'Cross-tenant access denied: caller owner_id claim does not match business owner_id.',
      };
    }
  }

  if (membership) {
    if (membership.status !== 'active') {
      return {
        businessId: requestedBusinessId,
        businessRecordId: business.businessRecordId,
        businessStatus: business.status,
        ownerId: business.ownerId,
        tenantId: business.tenantId,
        authorized: false,
        membershipRole: membership.role,
        membershipStatus: membership.status,
        reason: `Business membership for caller is not active (status="${membership.status}").`,
      };
    }

    if (business.tenantId && membership.tenantId !== business.tenantId) {
      return {
        businessId: requestedBusinessId,
        businessRecordId: business.businessRecordId,
        businessStatus: business.status,
        ownerId: business.ownerId,
        tenantId: business.tenantId,
        authorized: false,
        membershipRole: membership.role,
        membershipStatus: membership.status,
        reason: 'Business membership tenant_id mismatch (fail-closed).',
      };
    }

    if (
      !caller.roles.includes(membership.role as any) &&
      !(caller.roles.includes('owner') && business.ownerId === caller.userId)
    ) {
      return {
        businessId: requestedBusinessId,
        businessRecordId: business.businessRecordId,
        businessStatus: business.status,
        ownerId: business.ownerId,
        tenantId: business.tenantId,
        authorized: false,
        membershipRole: membership.role,
        membershipStatus: membership.status,
        reason: `Caller role set does not authorize membership role "${membership.role}".`,
      };
    }

    return {
      businessId: requestedBusinessId,
      businessRecordId: business.businessRecordId,
      businessStatus: business.status,
      ownerId: business.ownerId,
      tenantId: business.tenantId,
      authorized: true,
      membershipRole: membership.role,
      membershipStatus: membership.status,
    };
  }

  // Fallback ONLY for direct verified owner matching public.businesses.owner_id
  if (caller.roles.includes('owner') && business.ownerId === caller.userId) {
    return {
      businessId: requestedBusinessId,
      businessRecordId: business.businessRecordId,
      businessStatus: business.status,
      ownerId: business.ownerId,
      tenantId: business.tenantId,
      authorized: true,
      membershipRole: 'owner',
      membershipStatus: 'owner_direct',
    };
  }

  return {
    businessId: requestedBusinessId,
    businessRecordId: business.businessRecordId,
    businessStatus: business.status,
    ownerId: business.ownerId,
    tenantId: business.tenantId,
    authorized: false,
    membershipStatus: 'missing',
    reason: 'Caller lacks an active business_memberships record for this business (fail-closed).',
  };
}

/**
 * Test-only in-memory store supporting authoritative businesses, memberships, and orders
 * with optimistic single-refund state updates. Never used as a default server fallback.
 */
export function createInMemoryAuthoritativeOrderStore(seed: {
  businesses: ReadonlyArray<AuthoritativeBusinessRecord>;
  memberships?: ReadonlyArray<AuthoritativeBusinessMembershipRecord>;
  orders: ReadonlyArray<AuthoritativeOrderRecord>;
  throwOnLookup?: () => boolean;
}): AuthoritativeOrderStore {
  const bizByKey = new Map<string, AuthoritativeBusinessRecord>();
  for (const b of seed.businesses) {
    bizByKey.set(b.businessId, b);
    if (b.businessRecordId) bizByKey.set(b.businessRecordId, b);
    if (b.slug) bizByKey.set(b.slug, b);
  }

  const membershipByKey = new Map<string, AuthoritativeBusinessMembershipRecord>();
  for (const m of seed.memberships ?? []) {
    membershipByKey.set(`${m.businessId}::${m.userId}`, m);
    const b = bizByKey.get(m.businessId);
    if (b?.businessRecordId) {
      membershipByKey.set(`${b.businessRecordId}::${m.userId}`, m);
    }
    if (b?.businessId) {
      membershipByKey.set(`${b.businessId}::${m.userId}`, m);
    }
  }

  const ordersByKey = new Map<string, AuthoritativeOrderRecord>();
  for (const o of seed.orders) {
    ordersByKey.set(`${o.businessId}::${o.orderId}`, o);
  }

  return {
    configured: true,
    getOrderForBusiness: async ({ orderId, businessId }) => {
      if (seed.throwOnLookup?.()) {
        throw new Error('Simulated public.orders connectivity error');
      }
      const order = ordersByKey.get(`${businessId}::${orderId}`);
      if (!order) return null;
      const biz = bizByKey.get(businessId);
      if (!biz) return null;
      return {
        ...order,
        businessStatus: order.businessStatus ?? biz.status,
        ownerId: order.ownerId !== undefined ? order.ownerId : biz.ownerId,
        tenantId: order.tenantId !== undefined ? order.tenantId : biz.tenantId,
      };
    },
    verifyCallerBusinessAccess: async ({ businessId, caller }) => {
      if (seed.throwOnLookup?.()) {
        throw new Error('Simulated public.businesses connectivity error');
      }
      const biz = bizByKey.get(businessId) ?? null;
      const membership =
        (biz
          ? membershipByKey.get(`${biz.businessId}::${caller.userId}`) ??
            (biz.businessRecordId
              ? membershipByKey.get(`${biz.businessRecordId}::${caller.userId}`)
              : undefined)
          : undefined) ??
        membershipByKey.get(`${businessId}::${caller.userId}`) ??
        null;
      return evaluateMembershipAccess({
        requestedBusinessId: businessId,
        business: biz,
        membership,
        caller,
      });
    },
    listAuthorizedBusinessesForCaller: async (caller) => {
      const out: Array<{ businessId: string; ownerId: string | null; tenantId: string | null }> = [];
      const seen = new Set<string>();
      for (const b of seed.businesses) {
        const access = evaluateMembershipAccess({
          requestedBusinessId: b.businessId,
          business: b,
          membership:
            membershipByKey.get(`${b.businessId}::${caller.userId}`) ??
            (b.businessRecordId
              ? membershipByKey.get(`${b.businessRecordId}::${caller.userId}`)
              : undefined) ??
            null,
          caller,
        });
        if (access.authorized && !seen.has(b.businessId)) {
          seen.add(b.businessId);
          out.push({
            businessId: b.businessId,
            ownerId: b.ownerId,
            tenantId: b.tenantId,
          });
        }
      }
      return out;
    },
    markOrderRefunded: async (input) => {
      const key = `${input.businessId}::${input.orderId}`;
      const existing = ordersByKey.get(key);
      if (!existing) {
        return { updated: false, reason: 'Order not found during refund state update.' };
      }
      if (
        existing.paymentStatus === 'refunded' &&
        existing.refundReservationId === input.reservationId
      ) {
        return { updated: false, alreadyRefunded: true };
      }
      if (
        existing.externalRefunded ||
        existing.paymentStatus === 'refunded' ||
        existing.refundedAmountCents > 0
      ) {
        return { updated: false, alreadyRefunded: true, reason: 'Order already refunded.' };
      }
      ordersByKey.set(key, {
        ...existing,
        refundedAmountCents: input.refundAmountCents,
        remainingRefundableCents: 0,
        paymentStatus: 'refunded',
        status: 'refunded',
        eligibleForRefund: false,
        refundTxId: input.refundTxId,
        refundReservationId: input.reservationId,
        refundedAt: input.refundedAt ?? new Date().toISOString(),
      });
      return { updated: true };
    },
  };
}

/**
 * Authoritative Supabase server-side order & membership store against
 * `public.businesses`, `public.business_memberships`, and `public.orders`.
 * Fails closed (`configured: false` or throws on missing/unreadable tables)
 * and NEVER simulates or invents order or membership records.
 */
export function createSupabaseAuthoritativeOrderStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  clientOverride?: SupabaseClient
): AuthoritativeOrderStore {
  const supabaseUrl =
    env.SUPABASE_URL?.trim() || env.VITE_SUPABASE_URL?.trim() || '';
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';

  if (!clientOverride && (!supabaseUrl || !serviceRoleKey)) {
    return {
      configured: false,
      reason:
        'Authoritative server-side orders source is not configured (fail-closed): no public.orders Supabase service connection is available.',
      getOrderForBusiness: async () => {
        throw new Error(
          'Authoritative server-side orders source is not configured (fail-closed).'
        );
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
      reason: `Authoritative server-side orders store failed initialization (${err?.message || 'invalid config'}).`,
      getOrderForBusiness: async () => {
        throw new Error('Authoritative server-side orders store unavailable.');
      },
    };
  }

  async function resolveBusiness(cleanBusinessId: string): Promise<AuthoritativeBusinessRecord | null> {
    if (!cleanBusinessId) return null;
    const col = UUID_REGEX.test(cleanBusinessId) ? 'id' : 'slug';
    const { data, error } = await client
      .from('businesses')
      .select('id, slug, owner_id, tenant_id, status')
      .eq(col, cleanBusinessId)
      .maybeSingle();

    if (error) {
      throw new Error(
        `Authoritative businesses lookup failed (fail-closed): ${error.message}`
      );
    }
    if (!data) return null;
    return {
      businessId: cleanBusinessId,
      businessRecordId: String(data.id),
      slug: data.slug ? String(data.slug) : undefined,
      ownerId: data.owner_id ? String(data.owner_id) : null,
      tenantId: data.tenant_id ? String(data.tenant_id).trim() || null : null,
      status: String(data.status || '').trim().toLowerCase(),
    };
  }

  async function fetchRawOrderRow(
    businessUuid: string,
    cleanOrderId: string
  ): Promise<Record<string, any> | null> {
    const selectCols =
      'id, owner_id, tenant_id, order_number, business_id, amount, amount_cents, currency, payment_status, status, refunded_amount_cents, external_refunded, payment_provider, payment_intent_id, refund_tx_id, refund_reservation_id, refunded_at';

    const byNumber = await client
      .from('orders')
      .select(selectCols)
      .eq('business_id', businessUuid)
      .eq('order_number', cleanOrderId)
      .maybeSingle();

    if (byNumber.error) {
      throw new Error(
        `Authoritative orders lookup failed (fail-closed): ${byNumber.error.message}`
      );
    }
    if (byNumber.data) return byNumber.data;

    if (UUID_REGEX.test(cleanOrderId)) {
      const byUuid = await client
        .from('orders')
        .select(selectCols)
        .eq('business_id', businessUuid)
        .eq('id', cleanOrderId)
        .maybeSingle();

      if (byUuid.error) {
        throw new Error(
          `Authoritative orders lookup failed (fail-closed): ${byUuid.error.message}`
        );
      }
      return byUuid.data ?? null;
    }

    return null;
  }

  return {
    configured: true,

    verifyCallerBusinessAccess: async ({
      businessId,
      caller,
    }): Promise<AuthoritativeBusinessMembership> => {
      const cleanBusinessId = String(businessId || '').trim();
      const biz = await resolveBusiness(cleanBusinessId);
      if (!biz || !biz.businessRecordId) {
        return evaluateMembershipAccess({
          requestedBusinessId: cleanBusinessId,
          business: biz,
          membership: null,
          caller,
        });
      }

      const { data: memData, error: memErr } = await client
        .from('business_memberships')
        .select('business_id, user_id, tenant_id, role, status')
        .eq('business_id', biz.businessRecordId)
        .eq('user_id', caller.userId)
        .maybeSingle();

      if (memErr) {
        throw new Error(
          `Authoritative business_memberships lookup failed (fail-closed): ${memErr.message}`
        );
      }

      const membership: AuthoritativeBusinessMembershipRecord | null = memData
        ? {
            businessId: String(memData.business_id),
            userId: String(memData.user_id),
            tenantId: String(memData.tenant_id),
            role: String(memData.role),
            status: String(memData.status),
          }
        : null;

      return evaluateMembershipAccess({
        requestedBusinessId: cleanBusinessId,
        business: biz,
        membership,
        caller,
      });
    },

    listAuthorizedBusinessesForCaller: async (caller) => {
      const bindings = new Map<
        string,
        { businessId: string; ownerId: string | null; tenantId: string | null }
      >();

      const { data: memRows, error: memErr } = await client
        .from('business_memberships')
        .select('business_id, tenant_id, role, status')
        .eq('user_id', caller.userId)
        .eq('status', 'active');

      if (memErr) {
        throw new Error(
          `Authoritative business_memberships list failed (fail-closed): ${memErr.message}`
        );
      }

      const memBizIds = (memRows || []).map((r) => String(r.business_id));
      if (memBizIds.length > 0) {
        const { data: bizRows, error: bizErr } = await client
          .from('businesses')
          .select('id, slug, owner_id, tenant_id, status')
          .in('id', memBizIds)
          .eq('status', 'active');

        if (bizErr) {
          throw new Error(
            `Authoritative businesses list failed (fail-closed): ${bizErr.message}`
          );
        }

        for (const b of bizRows || []) {
          const rec: AuthoritativeBusinessRecord = {
            businessId: String(b.id),
            businessRecordId: String(b.id),
            slug: b.slug ? String(b.slug) : undefined,
            ownerId: b.owner_id ? String(b.owner_id) : null,
            tenantId: b.tenant_id ? String(b.tenant_id).trim() || null : null,
            status: String(b.status),
          };
          const memRow = (memRows || []).find((m) => String(m.business_id) === String(b.id));
          const access = evaluateMembershipAccess({
            requestedBusinessId: rec.businessId,
            business: rec,
            membership: memRow
              ? {
                  businessId: String(memRow.business_id),
                  userId: caller.userId,
                  tenantId: String(memRow.tenant_id),
                  role: String(memRow.role),
                  status: String(memRow.status),
                }
              : null,
            caller,
          });
          if (access.authorized) {
            bindings.set(String(b.id), {
              businessId: String(b.id),
              ownerId: rec.ownerId,
              tenantId: rec.tenantId,
            });
            if (rec.slug) {
              bindings.set(rec.slug, {
                businessId: rec.slug,
                ownerId: rec.ownerId,
                tenantId: rec.tenantId,
              });
            }
          }
        }
      }

      if (caller.roles.includes('owner')) {
        const { data: ownedRows, error: ownedErr } = await client
          .from('businesses')
          .select('id, slug, owner_id, tenant_id, status')
          .eq('owner_id', caller.userId)
          .eq('status', 'active');

        if (ownedErr) {
          throw new Error(
            `Authoritative owned businesses list failed (fail-closed): ${ownedErr.message}`
          );
        }

        for (const b of ownedRows || []) {
          const rec: AuthoritativeBusinessRecord = {
            businessId: String(b.id),
            businessRecordId: String(b.id),
            slug: b.slug ? String(b.slug) : undefined,
            ownerId: b.owner_id ? String(b.owner_id) : null,
            tenantId: b.tenant_id ? String(b.tenant_id).trim() || null : null,
            status: String(b.status),
          };
          const access = evaluateMembershipAccess({
            requestedBusinessId: rec.businessId,
            business: rec,
            membership: null,
            caller,
          });
          if (access.authorized) {
            bindings.set(String(b.id), {
              businessId: String(b.id),
              ownerId: rec.ownerId,
              tenantId: rec.tenantId,
            });
            if (rec.slug) {
              bindings.set(rec.slug, {
                businessId: rec.slug,
                ownerId: rec.ownerId,
                tenantId: rec.tenantId,
              });
            }
          }
        }
      }

      return Array.from(bindings.values());
    },

    getOrderForBusiness: async ({
      orderId,
      businessId,
    }): Promise<AuthoritativeOrderRecord | null> => {
      const cleanOrderId = String(orderId || '').trim();
      const cleanBusinessId = String(businessId || '').trim();
      if (!cleanOrderId || !cleanBusinessId) {
        return null;
      }

      const business = await resolveBusiness(cleanBusinessId);
      if (!business || !business.businessRecordId) {
        return null;
      }

      const row = await fetchRawOrderRow(business.businessRecordId, cleanOrderId);
      if (!row) {
        return null;
      }

      const amountCents =
        row.amount_cents !== null && row.amount_cents !== undefined
          ? Number(row.amount_cents)
          : Math.round(Number(row.amount) * 100);
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return null;
      }

      const refundedAmountCents = Number.isInteger(Number(row.refunded_amount_cents))
        ? Number(row.refunded_amount_cents)
        : 0;
      const status = String(row.status || '').trim().toLowerCase();
      const paymentStatus = String(row.payment_status || 'unpaid').trim().toLowerCase();
      const externalRefunded = Boolean(row.external_refunded);
      const ownerId = row.owner_id ? String(row.owner_id) : business.ownerId;
      const tenantId = row.tenant_id
        ? String(row.tenant_id).trim() || null
        : business.tenantId;
      const remainingRefundableCents = Math.max(0, amountCents - refundedAmountCents);

      const eligibleForRefund =
        business.status === 'active' &&
        (paymentStatus === 'paid' || paymentStatus === 'settled') &&
        status !== 'cancelled' &&
        status !== 'disputed' &&
        status !== 'refunded' &&
        !externalRefunded &&
        refundedAmountCents === 0;

      return {
        orderRecordId: String(row.id),
        orderId: String(row.order_number || row.id),
        businessId: cleanBusinessId,
        businessRecordId: business.businessRecordId,
        ownerId,
        tenantId,
        businessStatus: business.status,
        amountCents,
        refundedAmountCents,
        remainingRefundableCents,
        currency: String(row.currency || 'USD').trim().toUpperCase(),
        paymentStatus,
        status,
        externalRefunded,
        eligibleForRefund,
        paymentProvider: row.payment_provider ? String(row.payment_provider) : null,
        paymentIntentId: row.payment_intent_id ? String(row.payment_intent_id) : null,
        refundTxId: row.refund_tx_id ? String(row.refund_tx_id) : null,
        refundReservationId: row.refund_reservation_id
          ? String(row.refund_reservation_id)
          : null,
        refundedAt: row.refunded_at ? String(row.refunded_at) : null,
      };
    },

    markOrderRefunded: async (input): Promise<MarkOrderRefundedResult> => {
      const business = await resolveBusiness(input.businessId.trim());
      if (!business?.businessRecordId) {
        return { updated: false, reason: 'Business not found during order refund update.' };
      }
      const row = await fetchRawOrderRow(business.businessRecordId, input.orderId.trim());
      if (!row?.id) {
        return { updated: false, reason: 'Order not found during order refund update.' };
      }

      const { data, error } = await client.rpc('record_authoritative_order_refund', {
        p_order_uuid: String(row.id),
        p_business_uuid: business.businessRecordId,
        p_refund_amount_cents: input.refundAmountCents,
        p_refund_tx_id: input.refundTxId,
        p_reservation_id: input.reservationId,
        p_refunded_at: input.refundedAt ?? new Date().toISOString(),
      });

      if (error || !data) {
        throw new Error(
          `Supabase record_authoritative_order_refund failed: ${error?.message || 'empty response'}`
        );
      }

      const status = String((data as Record<string, any>).status || '');
      if (status === 'UPDATED') {
        return { updated: true };
      }
      if (status === 'ALREADY_RECORDED' || status === 'ALREADY_REFUNDED_OR_INELIGIBLE') {
        return {
          updated: false,
          alreadyRefunded: true,
          reason: String((data as Record<string, any>).reason || 'Already refunded.'),
        };
      }
      return {
        updated: false,
        reason: String((data as Record<string, any>).reason || `Order update rejected (${status}).`),
      };
    },
  };
}
