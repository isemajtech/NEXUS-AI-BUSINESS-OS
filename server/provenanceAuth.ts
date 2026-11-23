import crypto from 'node:crypto';
import {
  AuthorityLevel,
  CURRENT_PROVENANCE_CANONICAL_VERSION,
  DEFAULT_INGESTION_FRESHNESS_MS,
  DEFAULT_PERSISTED_REQUEST_TTL_MS,
  MAX_FUTURE_TIMESTAMP_SKEW_MS,
  DepartmentAgentId,
  FinanceRefundRequest,
  OriginalTrigger,
  ProvenanceIngestionAuth,
  ProvenanceRecord,
  SenderAuthContext,
  buildCanonicalProvenancePayload,
  generateNonceHex,
  generateUuidV4,
  normalizeConfidenceBasisPoints,
  parseStrictIsoTimestamp,
} from '../src/governance/provenance';
import type {
  IngestionSignatureVerificationResult,
  IngestionSignatureVerifier,
} from '../src/governance/financeRefundGate';

const MIN_PERSISTED_REQUEST_TTL_MS = 15 * 60 * 1000;
const MAX_PERSISTED_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export { DEFAULT_INGESTION_FRESHNESS_MS, DEFAULT_PERSISTED_REQUEST_TTL_MS };

export function resolveServerPersistedRequestTtlMs(): number {
  const raw = Number(process.env.GOVERNANCE_REQUEST_TTL_MS);
  if (
    Number.isFinite(raw) &&
    raw >= MIN_PERSISTED_REQUEST_TTL_MS &&
    raw <= MAX_PERSISTED_REQUEST_TTL_MS
  ) {
    return Math.round(raw);
  }
  return DEFAULT_PERSISTED_REQUEST_TTL_MS;
}

export interface IngestionFreshnessVerificationResult {
  valid: boolean;
  code?:
    | 'MISSING_OR_MALFORMED_TIMESTAMP'
    | 'FUTURE_PROVENANCE_TIMESTAMP'
    | 'STALE_INGESTION_SIGNATURE'
    | 'REFUND_REQUEST_EXPIRED';
  reason?: string;
}

/**
 * Verifies Rule A (initial provenance ingestion signature freshness) and
 * strict timestamp integrity fail-closed.
 */
export function verifyIngestionPayloadFreshness(
  provenance: ProvenanceRecord | undefined | null,
  options?: {
    now?: Date;
    maxFreshnessMs?: number;
    maxFutureSkewMs?: number;
  }
): IngestionFreshnessVerificationResult {
  if (!provenance || !provenance.ingestion_auth) {
    return {
      valid: false,
      code: 'MISSING_OR_MALFORMED_TIMESTAMP',
      reason: 'Missing provenance or ingestion_auth metadata.',
    };
  }

  const nowDate = options?.now ?? new Date();
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) {
    return {
      valid: false,
      code: 'MISSING_OR_MALFORMED_TIMESTAMP',
      reason: 'Invalid server reference clock.',
    };
  }

  const maxFreshnessMs = options?.maxFreshnessMs ?? DEFAULT_INGESTION_FRESHNESS_MS;
  const maxFutureSkewMs = options?.maxFutureSkewMs ?? MAX_FUTURE_TIMESTAMP_SKEW_MS;

  const createdMs = parseStrictIsoTimestamp(provenance.created_at);
  const ingestedMs = parseStrictIsoTimestamp(provenance.ingestion_auth.ingested_at);
  const expiresMs = parseStrictIsoTimestamp(provenance.expires_at);

  if (createdMs === null || ingestedMs === null || expiresMs === null) {
    return {
      valid: false,
      code: 'MISSING_OR_MALFORMED_TIMESTAMP',
      reason: 'Missing or malformed created_at, ingested_at, or expires_at timestamp.',
    };
  }

  if (createdMs > nowMs + maxFutureSkewMs || ingestedMs > nowMs + maxFutureSkewMs) {
    return {
      valid: false,
      code: 'FUTURE_PROVENANCE_TIMESTAMP',
      reason: 'Provenance created_at or ingested_at timestamp is abnormally far in the future.',
    };
  }

  if (expiresMs <= createdMs) {
    return {
      valid: false,
      code: 'MISSING_OR_MALFORMED_TIMESTAMP',
      reason: 'Provenance expires_at must be strictly later than created_at.',
    };
  }

  if (nowMs >= expiresMs) {
    return {
      valid: false,
      code: 'REFUND_REQUEST_EXPIRED',
      reason: `Provenance request expired at "${provenance.expires_at}".`,
    };
  }

  if (nowMs - ingestedMs >= maxFreshnessMs) {
    return {
      valid: false,
      code: 'STALE_INGESTION_SIGNATURE',
      reason: `Initial ingestion signature exceeded freshness window (${Math.round(
        maxFreshnessMs / 1000
      )}s).`,
    };
  }

  return { valid: true };
}

export type KeyStatus = 'active' | 'rotated_grace' | 'revoked';

export interface ServerSigningKeyEntry {
  keyId: string;
  secret: string;
  status: KeyStatus;
  allowedComponent: string;
  expiresAt?: string; // ISO-8601
}

export interface ServerKeyring {
  activeKeyId: string;
  keys: Record<string, ServerSigningKeyEntry>;
}

/**
 * Loads server-side HMAC signing keys exclusively from server environment variables.
 * Never reads browser env vars (VITE_*) and never ships secrets to client bundles.
 * Fails closed (returns empty keyring) when secrets are unconfigured.
 */
export function loadServerKeyringFromEnv(): ServerKeyring {
  const keys: Record<string, ServerSigningKeyEntry> = {};
  const rawJson = process.env.PROVENANCE_HMAC_KEYS?.trim();
  let activeKeyId = process.env.PROVENANCE_ACTIVE_KEY_ID?.trim() || '';

  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<
        string,
        {
          secret?: string;
          status?: KeyStatus;
          allowedComponent?: string;
          expiresAt?: string;
        }
      >;
      for (const [keyId, cfg] of Object.entries(parsed)) {
        if (!cfg?.secret || cfg.secret.trim().length < 16) continue;
        const entry: ServerSigningKeyEntry = {
          keyId,
          secret: cfg.secret.trim(),
          status: cfg.status ?? 'active',
          allowedComponent: cfg.allowedComponent || 'nexus-ingestion-api',
          expiresAt: cfg.expiresAt,
        };
        keys[keyId] = entry;
        if (!activeKeyId && entry.status === 'active') {
          activeKeyId = keyId;
        }
      }
    } catch {
      // Fail closed if keyring JSON is malformed
      return { activeKeyId: '', keys: {} };
    }
  } else if (process.env.PROVENANCE_HMAC_SECRET?.trim()) {
    const fallbackKeyId = activeKeyId || 'ingest-key-default';
    keys[fallbackKeyId] = {
      keyId: fallbackKeyId,
      secret: process.env.PROVENANCE_HMAC_SECRET.trim(),
      status: 'active',
      allowedComponent:
        process.env.PROVENANCE_INGEST_COMPONENT?.trim() || 'nexus-ingestion-api',
      expiresAt: process.env.PROVENANCE_KEY_EXPIRES_AT?.trim() || undefined,
    };
    activeKeyId = fallbackKeyId;
  }

  return { activeKeyId, keys };
}

export function sha256HexNode(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function signCanonicalPayloadHmac(
  canonicalPayload: string,
  secret: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(canonicalPayload, 'utf8')
    .digest('hex');
}

export function timingSafeHexEquals(aHex: string, bHex: string): boolean {
  if (
    typeof aHex !== 'string' ||
    typeof bHex !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(aHex) ||
    !/^[0-9a-f]{64}$/i.test(bHex)
  ) {
    return false;
  }
  const aBuf = Buffer.from(aHex.toLowerCase(), 'hex');
  const bBuf = Buffer.from(bHex.toLowerCase(), 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Builds the server-side verifier callback injected into evaluateFinanceRefund().
 * Enforces key presence, component authorization, revocation, expiration, and constant-time HMAC check.
 */
export function createKeyringSignatureVerifier(
  keyring: ServerKeyring
): IngestionSignatureVerifier {
  return ({
    canonicalPayload,
    signature,
    keyId,
    algorithm,
    ingestedByComponent,
    now,
  }): IngestionSignatureVerificationResult => {
    if (algorithm !== 'HMAC-SHA256') {
      return { valid: false, reason: `Unsupported signature algorithm "${algorithm}".` };
    }

    const keyEntry = keyring.keys[keyId];
    if (!keyEntry) {
      return {
        valid: false,
        keyStatus: 'unknown',
        reason: `Untrusted or unknown signing key_id "${keyId}".`,
      };
    }

    if (keyEntry.status === 'revoked') {
      return {
        valid: false,
        keyStatus: 'revoked',
        reason: `Signing key "${keyId}" has been revoked.`,
      };
    }

    if (keyEntry.expiresAt) {
      const expMs = parseStrictIsoTimestamp(keyEntry.expiresAt);
      if (expMs === null || now.getTime() >= expMs) {
        return {
          valid: false,
          keyStatus: 'expired',
          reason: `Signing key "${keyId}" expired at ${keyEntry.expiresAt}.`,
        };
      }
    }

    if (keyEntry.allowedComponent !== ingestedByComponent) {
      return {
        valid: false,
        keyStatus: 'unauthorized',
        reason: `Key "${keyId}" is restricted to component "${keyEntry.allowedComponent}", not "${ingestedByComponent}".`,
      };
    }

    const expectedSig = signCanonicalPayloadHmac(canonicalPayload, keyEntry.secret);
    if (!timingSafeHexEquals(signature, expectedSig)) {
      return {
        valid: false,
        keyStatus: keyEntry.status,
        reason: 'HMAC-SHA256 ingestion signature mismatch (possible forgery or tampering).',
      };
    }

    return {
      valid: true,
      keyStatus: keyEntry.status,
    };
  };
}

export interface AuthenticatedIngestRefundInput {
  business_id: string;
  order_id: string;
  customer_email: string;
  amount_usd: number;
  reason: string;
  source_agent: DepartmentAgentId;
  trigger_type: OriginalTrigger['type'];
  trigger_id: string;
  raw_trigger_payload: string;
  confidence: number;
  authority_level: AuthorityLevel;
  policy_version?: string;
  idempotency_key?: string;
  ingested_by_component?: string;
  sender_auth?: SenderAuthContext;
  ttlMs?: number;
  now?: Date;
}

/**
 * Trusted server-side ingestion component that authenticates an incoming trigger
 * and seals a deterministic ProvenanceRecord using the active server HMAC key.
 */
export function ingestAuthenticatedRefundRequest(
  input: AuthenticatedIngestRefundInput,
  keyring: ServerKeyring
): FinanceRefundRequest {
  const activeKey = keyring.keys[keyring.activeKeyId];
  if (!activeKey || activeKey.status !== 'active') {
    throw new Error(
      `No active server signing key configured for key_id="${keyring.activeKeyId}".`
    );
  }
  const nowDate = input.now ?? new Date();
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error('Invalid reference timestamp supplied to ingestAuthenticatedRefundRequest.');
  }
  if (activeKey.expiresAt) {
    const keyExpMs = parseStrictIsoTimestamp(activeKey.expiresAt);
    if (keyExpMs === null || nowDate.getTime() >= keyExpMs) {
      throw new Error(`Active signing key "${activeKey.keyId}" is expired.`);
    }
  }

  const effectiveTtlMs = input.ttlMs ?? resolveServerPersistedRequestTtlMs();
  if (!Number.isFinite(effectiveTtlMs) || effectiveTtlMs <= 0) {
    throw new Error('Provenance ttlMs must be a positive finite number.');
  }

  const nowIso = nowDate.toISOString();
  const expiresIso = new Date(nowDate.getTime() + effectiveTtlMs).toISOString();
  const componentName = input.ingested_by_component || activeKey.allowedComponent;
  if (componentName !== activeKey.allowedComponent) {
    throw new Error(
      `Component "${componentName}" is not authorized to sign with key "${activeKey.keyId}".`
    );
  }

  const rawHash = sha256HexNode(input.raw_trigger_payload);
  // Enforce valid finite confidence in [0, 1] before signing (fail closed)
  normalizeConfidenceBasisPoints(input.confidence);
  const requestId = generateUuidV4();
  const nonce = generateNonceHex(16);
  const idempotencyKey =
    input.idempotency_key || `idem-${requestId}-${nonce.slice(0, 8)}`;

  const baseProvenance: ProvenanceRecord = {
    request_id: requestId,
    nonce,
    bound_order_id: input.order_id,
    source_agent: input.source_agent,
    original_trigger: {
      type: input.trigger_type,
      id: input.trigger_id,
      raw_hash: rawHash,
    },
    chain: [
      {
        agent: input.source_agent,
        timestamp: nowIso,
        observed_authority_level: input.authority_level,
      },
    ],
    confidence: input.confidence,
    authority_level: input.authority_level,
    initial_authority_level: input.authority_level,
    policy_version: input.policy_version ?? '2026.11.0',
    created_at: nowIso,
    expires_at: expiresIso,
    sender_auth: input.sender_auth ?? {
      verified: false,
      provider: 'unverified',
    },
    ingestion_auth: {
      algorithm: 'HMAC-SHA256',
      key_id: activeKey.keyId,
      canonical_version: 'v2',
      ingested_by_component: componentName,
      ingested_at: nowIso,
      signature: '0'.repeat(64), // placeholder before signing
    },
  };

  const baseRequest: FinanceRefundRequest = {
    action: 'issue_refund',
    business_id: input.business_id,
    order_id: input.order_id,
    customer_email: input.customer_email,
    amount_usd: input.amount_usd,
    reason: input.reason,
    idempotency_key: idempotencyKey,
    provenance: baseProvenance,
  };

  const canonical = buildCanonicalProvenancePayload({
    request: baseRequest,
    provenance: baseProvenance,
  });
  const signature = signCanonicalPayloadHmac(canonical, activeKey.secret);

  const signedAuth: ProvenanceIngestionAuth = {
    algorithm: 'HMAC-SHA256',
    key_id: activeKey.keyId,
    canonical_version: 'v2',
    ingested_by_component: componentName,
    ingested_at: nowIso,
    signature,
  };

  return {
    ...baseRequest,
    provenance: {
      ...baseProvenance,
      ingestion_auth: signedAuth,
    },
  };
}
