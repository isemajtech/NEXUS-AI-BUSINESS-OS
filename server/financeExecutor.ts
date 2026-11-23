import {
  AuthoritativeOwnerApprovalRecord,
  FinanceBoundaryDecision,
  FinanceRefundPolicy,
  evaluateFinanceRefund,
} from '../src/governance/financeRefundGate';
import {
  buildCanonicalProvenancePayload,
  isValidConfidence,
  type FinanceRefundRequest,
  type ProvenanceRecord,
} from '../src/governance/provenance';
import {
  ServerKeyring,
  createKeyringSignatureVerifier,
  sha256HexNode,
} from './provenanceAuth';
import type {
  AuthenticatedRefundRequestRecord,
  PersistentReplayStore,
  RefundAuthorizationStatus,
  RefundReservationRecord,
} from './replayStore';
import {
  type AuthoritativeBusinessMembership,
  type AuthoritativeOrderRecord,
  type AuthoritativeOrderStore,
  validateOrderRefundEligibility,
} from './orderStore';
import {
  isCallerAuthorizedForScope,
  validateCallerHasScope,
  type GovernanceCallerIdentity,
  type GovernanceScopeFilter,
} from './governanceAuth';

export type ProviderRefundExecutionResult =
  | {
      outcome: 'CONFIRMED_SUCCESS';
      txId: string;
      providerRefundId?: string;
      providerStatus?: string;
      rawSummary?: Record<string, unknown>;
    }
  | {
      outcome: 'CONFIRMED_FAILURE';
      reason: string;
      errorCode?: string;
      retryable?: boolean;
    }
  | {
      outcome: 'UNKNOWN_OR_TIMEOUT';
      reason: string;
      errorCode?: string;
    };

export type ProviderRefundLookupResult =
  | {
      outcome: 'FOUND_SUCCESS';
      txId: string;
      providerRefundId?: string;
      providerStatus?: string;
      rawSummary?: Record<string, unknown>;
    }
  | {
      outcome: 'CONFIRMED_NOT_EXECUTED';
      reason: string;
    }
  | {
      outcome: 'UNKNOWN_OR_UNSUPPORTED';
      reason: string;
    };

export interface PaymentRefundProviderAdapter {
  readonly providerName: string;
  readonly supportsIdempotencyKey: boolean;
  readonly supportsRefundLookup: boolean;
  executeRefund: (input: {
    request: FinanceRefundRequest;
    providerIdempotencyKey: string;
    reservationId: string;
    amountCents: number;
  }) => Promise<ProviderRefundExecutionResult>;
  lookupRefundByIdempotencyKey?: (input: {
    providerIdempotencyKey: string;
    reservationId: string;
    requestId: string;
    orderId: string;
    amountCents: number;
  }) => Promise<ProviderRefundLookupResult>;
}

export type RefundExecutionOutcome =
  | {
      status: 'EXECUTED';
      executedNewRefund: true;
      executionTxId: string;
      reservationId: string;
      providerIdempotencyKey: string;
      updatedChain: ProvenanceRecord['chain'];
      reasons: string[];
    }
  | {
      status: 'IDEMPOTENT_RETURN';
      executedNewRefund: false;
      executionTxId: string;
      consumedAt: string;
      reservationId?: string;
      providerIdempotencyKey?: string;
      reasons: string[];
    }
  | {
      status: 'UNCERTAIN_RECONCILIATION_REQUIRED';
      executedNewRefund: false;
      uncertaintyCode:
        | 'PROVIDER_TIMEOUT_OR_UNKNOWN'
        | 'FINALIZATION_FAILED_AFTER_PROVIDER_SUCCESS';
      reservationId: string;
      providerIdempotencyKey: string;
      knownProviderTxId?: string;
      reasons: string[];
    }
  | {
      status: 'PROVIDER_EXECUTION_FAILED';
      executedNewRefund: false;
      code: string;
      retryEligible: boolean;
      reservationId: string;
      providerIdempotencyKey: string;
      reasons: string[];
    }
  | {
      status: 'REJECTED_REPLAY_OR_CONFLICT' | 'REJECTED_SECURITY_VIOLATION';
      executedNewRefund: false;
      code: string;
      reasons: string[];
    }
  | {
      status: 'ESCALATED_TO_OWNER_APPROVAL';
      executedNewRefund: false;
      reasons: string[];
    };

export interface ExecuteFinanceRefundDeps {
  keyring: ServerKeyring;
  replayStore: PersistentReplayStore;
  /** Authoritative server-side order lookup store (fail-closed when absent or unconfigured) */
  orderStore?: AuthoritativeOrderStore;
  /** Authenticated server caller identity for fail-closed tenant/business enforcement */
  caller?: GovernanceCallerIdentity;
  /** Pre-verified authoritative business & membership access from public.businesses / public.business_memberships */
  verifiedBusinessAccess?: AuthoritativeBusinessMembership;
  /** When true, missing persisted provenance snapshot in replayStore fails closed. */
  requirePersistedProvenance?: boolean;
  policyOverrides?: Partial<FinanceRefundPolicy>;
  expectedRawTriggerHash?: string;
  now?: Date;
  executionLeaseMs?: number;
  /** Authoritative payment-provider adapter with explicit idempotency & lookup capabilities */
  paymentProvider?: PaymentRefundProviderAdapter;
  /** Legacy callback compatibility; treated as lacking idempotency & lookup capability */
  executePaymentRefund?: (
    req: FinanceRefundRequest,
    ctx?: { providerIdempotencyKey: string; reservationId: string; amountCents: number }
  ) => Promise<{ txId: string }>;
}

export interface ReconcileFinanceRefundInput {
  reservationId?: string;
  requestId?: string;
  orderId?: string;
  businessId?: string;
  scope?: GovernanceScopeFilter;
  caller?: GovernanceCallerIdentity;
  verifiedBusinessAccess?: AuthoritativeBusinessMembership;
}

export interface ReconcileFinanceRefundDeps {
  replayStore: PersistentReplayStore;
  orderStore?: AuthoritativeOrderStore;
  paymentProvider?: PaymentRefundProviderAdapter;
  now?: Date;
  executionLeaseMs?: number;
}

export type ReconcileFinanceRefundOutcome =
  | {
      status: 'RECONCILED_EXECUTED';
      reconciled: true;
      reservationId: string;
      providerIdempotencyKey: string;
      executionTxId: string;
      reservationStatus: 'executed';
      reason: string;
    }
  | {
      status: 'RECONCILED_NOT_EXECUTED_RETRY_PERMITTED';
      reconciled: true;
      reservationId: string;
      providerIdempotencyKey: string;
      reservationStatus: 'failed';
      reason: string;
    }
  | {
      status: 'RECONCILED_NOT_EXECUTED_RETRY_BLOCKED';
      reconciled: true;
      reservationId: string;
      providerIdempotencyKey: string;
      reservationStatus: 'rejected';
      reason: string;
    }
  | {
      status: 'ALREADY_EXECUTED';
      reconciled: false;
      reservationId: string;
      providerIdempotencyKey: string;
      executionTxId: string;
      reservationStatus: 'executed';
      reason: string;
    }
  | {
      status: 'ALREADY_FAILED_RETRYABLE' | 'PERMANENTLY_REJECTED';
      reconciled: false;
      reservationId: string;
      providerIdempotencyKey: string;
      reservationStatus: RefundAuthorizationStatus;
      reason: string;
    }
  | {
      status:
        | 'STILL_IN_FLIGHT'
        | 'BLOCKED_LOOKUP_UNSUPPORTED'
        | 'BLOCKED_OUTCOME_UNKNOWN'
        | 'BLOCKED_FINALIZATION_FAILED'
        | 'AMBIGUOUS_ORDER_REQUIRES_BUSINESS_ID'
        | 'NOT_FOUND';
      reconciled: false;
      reservationId?: string;
      providerIdempotencyKey?: string;
      reservationStatus?: RefundAuthorizationStatus;
      reason: string;
    };

function resolveProviderAdapter(
  deps: ExecuteFinanceRefundDeps
): { adapter: PaymentRefundProviderAdapter | null; isLegacyCallback: boolean } {
  if (deps.paymentProvider) {
    return { adapter: deps.paymentProvider, isLegacyCallback: false };
  }
  if (deps.executePaymentRefund) {
    const legacyFn = deps.executePaymentRefund;
    return {
      isLegacyCallback: true,
      adapter: {
        providerName: 'legacy_callback_no_idempotency',
        supportsIdempotencyKey: false,
        supportsRefundLookup: false,
        executeRefund: async ({ request, providerIdempotencyKey, reservationId, amountCents }) => {
          const res = await legacyFn(request, {
            providerIdempotencyKey,
            reservationId,
            amountCents,
          });
          if (!res || !String(res.txId || '').trim()) {
            return {
              outcome: 'UNKNOWN_OR_TIMEOUT',
              reason: 'Payment callback returned without a verifiable transaction ID.',
            };
          }
          return {
            outcome: 'CONFIRMED_SUCCESS',
            txId: String(res.txId),
          };
        },
      },
    };
  }
  return { adapter: null, isLegacyCallback: false };
}

/**
 * Full server-side Finance Refund Boundary & Crash-Safe Replay-Protected Executor.
 * 1. Verifies HMAC-SHA256 ingestion signature, key status, order binding, authoritative owner approval ledger, chain, and policy.
 * 2. Fails closed if provider adapter is unconfigured or lacks idempotency support.
 * 3. Atomically reserves an in-flight DB lock (`status = 'executing'`) and generates an immutable server `provider_idempotency_key` ONCE.
 * 4. Separates provider execution from DB finalization:
 *    - Timeout/unknown/exception -> preserves reservation & approval in `uncertain_reconciliation_required`, holds order lock, blocks blind retry.
 *    - DB finalization error after confirmed provider success -> NEVER calls `failRefundExecution`; preserves reservation as uncertain for reconciliation.
 *    - Definitive provider rejection ONLY -> calls `failRefundExecution` so safe retry can reuse the exact same `provider_idempotency_key`.
 */
export async function executeAuthorizedFinanceRefund(
  req: FinanceRefundRequest,
  deps: ExecuteFinanceRefundDeps
): Promise<RefundExecutionOutcome> {
  const verifySignature = createKeyringSignatureVerifier(deps.keyring);
  const prov = req.provenance;

  let bizAccess: AuthoritativeBusinessMembership | undefined = deps.verifiedBusinessAccess;
  if (deps.caller) {
    if (!bizAccess && deps.orderStore?.configured && deps.orderStore.verifyCallerBusinessAccess) {
      try {
        bizAccess = await deps.orderStore.verifyCallerBusinessAccess({
          businessId: req.business_id,
          caller: deps.caller,
        });
      } catch (bizErr: any) {
        return {
          status: 'REJECTED_SECURITY_VIOLATION',
          executedNewRefund: false,
          code: 'AUTHORITATIVE_ORDER_LOOKUP_FAILED',
          reasons: [
            bizErr?.message ||
              'Authoritative business membership verification failed (fail-closed).',
          ],
        };
      }
    }

    if (bizAccess) {
      if (!bizAccess.authorized) {
        const isInactiveBiz =
          bizAccess.businessStatus &&
          bizAccess.businessStatus !== 'active' &&
          bizAccess.businessStatus !== 'missing';
        return {
          status: 'REJECTED_SECURITY_VIOLATION',
          executedNewRefund: false,
          code: isInactiveBiz
            ? 'BUSINESS_NOT_ACTIVE'
            : 'CROSS_TENANT_OR_BUSINESS_DENIED',
          reasons: [
            bizAccess.reason ||
              'Caller lacks active verified business membership (fail-closed).',
          ],
        };
      }
    } else {
      const bizCheck = isCallerAuthorizedForScope(deps.caller, {
        businessId: req.business_id,
        requireStoredTenantOrOwnerScope: false,
      });
      if (!bizCheck.authorized) {
        return {
          status: 'REJECTED_SECURITY_VIOLATION',
          executedNewRefund: false,
          code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
          reasons: [bizCheck.reason || 'Caller is not authorized for the requested business_id.'],
        };
      }
    }
  }

  let storedReq: AuthenticatedRefundRequestRecord | undefined;
  if (prov?.request_id && deps.replayStore.getAuthenticatedRefundRequest) {
    storedReq = await deps.replayStore.getAuthenticatedRefundRequest(prov.request_id);
    if (deps.caller && storedReq) {
      const reqScopeCheck = isCallerAuthorizedForScope(
        deps.caller,
        {
          ownerId: storedReq.ownerId,
          tenantId: storedReq.tenantId,
          businessId: storedReq.businessId,
        },
        bizAccess
      );
      if (!reqScopeCheck.authorized) {
        return {
          status: 'REJECTED_SECURITY_VIOLATION',
          executedNewRefund: false,
          code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
          reasons: [
            reqScopeCheck.reason ||
              'Caller is not authorized for this refund request tenant or business.',
          ],
        };
      }
      if (storedReq.businessId !== req.business_id) {
        return {
          status: 'REJECTED_SECURITY_VIOLATION',
          executedNewRefund: false,
          code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
          reasons: ['Request business_id does not match persisted refund request scope.'],
        };
      }
    }
  }

  let priorProvenance: ProvenanceRecord | undefined;
  if (prov?.request_id) {
    try {
      priorProvenance = await deps.replayStore.getProvenanceSnapshot(prov.request_id);
    } catch (snapshotErr: any) {
      return {
        status: 'REJECTED_SECURITY_VIOLATION',
        executedNewRefund: false,
        code: 'PROVENANCE_SNAPSHOT_CORRUPTED_OR_UNAVAILABLE',
        reasons: [
          snapshotErr?.message ||
            'Persisted provenance snapshot is corrupted or unavailable (fail-closed).',
        ],
      };
    }
  }

  const claimedApprovalId = (
    prov?.owner_approval_id ||
    prov?.owner_approval_binding?.approval_id ||
    ''
  ).trim();

  let authoritativeOwnerApproval: AuthoritativeOwnerApprovalRecord | null | undefined;
  if (prov?.authority_level === 'owner_approved') {
    authoritativeOwnerApproval = claimedApprovalId
      ? (await deps.replayStore.getOwnerApproval(claimedApprovalId)) ?? null
      : null;
  }

  let replayStatus;
  if (
    prov?.request_id &&
    prov?.nonce &&
    isValidConfidence(prov.confidence) &&
    (prov.ingestion_auth?.canonical_version === 'v1' ||
      prov.ingestion_auth?.canonical_version === 'v2' ||
      !prov.ingestion_auth)
  ) {
    try {
      const preCanonical = buildCanonicalProvenancePayload({
        request: req,
        provenance: prov,
      });
      const preDigest = sha256HexNode(preCanonical);
      const preIdemKey =
        req.idempotency_key || `idem-${prov.request_id}-${prov.nonce}`;
      const precheck = await deps.replayStore.getReplayPrecheck({
        requestId: prov.request_id,
        nonce: prov.nonce,
        orderId: req.order_id,
        businessId: req.business_id,
        amountCents: Math.round(Number(req.amount_usd || 0) * 100),
        approvalId: claimedApprovalId || null,
        canonicalDigest: preDigest,
        idempotencyKey: preIdemKey,
      });
      if (precheck?.idempotentOutcome) {
        replayStatus = { idempotentOutcome: precheck.idempotentOutcome };
      }
    } catch {
      // Malformed provenance fails closed in evaluateFinanceRefund below
    }
  }

  const effectiveNow = deps.now ?? new Date();

  const decision: FinanceBoundaryDecision = evaluateFinanceRefund(req, {
    policy: deps.policyOverrides,
    priorProvenance,
    persistedRequest: storedReq
      ? {
          requestId: storedReq.requestId,
          orderId: storedReq.orderId,
          businessId: storedReq.businessId,
          amountCents: storedReq.amountCents,
          createdAt: storedReq.createdAt,
          expiresAt: storedReq.expiresAt,
          provenance: storedReq.provenance,
        }
      : undefined,
    requirePriorProvenance: deps.requirePersistedProvenance,
    expectedRawTriggerHash: deps.expectedRawTriggerHash,
    verifyIngestionSignature: verifySignature,
    authoritativeOwnerApproval,
    replayStatus,
    now: effectiveNow,
  });

  if (decision.decision === 'REJECT_SECURITY_VIOLATION') {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: decision.securityCode,
      reasons: decision.reasons,
    };
  }

  if (decision.decision === 'ESCALATE_TO_OWNER_APPROVAL') {
    return {
      status: 'ESCALATED_TO_OWNER_APPROVAL',
      executedNewRefund: false,
      reasons: decision.reasons,
    };
  }

  if (decision.decision === 'IDEMPOTENT_RETURN') {
    return {
      status: 'IDEMPOTENT_RETURN',
      executedNewRefund: false,
      executionTxId: decision.idempotentOutcome.execution_tx_id,
      consumedAt: decision.idempotentOutcome.consumed_at,
      reasons: decision.reasons,
    };
  }

  // decision.decision === 'EXECUTE'
  if (!prov || !prov.nonce || !prov.ingestion_auth) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: 'MISSING_AUTH_OR_NONCE',
      reasons: ['Missing provenance authentication or nonce at execution commit step.'],
    };
  }

  const { adapter, isLegacyCallback } = resolveProviderAdapter(deps);
  if (!adapter) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: 'PAYMENT_PROVIDER_UNCONFIGURED',
      reasons: ['No payment-provider adapter is configured (fail-closed).'],
    };
  }

  // Fail closed when explicit adapter lacks idempotency support
  if (!isLegacyCallback && !adapter.supportsIdempotencyKey) {
    return {
      status: 'REJECTED_REPLAY_OR_CONFLICT',
      executedNewRefund: false,
      code: 'PROVIDER_IDEMPOTENCY_UNSUPPORTED',
      reasons: [
        `Payment provider "${adapter.providerName}" does not support idempotency keys; refund execution blocked (fail-closed).`,
      ],
    };
  }

  // Also fail closed on retries if legacy callback is used without idempotency support
  const existingReservation = await deps.replayStore.getRefundReservation({
    requestId: prov.request_id,
    businessId: req.business_id,
  });
  if (existingReservation?.status === 'failed' && !adapter.supportsIdempotencyKey) {
    return {
      status: 'REJECTED_REPLAY_OR_CONFLICT',
      executedNewRefund: false,
      code: 'PROVIDER_IDEMPOTENCY_UNSUPPORTED',
      reasons: [
        `Automatic retry blocked: provider "${adapter.providerName}" does not support idempotency keys.`,
      ],
    };
  }

  // Authoritative server-side order verification (H2):
  // Fail closed when no authoritative orders source is configured or accessible,
  // or when order does not exist in requested business, fails caller scope,
  // is ineligible for refund, or mismatches requested refund amount.
  if (!deps.orderStore || !deps.orderStore.configured) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: 'AUTHORITATIVE_ORDERS_UNCONFIGURED',
      reasons: [
        deps.orderStore?.reason ||
          'Authoritative server-side orders source is not configured (fail-closed).',
      ],
    };
  }

  let authOrder: AuthoritativeOrderRecord | null;
  try {
    authOrder = await deps.orderStore.getOrderForBusiness({
      orderId: req.order_id,
      businessId: req.business_id,
    });
  } catch (orderErr: any) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: 'AUTHORITATIVE_ORDER_LOOKUP_FAILED',
      reasons: [
        orderErr?.message ||
          'Authoritative order verification failed (fail-closed).',
      ],
    };
  }

  if (!authOrder) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: 'AUTHORITATIVE_ORDER_NOT_FOUND',
      reasons: ['No authoritative order found for the specified business_id and order_id.'],
    };
  }

  if (authOrder.businessId !== req.business_id) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: 'AUTHORITATIVE_ORDER_BUSINESS_MISMATCH',
      reasons: ['Authoritative order does not belong to the requested business_id.'],
    };
  }

  if (deps.caller) {
    const orderScopeCheck = isCallerAuthorizedForScope(
      deps.caller,
      {
        ownerId: authOrder.ownerId,
        tenantId: authOrder.tenantId,
        businessId: authOrder.businessId,
      },
      bizAccess
    );
    if (!orderScopeCheck.authorized) {
      return {
        status: 'REJECTED_SECURITY_VIOLATION',
        executedNewRefund: false,
        code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
        reasons: [
          orderScopeCheck.reason ||
            'Caller is not authorized for the authoritative order tenant or business.',
        ],
      };
    }
  }

  const amountCents = Math.round(req.amount_usd * 100);
  const eligibility = validateOrderRefundEligibility(authOrder, amountCents, req.currency);
  if (!eligibility.eligible) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: eligibility.code || 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
      reasons: [eligibility.reason || 'Order is not eligible for refund.'],
    };
  }

  const resolvedOwnerId =
    storedReq?.ownerId ??
    authOrder.ownerId ??
    bizAccess?.ownerId ??
    (deps.caller?.roles.includes('owner')
      ? deps.caller.userId
      : deps.caller?.ownerId ?? null);
  const resolvedTenantId =
    storedReq?.tenantId ??
    authOrder.tenantId ??
    bizAccess?.tenantId ??
    deps.caller?.tenantId ??
    resolvedOwnerId ??
    null;

  if (!resolvedOwnerId && !resolvedTenantId) {
    return {
      status: 'REJECTED_SECURITY_VIOLATION',
      executedNewRefund: false,
      code: 'CALLER_SCOPE_MISSING',
      reasons: ['Refund execution requires verifiable owner_id or tenant_id scope (fail-closed).'],
    };
  }

  const canonicalDigest = sha256HexNode(decision.canonicalPayload);
  const idempotencyKey =
    req.idempotency_key || `idem-${prov.request_id}-${prov.nonce}`;

  const reservation = await deps.replayStore.reserveRefundExecution({
    ownerId: resolvedOwnerId,
    tenantId: resolvedTenantId,
    requestId: prov.request_id,
    nonce: prov.nonce,
    orderId: req.order_id,
    businessId: req.business_id,
    approvalId: claimedApprovalId || null,
    requireOwnerApproval: prov.authority_level === 'owner_approved',
    amountCents,
    idempotencyKey,
    canonicalDigest,
    keyId: prov.ingestion_auth.key_id,
    providerName: adapter.providerName,
    executionLeaseMs: deps.executionLeaseMs,
    expiresAt: storedReq?.expiresAt ?? prov.expires_at ?? '',
    nowIso: effectiveNow.toISOString(),
    provenanceSnapshot: prov,
  });

  if (reservation.status === 'IDEMPOTENT_REPLAY') {
    return {
      status: 'IDEMPOTENT_RETURN',
      executedNewRefund: false,
      executionTxId: reservation.executionTxId,
      consumedAt: reservation.consumedAt,
      reservationId: reservation.reservationId,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reasons: ['Duplicate network retry detected; returning stored transaction outcome.'],
    };
  }

  if (reservation.status !== 'ACQUIRED') {
    const isSecurityExpirationFailure =
      reservation.status === 'REFUND_REQUEST_EXPIRED' ||
      reservation.status === 'APPROVAL_EXPIRED' ||
      reservation.status === 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION' ||
      reservation.status === 'MISSING_OR_MALFORMED_TIMESTAMP';
    return {
      status: isSecurityExpirationFailure
        ? 'REJECTED_SECURITY_VIOLATION'
        : 'REJECTED_REPLAY_OR_CONFLICT',
      executedNewRefund: false,
      code:
        reservation.status === 'APPROVAL_EXPIRED'
          ? 'OWNER_APPROVAL_EXPIRED'
          : reservation.status,
      reasons: [reservation.reason],
    };
  }

  // Step A: Execute payment provider ONLY while reservation lock is held.
  // Isolated try/catch: thrown network/SDK errors NEVER mark the refund `failed`!
  let providerResult: ProviderRefundExecutionResult;
  try {
    providerResult = await adapter.executeRefund({
      request: req,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reservationId: reservation.reservationId,
      amountCents,
    });
  } catch (err: any) {
    const unknownReason = `Payment provider threw an uncertain error/timeout: ${
      err?.message || 'unknown error'
    }`;
    try {
      await deps.replayStore.markRefundUncertain({
        reservationId: reservation.reservationId,
        providerOutcomeStatus: 'timeout_or_unknown',
        reason: unknownReason,
        nowIso: effectiveNow.toISOString(),
      });
    } catch {
      // Even if DB is unreachable here, reservation remains in `executing`,
      // holding the order lock and blocking blind retries until reconciliation.
    }
    return {
      status: 'UNCERTAIN_RECONCILIATION_REQUIRED',
      executedNewRefund: false,
      uncertaintyCode: 'PROVIDER_TIMEOUT_OR_UNKNOWN',
      reservationId: reservation.reservationId,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reasons: [unknownReason],
    };
  }

  if (!providerResult || providerResult.outcome === 'UNKNOWN_OR_TIMEOUT') {
    const reason =
      providerResult?.reason || 'Payment provider returned an unknown/timeout outcome.';
    try {
      await deps.replayStore.markRefundUncertain({
        reservationId: reservation.reservationId,
        providerOutcomeStatus: 'timeout_or_unknown',
        reason,
        nowIso: effectiveNow.toISOString(),
      });
    } catch {
      // Reservation remains `executing` if DB update also fails.
    }
    return {
      status: 'UNCERTAIN_RECONCILIATION_REQUIRED',
      executedNewRefund: false,
      uncertaintyCode: 'PROVIDER_TIMEOUT_OR_UNKNOWN',
      reservationId: reservation.reservationId,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reasons: [reason],
    };
  }

  if (providerResult.outcome === 'CONFIRMED_FAILURE') {
    const retryEligible = Boolean(
      adapter.supportsIdempotencyKey && providerResult.retryable !== false
    );
    await deps.replayStore.failRefundExecution({
      reservationId: reservation.reservationId,
      reason: providerResult.reason,
      retryAllowed: retryEligible,
      nowIso: effectiveNow.toISOString(),
    });
    return {
      status: 'PROVIDER_EXECUTION_FAILED',
      executedNewRefund: false,
      code: providerResult.errorCode || 'PROVIDER_CONFIRMED_FAILURE',
      retryEligible,
      reservationId: reservation.reservationId,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reasons: [providerResult.reason],
    };
  }

  // Step B: Confirmed provider success! Persist final DB state in a SEPARATE try/catch.
  // CRITICAL INVARIANT: DB failure here must NEVER call failRefundExecution()!
  try {
    await deps.replayStore.finalizeRefundExecution({
      reservationId: reservation.reservationId,
      executionTxId: providerResult.txId,
      outcomePayload: {
        txId: providerResult.txId,
        providerIdempotencyKey: reservation.providerIdempotencyKey,
        providerRefundId: providerResult.providerRefundId ?? providerResult.txId,
        providerStatus: providerResult.providerStatus ?? 'succeeded',
        orderId: req.order_id,
        requestId: prov.request_id,
        amountUsd: req.amount_usd,
        updatedChain: decision.updatedChain,
      },
      nowIso: effectiveNow.toISOString(),
    });
  } catch (dbErr: any) {
    const finalizationReason = `Provider succeeded (txId=${providerResult.txId}) but database finalization failed: ${
      dbErr?.message || 'database write error'
    }`;
    try {
      await deps.replayStore.markRefundUncertain({
        reservationId: reservation.reservationId,
        providerOutcomeStatus: 'finalization_failed_after_success',
        providerTxId: providerResult.txId,
        reason: finalizationReason,
        nowIso: effectiveNow.toISOString(),
      });
    } catch {
      // Preserve `executing` row lock if DB is completely unreachable.
    }
    return {
      status: 'UNCERTAIN_RECONCILIATION_REQUIRED',
      executedNewRefund: false,
      uncertaintyCode: 'FINALIZATION_FAILED_AFTER_PROVIDER_SUCCESS',
      reservationId: reservation.reservationId,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      knownProviderTxId: providerResult.txId,
      reasons: [finalizationReason],
    };
  }

  // Update authoritative order refund state ONLY after provider confirmed success & reservation finalized.
  if (deps.orderStore.markOrderRefunded) {
    try {
      await deps.orderStore.markOrderRefunded({
        orderId: authOrder.orderId,
        businessId: authOrder.businessId,
        refundAmountCents: amountCents,
        refundTxId: providerResult.txId,
        reservationId: reservation.reservationId,
        refundedAt: effectiveNow.toISOString(),
      });
    } catch (orderUpdateErr: any) {
      console.warn(
        `[financeExecutor] Finalized reservation ${reservation.reservationId}, but authoritative order refund status sync deferred:`,
        orderUpdateErr?.message || orderUpdateErr
      );
    }
  }

  return {
    status: 'EXECUTED',
    executedNewRefund: true,
    executionTxId: providerResult.txId,
    reservationId: reservation.reservationId,
    providerIdempotencyKey: reservation.providerIdempotencyKey,
    updatedChain: decision.updatedChain,
    reasons: [],
  };
}

/**
 * Identifies stale `executing` reservations whose lease has expired and therefore
 * require provider reconciliation before any retry or state change.
 */
export async function identifyStaleRefundReservations(
  replayStore: PersistentReplayStore,
  now: Date = new Date(),
  scope?: GovernanceScopeFilter
): Promise<RefundReservationRecord[]> {
  return replayStore.listStaleExecutingReservations(now.toISOString(), scope);
}

/**
 * Reconciles a stuck/uncertain refund reservation against the payment provider
 * using the persisted `provider_idempotency_key`.
 *
 * Fail-closed invariants:
 * - Never invents lookup capability: if adapter has `supportsRefundLookup === false`
 *   (or no lookup method), keeps reservation locked & blocked for manual reconciliation.
 * - Never releases the order lock or permits retry unless provider authoritatively confirms
 *   `CONFIRMED_NOT_EXECUTED` (and even then only permits retry when `supportsIdempotencyKey === true`).
 * - Finalizes `executed` + consumes `owner_approvals` atomically ONLY when provider confirms `FOUND_SUCCESS`.
 * - Strictly enforces caller/tenant/business scope and returns non-leaking `NOT_FOUND` on foreign records.
 */
export async function reconcileFinanceRefund(
  input: ReconcileFinanceRefundInput,
  deps: ReconcileFinanceRefundDeps
): Promise<ReconcileFinanceRefundOutcome> {
  if (!input.reservationId && !input.requestId && input.orderId && !input.businessId?.trim()) {
    return {
      status: 'AMBIGUOUS_ORDER_REQUIRES_BUSINESS_ID',
      reconciled: false,
      reason: 'business_id is required when reconciling a refund by order_id.',
    };
  }

  if (input.caller && !validateCallerHasScope(input.caller).authorized) {
    return {
      status: 'NOT_FOUND',
      reconciled: false,
      reason: 'No matching refund reservation found.',
    };
  }

  const effectiveNow = deps.now ?? new Date();
  const nowMs = effectiveNow.getTime();
  const reservation = await deps.replayStore.getRefundReservation({
    reservationId: input.reservationId,
    requestId: input.requestId,
    orderId: input.orderId,
    businessId: input.businessId,
    scope: input.scope,
  });

  if (!reservation) {
    return {
      status: 'NOT_FOUND',
      reconciled: false,
      reason: 'No matching refund reservation found.',
    };
  }

  if (input.caller) {
    let bizAccess = input.verifiedBusinessAccess;
    if (!bizAccess && deps.orderStore?.configured && deps.orderStore.verifyCallerBusinessAccess) {
      bizAccess = await deps.orderStore.verifyCallerBusinessAccess({
        businessId: reservation.businessId,
        caller: input.caller,
      });
    }
    const scopeCheck = isCallerAuthorizedForScope(
      input.caller,
      {
        ownerId: reservation.ownerId,
        tenantId: reservation.tenantId,
        businessId: reservation.businessId,
      },
      bizAccess
    );
    if (!scopeCheck.authorized) {
      return {
        status: 'NOT_FOUND',
        reconciled: false,
        reason: 'No matching refund reservation found.',
      };
    }
  }

  if (reservation.status === 'executed') {
    return {
      status: 'ALREADY_EXECUTED',
      reconciled: false,
      reservationId: reservation.id,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      executionTxId: reservation.executionTxId || reservation.providerTxId || '',
      reservationStatus: 'executed',
      reason: `Reservation "${reservation.id}" is already finalized as executed.`,
    };
  }

  if (reservation.status === 'failed') {
    return {
      status: 'ALREADY_FAILED_RETRYABLE',
      reconciled: false,
      reservationId: reservation.id,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reservationStatus: 'failed',
      reason: `Reservation "${reservation.id}" is already marked failed (retryAllowed=${reservation.retryAllowed}).`,
    };
  }

  if (reservation.status === 'rejected') {
    return {
      status: 'PERMANENTLY_REJECTED',
      reconciled: false,
      reservationId: reservation.id,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reservationStatus: 'rejected',
      reason: `Reservation "${reservation.id}" is permanently rejected.`,
    };
  }

  if (reservation.status === 'executing') {
    const leaseMs = reservation.leaseExpiresAt
      ? Date.parse(reservation.leaseExpiresAt)
      : (reservation.executionStartedAt
          ? Date.parse(reservation.executionStartedAt)
          : Date.parse(reservation.updatedAt)) + (deps.executionLeaseMs ?? 60_000);
    if (!Number.isNaN(leaseMs) && nowMs <= leaseMs) {
      return {
        status: 'STILL_IN_FLIGHT',
        reconciled: false,
        reservationId: reservation.id,
        providerIdempotencyKey: reservation.providerIdempotencyKey,
        reservationStatus: 'executing',
        reason: `Reservation "${reservation.id}" lease has not expired (${reservation.leaseExpiresAt}); refusing premature reconciliation.`,
      };
    }

    // Stale `executing` lock: transition to `uncertain_reconciliation_required`
    // (preserving order lock & owner approval) before performing provider lookup.
    await deps.replayStore.markRefundUncertain({
      reservationId: reservation.id,
      providerOutcomeStatus:
        reservation.providerOutcomeStatus === 'finalization_failed_after_success'
          ? 'finalization_failed_after_success'
          : 'timeout_or_unknown',
      providerTxId: reservation.providerTxId,
      reason: `Stale executing reservation (lease expired at ${reservation.leaseExpiresAt}) moved to uncertain reconciliation.`,
      nowIso: effectiveNow.toISOString(),
    });
  }

  const provider = deps.paymentProvider;
  if (
    !provider ||
    !provider.supportsRefundLookup ||
    typeof provider.lookupRefundByIdempotencyKey !== 'function'
  ) {
    return {
      status: 'BLOCKED_LOOKUP_UNSUPPORTED',
      reconciled: false,
      reservationId: reservation.id,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reservationStatus: 'uncertain_reconciliation_required',
      reason:
        'Payment provider adapter does not support authoritative refund lookup; reservation remains locked for manual reconciliation.',
    };
  }

  let lookupResult: ProviderRefundLookupResult;
  try {
    lookupResult = await provider.lookupRefundByIdempotencyKey({
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reservationId: reservation.id,
      requestId: reservation.requestId,
      orderId: reservation.orderId,
      amountCents: reservation.amountCents,
    });
  } catch (err: any) {
    return {
      status: 'BLOCKED_OUTCOME_UNKNOWN',
      reconciled: false,
      reservationId: reservation.id,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reservationStatus: 'uncertain_reconciliation_required',
      reason: `Provider lookup failed (${err?.message || 'unknown error'}); reservation remains locked.`,
    };
  }

  if (lookupResult.outcome === 'FOUND_SUCCESS') {
    try {
      await deps.replayStore.finalizeRefundExecution({
        reservationId: reservation.id,
        executionTxId: lookupResult.txId,
        outcomePayload: {
          txId: lookupResult.txId,
          providerIdempotencyKey: reservation.providerIdempotencyKey,
          providerRefundId: lookupResult.providerRefundId ?? lookupResult.txId,
          providerStatus: lookupResult.providerStatus ?? 'succeeded',
          orderId: reservation.orderId,
          requestId: reservation.requestId,
          reconciledAt: effectiveNow.toISOString(),
        },
        nowIso: effectiveNow.toISOString(),
      });
    } catch (err: any) {
      return {
        status: 'BLOCKED_FINALIZATION_FAILED',
        reconciled: false,
        reservationId: reservation.id,
        providerIdempotencyKey: reservation.providerIdempotencyKey,
        reservationStatus: 'uncertain_reconciliation_required',
        reason: `Provider confirmed refund "${lookupResult.txId}", but DB finalization failed: ${
          err?.message || 'unknown error'
        }`,
      };
    }

    if (deps.orderStore?.configured && deps.orderStore.markOrderRefunded) {
      try {
        await deps.orderStore.markOrderRefunded({
          orderId: reservation.orderId,
          businessId: reservation.businessId,
          refundAmountCents: reservation.amountCents,
          refundTxId: lookupResult.txId,
          reservationId: reservation.id,
          refundedAt: effectiveNow.toISOString(),
        });
      } catch (orderUpdateErr: any) {
        console.warn(
          `[financeExecutor] Reconciled reservation ${reservation.id}, but authoritative order refund status sync deferred:`,
          orderUpdateErr?.message || orderUpdateErr
        );
      }
    }

    return {
      status: 'RECONCILED_EXECUTED',
      reconciled: true,
      reservationId: reservation.id,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      executionTxId: lookupResult.txId,
      reservationStatus: 'executed',
      reason: `Reconciliation confirmed provider refund "${lookupResult.txId}" and finalized execution without issuing a duplicate refund.`,
    };
  }

  if (lookupResult.outcome === 'CONFIRMED_NOT_EXECUTED') {
    const retryPermitted = Boolean(provider.supportsIdempotencyKey);
    await deps.replayStore.reconcileMarkNotExecuted({
      reservationId: reservation.id,
      retryAllowed: retryPermitted,
      reason: lookupResult.reason,
      nowIso: effectiveNow.toISOString(),
    });
    if (retryPermitted) {
      return {
        status: 'RECONCILED_NOT_EXECUTED_RETRY_PERMITTED',
        reconciled: true,
        reservationId: reservation.id,
        providerIdempotencyKey: reservation.providerIdempotencyKey,
        reservationStatus: 'failed',
        reason: `Provider authoritatively confirmed no refund occurred (${lookupResult.reason}); safe retry permitted using existing provider_idempotency_key.`,
      };
    }
    return {
      status: 'RECONCILED_NOT_EXECUTED_RETRY_BLOCKED',
      reconciled: true,
      reservationId: reservation.id,
      providerIdempotencyKey: reservation.providerIdempotencyKey,
      reservationStatus: 'rejected',
      reason: `Provider confirmed no refund occurred, but adapter lacks idempotency key support; automatic retry blocked (${lookupResult.reason}).`,
    };
  }

  return {
    status: 'BLOCKED_OUTCOME_UNKNOWN',
    reconciled: false,
    reservationId: reservation.id,
    providerIdempotencyKey: reservation.providerIdempotencyKey,
    reservationStatus: 'uncertain_reconciliation_required',
    reason: `Provider lookup outcome is unknown (${lookupResult.reason}); reservation remains locked.`,
  };
}

