import {
  AUTHORITY_RANK,
  DEFAULT_INGESTION_FRESHNESS_MS,
  DEFAULT_PERSISTED_REQUEST_TTL_MS,
  MAX_FUTURE_TIMESTAMP_SKEW_MS,
  DepartmentAgentId,
  FinanceRefundRequest,
  OwnerApprovalBinding,
  ProvenanceHop,
  ProvenanceRecord,
  buildCanonicalProvenancePayload,
  isValidConfidence,
  normalizeConfidenceBasisPoints,
  parseStrictIsoTimestamp,
} from './provenance';

export interface FinanceRefundPolicy {
  currentPolicyVersion: string;
  maxAutoRefundUsd: number;
  minConfidence: number;
  /** Initial ingestion signature freshness / unpersisted request window (5 minutes) */
  maxRequestAgeMs: number;
  /** Maximum lifetime of a persisted authenticated refund request (60 minutes) */
  maxPersistedRequestAgeMs: number;
  /** Maximum forward clock skew tolerated for created_at / ingested_at */
  maxFutureTimestampSkewMs: number;
  allowedInitiators: ReadonlyArray<DepartmentAgentId>;
  allowedIngestionComponents: ReadonlyArray<string>;
  verifyOwnerApprovalToken: (
    approvalId: string,
    requestId: string,
    orderId: string,
    amountUsd: number
  ) => boolean;
}

export interface IngestionSignatureVerificationResult {
  valid: boolean;
  reason?: string;
  keyStatus?: 'active' | 'rotated_grace' | 'expired' | 'revoked' | 'unknown' | 'unauthorized';
}

export type IngestionSignatureVerifier = (input: {
  canonicalPayload: string;
  signature: string;
  keyId: string;
  algorithm: string;
  ingestedByComponent: string;
  ingestedAt: string;
  now: Date;
}) => IngestionSignatureVerificationResult;

export interface ReplayPrecheckStatus {
  alreadyConsumed?: boolean;
  concurrentInFlight?: boolean;
  conflictReason?: string;
  idempotentOutcome?: {
    execution_tx_id: string;
    consumed_at: string;
  };
}

export type OwnerApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'revoked'
  | 'consumed';

/**
 * Authoritative owner approval record retrieved strictly from the server-side
 * approval store (never from client-supplied request JSON).
 */
export interface AuthoritativeOwnerApprovalRecord {
  readonly approval_id: string;
  readonly request_id: string;
  readonly order_id: string;
  readonly business_id: string;
  readonly amount_cents: number;
  readonly approved_by_user_id: string;
  readonly status: OwnerApprovalStatus;
  readonly expires_at: string; // ISO-8601
  readonly created_at?: string;
  readonly consumed_at?: string | null;
  readonly consumed_by_request_id?: string | null;
}

export interface PersistedRequestExpirationContext {
  readonly requestId: string;
  readonly orderId: string;
  readonly businessId: string;
  readonly amountCents: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly provenance?: ProvenanceRecord;
}

export interface FinanceBoundaryContext {
  policy: Partial<FinanceRefundPolicy>;
  /** Prior append-only provenance snapshot from immutable server ledger, if seen earlier */
  priorProvenance?: ProvenanceRecord;
  /** Authoritative persisted authenticated_refund_requests row, when available */
  persistedRequest?: PersistedRequestExpirationContext;
  /** When true, missing priorProvenance in ctx fails closed as a security violation */
  requirePriorProvenance?: boolean;
  /** Independently computed SHA-256 of the raw trigger object, if available */
  expectedRawTriggerHash?: string;
  /** Server-side cryptographic verifier hook (kept out of browser bundle) */
  verifyIngestionSignature?: IngestionSignatureVerifier;
  /**
   * Authoritative server-side owner approval record for `owner_approved` requests.
   * - `undefined`: no authoritative approval store lookup was supplied (fail-closed)
   * - `null`: authoritative store queried and no matching record exists (fail-closed)
   * - `AuthoritativeOwnerApprovalRecord`: validated strictly against request & clock
   */
  authoritativeOwnerApproval?: AuthoritativeOwnerApprovalRecord | null;
  /** Synchronous replay / DB lock check result supplied by execution layer */
  replayStatus?: ReplayPrecheckStatus;
  now?: Date;
}

export type FinanceBoundaryDecision =
  | {
      decision: 'EXECUTE';
      allowedToAutoExecute: true;
      updatedChain: ProvenanceRecord['chain'];
      canonicalPayload: string;
      reasons: string[];
    }
  | {
      decision: 'IDEMPOTENT_RETURN';
      allowedToAutoExecute: false;
      idempotentOutcome: {
        execution_tx_id: string;
        consumed_at: string;
      };
      reasons: string[];
    }
  | {
      decision: 'REJECT_SECURITY_VIOLATION';
      allowedToAutoExecute: false;
      securityCode: string;
      reasons: string[];
    }
  | {
      decision: 'ESCALATE_TO_OWNER_APPROVAL';
      allowedToAutoExecute: false;
      approvalType: 'issue_refund';
      reasons: string[];
    };

export const DEFAULT_FINANCE_REFUND_POLICY: FinanceRefundPolicy = {
  currentPolicyVersion: '2026.11.0',
  maxAutoRefundUsd: 25.0,
  minConfidence: 0.85,
  maxRequestAgeMs: DEFAULT_INGESTION_FRESHNESS_MS, // 5 minutes (initial ingestion / unpersisted signature window)
  maxPersistedRequestAgeMs: DEFAULT_PERSISTED_REQUEST_TTL_MS, // 60 minutes (persisted request workflow lifetime)
  maxFutureTimestampSkewMs: MAX_FUTURE_TIMESTAMP_SKEW_MS, // 60 seconds
  allowedInitiators: ['customer_support'],
  allowedIngestionComponents: ['nexus-ingestion-api', 'nexus-webhook-ingest'],
  // Fail-closed default: never accept prefix-only or unverified approval tokens.
  verifyOwnerApprovalToken: () => false,
};

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const NONCE_REGEX = /^[A-Za-z0-9_-]{16,128}$/;

export function evaluateFinanceRefund(
  req: FinanceRefundRequest,
  ctx: Partial<FinanceBoundaryContext> = {}
): FinanceBoundaryDecision {
  const policy: FinanceRefundPolicy = {
    ...DEFAULT_FINANCE_REFUND_POLICY,
    ...(ctx.policy || {}),
  };
  const policyReasons: string[] = [];
  const securityReasons: string[] = [];
  let primarySecurityCode: string | null = null;
  const addSecurityViolation = (reason: string, code?: string) => {
    securityReasons.push(reason);
    if (code && !primarySecurityCode) {
      primarySecurityCode = code;
    }
  };
  const nowDate = ctx.now ?? new Date();
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) {
    return {
      decision: 'REJECT_SECURITY_VIOLATION',
      allowedToAutoExecute: false,
      securityCode: 'MISSING_OR_MALFORMED_TIMESTAMP',
      reasons: ['Invalid server reference clock at Finance refund boundary.'],
    };
  }
  const prov = req.provenance;

  // 0. Presence gate — missing provenance always fails closed
  if (!prov) {
    return {
      decision: 'ESCALATE_TO_OWNER_APPROVAL',
      allowedToAutoExecute: false,
      approvalType: 'issue_refund',
      reasons: ['Missing provenance record at Finance refund boundary.'],
    };
  }

  // 1. Provenance schema & trigger integrity checks
  if (!UUID_V4_REGEX.test(prov.request_id)) {
    securityReasons.push(`Invalid request_id UUID: "${prov.request_id}".`);
  }

  if (!prov.nonce || !NONCE_REGEX.test(prov.nonce)) {
    securityReasons.push('Missing or malformed replay-protection nonce.');
  }

  // Explicit order_id binding — never allow owner approval to override mismatched binding
  if (!req.order_id || !req.order_id.trim()) {
    securityReasons.push('Missing target order_id on Finance refund request.');
  } else if (!prov.bound_order_id || prov.bound_order_id !== req.order_id) {
    securityReasons.push(
      `Order binding mismatch: provenance bound_order_id="${prov.bound_order_id ?? 'missing'}" !== request.order_id="${req.order_id}".`
    );
  }

  if (!prov.original_trigger?.id?.trim()) {
    securityReasons.push('Missing original_trigger.id.');
  }

  if (!SHA256_HEX_REGEX.test(prov.original_trigger?.raw_hash ?? '')) {
    securityReasons.push(
      'Invalid original_trigger.raw_hash (expected lowercase 64-char SHA-256 hex).'
    );
  } else if (
    ctx.expectedRawTriggerHash &&
    prov.original_trigger.raw_hash !== ctx.expectedRawTriggerHash
  ) {
    securityReasons.push('original_trigger.raw_hash mismatch: raw trigger payload was modified.');
  }

  const confidenceValid = isValidConfidence(prov.confidence);
  if (!confidenceValid) {
    securityReasons.push(
      `Missing or invalid provenance confidence "${String(prov.confidence)}" (expected finite number between 0 and 1).`
    );
  }

  const createdMs = parseStrictIsoTimestamp(prov.created_at);
  const provExpiresMs = parseStrictIsoTimestamp(prov.expires_at);
  const ingestedMs = parseStrictIsoTimestamp(prov.ingestion_auth?.ingested_at);

  const isIdempotentReplay = Boolean(ctx.replayStatus?.idempotentOutcome);

  if (createdMs === null) {
    addSecurityViolation(
      `Missing or malformed provenance created_at timestamp: "${String(prov.created_at)}".`,
      'MISSING_OR_MALFORMED_TIMESTAMP'
    );
  } else if (createdMs > nowMs + policy.maxFutureTimestampSkewMs) {
    addSecurityViolation(
      'Provenance created_at timestamp is abnormally far in the future.',
      'FUTURE_PROVENANCE_TIMESTAMP'
    );
  }

  if (provExpiresMs === null) {
    addSecurityViolation(
      `Missing or malformed provenance expires_at timestamp: "${String(prov.expires_at)}".`,
      'MISSING_OR_MALFORMED_TIMESTAMP'
    );
  } else if (createdMs !== null && provExpiresMs <= createdMs) {
    addSecurityViolation(
      'Malformed provenance expiration window: expires_at must be strictly later than created_at.',
      'MISSING_OR_MALFORMED_TIMESTAMP'
    );
  }

  if (ingestedMs === null) {
    addSecurityViolation(
      `Missing or malformed ingestion_auth.ingested_at timestamp: "${String(
        prov.ingestion_auth?.ingested_at
      )}".`,
      'MISSING_OR_MALFORMED_TIMESTAMP'
    );
  } else if (ingestedMs > nowMs + policy.maxFutureTimestampSkewMs) {
    addSecurityViolation(
      'Provenance ingestion_auth.ingested_at timestamp is abnormally far in the future.',
      'FUTURE_PROVENANCE_TIMESTAMP'
    );
  } else if (
    createdMs !== null &&
    Math.abs(ingestedMs - createdMs) > policy.maxFutureTimestampSkewMs
  ) {
    addSecurityViolation(
      'Inconsistent provenance created_at and ingestion_auth.ingested_at timestamps.',
      'MISSING_OR_MALFORMED_TIMESTAMP'
    );
  }

  // Rule B (persisted request eligibility) & Rule A (initial ingestion freshness for unpersisted requests)
  let effectiveRequestExpiresMs: number | null = provExpiresMs;
  if (ctx.persistedRequest) {
    const pReq = ctx.persistedRequest;
    const pCreatedMs = parseStrictIsoTimestamp(pReq.createdAt);
    const pExpiresMs = parseStrictIsoTimestamp(pReq.expiresAt);
    const expectedAmountCents = Math.round(Number(req.amount_usd || 0) * 100);
    if (
      pReq.requestId !== prov.request_id ||
      pReq.orderId !== req.order_id ||
      pReq.businessId !== req.business_id ||
      pReq.amountCents !== expectedAmountCents
    ) {
      addSecurityViolation(
        'Submitted refund request does not match persisted authenticated refund request parameters.',
        'PROVENANCE_AUTH_OR_BINDING_FAILED'
      );
    }
    if (pCreatedMs === null || pExpiresMs === null || pExpiresMs <= pCreatedMs) {
      addSecurityViolation(
        `Persisted refund request "${pReq.requestId}" has missing or malformed createdAt/expiresAt timestamps.`,
        'MISSING_OR_MALFORMED_TIMESTAMP'
      );
    } else {
      if (pCreatedMs > nowMs + policy.maxFutureTimestampSkewMs) {
        addSecurityViolation(
          'Persisted refund request createdAt timestamp is abnormally far in the future.',
          'FUTURE_PROVENANCE_TIMESTAMP'
        );
      }
      if (createdMs !== null && pCreatedMs !== createdMs) {
        addSecurityViolation(
          'Provenance created_at does not match persisted authenticated refund request createdAt.',
          'PROVENANCE_AUTH_OR_BINDING_FAILED'
        );
      }
      if (provExpiresMs !== null && pExpiresMs !== provExpiresMs) {
        addSecurityViolation(
          'Provenance expires_at does not match persisted authenticated refund request expiresAt.',
          'PROVENANCE_AUTH_OR_BINDING_FAILED'
        );
      }
      effectiveRequestExpiresMs =
        provExpiresMs !== null ? Math.min(provExpiresMs, pExpiresMs) : pExpiresMs;
      if (!isIdempotentReplay) {
        if (pExpiresMs - pCreatedMs > policy.maxPersistedRequestAgeMs) {
          addSecurityViolation(
            `Persisted refund request lifetime exceeds server maxPersistedRequestAgeMs (${Math.round(
              policy.maxPersistedRequestAgeMs / 60000
            )}m).`,
            'REFUND_REQUEST_EXPIRED'
          );
        } else if (
          nowMs >= pExpiresMs ||
          nowMs - pCreatedMs >= policy.maxPersistedRequestAgeMs
        ) {
          addSecurityViolation(
            `Persisted authenticated refund request "${pReq.requestId}" expired at "${pReq.expiresAt}".`,
            'REFUND_REQUEST_EXPIRED'
          );
        }
      }
    }
  } else if (!isIdempotentReplay && ingestedMs !== null) {
    // Unpersisted signature: strictly constrained by short initial ingestion freshness window (5 minutes)
    if (nowMs - ingestedMs >= policy.maxRequestAgeMs) {
      addSecurityViolation(
        `Unpersisted ingestion signature expired beyond short freshness window (${Math.round(
          policy.maxRequestAgeMs / 1000
        )}s).`,
        'STALE_INGESTION_SIGNATURE'
      );
    }
  }

  if (!isIdempotentReplay && effectiveRequestExpiresMs !== null && nowMs >= effectiveRequestExpiresMs) {
    addSecurityViolation(
      `Provenance refund request expired at "${prov.expires_at}".`,
      'REFUND_REQUEST_EXPIRED'
    );
  }

  if (!(prov.authority_level in AUTHORITY_RANK)) {
    securityReasons.push(`Unknown authority_level: "${String(prov.authority_level)}".`);
  }

  if (!prov.initial_authority_level || !(prov.initial_authority_level in AUTHORITY_RANK)) {
    securityReasons.push(
      `Missing or invalid initial_authority_level: "${String(prov.initial_authority_level)}".`
    );
  }

  // 2. Cryptographic Ingestion Authentication Verification (Fail Closed!)
  const auth = prov.ingestion_auth;
  let canonicalPayload = '';
  let canVerifySignature = false;

  if (!auth) {
    securityReasons.push(
      'Missing server ingestion_auth cryptographic signature on provenance.'
    );
  } else {
    if (auth.algorithm !== 'HMAC-SHA256') {
      securityReasons.push(`Unsupported ingestion_auth algorithm: "${String(auth.algorithm)}".`);
    }
    if (auth.canonical_version === 'v1') {
      securityReasons.push(
        'Legacy canonical_version "v1" does not cryptographically protect confidence and cannot authorize financial execution (fail-closed).'
      );
    } else if (auth.canonical_version !== 'v2') {
      securityReasons.push(
        `Unsupported canonical_version: "${String(auth.canonical_version)}".`
      );
    }
    if (!auth.key_id?.trim()) {
      securityReasons.push('Missing signing key_id in ingestion_auth.');
    }
    if (
      !auth.ingested_by_component?.trim() ||
      !policy.allowedIngestionComponents.includes(auth.ingested_by_component)
    ) {
      securityReasons.push(
        `Unauthorized ingestion component: "${String(auth.ingested_by_component)}".`
      );
    }

    if (auth.canonical_version === 'v2' && confidenceValid) {
      try {
        canonicalPayload = buildCanonicalProvenancePayload({
          request: req,
          provenance: prov,
        });
        canVerifySignature = true;
      } catch (err: any) {
        securityReasons.push(
          err?.message || 'Failed to build canonical v2 provenance payload (fail-closed).'
        );
      }
    }

    if (!SHA256_HEX_REGEX.test(auth.signature ?? '')) {
      securityReasons.push('Malformed ingestion_auth.signature (expected 64-char hex).');
    } else if (!ctx.verifyIngestionSignature) {
      securityReasons.push(
        'Cryptographic signature verifier unavailable in current runtime (fail-closed).'
      );
    } else if (canVerifySignature) {
      const sigResult = ctx.verifyIngestionSignature({
        canonicalPayload,
        signature: auth.signature,
        keyId: auth.key_id,
        algorithm: auth.algorithm,
        ingestedByComponent: auth.ingested_by_component,
        ingestedAt: auth.ingested_at,
        now: nowDate,
      });
      if (!sigResult.valid) {
        securityReasons.push(
          sigResult.reason ||
            `Ingestion signature verification failed (keyStatus=${sigResult.keyStatus ?? 'unknown'}).`
        );
      }
    }
  }

  // 3. Append-only chain integrity & monotonic authority checks
  const chain: ReadonlyArray<ProvenanceHop> | undefined = Array.isArray(prov.chain)
    ? prov.chain
    : undefined;
  if (!chain || chain.length === 0) {
    securityReasons.push('Provenance chain is empty.');
  } else {
    if (chain[0].agent !== prov.source_agent) {
      securityReasons.push(
        `Chain origin mismatch: chain[0]="${chain[0].agent}" !== source_agent="${prov.source_agent}".`
      );
    }

    const finalRank = AUTHORITY_RANK[prov.authority_level] ?? 0;
    for (let i = 0; i < chain.length; i++) {
      const hop: ProvenanceHop = chain[i];
      if (i > 0 && Date.parse(hop.timestamp) < Date.parse(chain[i - 1].timestamp)) {
        securityReasons.push(`Chain timestamp regression at hop ${i}.`);
      }
      const hopRank = AUTHORITY_RANK[hop.observed_authority_level] ?? 0;
      if (finalRank < hopRank) {
        securityReasons.push(
          `Illegal authority_level downgrade: hop ${i} recorded "${hop.observed_authority_level}", final is "${prov.authority_level}".`
        );
      }
    }
  }

  // Verify initial_authority_level was not silently escalated without owner approval
  if (
    prov.initial_authority_level &&
    prov.authority_level !== prov.initial_authority_level &&
    prov.authority_level !== 'owner_approved'
  ) {
    securityReasons.push(
      `Illegal authority_level elevation from "${prov.initial_authority_level}" to "${prov.authority_level}" without Owner Approval.`
    );
  }

  // Compare against immutable prior ledger snapshot when available (or required)
  if (ctx.requirePriorProvenance && !ctx.priorProvenance) {
    securityReasons.push(
      'Missing required authoritative prior provenance snapshot in ledger (fail-closed).'
    );
  } else if (ctx.priorProvenance) {
    const prev = ctx.priorProvenance;
    if (prev.request_id !== prov.request_id || prev.source_agent !== prov.source_agent) {
      securityReasons.push('Immutable provenance identity (request_id / source_agent) altered.');
    }
    if (prev.nonce && prev.nonce !== prov.nonce) {
      securityReasons.push('Rule 1 violation: replay nonce altered between hops.');
    }
    if (prev.bound_order_id && prev.bound_order_id !== prov.bound_order_id) {
      securityReasons.push('Rule 1 violation: bound_order_id altered between hops.');
    }
    if (!isValidConfidence(prev.confidence)) {
      securityReasons.push(
        'Corrupted prior provenance snapshot: missing or invalid confidence (fail-closed).'
      );
    } else if (
      confidenceValid &&
      (normalizeConfidenceBasisPoints(prov.confidence) !==
        normalizeConfidenceBasisPoints(prev.confidence) ||
        Math.abs(prov.confidence - prev.confidence) > 1e-9)
    ) {
      securityReasons.push(
        `Rule 1 violation: provenance confidence altered from ${prev.confidence} to ${prov.confidence}.`
      );
    }
    if (
      prev.initial_authority_level &&
      prov.initial_authority_level !== prev.initial_authority_level
    ) {
      securityReasons.push(
        `Rule 1 violation: initial_authority_level altered from "${prev.initial_authority_level}" to "${String(prov.initial_authority_level)}".`
      );
    }
    if (
      prev.original_trigger.type !== prov.original_trigger.type ||
      prev.original_trigger.id !== prov.original_trigger.id ||
      prev.original_trigger.raw_hash !== prov.original_trigger.raw_hash
    ) {
      securityReasons.push('Rule 1 violation: original_trigger was rewritten between hops.');
    }
    if (prov.chain.length < prev.chain.length) {
      securityReasons.push('Rule 1 violation: provenance chain was truncated.');
    } else {
      for (let i = 0; i < prev.chain.length; i++) {
        if (
          prov.chain[i].agent !== prev.chain[i].agent ||
          prov.chain[i].timestamp !== prev.chain[i].timestamp ||
          prov.chain[i].observed_authority_level !== prev.chain[i].observed_authority_level
        ) {
          securityReasons.push(`Rule 1 violation: prior chain hop ${i} was altered.`);
          break;
        }
      }
    }
    const prevCreatedMs = parseStrictIsoTimestamp(prev.created_at);
    const prevExpiresMs = parseStrictIsoTimestamp(prev.expires_at);
    const prevIngestedMs = parseStrictIsoTimestamp(prev.ingestion_auth?.ingested_at);
    if (prevCreatedMs === null || prevExpiresMs === null || prevIngestedMs === null) {
      addSecurityViolation(
        'Corrupted prior provenance snapshot: missing or malformed timestamps (fail-closed).',
        'MISSING_OR_MALFORMED_TIMESTAMP'
      );
    } else if (
      (createdMs !== null && prevCreatedMs !== createdMs) ||
      (provExpiresMs !== null && prevExpiresMs !== provExpiresMs) ||
      (ingestedMs !== null && prevIngestedMs !== ingestedMs)
    ) {
      addSecurityViolation(
        'Rule 1 violation: provenance created_at, expires_at, or ingested_at differs from persisted ledger snapshot.',
        'PROVENANCE_AUTH_OR_BINDING_FAILED'
      );
    }
    if (AUTHORITY_RANK[prov.authority_level] < AUTHORITY_RANK[prev.authority_level]) {
      securityReasons.push(
        `Rule 1 violation: authority_level lowered from "${prev.authority_level}" to "${prov.authority_level}".`
      );
    }
  }

  // 4. Client approval binding consistency check + authoritative server approval verification
  // IMPORTANT: Client-supplied `owner_approval_binding` is NEVER proof of approval;
  // it is checked only to detect request tampering. Proof must come from `ctx.authoritativeOwnerApproval`
  // (or an explicitly injected secure server verifier).
  if (prov.owner_approval_binding) {
    const b: OwnerApprovalBinding = prov.owner_approval_binding;
    if (b.request_id !== prov.request_id) {
      securityReasons.push(
        `Approval binding mismatch: approval bound to request_id="${b.request_id}", got "${prov.request_id}".`
      );
    }
    if (b.order_id !== req.order_id) {
      securityReasons.push(
        `Approval binding mismatch: approval bound to order_id="${b.order_id}", got "${req.order_id}".`
      );
    }
    if (Math.round(b.amount_usd * 100) !== Math.round(Number(req.amount_usd || 0) * 100)) {
      securityReasons.push(
        `Approval binding mismatch: approval bound to $${b.amount_usd.toFixed(2)}, got $${Number(req.amount_usd || 0).toFixed(2)}.`
      );
    }
    if (prov.owner_approval_id && b.approval_id !== prov.owner_approval_id) {
      securityReasons.push('owner_approval_id does not match owner_approval_binding.approval_id.');
    }
  }

  let approvalFailureSecurityCode = 'PROVENANCE_AUTH_OR_BINDING_FAILED';
  if (prov.authority_level === 'owner_approved') {
    const claimedApprovalId = (
      prov.owner_approval_id ||
      prov.owner_approval_binding?.approval_id ||
      ''
    ).trim();
    const expectedAmountCents = Math.round(Number(req.amount_usd || 0) * 100);
    const hasCustomTokenVerifier = Boolean(
      ctx.policy?.verifyOwnerApprovalToken &&
        ctx.policy.verifyOwnerApprovalToken !==
          DEFAULT_FINANCE_REFUND_POLICY.verifyOwnerApprovalToken
    );
    const isExactIdempotentRetry = Boolean(
      ctx.replayStatus?.idempotentOutcome &&
        ctx.authoritativeOwnerApproval &&
        ctx.authoritativeOwnerApproval.status === 'consumed' &&
        ctx.authoritativeOwnerApproval.consumed_by_request_id === prov.request_id
    );

    if (!claimedApprovalId) {
      approvalFailureSecurityCode = 'OWNER_APPROVAL_MISSING';
      securityReasons.push(
        'authority_level="owner_approved" requires a valid approval_id backed by an authoritative approval record.'
      );
    } else if (ctx.authoritativeOwnerApproval === undefined) {
      // No authoritative server approval store record supplied: only an explicit non-default verifier
      // injected via ctx.policy may verify, and default fail-closed verifier returns false.
      const customVerifierAccepted = hasCustomTokenVerifier
        ? policy.verifyOwnerApprovalToken(
            claimedApprovalId,
            prov.request_id,
            req.order_id,
            req.amount_usd
          )
        : false;
      if (!customVerifierAccepted) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_UNVERIFIED';
        securityReasons.push(
          'No authoritative owner approval store or verifier validated this approval (fail-closed).'
        );
      }
    } else if (ctx.authoritativeOwnerApproval === null) {
      approvalFailureSecurityCode = 'OWNER_APPROVAL_NOT_FOUND';
      securityReasons.push(
        `Owner approval "${claimedApprovalId}" was not found in the authoritative approval store.`
      );
    } else {
      const authApproval = ctx.authoritativeOwnerApproval;
      if (authApproval.approval_id !== claimedApprovalId) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_MISMATCH';
        securityReasons.push(
          `Authoritative approval_id="${authApproval.approval_id}" does not match claimed "${claimedApprovalId}".`
        );
      }
      if (!authApproval.approved_by_user_id || !authApproval.approved_by_user_id.trim()) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_MISSING_APPROVER';
        securityReasons.push(
          'Authoritative owner approval record is missing a verified approved_by_user_id.'
        );
      }
      if (
        prov.owner_approval_binding?.approved_by_user_id &&
        prov.owner_approval_binding.approved_by_user_id !== authApproval.approved_by_user_id
      ) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_MISMATCH';
        securityReasons.push(
          'Client-supplied owner_approval_binding.approved_by_user_id does not match authoritative approver.'
        );
      }
      if (authApproval.request_id !== prov.request_id) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_MISMATCH';
        securityReasons.push(
          `Authoritative approval is bound to request_id="${authApproval.request_id}", not "${prov.request_id}".`
        );
      }
      if (authApproval.order_id !== req.order_id) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_MISMATCH';
        securityReasons.push(
          `Authoritative approval is bound to order_id="${authApproval.order_id}", not "${req.order_id}".`
        );
      }
      if (authApproval.business_id !== req.business_id) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_MISMATCH';
        securityReasons.push(
          `Authoritative approval is bound to business_id="${authApproval.business_id}", not "${req.business_id}".`
        );
      }
      if (
        !Number.isInteger(authApproval.amount_cents) ||
        authApproval.amount_cents <= 0 ||
        authApproval.amount_cents !== expectedAmountCents
      ) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_AMOUNT_MISMATCH';
        securityReasons.push(
          `Authoritative approval is bound to ${authApproval.amount_cents} cents, got ${expectedAmountCents} cents.`
        );
      }
      const approvalCreatedMs = authApproval.created_at
        ? parseStrictIsoTimestamp(authApproval.created_at)
        : null;
      if (authApproval.created_at !== undefined && approvalCreatedMs === null) {
        approvalFailureSecurityCode = 'MISSING_OR_MALFORMED_TIMESTAMP';
        addSecurityViolation(
          `Authoritative owner approval "${claimedApprovalId}" has malformed created_at timestamp.`,
          'MISSING_OR_MALFORMED_TIMESTAMP'
        );
      }

      const approvalExpiresMs = parseStrictIsoTimestamp(authApproval.expires_at);
      if (approvalExpiresMs === null) {
        approvalFailureSecurityCode = 'MISSING_OR_MALFORMED_TIMESTAMP';
        addSecurityViolation(
          `Authoritative owner approval "${claimedApprovalId}" has missing or malformed expires_at timestamp.`,
          'MISSING_OR_MALFORMED_TIMESTAMP'
        );
      } else {
        if (
          effectiveRequestExpiresMs !== null &&
          approvalExpiresMs > effectiveRequestExpiresMs
        ) {
          approvalFailureSecurityCode = 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION';
          addSecurityViolation(
            `Owner approval "${claimedApprovalId}" expires at "${authApproval.expires_at}", which exceeds refund request expiration.`,
            'APPROVAL_EXCEEDS_REQUEST_EXPIRATION'
          );
        }
        if (!isExactIdempotentRetry && nowMs >= approvalExpiresMs) {
          approvalFailureSecurityCode = 'OWNER_APPROVAL_EXPIRED';
          addSecurityViolation(
            `Authoritative owner approval "${claimedApprovalId}" expired at "${authApproval.expires_at}".`,
            'OWNER_APPROVAL_EXPIRED'
          );
        } else if (approvalCreatedMs !== null && approvalExpiresMs <= approvalCreatedMs) {
          approvalFailureSecurityCode = 'MISSING_OR_MALFORMED_TIMESTAMP';
          addSecurityViolation(
            `Authoritative owner approval "${claimedApprovalId}" has invalid expires_at <= created_at.`,
            'MISSING_OR_MALFORMED_TIMESTAMP'
          );
        }
      }
      if (authApproval.status === 'consumed' || authApproval.consumed_at != null) {
        if (!isExactIdempotentRetry) {
          approvalFailureSecurityCode = 'OWNER_APPROVAL_ALREADY_CONSUMED';
          securityReasons.push(
            `Owner approval "${claimedApprovalId}" has already been consumed.`
          );
        }
      } else if (authApproval.status !== 'approved') {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_NOT_APPROVED';
        securityReasons.push(
          `Owner approval "${claimedApprovalId}" has status "${authApproval.status}", expected "approved".`
        );
      }
      if (
        hasCustomTokenVerifier &&
        !isExactIdempotentRetry &&
        !policy.verifyOwnerApprovalToken(
          claimedApprovalId,
          prov.request_id,
          req.order_id,
          req.amount_usd
        )
      ) {
        approvalFailureSecurityCode = 'OWNER_APPROVAL_UNVERIFIED';
        securityReasons.push('Custom owner approval token verifier rejected this approval.');
      }
    }
  }

  // Critical: Cryptographic, identity, expiration, or binding failures MUST NEVER be bypassed by owner_approved!
  if (securityReasons.length > 0) {
    return {
      decision: 'REJECT_SECURITY_VIOLATION',
      allowedToAutoExecute: false,
      securityCode:
        prov.authority_level === 'owner_approved' &&
        approvalFailureSecurityCode !== 'PROVENANCE_AUTH_OR_BINDING_FAILED'
          ? primarySecurityCode || approvalFailureSecurityCode
          : primarySecurityCode || approvalFailureSecurityCode,
      reasons: securityReasons,
    };
  }

  // 5. Synchronous replay status pre-check (if supplied by execution layer)
  if (ctx.replayStatus) {
    if (ctx.replayStatus.idempotentOutcome) {
      return {
        decision: 'IDEMPOTENT_RETURN',
        allowedToAutoExecute: false,
        idempotentOutcome: ctx.replayStatus.idempotentOutcome,
        reasons: ['Idempotent network retry: returning existing refund outcome.'],
      };
    }
    if (ctx.replayStatus.concurrentInFlight) {
      return {
        decision: 'REJECT_SECURITY_VIOLATION',
        allowedToAutoExecute: false,
        securityCode: 'CONCURRENT_REPLAY_LOCKED',
        reasons: ['Concurrent refund execution already in flight for this request/order.'],
      };
    }
    if (ctx.replayStatus.alreadyConsumed || ctx.replayStatus.conflictReason) {
      return {
        decision: 'REJECT_SECURITY_VIOLATION',
        allowedToAutoExecute: false,
        securityCode: 'REPLAY_DETECTED',
        reasons: [
          ctx.replayStatus.conflictReason ||
            'Authorization or nonce has already been consumed.',
        ],
      };
    }
  }

  // 6. Finance Policy Boundary Enforcement
  if (prov.policy_version !== policy.currentPolicyVersion) {
    policyReasons.push(
      `Stale or unknown policy_version "${prov.policy_version}" (expected "${policy.currentPolicyVersion}").`
    );
  }

  if (!Number.isFinite(req.amount_usd) || req.amount_usd <= 0) {
    policyReasons.push(`Invalid refund amount: $${req.amount_usd}.`);
  }

  if (prov.authority_level === 'recommend_only') {
    policyReasons.push('authority_level is "recommend_only"; requires Owner Approval.');
  } else if (prov.authority_level === 'execute_under_policy') {
    if (!policy.allowedInitiators.includes(prov.source_agent)) {
      policyReasons.push(
        `source_agent "${prov.source_agent}" is not authorized to initiate policy auto-refunds.`
      );
    }
    if (req.amount_usd > policy.maxAutoRefundUsd) {
      policyReasons.push(
        `Refund $${req.amount_usd.toFixed(2)} exceeds execute_under_policy cap ($${policy.maxAutoRefundUsd.toFixed(2)}).`
      );
    }
    if (
      !confidenceValid ||
      prov.confidence < policy.minConfidence ||
      normalizeConfidenceBasisPoints(prov.confidence) <
        normalizeConfidenceBasisPoints(policy.minConfidence)
    ) {
      policyReasons.push(
        `Confidence ${Number(prov.confidence).toFixed(2)} below Finance floor (${policy.minConfidence}).`
      );
    }
  } else if (prov.authority_level === 'owner_approved') {
    // Authoritative owner approval verification was already enforced fail-closed in Step 4 above.
    const approvalId = (
      prov.owner_approval_id ||
      prov.owner_approval_binding?.approval_id ||
      ''
    ).trim();
    if (!approvalId) {
      return {
        decision: 'REJECT_SECURITY_VIOLATION',
        allowedToAutoExecute: false,
        securityCode: 'OWNER_APPROVAL_MISSING',
        reasons: ['authority_level="owner_approved" lacks a verified approval_id.'],
      };
    }
  }

  if (policyReasons.length > 0) {
    return {
      decision: 'ESCALATE_TO_OWNER_APPROVAL',
      allowedToAutoExecute: false,
      approvalType: 'issue_refund',
      reasons: policyReasons,
    };
  }

  // Append Finance as the final executing hop
  const updatedChain = [
    ...prov.chain,
    {
      agent: 'finance' as const,
      timestamp: nowDate.toISOString(),
      observed_authority_level: prov.authority_level,
    },
  ];

  return {
    decision: 'EXECUTE',
    allowedToAutoExecute: true,
    updatedChain,
    canonicalPayload,
    reasons: [],
  };
}
