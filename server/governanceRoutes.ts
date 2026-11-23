import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import {
  AUTHORITY_RANK,
  DEFAULT_OWNER_APPROVAL_TTL_MS,
  isValidConfidence,
  parseStrictIsoTimestamp,
  type AuthorityLevel,
  type FinanceRefundRequest,
} from '../src/governance/provenance';
import { DEFAULT_FINANCE_REFUND_POLICY } from '../src/governance/financeRefundGate';
import {
  ingestAuthenticatedRefundRequest,
  loadServerKeyringFromEnv,
  resolveServerPersistedRequestTtlMs,
  verifyIngestionPayloadFreshness,
  type ServerKeyring,
} from './provenanceAuth';
import type { PersistentReplayStore } from './replayStore';
import {
  type PaymentRefundProviderAdapter,
  executeAuthorizedFinanceRefund,
  identifyStaleRefundReservations,
  reconcileFinanceRefund,
} from './financeExecutor';
import {
  type AuthenticatedGovernanceRequest,
  type GovernanceAuthVerifier,
  buildCallerScopeFilter,
  createSupabaseGovernanceAuthFromEnv,
  isCallerAuthorizedForScope,
  requireGovernancePermission,
  validateCallerHasScope,
} from './governanceAuth';
import {
  SUPPORTED_REFUND_CURRENCIES,
  createSupabaseAuthoritativeOrderStoreFromEnv,
  validateOrderRefundEligibility,
  type AuthoritativeBusinessMembership,
  type AuthoritativeOrderStore,
} from './orderStore';
import {
  SlidingFixedWindowRateLimiter,
  createRateLimitMiddleware,
  type RateLimiterBackend,
  type RateLimitRule,
} from './rateLimiter';

const MIN_OWNER_APPROVAL_TTL_MS = 60 * 1000;
const MAX_OWNER_APPROVAL_TTL_MS = 60 * 60 * 1000;

function resolveServerApprovalTtlMs(): number {
  const raw = Number(process.env.GOVERNANCE_APPROVAL_TTL_MS);
  if (Number.isFinite(raw) && raw >= MIN_OWNER_APPROVAL_TTL_MS && raw <= MAX_OWNER_APPROVAL_TTL_MS) {
    return Math.round(raw);
  }
  return DEFAULT_OWNER_APPROVAL_TTL_MS;
}

export interface GovernanceRouterDeps {
  replayStore: PersistentReplayStore;
  getKeyring?: () => ServerKeyring;
  getAuthVerifier?: () => GovernanceAuthVerifier;
  orderStore?: AuthoritativeOrderStore;
  getOrderStore?: () => AuthoritativeOrderStore;
  getNow?: () => Date;
  paymentProvider?: PaymentRefundProviderAdapter;
  executePaymentRefund?: (
    req: FinanceRefundRequest,
    ctx?: { providerIdempotencyKey: string; reservationId: string; amountCents: number }
  ) => Promise<{ txId: string }>;
  limiter?: RateLimiterBackend;
  rateLimits?: Partial<{
    ingest: RateLimitRule;
    approvalCreate: RateLimitRule;
    approvalRevoke: RateLimitRule;
    refundExecute: RateLimitRule;
    reconcile: RateLimitRule;
  }>;
}

export function createGovernanceRouter(deps: GovernanceRouterDeps): Router {
  const router = Router();
  const getKeyring = deps.getKeyring ?? loadServerKeyringFromEnv;
  const getAuthVerifier =
    deps.getAuthVerifier ?? (() => createSupabaseGovernanceAuthFromEnv());
  const getOrderStore =
    deps.getOrderStore ??
    (() => deps.orderStore ?? createSupabaseAuthoritativeOrderStoreFromEnv());
  const getNow = deps.getNow ?? (() => new Date());
  const limiter = deps.limiter ?? new SlidingFixedWindowRateLimiter();

  const ingestRule: RateLimitRule = deps.rateLimits?.ingest ?? {
    bucket: 'gov:provenance-ingest',
    windowMs: 5 * 60 * 1000,
    maxRequests: 120,
  };
  const approvalCreateRule: RateLimitRule = deps.rateLimits?.approvalCreate ?? {
    bucket: 'gov:approvals-create',
    windowMs: 5 * 60 * 1000,
    maxRequests: 120,
  };
  const approvalRevokeRule: RateLimitRule = deps.rateLimits?.approvalRevoke ?? {
    bucket: 'gov:approvals-revoke',
    windowMs: 5 * 60 * 1000,
    maxRequests: 120,
  };
  const refundExecuteRule: RateLimitRule = deps.rateLimits?.refundExecute ?? {
    bucket: 'gov:refund-execute',
    windowMs: 5 * 60 * 1000,
    maxRequests: 60,
  };
  const reconcileRule: RateLimitRule = deps.rateLimits?.reconcile ?? {
    bucket: 'gov:refund-reconcile',
    windowMs: 5 * 60 * 1000,
    maxRequests: 120,
  };

  const paymentProvider = deps.paymentProvider;
  const paymentCallback = deps.executePaymentRefund;

  // Strictly non-secret diagnostic endpoint reporting boolean configuration state only
  router.get('/api/governance/provenance/status', (_req: Request, res: Response) => {
    const rawActiveId = process.env.PROVENANCE_ACTIVE_KEY_ID;
    const rawKeys = process.env.PROVENANCE_HMAC_KEYS;
    const rawFallback = process.env.PROVENANCE_HMAC_SECRET;

    const trimmedKeys = rawKeys?.trim() || '';
    const trimmedActive = rawActiveId?.trim() || '';

    let rawJsonParses = false;
    let parsedTopLevelIsObject = false;
    let parsedEntryCount = 0;
    let entriesWithValidSecretLen = 0;
    try {
      if (trimmedKeys) {
        const parsed = JSON.parse(trimmedKeys);
        rawJsonParses = true;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedTopLevelIsObject = true;
          const vals = Object.values(parsed as Record<string, any>);
          parsedEntryCount = vals.length;
          entriesWithValidSecretLen = vals.filter(
            (v) => v && typeof v.secret === 'string' && v.secret.trim().length >= 16
          ).length;
        }
      }
    } catch {
      rawJsonParses = false;
    }

    const keyring = getKeyring();
    const activeEntry = keyring.activeKeyId
      ? keyring.keys[keyring.activeKeyId]
      : undefined;
    const activeKeyNotExpired = Boolean(
      activeEntry &&
        (!activeEntry.expiresAt ||
          (parseStrictIsoTimestamp(activeEntry.expiresAt) ?? -1) > getNow().getTime())
    );
    const componentAuthorized = Boolean(
      activeEntry &&
        DEFAULT_FINANCE_REFUND_POLICY.allowedIngestionComponents.includes(
          activeEntry.allowedComponent
        )
    );
    const authVerifier = getAuthVerifier();
    const orderStore = getOrderStore();

    res.json({
      variablesPresent: {
        PROVENANCE_ACTIVE_KEY_ID: Boolean(trimmedActive),
        PROVENANCE_HMAC_KEYS: Boolean(trimmedKeys),
        PROVENANCE_HMAC_SECRET: Boolean(rawFallback?.trim()),
      },
      jsonKeyringParses: rawJsonParses && parsedTopLevelIsObject && parsedEntryCount > 0,
      activeKeyMatchesActiveEntry: Boolean(
        activeEntry && activeEntry.status === 'active' && activeKeyNotExpired
      ),
      signingComponentAuthorized: componentAuthorized,
      loadedKeyCount: Object.keys(keyring.keys).length,
      parsedEntryCount,
      entriesWithValidSecretLength: entriesWithValidSecretLen,
      detectedNonJsonRawToken: !rawJsonParses && /^[0-9a-fA-F]{16,}$/.test(trimmedKeys),
      governanceHttpAuthConfigured: authVerifier.configured,
      authoritativeOrdersConfigured: orderStore.configured,
    });
  });

  router.post(
    '/api/governance/provenance/ingest',
    requireGovernancePermission(getAuthVerifier, 'provenance:ingest'),
    createRateLimitMiddleware(limiter, ingestRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller;
      if (!caller) {
        res.status(401).json({
          success: false,
          code: 'AUTHENTICATION_REQUIRED',
          error: 'Caller identity could not be verified.',
        });
        return;
      }

      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error:
            callerScope.reason ||
            'Caller lacks verifiable tenant, owner, or authorized business scope.',
        });
        return;
      }

      const keyring = getKeyring();
      if (!keyring.activeKeyId || !keyring.keys[keyring.activeKeyId]) {
        res.status(503).json({
          success: false,
          error:
            'Provenance ingestion signing keys are not configured on server (fail-closed). Set PROVENANCE_HMAC_KEYS or PROVENANCE_HMAC_SECRET.',
        });
        return;
      }

      const body = req.body || {};
      const requestedAuthority = (body.authority_level || 'recommend_only') as string;
      if (!(requestedAuthority in AUTHORITY_RANK)) {
        res.status(400).json({
          success: false,
          error: `Invalid authority_level "${requestedAuthority}".`,
        });
        return;
      }

      // Only owner/admin callers may request initial owner_approved authority at ingest;
      // execution still independently requires an authoritative server-side owner_approvals record.
      if (
        requestedAuthority === 'owner_approved' &&
        !caller.roles.includes('owner') &&
        !caller.roles.includes('admin')
      ) {
        res.status(403).json({
          success: false,
          code: 'INSUFFICIENT_ROLE_FOR_AUTHORITY',
          error:
            'Caller role is not permitted to ingest requests with authority_level="owner_approved".',
        });
        return;
      }

      const businessId =
        typeof body.business_id === 'string' ? body.business_id.trim() : '';
      if (!businessId) {
        res.status(400).json({
          success: false,
          code: 'MISSING_BUSINESS_ID',
          error: 'A non-empty business_id is required.',
        });
        return;
      }

      const orderStore = getOrderStore();
      let bizAccess: AuthoritativeBusinessMembership | undefined;
      if (orderStore.configured && orderStore.verifyCallerBusinessAccess) {
        try {
          bizAccess = await orderStore.verifyCallerBusinessAccess({
            businessId,
            caller,
          });
        } catch (bizErr: any) {
          res.status(503).json({
            success: false,
            code: 'AUTHORITATIVE_ORDER_LOOKUP_FAILED',
            error:
              bizErr?.message ||
              'Authoritative business membership verification failed (fail-closed).',
          });
          return;
        }
        if (!bizAccess.authorized) {
          const isInactiveBiz =
            bizAccess.businessStatus &&
            bizAccess.businessStatus !== 'active' &&
            bizAccess.businessStatus !== 'missing';
          res.status(isInactiveBiz ? 409 : 403).json({
            success: false,
            code: isInactiveBiz ? 'BUSINESS_NOT_ACTIVE' : 'BUSINESS_SCOPE_DENIED',
            error: bizAccess.reason || 'Caller is not authorized for this business_id.',
          });
          return;
        }
      } else {
        const scopeCheck = isCallerAuthorizedForScope(caller, {
          businessId,
          ownerId: caller.ownerId,
          tenantId: caller.tenantId,
          requireStoredTenantOrOwnerScope: false,
        });
        if (!scopeCheck.authorized) {
          res.status(403).json({
            success: false,
            code: 'BUSINESS_SCOPE_DENIED',
            error: scopeCheck.reason || 'Caller is not authorized for this business_id.',
          });
          return;
        }
      }

      if (!String(body.order_id || '').trim()) {
        res.status(400).json({
          success: false,
          error: 'A non-empty order_id is required.',
        });
        return;
      }

      const amountUsd = Number(body.amount_usd || 0);
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        res.status(400).json({
          success: false,
          error: 'A positive amount_usd is required.',
        });
        return;
      }

      const rawCurrency =
        typeof body.currency === 'string' && body.currency.trim()
          ? body.currency.trim().toUpperCase()
          : undefined;
      if (rawCurrency && !SUPPORTED_REFUND_CURRENCIES.has(rawCurrency)) {
        res.status(400).json({
          success: false,
          code: 'UNSUPPORTED_ORDER_CURRENCY',
          error: `Unsupported refund currency "${rawCurrency}".`,
        });
        return;
      }

      if (typeof body.confidence !== 'number' || !isValidConfidence(body.confidence)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_CONFIDENCE',
          error: 'A valid finite numeric confidence between 0 and 1 is required.',
        });
        return;
      }

      try {
        // Strictly ignore any client-supplied sender_auth claims, created_at, expires_at,
        // ttl, ttlMs, or ingested_at. Derive all timestamps and authority from server UTC clock & policy.
        const nowDate = getNow();
        const requestTtlMs = resolveServerPersistedRequestTtlMs();
        const signedRequest = ingestAuthenticatedRefundRequest(
          {
            business_id: businessId,
            order_id: String(body.order_id || '').trim(),
            customer_email: String(body.customer_email || ''),
            amount_usd: amountUsd,
            ...(rawCurrency ? { currency: rawCurrency } : {}),
            reason: String(body.reason || ''),
            source_agent: body.source_agent || 'customer_support',
            trigger_type: body.trigger_type || 'customer_ticket',
            trigger_id: String(body.trigger_id || `tkt-${nowDate.getTime()}`),
            raw_trigger_payload: JSON.stringify(body.raw_trigger_payload ?? body),
            confidence: body.confidence,
            authority_level: requestedAuthority as AuthorityLevel,
            policy_version: body.policy_version
              ? String(body.policy_version)
              : '2026.11.0',
            sender_auth: {
              verified: true,
              provider: caller.authProvider,
              actor_id: caller.userId,
              verified_at: nowDate.toISOString(),
            },
            now: nowDate,
            ttlMs: requestTtlMs,
          },
          keyring
        );

        const freshness = verifyIngestionPayloadFreshness(signedRequest.provenance, {
          now: nowDate,
        });
        if (!freshness.valid) {
          res.status(400).json({
            success: false,
            code: freshness.code || 'STALE_INGESTION_SIGNATURE',
            error: freshness.reason || 'Ingested provenance failed server freshness validation.',
          });
          return;
        }

        if (signedRequest.provenance) {
          let effectiveOwner: string | null =
            bizAccess?.ownerId ??
            (caller.roles.includes('owner') ? caller.userId : caller.ownerId ?? null);
          let effectiveTenant: string | null =
            bizAccess?.tenantId ??
            caller.tenantId ??
            caller.ownerId ??
            (caller.roles.includes('owner') ? caller.userId : null);

          if (orderStore.configured) {
            const authOrder = await orderStore.getOrderForBusiness({
              orderId: signedRequest.order_id,
              businessId: signedRequest.business_id,
            });
            if (authOrder) {
              const orderScope = isCallerAuthorizedForScope(
                caller,
                {
                  ownerId: authOrder.ownerId,
                  tenantId: authOrder.tenantId,
                  businessId: authOrder.businessId,
                },
                bizAccess
              );
              if (!orderScope.authorized) {
                res.status(403).json({
                  success: false,
                  code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
                  error: 'Caller is not authorized to ingest provenance for this order.',
                });
                return;
              }
              if (!effectiveOwner && authOrder.ownerId) {
                effectiveOwner = authOrder.ownerId;
              }
              if (authOrder.tenantId && !bizAccess?.tenantId) {
                effectiveTenant = authOrder.tenantId;
              } else if (!effectiveTenant && (authOrder.tenantId || authOrder.ownerId)) {
                effectiveTenant = authOrder.tenantId ?? authOrder.ownerId ?? null;
              }
            }
          }

          if (!effectiveOwner && !effectiveTenant) {
            res.status(403).json({
              success: false,
              code: 'CALLER_SCOPE_MISSING',
              error:
                'Ingested governance records require a verifiable owner or tenant scope (fail-closed).',
            });
            return;
          }

          await deps.replayStore.recordProvenanceOrigin(
            signedRequest.provenance,
            signedRequest.order_id,
            {
              ownerId: effectiveOwner,
              tenantId: effectiveTenant,
            }
          );

          if (deps.replayStore.recordAuthenticatedRefundRequest) {
            if (!signedRequest.provenance.expires_at) {
              res.status(500).json({
                success: false,
                code: 'MISSING_OR_MALFORMED_TIMESTAMP',
                error: 'Signed provenance missing server expires_at timestamp.',
              });
              return;
            }
            await deps.replayStore.recordAuthenticatedRefundRequest({
              requestId: signedRequest.provenance.request_id,
              ownerId: effectiveOwner,
              tenantId: effectiveTenant,
              businessId: signedRequest.business_id,
              orderId: signedRequest.order_id,
              amountCents: Math.round(signedRequest.amount_usd * 100),
              customerEmail: signedRequest.customer_email,
              reason: signedRequest.reason,
              authorityLevel: signedRequest.provenance.authority_level,
              expiresAt: signedRequest.provenance.expires_at,
              createdAt: signedRequest.provenance.created_at,
              provenance: signedRequest.provenance,
            });
          }
        }

        res.json({ success: true, request: signedRequest });
      } catch (err: any) {
        res.status(400).json({
          success: false,
          error: err?.message || 'Could not ingest authenticated provenance request.',
        });
      }
    }
  );

  // Authoritative server-side owner approval creation (P0-C)
  router.post(
    '/api/governance/approvals',
    requireGovernancePermission(getAuthVerifier, 'finance:approval:create'),
    createRateLimitMiddleware(limiter, approvalCreateRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller;
      if (!caller) {
        res.status(401).json({
          success: false,
          code: 'AUTHENTICATION_REQUIRED',
          error: 'Caller identity could not be verified.',
        });
        return;
      }

      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error:
            callerScope.reason ||
            'Caller lacks verifiable tenant, owner, or authorized business scope.',
        });
        return;
      }

      if (
        !deps.replayStore.getAuthenticatedRefundRequest ||
        !deps.replayStore.findActiveApprovalForRequestOrOrder
      ) {
        res.status(503).json({
          success: false,
          code: 'APPROVAL_LEDGER_UNSUPPORTED',
          error: 'Authoritative approval ledger methods are unavailable on configured replay store.',
        });
        return;
      }

      const body = req.body || {};
      const requestId =
        typeof body.request_id === 'string' ? body.request_id.trim() : '';
      const orderId =
        typeof body.order_id === 'string' ? body.order_id.trim() : '';
      const businessId =
        typeof body.business_id === 'string' ? body.business_id.trim() : '';
      const rawAmountCents = body.amount_cents;
      const amountCents =
        typeof rawAmountCents === 'number' && Number.isInteger(rawAmountCents)
          ? rawAmountCents
          : NaN;
      const decisionNote =
        typeof body.decision_note === 'string' && body.decision_note.trim()
          ? body.decision_note.trim().slice(0, 500)
          : null;

      if (!requestId || !orderId || !businessId || !Number.isInteger(amountCents) || amountCents <= 0) {
        res.status(400).json({
          success: false,
          code: 'INVALID_APPROVAL_REQUEST_PAYLOAD',
          error:
            'request_id, order_id, business_id, and positive integer amount_cents are required.',
        });
        return;
      }

      const orderStore = getOrderStore();
      let bizAccess: AuthoritativeBusinessMembership | undefined;
      if (orderStore.configured && orderStore.verifyCallerBusinessAccess) {
        try {
          bizAccess = await orderStore.verifyCallerBusinessAccess({
            businessId,
            caller,
          });
        } catch (bizErr: any) {
          res.status(503).json({
            success: false,
            code: 'AUTHORITATIVE_ORDER_LOOKUP_FAILED',
            error:
              bizErr?.message ||
              'Authoritative business membership verification failed (fail-closed).',
          });
          return;
        }
        if (!bizAccess.authorized) {
          const isInactiveBiz =
            bizAccess.businessStatus &&
            bizAccess.businessStatus !== 'active' &&
            bizAccess.businessStatus !== 'missing';
          res.status(isInactiveBiz ? 409 : 403).json({
            success: false,
            code: isInactiveBiz ? 'BUSINESS_NOT_ACTIVE' : 'CROSS_TENANT_OR_BUSINESS_DENIED',
            error:
              bizAccess.reason ||
              'Caller is not authorized to approve requests for this tenant or business.',
          });
          return;
        }
      } else {
        const bizPreCheck = isCallerAuthorizedForScope(caller, {
          businessId,
          requireStoredTenantOrOwnerScope: false,
        });
        if (!bizPreCheck.authorized) {
          res.status(403).json({
            success: false,
            code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
            error: 'Caller is not authorized to approve requests for this tenant or business.',
          });
          return;
        }
      }

      try {
        const origReq = await deps.replayStore.getAuthenticatedRefundRequest(requestId);
        if (!origReq) {
          res.status(404).json({
            success: false,
            code: 'REFUND_REQUEST_NOT_FOUND',
            error: `Authenticated refund request "${requestId}" was not found.`,
          });
          return;
        }

        const scopeCheck = isCallerAuthorizedForScope(
          caller,
          {
            ownerId: origReq.ownerId,
            tenantId: origReq.tenantId,
            businessId: origReq.businessId,
          },
          bizAccess
        );
        if (!scopeCheck.authorized) {
          res.status(403).json({
            success: false,
            code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
            error: 'Caller is not authorized to approve requests for this tenant or business.',
          });
          return;
        }

        const nowDate = getNow();
        const nowMs = nowDate.getTime();
        const reqCreatedMs = parseStrictIsoTimestamp(origReq.createdAt);
        const reqExpiresMs = parseStrictIsoTimestamp(origReq.expiresAt);
        if (
          reqCreatedMs === null ||
          reqExpiresMs === null ||
          reqExpiresMs <= reqCreatedMs
        ) {
          res.status(409).json({
            success: false,
            code: 'MISSING_OR_MALFORMED_TIMESTAMP',
            error: `Persisted refund request "${requestId}" has missing or malformed created_at/expires_at timestamps.`,
          });
          return;
        }
        if (nowMs >= reqExpiresMs) {
          res.status(409).json({
            success: false,
            code: 'REFUND_REQUEST_EXPIRED',
            error: `Refund request "${requestId}" expired at "${origReq.expiresAt}" and can no longer be approved.`,
          });
          return;
        }

        if (
          origReq.orderId !== orderId ||
          origReq.businessId !== businessId ||
          origReq.amountCents !== amountCents
        ) {
          res.status(409).json({
            success: false,
            code: 'APPROVAL_REQUEST_BINDING_MISMATCH',
            error:
              'Submitted order_id, business_id, or amount_cents does not match the original authenticated refund request.',
          });
          return;
        }

        if (orderStore.configured) {
          const authOrder = await orderStore.getOrderForBusiness({
            orderId: origReq.orderId,
            businessId: origReq.businessId,
          });
          if (!authOrder) {
            res.status(404).json({
              success: false,
              code: 'AUTHORITATIVE_ORDER_NOT_FOUND',
              error: 'No authoritative order found for this business and order_id.',
            });
            return;
          }
          const orderScope = isCallerAuthorizedForScope(
            caller,
            {
              ownerId: authOrder.ownerId,
              tenantId: authOrder.tenantId,
              businessId: authOrder.businessId,
            },
            bizAccess
          );
          if (!orderScope.authorized) {
            res.status(403).json({
              success: false,
              code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
              error: 'Caller is not authorized to approve requests for this tenant or business.',
            });
            return;
          }
          const eligibility = validateOrderRefundEligibility(
            authOrder,
            origReq.amountCents,
            typeof body.currency === 'string' ? body.currency : undefined
          );
          if (!eligibility.eligible) {
            res.status(409).json({
              success: false,
              code: eligibility.code || 'ORDER_NOT_ELIGIBLE_FOR_REFUND',
              error: eligibility.reason || `Order is not eligible for refund.`,
            });
            return;
          }
        }

        const callerScopeFilter = buildCallerScopeFilter(
          caller,
          origReq.businessId,
          bizAccess
            ? [
                {
                  businessId: origReq.businessId,
                  ownerId: bizAccess.ownerId,
                  tenantId: bizAccess.tenantId,
                },
              ]
            : undefined
        );
        const existingReservation =
          (await deps.replayStore.getRefundReservation({
            requestId,
            businessId: origReq.businessId,
            scope: callerScopeFilter,
          })) ??
          (await deps.replayStore.getRefundReservation({
            orderId,
            businessId: origReq.businessId,
            scope: callerScopeFilter,
          }));
        if (
          existingReservation &&
          (existingReservation.status === 'executed' ||
            existingReservation.status === 'executing' ||
            existingReservation.status === 'uncertain_reconciliation_required')
        ) {
          res.status(409).json({
            success: false,
            code: 'REFUND_ALREADY_PROCESSED_OR_LOCKED',
            error: `Order "${orderId}" already has a refund reservation in state "${existingReservation.status}".`,
          });
          return;
        }

        const existingApproval =
          await deps.replayStore.findActiveApprovalForRequestOrOrder(
            requestId,
            orderId,
            origReq.businessId
          );
        if (existingApproval) {
          res.status(409).json({
            success: false,
            code: 'DUPLICATE_ACTIVE_APPROVAL',
            error: `An authoritative approval ("${existingApproval.approval_id}", status="${existingApproval.status}") already exists for this request or order.`,
          });
          return;
        }

        // Ignore any client-supplied approval_id, approved_by_user_id, expires_at, ttl, created_at, or status.
        // Strictly cap approval expiration so it never extends beyond the parent refund request's expiration.
        const approvalId = `apr-${crypto.randomUUID()}`;
        const uncappedApprovalExpiresMs = nowMs + resolveServerApprovalTtlMs();
        const cappedApprovalExpiresMs = Math.min(uncappedApprovalExpiresMs, reqExpiresMs);
        if (cappedApprovalExpiresMs <= nowMs) {
          res.status(409).json({
            success: false,
            code: 'REFUND_REQUEST_EXPIRED',
            error: `Refund request "${requestId}" expired at "${origReq.expiresAt}" and can no longer be approved.`,
          });
          return;
        }
        const expiresAt = new Date(cappedApprovalExpiresMs).toISOString();
        const ownerId =
          origReq.ownerId ??
          bizAccess?.ownerId ??
          (caller.roles.includes('owner') ? caller.userId : caller.ownerId ?? null);
        const tenantId =
          origReq.tenantId ??
          bizAccess?.tenantId ??
          caller.tenantId ??
          ownerId;

        const created = await deps.replayStore.recordOwnerApproval({
          approvalId,
          requestId: origReq.requestId,
          orderId: origReq.orderId,
          businessId: origReq.businessId,
          amountCents: origReq.amountCents,
          approvedByUserId: caller.userId,
          expiresAt,
          nowIso: nowDate.toISOString(),
          status: 'approved',
          ownerId,
          tenantId,
          decisionNote,
        });

        res.status(201).json({
          success: true,
          approval: created,
        });
      } catch (err: any) {
        if (err?.code === 'DUPLICATE_ACTIVE_APPROVAL') {
          res.status(409).json({
            success: false,
            code: 'DUPLICATE_ACTIVE_APPROVAL',
            error: err.message,
          });
          return;
        }
        res.status(500).json({
          success: false,
          code: 'APPROVAL_CREATION_FAILED',
          error: err?.message || 'Could not record authoritative owner approval.',
        });
      }
    }
  );

  // List authoritative approvals scoped strictly to caller's verified tenant & businesses
  router.get(
    '/api/governance/approvals',
    requireGovernancePermission(getAuthVerifier, 'finance:approval:read'),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller;
      if (!caller) {
        res.status(401).json({
          success: false,
          code: 'AUTHENTICATION_REQUIRED',
          error: 'Caller identity could not be verified.',
        });
        return;
      }

      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error:
            callerScope.reason ||
            'Caller lacks verifiable tenant, owner, or authorized business scope.',
        });
        return;
      }

      if (!deps.replayStore.listOwnerApprovals) {
        res.status(503).json({
          success: false,
          code: 'APPROVAL_LEDGER_UNSUPPORTED',
          error: 'Authoritative approval ledger listing is unavailable.',
        });
        return;
      }

      const businessId =
        typeof req.query.business_id === 'string' && req.query.business_id.trim()
          ? req.query.business_id.trim()
          : undefined;
      const requestId =
        typeof req.query.request_id === 'string' && req.query.request_id.trim()
          ? req.query.request_id.trim()
          : undefined;
      const orderId =
        typeof req.query.order_id === 'string' && req.query.order_id.trim()
          ? req.query.order_id.trim()
          : undefined;

      const orderStore = getOrderStore();
      if (businessId) {
        if (orderStore.configured && orderStore.verifyCallerBusinessAccess) {
          const bizAccess = await orderStore.verifyCallerBusinessAccess({
            businessId,
            caller,
          });
          if (!bizAccess.authorized) {
            res.status(403).json({
              success: false,
              code: 'BUSINESS_SCOPE_DENIED',
              error: bizAccess.reason || 'Caller is not authorized for this business_id.',
            });
            return;
          }
        } else {
          const bizCheck = isCallerAuthorizedForScope(caller, {
            businessId,
            requireStoredTenantOrOwnerScope: false,
          });
          if (!bizCheck.authorized) {
            res.status(403).json({
              success: false,
              code: 'BUSINESS_SCOPE_DENIED',
              error: bizCheck.reason || 'Caller is not authorized for this business_id.',
            });
            return;
          }
        }
      }

      try {
        const authorizedBindings =
          orderStore.configured && orderStore.listAuthorizedBusinessesForCaller
            ? await orderStore.listAuthorizedBusinessesForCaller(caller)
            : undefined;
        const scopeFilter = buildCallerScopeFilter(caller, businessId, authorizedBindings);
        // Apply tenant/owner/business filter inside DB query BEFORE SQL LIMIT 200
        const dbScopedRows = await deps.replayStore.listOwnerApprovals({
          businessId,
          requestId,
          orderId,
          scope: scopeFilter,
        });

        const scopedRows = dbScopedRows.filter((row) => {
          const binding = authorizedBindings?.find((b) => b.businessId === row.business_id);
          return isCallerAuthorizedForScope(
            caller,
            {
              ownerId: row.owner_id,
              tenantId: row.tenant_id,
              businessId: row.business_id,
            },
            binding
              ? {
                  authorized: true,
                  businessId: binding.businessId,
                  ownerId: binding.ownerId,
                  tenantId: binding.tenantId,
                }
              : undefined
          ).authorized;
        });

        res.json({
          success: true,
          approvals: scopedRows,
        });
      } catch (err: any) {
        res.status(500).json({
          success: false,
          error: err?.message || 'Failed to fetch authoritative owner approvals.',
        });
      }
    }
  );

  // Revoke an unused/unconsumed owner approval (blocks already-consumed & cross-tenant approvals)
  router.post(
    '/api/governance/approvals/:approvalId/revoke',
    requireGovernancePermission(getAuthVerifier, 'finance:approval:revoke'),
    createRateLimitMiddleware(limiter, approvalRevokeRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller;
      if (!caller) {
        res.status(401).json({
          success: false,
          code: 'AUTHENTICATION_REQUIRED',
          error: 'Caller identity could not be verified.',
        });
        return;
      }

      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error:
            callerScope.reason ||
            'Caller lacks verifiable tenant, owner, or authorized business scope.',
        });
        return;
      }

      const approvalId = String(req.params.approvalId || '').trim();
      if (!approvalId) {
        res.status(400).json({
          success: false,
          error: 'approvalId is required.',
        });
        return;
      }

      if (
        !deps.replayStore.getOwnerApprovalDetailed ||
        !deps.replayStore.revokeOwnerApprovalWithResult
      ) {
        res.status(503).json({
          success: false,
          code: 'APPROVAL_LEDGER_UNSUPPORTED',
          error: 'Authoritative approval revocation is unavailable.',
        });
        return;
      }

      try {
        const existing = await deps.replayStore.getOwnerApprovalDetailed(approvalId);
        if (!existing) {
          res.status(404).json({
            success: false,
            code: 'APPROVAL_NOT_FOUND',
            error: `Owner approval "${approvalId}" was not found.`,
          });
          return;
        }

        const orderStore = getOrderStore();
        const bizAccess =
          orderStore.configured && orderStore.verifyCallerBusinessAccess
            ? await orderStore.verifyCallerBusinessAccess({
                businessId: existing.business_id,
                caller,
              })
            : undefined;

        const scopeCheck = isCallerAuthorizedForScope(
          caller,
          {
            ownerId: existing.owner_id,
            tenantId: existing.tenant_id,
            businessId: existing.business_id,
          },
          bizAccess
        );
        if (!scopeCheck.authorized) {
          res.status(403).json({
            success: false,
            code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
            error: 'Caller is not authorized to revoke this approval.',
          });
          return;
        }

        const revokeResult = await deps.replayStore.revokeOwnerApprovalWithResult(
          approvalId,
          buildCallerScopeFilter(
            caller,
            existing.business_id,
            bizAccess
              ? [
                  {
                    businessId: existing.business_id,
                    ownerId: bizAccess.ownerId,
                    tenantId: bizAccess.tenantId,
                  },
                ]
              : undefined
          )
        );
        if (revokeResult.status === 'forbidden_scope') {
          res.status(403).json({
            success: false,
            code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
            error: 'Caller is not authorized to revoke this approval.',
          });
          return;
        }
        if (revokeResult.status === 'not_found') {
          res.status(404).json({
            success: false,
            code: 'APPROVAL_NOT_FOUND',
            error: `Owner approval "${approvalId}" was not found.`,
          });
          return;
        }
        if (revokeResult.status === 'already_consumed') {
          res.status(409).json({
            success: false,
            code: 'APPROVAL_ALREADY_CONSUMED',
            error: `Owner approval "${approvalId}" has already been consumed and cannot be revoked.`,
          });
          return;
        }
        if (revokeResult.status === 'already_revoked') {
          res.status(409).json({
            success: false,
            code: 'APPROVAL_ALREADY_REVOKED',
            error: `Owner approval "${approvalId}" is already revoked.`,
          });
          return;
        }
        if (revokeResult.status !== 'revoked') {
          res.status(409).json({
            success: false,
            code: 'APPROVAL_CANNOT_BE_REVOKED',
            error: `Owner approval "${approvalId}" cannot be revoked in status "${revokeResult.approval.status}".`,
          });
          return;
        }

        res.json({
          success: true,
          approval: revokeResult.approval,
        });
      } catch (err: any) {
        res.status(500).json({
          success: false,
          error: err?.message || 'Failed to revoke owner approval.',
        });
      }
    }
  );

  router.post(
    '/api/governance/finance/refund',
    requireGovernancePermission(getAuthVerifier, 'finance:refund:execute'),
    createRateLimitMiddleware(limiter, refundExecuteRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller;
      if (!caller) {
        res.status(401).json({
          success: false,
          status: 'REJECTED_SECURITY_VIOLATION',
          code: 'AUTHENTICATION_REQUIRED',
          error: 'Caller identity could not be verified.',
        });
        return;
      }

      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          status: 'REJECTED_SECURITY_VIOLATION',
          code: 'CALLER_SCOPE_MISSING',
          error:
            callerScope.reason ||
            'Caller lacks verifiable tenant, owner, or authorized business scope.',
        });
        return;
      }

      const refundReq = req.body as FinanceRefundRequest;
      const refundBusinessId = String(refundReq?.business_id || '').trim();
      if (!refundBusinessId) {
        res.status(400).json({
          success: false,
          status: 'REJECTED_SECURITY_VIOLATION',
          code: 'MISSING_BUSINESS_ID',
          error: 'A non-empty business_id is required.',
        });
        return;
      }

      const orderStore = getOrderStore();
      if (!orderStore.configured) {
        res.status(503).json({
          success: false,
          status: 'REJECTED_SECURITY_VIOLATION',
          code: 'AUTHORITATIVE_ORDERS_UNCONFIGURED',
          error:
            orderStore.reason ||
            'Authoritative server-side orders source is not configured on server (fail-closed).',
        });
        return;
      }

      let bizAccess: AuthoritativeBusinessMembership | undefined;
      if (orderStore.verifyCallerBusinessAccess) {
        try {
          bizAccess = await orderStore.verifyCallerBusinessAccess({
            businessId: refundBusinessId,
            caller,
          });
        } catch (bizErr: any) {
          res.status(503).json({
            success: false,
            status: 'REJECTED_SECURITY_VIOLATION',
            code: 'AUTHORITATIVE_ORDER_LOOKUP_FAILED',
            error:
              bizErr?.message ||
              'Authoritative business membership verification failed (fail-closed).',
          });
          return;
        }
        if (!bizAccess.authorized) {
          const isInactiveBiz =
            bizAccess.businessStatus &&
            bizAccess.businessStatus !== 'active' &&
            bizAccess.businessStatus !== 'missing';
          res.status(isInactiveBiz ? 409 : 403).json({
            success: false,
            status: 'REJECTED_SECURITY_VIOLATION',
            code: isInactiveBiz ? 'BUSINESS_NOT_ACTIVE' : 'CROSS_TENANT_OR_BUSINESS_DENIED',
            error: bizAccess.reason || 'Caller is not authorized for this business_id.',
          });
          return;
        }
      } else {
        const bizCheck = isCallerAuthorizedForScope(caller, {
          businessId: refundBusinessId,
          requireStoredTenantOrOwnerScope: false,
        });
        if (!bizCheck.authorized) {
          res.status(403).json({
            success: false,
            status: 'REJECTED_SECURITY_VIOLATION',
            code: 'BUSINESS_SCOPE_DENIED',
            error: bizCheck.reason || 'Caller is not authorized for this business_id.',
          });
          return;
        }
      }

      if (
        refundReq?.provenance?.request_id &&
        deps.replayStore.getAuthenticatedRefundRequest
      ) {
        const storedReq = await deps.replayStore.getAuthenticatedRefundRequest(
          refundReq.provenance.request_id
        );
        if (storedReq) {
          const scopeCheck = isCallerAuthorizedForScope(
            caller,
            {
              ownerId: storedReq.ownerId,
              tenantId: storedReq.tenantId,
              businessId: storedReq.businessId,
            },
            bizAccess
          );
          if (!scopeCheck.authorized || storedReq.businessId !== refundBusinessId) {
            res.status(403).json({
              success: false,
              status: 'REJECTED_SECURITY_VIOLATION',
              code: 'CROSS_TENANT_OR_BUSINESS_DENIED',
              error: 'Cross-tenant or cross-business refund execution denied.',
            });
            return;
          }
        } else {
          // Unpersisted request_id fails closed cleanly at provenance boundary
          res.status(403).json({
            success: false,
            status: 'REJECTED_SECURITY_VIOLATION',
            code: 'MISSING_PERSISTED_PROVENANCE',
            reasons: ['No persisted authenticated refund request found (fail-closed).'],
          });
          return;
        }
      }

      const keyring = getKeyring();
      if (!keyring.activeKeyId && Object.keys(keyring.keys).length === 0) {
        res.status(503).json({
          success: false,
          status: 'REJECTED_SECURITY_VIOLATION',
          error: 'Server verification keyring is unconfigured (fail-closed).',
        });
        return;
      }

      if (!paymentProvider && !paymentCallback) {
        res.status(503).json({
          success: false,
          status: 'REJECTED_SECURITY_VIOLATION',
          code: 'PAYMENT_PROVIDER_UNCONFIGURED',
          error:
            'No payment-provider adapter is configured on server (fail-closed). Refusing to simulate refund.',
        });
        return;
      }

      try {
        const nowDate = getNow();
        const outcome = await executeAuthorizedFinanceRefund(refundReq, {
          keyring,
          replayStore: deps.replayStore,
          orderStore,
          caller,
          verifiedBusinessAccess: bizAccess,
          requirePersistedProvenance: true,
          now: nowDate,
          policyOverrides: {
            maxPersistedRequestAgeMs: resolveServerPersistedRequestTtlMs(),
          },
          paymentProvider,
          executePaymentRefund: paymentCallback,
        });

        const httpStatus =
          outcome.status === 'EXECUTED' || outcome.status === 'IDEMPOTENT_RETURN'
            ? 200
            : outcome.status === 'ESCALATED_TO_OWNER_APPROVAL'
            ? 202
            : outcome.status === 'UNCERTAIN_RECONCILIATION_REQUIRED' ||
              outcome.status === 'REJECTED_REPLAY_OR_CONFLICT'
            ? 409
            : outcome.status === 'PROVIDER_EXECUTION_FAILED'
            ? 502
            : outcome.status === 'REJECTED_SECURITY_VIOLATION' &&
              (outcome.code === 'AUTHORITATIVE_ORDERS_UNCONFIGURED' ||
                outcome.code === 'AUTHORITATIVE_ORDER_LOOKUP_FAILED')
            ? 503
            : outcome.status === 'REJECTED_SECURITY_VIOLATION' &&
              (outcome.code === 'ORDER_NOT_ELIGIBLE_FOR_REFUND' ||
                outcome.code === 'ORDER_AMOUNT_MISMATCH' ||
                outcome.code === 'BUSINESS_NOT_ACTIVE' ||
                outcome.code === 'ORDER_CURRENCY_MISMATCH' ||
                outcome.code === 'UNSUPPORTED_ORDER_CURRENCY')
            ? 409
            : 403;

        res.status(httpStatus).json(outcome);
      } catch (err: any) {
        res.status(500).json({
          status: 'REJECTED_SECURITY_VIOLATION',
          error: err?.message || 'Finance refund boundary execution error.',
        });
      }
    }
  );

  router.get(
    '/api/governance/finance/refund/stale',
    requireGovernancePermission(getAuthVerifier, 'finance:refund:execute'),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller;
      if (!caller) {
        res.status(401).json({
          success: false,
          code: 'AUTHENTICATION_REQUIRED',
          error: 'Caller identity could not be verified.',
        });
        return;
      }

      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error:
            callerScope.reason ||
            'Caller lacks verifiable tenant, owner, or authorized business scope.',
        });
        return;
      }

      const businessId =
        typeof req.query.business_id === 'string' && req.query.business_id.trim()
          ? req.query.business_id.trim()
          : undefined;

      const orderStore = getOrderStore();
      if (businessId) {
        if (orderStore.configured && orderStore.verifyCallerBusinessAccess) {
          const bizAccess = await orderStore.verifyCallerBusinessAccess({
            businessId,
            caller,
          });
          if (!bizAccess.authorized) {
            res.status(403).json({
              success: false,
              code: 'BUSINESS_SCOPE_DENIED',
              error: bizAccess.reason || 'Caller is not authorized for this business_id.',
            });
            return;
          }
        } else {
          const bizCheck = isCallerAuthorizedForScope(caller, {
            businessId,
            requireStoredTenantOrOwnerScope: false,
          });
          if (!bizCheck.authorized) {
            res.status(403).json({
              success: false,
              code: 'BUSINESS_SCOPE_DENIED',
              error: bizCheck.reason || 'Caller is not authorized for this business_id.',
            });
            return;
          }
        }
      }

      try {
        const authorizedBindings =
          orderStore.configured && orderStore.listAuthorizedBusinessesForCaller
            ? await orderStore.listAuthorizedBusinessesForCaller(caller)
            : undefined;
        const scopeFilter = buildCallerScopeFilter(caller, businessId, authorizedBindings);
        const [rawStale, rawUncertain] = await Promise.all([
          identifyStaleRefundReservations(deps.replayStore, getNow(), scopeFilter),
          deps.replayStore.listUncertainReservations(scopeFilter),
        ]);
        const filterRow = (r: { ownerId?: string | null; tenantId?: string | null; businessId: string }) => {
          const binding = authorizedBindings?.find((b) => b.businessId === r.businessId);
          return isCallerAuthorizedForScope(
            caller,
            {
              ownerId: r.ownerId,
              tenantId: r.tenantId,
              businessId: r.businessId,
            },
            binding
              ? {
                  authorized: true,
                  businessId: binding.businessId,
                  ownerId: binding.ownerId,
                  tenantId: binding.tenantId,
                }
              : undefined
          ).authorized;
        };

        res.json({
          success: true,
          staleExecuting: rawStale.filter(filterRow),
          uncertain: rawUncertain.filter(filterRow),
        });
      } catch (err: any) {
        res.status(500).json({
          success: false,
          error: err?.message || 'Failed to inspect stale or uncertain reservations.',
        });
      }
    }
  );

  router.post(
    '/api/governance/finance/refund/reconcile',
    requireGovernancePermission(getAuthVerifier, 'finance:refund:execute'),
    createRateLimitMiddleware(limiter, reconcileRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const caller = req.governanceCaller;
      if (!caller) {
        res.status(401).json({
          success: false,
          code: 'AUTHENTICATION_REQUIRED',
          error: 'Caller identity could not be verified.',
        });
        return;
      }

      const callerScope = validateCallerHasScope(caller);
      if (!callerScope.authorized) {
        res.status(403).json({
          success: false,
          code: 'CALLER_SCOPE_MISSING',
          error:
            callerScope.reason ||
            'Caller lacks verifiable tenant, owner, or authorized business scope.',
        });
        return;
      }

      const body = req.body || {};
      const reservationId =
        typeof body.reservation_id === 'string'
          ? body.reservation_id.trim()
          : typeof body.reservationId === 'string'
          ? body.reservationId.trim()
          : undefined;
      const requestId =
        typeof body.request_id === 'string'
          ? body.request_id.trim()
          : typeof body.requestId === 'string'
          ? body.requestId.trim()
          : undefined;
      const orderId =
        typeof body.order_id === 'string'
          ? body.order_id.trim()
          : typeof body.orderId === 'string'
          ? body.orderId.trim()
          : undefined;
      const businessId =
        typeof body.business_id === 'string'
          ? body.business_id.trim()
          : typeof body.businessId === 'string'
          ? body.businessId.trim()
          : undefined;

      if (!reservationId && !requestId && !orderId) {
        res.status(400).json({
          success: false,
          error: 'Provide reservation_id, request_id, or order_id to reconcile.',
        });
        return;
      }

      if (!reservationId && !requestId && orderId && !businessId) {
        res.status(400).json({
          success: false,
          code: 'BUSINESS_ID_REQUIRED_FOR_ORDER_RECONCILIATION',
          error: 'business_id is required when reconciling a refund by order_id.',
        });
        return;
      }

      const orderStore = getOrderStore();
      let bizAccess: AuthoritativeBusinessMembership | undefined;
      if (businessId) {
        if (orderStore.configured && orderStore.verifyCallerBusinessAccess) {
          bizAccess = await orderStore.verifyCallerBusinessAccess({
            businessId,
            caller,
          });
          if (!bizAccess.authorized) {
            res.status(403).json({
              success: false,
              code: 'BUSINESS_SCOPE_DENIED',
              error: bizAccess.reason || 'Caller is not authorized for this business_id.',
            });
            return;
          }
        } else {
          const bizCheck = isCallerAuthorizedForScope(caller, {
            businessId,
            requireStoredTenantOrOwnerScope: false,
          });
          if (!bizCheck.authorized) {
            res.status(403).json({
              success: false,
              code: 'BUSINESS_SCOPE_DENIED',
              error: bizCheck.reason || 'Caller is not authorized for this business_id.',
            });
            return;
          }
        }
      }

      try {
        const authorizedBindings =
          orderStore.configured && orderStore.listAuthorizedBusinessesForCaller
            ? await orderStore.listAuthorizedBusinessesForCaller(caller)
            : undefined;
        const outcome = await reconcileFinanceRefund(
          {
            reservationId,
            requestId,
            orderId,
            businessId,
            scope: buildCallerScopeFilter(caller, businessId, authorizedBindings),
            caller,
            verifiedBusinessAccess: bizAccess,
          },
          {
            replayStore: deps.replayStore,
            orderStore: orderStore.configured ? orderStore : undefined,
            paymentProvider,
            now: getNow(),
          }
        );
        const httpStatus =
          outcome.status === 'AMBIGUOUS_ORDER_REQUIRES_BUSINESS_ID'
            ? 400
            : outcome.status === 'NOT_FOUND'
            ? 404
            : outcome.status === 'STILL_IN_FLIGHT' ||
              outcome.status === 'BLOCKED_LOOKUP_UNSUPPORTED' ||
              outcome.status === 'BLOCKED_OUTCOME_UNKNOWN' ||
              outcome.status === 'BLOCKED_FINALIZATION_FAILED'
            ? 409
            : 200;
        res.status(httpStatus).json(outcome);
      } catch (err: any) {
        res.status(500).json({
          success: false,
          error: err?.message || 'Refund reconciliation failed.',
        });
      }
    }
  );

  return router;
}
