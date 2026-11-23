import Stripe from 'stripe';
import type {
  PaymentRefundProviderAdapter,
  ProviderRefundExecutionResult,
  ProviderRefundLookupResult,
} from './financeExecutor';
import type { AuthoritativeOrderStore } from './orderStore';

export interface ServerPaymentProviderDeps {
  orderStore: AuthoritativeOrderStore;
  stripeClient?: Stripe;
  stripeSecretKey?: string;
}

function isStripeRetryableError(err: any): boolean {
  const type = String(err?.type || '');
  const code = String(err?.code || '');
  const statusCode = Number(err?.statusCode || 0);
  if (
    type === 'StripeConnectionError' ||
    type === 'StripeAPIError' ||
    type === 'StripeRateLimitError' ||
    code === 'lock_timeout' ||
    statusCode === 429 ||
    statusCode >= 500
  ) {
    return true;
  }
  return false;
}

function isUnknownOutcomeError(err: any): boolean {
  const type = String(err?.type || '');
  const code = String(err?.code || '');
  const statusCode = Number(err?.statusCode || 0);
  return (
    type === 'StripeConnectionError' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    statusCode >= 502
  );
}

/**
 * C5 Remediation: Real payment provider refund adapter backed by authoritative
 * order payment_intent_id bindings and Stripe Refunds API with provider idempotency keys.
 * Fails closed when the order lacks a verified provider binding, lacks a Stripe secret key,
 * or belongs to a provider without automated refund support (e.g., manual settlement).
 */
export function createServerPaymentRefundProvider(
  deps: ServerPaymentProviderDeps
): PaymentRefundProviderAdapter {
  let cachedStripe: Stripe | null = deps.stripeClient ?? null;

  const getStripeClient = (): Stripe | null => {
    if (cachedStripe) return cachedStripe;
    const key =
      deps.stripeSecretKey?.trim() || process.env.STRIPE_SECRET_KEY?.trim() || '';
    if (!key) return null;
    cachedStripe = new Stripe(key);
    return cachedStripe;
  };

  const executeRefund: PaymentRefundProviderAdapter['executeRefund'] = async ({
    request,
    providerIdempotencyKey,
    reservationId,
    amountCents,
  }): Promise<ProviderRefundExecutionResult> => {
    if (!deps.orderStore.configured) {
      return {
        outcome: 'CONFIRMED_FAILURE',
        errorCode: 'ORDER_STORE_UNCONFIGURED',
        retryable: false,
        reason:
          deps.orderStore.reason ||
          'Authoritative order store is not configured; cannot resolve payment provider binding.',
      };
    }

    const order = await deps.orderStore.getOrderForBusiness({
      orderId: request.order_id,
      businessId: request.business_id,
    });
    if (!order) {
      return {
        outcome: 'CONFIRMED_FAILURE',
        errorCode: 'ORDER_NOT_FOUND',
        retryable: false,
        reason: `Authoritative order "${request.order_id}" not found for payment refund execution.`,
      };
    }

    const provider = String(order.paymentProvider || '').trim().toLowerCase();
    if (provider !== 'stripe') {
      return {
        outcome: 'CONFIRMED_FAILURE',
        errorCode: 'UNSUPPORTED_REFUND_PROVIDER',
        retryable: false,
        reason: `Automated refund execution is only supported for Stripe orders (order payment_provider="${order.paymentProvider || 'unknown'}").`,
      };
    }

    const paymentIntentId = String(order.paymentIntentId || '').trim();
    if (!paymentIntentId) {
      return {
        outcome: 'CONFIRMED_FAILURE',
        errorCode: 'MISSING_PAYMENT_INTENT_ID',
        retryable: false,
        reason: `Stripe order "${order.orderId}" is missing an authoritative payment_intent_id.`,
      };
    }

    const stripe = getStripeClient();
    if (!stripe) {
      return {
        outcome: 'CONFIRMED_FAILURE',
        errorCode: 'STRIPE_UNCONFIGURED',
        retryable: true,
        reason: 'STRIPE_SECRET_KEY is not configured on the server; automated refund execution failed closed.',
      };
    }

    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: amountCents,
          reason: 'requested_by_customer',
          metadata: {
            nexus_request_id: request.provenance?.request_id ?? '',
            nexus_reservation_id: reservationId,
            nexus_business_id: request.business_id,
            nexus_order_id: order.orderId,
            nexus_provider_idempotency_key: providerIdempotencyKey,
          },
        },
        {
          idempotencyKey: providerIdempotencyKey,
        }
      );

      if (refund.status === 'failed' || refund.status === 'canceled') {
        return {
          outcome: 'CONFIRMED_FAILURE',
          errorCode: refund.failure_reason || `stripe_refund_${refund.status}`,
          retryable: false,
          reason: `Stripe refund returned terminal status "${refund.status}".`,
        };
      }

      // Stripe synchronous refund statuses ('succeeded', 'pending', 'requires_action')
      return {
        outcome: 'CONFIRMED_SUCCESS',
        txId: refund.id,
        providerRefundId: refund.id,
        providerStatus: refund.status ?? 'succeeded',
        rawSummary: {
          id: refund.id,
          status: refund.status,
          amount: refund.amount,
          currency: refund.currency,
          payment_intent: refund.payment_intent,
        },
      };
    } catch (err: any) {
      if (isUnknownOutcomeError(err)) {
        return {
          outcome: 'UNKNOWN_OR_TIMEOUT',
          errorCode: err?.code || err?.type || 'STRIPE_UNKNOWN_OUTCOME',
          reason:
            err?.message ||
            'Stripe refund request timed out or lost connection; manual or lookup reconciliation required.',
        };
      }
      return {
        outcome: 'CONFIRMED_FAILURE',
        errorCode: err?.code || err?.type || 'STRIPE_REFUND_FAILED',
        retryable: isStripeRetryableError(err),
        reason: err?.message || 'Stripe refund execution was rejected.',
      };
    }
  };

  const lookupRefundByIdempotencyKey: NonNullable<
    PaymentRefundProviderAdapter['lookupRefundByIdempotencyKey']
  > = async ({
    providerIdempotencyKey,
    requestId,
    orderId,
    amountCents,
  }): Promise<ProviderRefundLookupResult> => {
    const stripe = getStripeClient();
    if (!stripe) {
      return {
        outcome: 'UNKNOWN_OR_UNSUPPORTED',
        reason: 'STRIPE_SECRET_KEY is not configured for refund reconciliation lookup.',
      };
    }

    try {
      // Search recent Stripe refunds matching exact metadata binding (since we store both
      // providerIdempotencyKey and requestId/orderId in refund metadata on creation).
      const list = await stripe.refunds.list({ limit: 50 });
      const match = (list.data || []).find(
        (r) =>
          r.metadata?.nexus_provider_idempotency_key === providerIdempotencyKey &&
          r.metadata?.nexus_request_id === requestId &&
          r.metadata?.nexus_order_id === orderId &&
          r.amount === amountCents
      );

      if (!match) {
        return {
          outcome: 'CONFIRMED_NOT_EXECUTED',
          reason: `No Stripe refund matched provider_idempotency_key "${providerIdempotencyKey}".`,
        };
      }

      if (match.status === 'failed' || match.status === 'canceled') {
        return {
          outcome: 'CONFIRMED_NOT_EXECUTED',
          reason: `Matched Stripe refund "${match.id}" has failed/canceled status "${match.status}".`,
        };
      }

      return {
        outcome: 'FOUND_SUCCESS',
        txId: match.id,
        providerRefundId: match.id,
        providerStatus: match.status ?? 'succeeded',
        rawSummary: {
          id: match.id,
          status: match.status,
          amount: match.amount,
          currency: match.currency,
        },
      };
    } catch (err: any) {
      return {
        outcome: 'UNKNOWN_OR_UNSUPPORTED',
        reason: err?.message || 'Stripe refund lookup failed.',
      };
    }
  };

  return {
    providerName: 'stripe',
    supportsIdempotencyKey: true,
    supportsRefundLookup: true,
    executeRefund,
    lookupRefundByIdempotencyKey,
  };
}
