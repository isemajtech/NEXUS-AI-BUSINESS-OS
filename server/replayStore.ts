import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  isValidConfidence,
  normalizeConfidenceBasisPoints,
  parseStrictIsoTimestamp,
  type ProvenanceRecord,
} from '../src/governance/provenance';

import type {
  AuthoritativeOwnerApprovalRecord,
  ReplayPrecheckStatus,
} from '../src/governance/financeRefundGate';
import type { GovernanceScopeFilter } from './governanceAuth';

export type RefundAuthorizationStatus =
  | 'executing'
  | 'uncertain_reconciliation_required'
  | 'executed'
  | 'failed'
  | 'rejected';

export type ProviderOutcomeStatus =
  | 'pending'
  | 'confirmed_success'
  | 'confirmed_failure'
  | 'timeout_or_unknown'
  | 'finalization_failed_after_success';

export interface RefundReservationRecord {
  id: string;
  ownerId?: string | null;
  tenantId?: string | null;
  requestId: string;
  nonce: string;
  orderId: string;
  businessId: string;
  approvalId: string | null;
  amountCents: number;
  idempotencyKey: string;
  providerIdempotencyKey: string;
  providerName: string | null;
  providerTxId: string | null;
  providerOutcomeStatus: ProviderOutcomeStatus;
  retryAllowed: boolean;
  attemptCount: number;
  status: RefundAuthorizationStatus;
  executionTxId: string | null;
  executionStartedAt: string | null;
  leaseExpiresAt: string | null;
  consumedAt: string | null;
  lastReconciledAt: string | null;
  reconciliationNotes: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReserveRefundInput {
  ownerId?: string | null;
  tenantId?: string | null;
  requestId: string;
  nonce: string;
  orderId: string;
  businessId: string;
  approvalId?: string | null;
  requireOwnerApproval?: boolean;
  amountCents: number;
  idempotencyKey: string;
  canonicalDigest: string;
  keyId: string;
  providerName?: string;
  executionLeaseMs?: number;
  expiresAt: string;
  nowIso?: string;
  provenanceSnapshot: ProvenanceRecord;
}

export interface RecordOwnerApprovalInput {
  approvalId: string;
  requestId: string;
  orderId: string;
  businessId: string;
  amountCents: number;
  approvedByUserId: string;
  expiresAt: string;
  nowIso?: string;
  status?: AuthoritativeOwnerApprovalRecord['status'];
  ownerId?: string | null;
  tenantId?: string | null;
  decisionNote?: string | null;
}

export interface AuthenticatedRefundRequestRecord {
  requestId: string;
  ownerId?: string | null;
  tenantId?: string | null;
  businessId: string;
  orderId: string;
  amountCents: number;
  customerEmail?: string | null;
  reason?: string | null;
  authorityLevel: ProvenanceRecord['authority_level'];
  expiresAt: string;
  createdAt: string;
  provenance: ProvenanceRecord;
}

export interface StoredOwnerApprovalSummary extends AuthoritativeOwnerApprovalRecord {
  owner_id?: string | null;
  tenant_id?: string | null;
  decision_note?: string | null;
  consumed_by_reservation_id?: string | null;
  updated_at?: string;
}

export type RevokeOwnerApprovalResult =
  | { status: 'revoked'; approval: StoredOwnerApprovalSummary }
  | { status: 'not_found' }
  | { status: 'forbidden_scope' }
  | { status: 'already_consumed'; approval: StoredOwnerApprovalSummary }
  | { status: 'already_revoked'; approval: StoredOwnerApprovalSummary }
  | { status: 'invalid_state'; approval: StoredOwnerApprovalSummary };

export type ReserveRefundOutcome =
  | {
      status: 'ACQUIRED';
      reservationId: string;
      providerIdempotencyKey: string;
      attemptCount: number;
      leaseExpiresAt: string;
    }
  | {
      status: 'IDEMPOTENT_REPLAY';
      reservationId: string;
      providerIdempotencyKey: string;
      executionTxId: string;
      consumedAt: string;
      outcomePayload: Record<string, any>;
    }
  | {
      status:
        | 'CONCURRENT_IN_FLIGHT'
        | 'STALE_EXECUTION_REQUIRES_RECONCILIATION'
        | 'UNCERTAIN_RECONCILIATION_REQUIRED'
        | 'RETRY_NOT_PERMITTED'
        | 'REPLAY_ALREADY_CONSUMED'
        | 'REPLAY_CONFLICT'
        | 'NONCE_REUSED'
        | 'APPROVAL_ORDER_MISMATCH'
        | 'APPROVAL_NOT_FOUND'
        | 'APPROVAL_ALREADY_CONSUMED'
        | 'APPROVAL_NOT_APPROVED'
        | 'APPROVAL_EXPIRED'
        | 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION'
        | 'APPROVAL_BINDING_MISMATCH'
        | 'REFUND_REQUEST_EXPIRED'
        | 'MISSING_OR_MALFORMED_TIMESTAMP'
        | 'DUPLICATE_ORDER_REFUND';
      reason: string;
      reservationId?: string;
      providerIdempotencyKey?: string;
    };

export interface PersistentReplayStore {
  recordProvenanceOrigin(
    provenance: ProvenanceRecord,
    orderId: string,
    scope?: { ownerId?: string | null; tenantId?: string | null }
  ): Promise<void>;
  getProvenanceSnapshot(requestId: string): Promise<ProvenanceRecord | undefined>;
  recordAuthenticatedRefundRequest?(record: AuthenticatedRefundRequestRecord): Promise<void>;
  getAuthenticatedRefundRequest?(
    requestId: string
  ): Promise<AuthenticatedRefundRequestRecord | undefined>;
  recordOwnerApproval(
    input: RecordOwnerApprovalInput
  ): Promise<AuthoritativeOwnerApprovalRecord>;
  getOwnerApproval(
    approvalId: string
  ): Promise<AuthoritativeOwnerApprovalRecord | undefined>;
  getOwnerApprovalDetailed?(
    approvalId: string
  ): Promise<StoredOwnerApprovalSummary | undefined>;
  listOwnerApprovals?(filter?: {
    requestId?: string;
    businessId?: string;
    orderId?: string;
    scope?: GovernanceScopeFilter;
  }): Promise<StoredOwnerApprovalSummary[]>;
  findActiveApprovalForRequestOrOrder?(
    requestId: string,
    orderId: string,
    businessId?: string
  ): Promise<StoredOwnerApprovalSummary | undefined>;
  revokeOwnerApproval(approvalId: string): Promise<void>;
  revokeOwnerApprovalWithResult?(
    approvalId: string,
    scope?: GovernanceScopeFilter
  ): Promise<RevokeOwnerApprovalResult>;
  getReplayPrecheck(input: {
    requestId: string;
    nonce: string;
    orderId: string;
    businessId?: string;
    amountCents: number;
    approvalId?: string | null;
    canonicalDigest: string;
    idempotencyKey: string;
  }): Promise<ReplayPrecheckStatus | undefined>;
  reserveRefundExecution(input: ReserveRefundInput): Promise<ReserveRefundOutcome>;
  finalizeRefundExecution(input: {
    reservationId: string;
    executionTxId: string;
    outcomePayload: Record<string, any>;
    nowIso?: string;
  }): Promise<void>;
  failRefundExecution(input: {
    reservationId: string;
    reason: string;
    retryAllowed?: boolean;
    nowIso?: string;
  }): Promise<void>;
  markRefundUncertain(input: {
    reservationId: string;
    reason: string;
    providerOutcomeStatus: 'timeout_or_unknown' | 'finalization_failed_after_success';
    providerTxId?: string | null;
    nowIso?: string;
  }): Promise<void>;
  reconcileMarkNotExecuted(input: {
    reservationId: string;
    retryAllowed: boolean;
    reason: string;
    nowIso?: string;
  }): Promise<void>;
  getRefundReservation(filter: {
    reservationId?: string;
    requestId?: string;
    orderId?: string;
    businessId?: string;
    scope?: GovernanceScopeFilter;
  }): Promise<RefundReservationRecord | undefined>;
  listStaleExecutingReservations(
    nowIso?: string,
    scope?: GovernanceScopeFilter
  ): Promise<RefundReservationRecord[]>;
  listUncertainReservations(scope?: GovernanceScopeFilter): Promise<RefundReservationRecord[]>;
  close(): void;
}

function validateScopeFilterUsable(scope: GovernanceScopeFilter): boolean {
  if (scope.authorizedBusinessBindings !== undefined && scope.authorizedBusinessBindings.length === 0) {
    return false;
  }
  const hasTenants = scope.tenantOrOwnerIds.length > 0;
  const hasBiz =
    scope.allowedBusinessIds === undefined || scope.allowedBusinessIds.length > 0;
  if (!hasBiz) return false;
  if (
    !hasTenants &&
    !(scope.allowedBusinessIds && scope.allowedBusinessIds.length > 0) &&
    !(scope.authorizedBusinessBindings && scope.authorizedBusinessBindings.length > 0)
  ) {
    return false;
  }
  return true;
}

function buildSqliteScopeClauses(scope: GovernanceScopeFilter): {
  impossible: boolean;
  clauses: string[];
  params: any[];
} {
  if (!validateScopeFilterUsable(scope)) {
    return { impossible: true, clauses: ['1 = 0'], params: [] };
  }
  const clauses: string[] = ['(owner_id IS NOT NULL OR tenant_id IS NOT NULL)'];
  const params: any[] = [];

  if (scope.authorizedBusinessBindings !== undefined) {
    const allowedSet = scope.allowedBusinessIds ? new Set(scope.allowedBusinessIds) : null;
    const filteredBindings = scope.authorizedBusinessBindings.filter(
      (b) => (!allowedSet || allowedSet.has(b.businessId)) && (!scope.businessId || b.businessId === scope.businessId)
    );
    if (filteredBindings.length === 0) {
      return { impossible: true, clauses: ['1 = 0'], params: [] };
    }
    const perBizClauses: string[] = [];
    for (const b of filteredBindings) {
      const sub: string[] = ['business_id = ?'];
      params.push(b.businessId);
      if (b.ownerId && b.ownerId.trim()) {
        sub.push('(owner_id IS NULL OR owner_id = ?)');
        params.push(b.ownerId.trim());
      }
      if (b.tenantId && b.tenantId.trim()) {
        sub.push('(tenant_id IS NULL OR tenant_id = ?)');
        params.push(b.tenantId.trim());
      }
      perBizClauses.push(`(${sub.join(' AND ')})`);
    }
    clauses.push(`(${perBizClauses.join(' OR ')})`);
    return { impossible: false, clauses, params };
  }

  if (scope.tenantOrOwnerIds.length > 0) {
    const placeholders = scope.tenantOrOwnerIds.map(() => '?').join(', ');
    clauses.push(
      `((tenant_id IS NULL OR tenant_id IN (${placeholders})) AND (owner_id IS NULL OR owner_id IN (${placeholders})))`
    );
    params.push(...scope.tenantOrOwnerIds, ...scope.tenantOrOwnerIds);
  }
  if (scope.allowedBusinessIds !== undefined) {
    const placeholders = scope.allowedBusinessIds.map(() => '?').join(', ');
    clauses.push(`business_id IN (${placeholders})`);
    params.push(...scope.allowedBusinessIds);
  }
  if (scope.businessId) {
    clauses.push('business_id = ?');
    params.push(scope.businessId);
  }
  return { impossible: false, clauses, params };
}

function sanitizePostgrestFilterValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /["\\(),]/.test(trimmed)) {
    throw new Error(`Unsafe PostgREST scope filter token rejected.`);
  }
  return `"${trimmed}"`;
}

function applySupabaseScopeFilter<T>(query: T, scope: GovernanceScopeFilter): {
  query: T;
  impossible: boolean;
} {
  if (!validateScopeFilterUsable(scope)) {
    return { query, impossible: true };
  }
  let q: any = query;
  if (scope.tenantOrOwnerIds.length > 0) {
    const inList = scope.tenantOrOwnerIds.map(sanitizePostgrestFilterValue).join(',');
    q = q.or(`tenant_id.in.(${inList}),owner_id.in.(${inList})`);
  } else {
    q = q.or('tenant_id.not.is.null,owner_id.not.is.null');
  }
  if (scope.authorizedBusinessBindings !== undefined) {
    const bindingBizIds = Array.from(
      new Set(scope.authorizedBusinessBindings.map((b) => b.businessId.trim()).filter(Boolean))
    );
    if (bindingBizIds.length === 0) {
      return { query, impossible: true };
    }
    const effectiveBizIds =
      scope.allowedBusinessIds !== undefined
        ? bindingBizIds.filter((id) => scope.allowedBusinessIds!.includes(id))
        : bindingBizIds;
    if (effectiveBizIds.length === 0) {
      return { query, impossible: true };
    }
    q = q.in('business_id', effectiveBizIds);
  } else if (scope.allowedBusinessIds !== undefined) {
    q = q.in('business_id', [...scope.allowedBusinessIds]);
  }
  if (scope.businessId) {
    q = q.eq('business_id', scope.businessId);
  }
  return { query: q as T, impossible: false };
}

function rowMatchesScopeFilter(
  row: { owner_id?: string | null; tenant_id?: string | null; business_id?: string | null },
  scope: GovernanceScopeFilter
): boolean {
  if (!validateScopeFilterUsable(scope)) return false;
  const rowOwner = row.owner_id?.trim() || null;
  const rowTenant = row.tenant_id?.trim() || null;
  const rowBiz = row.business_id?.trim() || '';
  if (!rowOwner && !rowTenant) return false;
  if (scope.businessId && rowBiz !== scope.businessId) return false;
  if (
    scope.allowedBusinessIds !== undefined &&
    !scope.allowedBusinessIds.includes(rowBiz)
  ) {
    return false;
  }
  if (scope.authorizedBusinessBindings !== undefined) {
    const binding = scope.authorizedBusinessBindings.find((b) => b.businessId === rowBiz);
    if (!binding) return false;
    const bOwner = binding.ownerId?.trim() || null;
    const bTenant = binding.tenantId?.trim() || null;
    if (rowTenant && bTenant && rowTenant !== bTenant) return false;
    if (rowOwner && bOwner && rowOwner !== bOwner) return false;
    return true;
  }
  if (scope.tenantOrOwnerIds.length > 0) {
    const allowedSet = new Set(scope.tenantOrOwnerIds);
    if (rowTenant && !allowedSet.has(rowTenant)) return false;
    if (rowOwner && !allowedSet.has(rowOwner)) return false;
    if (!rowTenant && !rowOwner) return false;
  }
  return true;
}

/**
 * ACID transactional SQLite persistent replay, owner approval, & provenance ledger store.
 * Uses BEGIN IMMEDIATE transactions and database-enforced UNIQUE constraints on:
 *   - request_id
 *   - nonce
 *   - idempotency_key
 *   - approval_id (partial unique where non-null + atomic single-use state transition in owner_approvals)
 *   - (business_id, order_id) (partial unique where status IN ('executing', 'uncertain_reconciliation_required', 'executed'))
 */
export class SqlitePersistentReplayStore implements PersistentReplayStore {
  private db: DatabaseSync;

  constructor(dbFilePath: string) {
    const dir = path.dirname(dbFilePath);
    if (dbFilePath !== ':memory:' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbFilePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS provenance_ledger (
        request_id TEXT PRIMARY KEY,
        owner_id TEXT,
        tenant_id TEXT,
        nonce TEXT NOT NULL UNIQUE,
        bound_order_id TEXT NOT NULL,
        source_agent TEXT NOT NULL,
        trigger_raw_hash TEXT NOT NULL,
        initial_authority_level TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authenticated_refund_requests (
        request_id TEXT PRIMARY KEY,
        owner_id TEXT,
        tenant_id TEXT,
        business_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        customer_email TEXT,
        reason TEXT,
        authority_level TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        provenance_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_auth_refund_req_order
        ON authenticated_refund_requests (order_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS owner_approvals (
        approval_id TEXT PRIMARY KEY,
        owner_id TEXT,
        tenant_id TEXT,
        request_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        approved_by_user_id TEXT NOT NULL,
        decision_note TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked', 'consumed', 'expired')),
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by_request_id TEXT,
        consumed_by_reservation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_owner_approvals_request_order
        ON owner_approvals (request_id, order_id);

      CREATE TABLE IF NOT EXISTS refund_authorizations (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        tenant_id TEXT,
        request_id TEXT NOT NULL UNIQUE,
        nonce TEXT NOT NULL UNIQUE,
        order_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        approval_id TEXT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        idempotency_key TEXT NOT NULL UNIQUE,
        provider_idempotency_key TEXT NOT NULL UNIQUE,
        provider_name TEXT,
        provider_tx_id TEXT,
        provider_outcome_status TEXT NOT NULL DEFAULT 'pending' CHECK (provider_outcome_status IN ('pending', 'confirmed_success', 'confirmed_failure', 'timeout_or_unknown', 'finalization_failed_after_success')),
        retry_allowed INTEGER NOT NULL DEFAULT 1 CHECK (retry_allowed IN (0, 1)),
        attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
        canonical_digest TEXT NOT NULL,
        key_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('executing', 'uncertain_reconciliation_required', 'executed', 'failed', 'rejected')),
        execution_tx_id TEXT,
        outcome_json TEXT,
        execution_started_at TEXT,
        lease_expires_at TEXT,
        consumed_at TEXT,
        last_reconciled_at TEXT,
        reconciliation_notes TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_auth_approval_id
        ON refund_authorizations (approval_id)
        WHERE approval_id IS NOT NULL;
    `);

    // Defensive upgrade if opening pre-H2 SQLite provenance_ledger file
    const plCols = this.db
      .prepare('PRAGMA table_info(provenance_ledger)')
      .all() as Array<{ name: string }>;
    const plColNames = new Set(plCols.map((c) => c.name));
    if (!plColNames.has('owner_id')) {
      this.db.exec(`ALTER TABLE provenance_ledger ADD COLUMN owner_id TEXT;`);
    }
    if (!plColNames.has('tenant_id')) {
      this.db.exec(`ALTER TABLE provenance_ledger ADD COLUMN tenant_id TEXT;`);
    }

    // Defensive upgrade if opening a pre-P0-C SQLite owner_approvals file
    const oaCols = this.db
      .prepare('PRAGMA table_info(owner_approvals)')
      .all() as Array<{ name: string }>;
    const oaColNames = new Set(oaCols.map((c) => c.name));
    if (!oaColNames.has('owner_id')) {
      this.db.exec(`ALTER TABLE owner_approvals ADD COLUMN owner_id TEXT;`);
    }
    if (!oaColNames.has('tenant_id')) {
      this.db.exec(`ALTER TABLE owner_approvals ADD COLUMN tenant_id TEXT;`);
    }
    if (!oaColNames.has('decision_note')) {
      this.db.exec(`ALTER TABLE owner_approvals ADD COLUMN decision_note TEXT;`);
    }

    this.db.exec(`
      UPDATE provenance_ledger
      SET tenant_id = owner_id
      WHERE tenant_id IS NULL AND owner_id IS NOT NULL;

      UPDATE authenticated_refund_requests
      SET tenant_id = owner_id
      WHERE tenant_id IS NULL AND owner_id IS NOT NULL;

      UPDATE owner_approvals
      SET tenant_id = owner_id
      WHERE tenant_id IS NULL AND owner_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS uq_owner_approvals_active_request
        ON owner_approvals (request_id)
        WHERE status IN ('pending', 'approved', 'consumed');
      CREATE INDEX IF NOT EXISTS idx_owner_approvals_scope_created
        ON owner_approvals (tenant_id, owner_id, business_id, created_at DESC);
    `);

    // Defensive upgrade if opening a pre-P0-B / pre-H2 SQLite refund_authorizations file
    const cols = this.db
      .prepare('PRAGMA table_info(refund_authorizations)')
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has('owner_id')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN owner_id TEXT;`);
    }
    if (!colNames.has('tenant_id')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN tenant_id TEXT;`);
    }
    this.db.exec(`
      UPDATE refund_authorizations
      SET tenant_id = owner_id
      WHERE tenant_id IS NULL AND owner_id IS NOT NULL;
    `);
    if (!colNames.has('provider_idempotency_key')) {
      this.db.exec(`
        ALTER TABLE refund_authorizations ADD COLUMN provider_idempotency_key TEXT;
        UPDATE refund_authorizations SET provider_idempotency_key = 'prov-idem-' || id WHERE provider_idempotency_key IS NULL;
      `);
    }
    if (!colNames.has('provider_name')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN provider_name TEXT;`);
    }
    if (!colNames.has('provider_tx_id')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN provider_tx_id TEXT;`);
    }
    if (!colNames.has('provider_outcome_status')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN provider_outcome_status TEXT NOT NULL DEFAULT 'pending';`);
    }
    if (!colNames.has('retry_allowed')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN retry_allowed INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!colNames.has('attempt_count')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;`);
    }
    if (!colNames.has('execution_started_at')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN execution_started_at TEXT;`);
    }
    if (!colNames.has('lease_expires_at')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN lease_expires_at TEXT;`);
    }
    if (!colNames.has('last_reconciled_at')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN last_reconciled_at TEXT;`);
    }
    if (!colNames.has('reconciliation_notes')) {
      this.db.exec(`ALTER TABLE refund_authorizations ADD COLUMN reconciliation_notes TEXT;`);
    }

    this.db.exec(`
      DROP INDEX IF EXISTS uq_refund_active_order;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_active_order
        ON refund_authorizations (business_id, order_id)
        WHERE status IN ('executing', 'uncertain_reconciliation_required', 'executed');

      CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_auth_provider_idempotency_key
        ON refund_authorizations (provider_idempotency_key);

      CREATE INDEX IF NOT EXISTS idx_refund_auth_status_lease
        ON refund_authorizations (status, lease_expires_at);

      CREATE INDEX IF NOT EXISTS idx_refund_auth_scope_status_lease
        ON refund_authorizations (tenant_id, owner_id, business_id, status, lease_expires_at);

      CREATE TRIGGER IF NOT EXISTS trg_refund_auth_immutable_provider_idem
        BEFORE UPDATE ON refund_authorizations
        FOR EACH ROW
        WHEN NEW.provider_idempotency_key IS NOT OLD.provider_idempotency_key
      BEGIN
        SELECT RAISE(ABORT, 'provider_idempotency_key is immutable and cannot be overwritten');
      END;
    `);
  }

  async recordProvenanceOrigin(
    provenance: ProvenanceRecord,
    orderId: string,
    scope?: { ownerId?: string | null; tenantId?: string | null }
  ): Promise<void> {
    if (!provenance.nonce) {
      throw new Error('Cannot persist provenance origin without nonce.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT request_id FROM provenance_ledger WHERE request_id = ?')
        .get(provenance.request_id) as { request_id: string } | undefined;

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO provenance_ledger
              (request_id, owner_id, tenant_id, nonce, bound_order_id, source_agent, trigger_raw_hash, initial_authority_level, provenance_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            provenance.request_id,
            scope?.ownerId ?? null,
            scope?.tenantId ?? scope?.ownerId ?? null,
            provenance.nonce,
            provenance.bound_order_id ?? orderId,
            provenance.source_agent,
            provenance.original_trigger.raw_hash,
            provenance.initial_authority_level ?? provenance.authority_level,
            JSON.stringify(provenance),
            provenance.created_at
          );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async getProvenanceSnapshot(
    requestId: string
  ): Promise<ProvenanceRecord | undefined> {
    const ledgerRow = this.db
      .prepare('SELECT provenance_json, initial_authority_level FROM provenance_ledger WHERE request_id = ?')
      .get(requestId) as { provenance_json: string; initial_authority_level: string } | undefined;

    const authReqRow = this.db
      .prepare('SELECT provenance_json, authority_level FROM authenticated_refund_requests WHERE request_id = ?')
      .get(requestId) as { provenance_json: string; authority_level: string } | undefined;

    if (!ledgerRow && !authReqRow) {
      return undefined;
    }

    const parseAndValidate = (rawJson: string, sourceTable: string): ProvenanceRecord => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        throw new Error(`Corrupted provenance snapshot JSON in ${sourceTable} for request "${requestId}".`);
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Corrupted provenance snapshot object in ${sourceTable} for request "${requestId}".`);
      }
      const record = parsed as ProvenanceRecord;
      if (!isValidConfidence(record.confidence)) {
        throw new Error(
          `Corrupted provenance snapshot in ${sourceTable}: missing or invalid confidence for request "${requestId}".`
        );
      }
      return record;
    };

    const ledgerRecord = ledgerRow
      ? parseAndValidate(ledgerRow.provenance_json, 'provenance_ledger')
      : undefined;
    const authReqRecord = authReqRow
      ? parseAndValidate(authReqRow.provenance_json, 'authenticated_refund_requests')
      : undefined;

    if (ledgerRecord && authReqRecord) {
      if (
        normalizeConfidenceBasisPoints(ledgerRecord.confidence) !==
          normalizeConfidenceBasisPoints(authReqRecord.confidence) ||
        Math.abs(ledgerRecord.confidence - authReqRecord.confidence) > 1e-9
      ) {
        throw new Error(
          `Corrupted provenance snapshot: confidence mismatch between provenance_ledger and authenticated_refund_requests for request "${requestId}".`
        );
      }
      if (
        (ledgerRecord.initial_authority_level ?? ledgerRecord.authority_level) !==
        (authReqRecord.initial_authority_level ?? authReqRecord.authority_level)
      ) {
        throw new Error(
          `Corrupted provenance snapshot: initial_authority_level mismatch between ledger tables for request "${requestId}".`
        );
      }
    }

    return authReqRecord ?? ledgerRecord;
  }

  async recordAuthenticatedRefundRequest(
    record: AuthenticatedRefundRequestRecord
  ): Promise<void> {
    if (!record.requestId?.trim()) {
      throw new Error('Cannot record authenticated refund request without requestId.');
    }
    if (!Number.isInteger(record.amountCents) || record.amountCents <= 0) {
      throw new Error('Cannot record authenticated refund request without positive integer amountCents.');
    }
    const createdMs = parseStrictIsoTimestamp(record.createdAt);
    const expiresMs = parseStrictIsoTimestamp(record.expiresAt);
    if (createdMs === null || expiresMs === null || expiresMs <= createdMs) {
      throw new Error('Cannot record authenticated refund request with invalid or malformed createdAt/expiresAt timestamps.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT request_id FROM authenticated_refund_requests WHERE request_id = ?')
        .get(record.requestId) as { request_id: string } | undefined;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO authenticated_refund_requests (
              request_id, owner_id, tenant_id, business_id, order_id, amount_cents,
              customer_email, reason, authority_level, expires_at, created_at, provenance_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            record.requestId,
            record.ownerId ?? null,
            record.tenantId ?? null,
            record.businessId,
            record.orderId,
            record.amountCents,
            record.customerEmail ?? null,
            record.reason ?? null,
            record.authorityLevel,
            record.expiresAt,
            record.createdAt,
            JSON.stringify(record.provenance)
          );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  async getAuthenticatedRefundRequest(
    requestId: string
  ): Promise<AuthenticatedRefundRequestRecord | undefined> {
    const cleanId = requestId?.trim();
    if (!cleanId) return undefined;
    const row = this.db
      .prepare('SELECT * FROM authenticated_refund_requests WHERE request_id = ?')
      .get(cleanId) as Record<string, any> | undefined;
    if (!row) return undefined;
    return {
      requestId: String(row.request_id),
      ownerId: row.owner_id ? String(row.owner_id) : null,
      tenantId: row.tenant_id ? String(row.tenant_id) : null,
      businessId: String(row.business_id),
      orderId: String(row.order_id),
      amountCents: Number(row.amount_cents),
      customerEmail: row.customer_email ? String(row.customer_email) : null,
      reason: row.reason ? String(row.reason) : null,
      authorityLevel: row.authority_level as ProvenanceRecord['authority_level'],
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      provenance: JSON.parse(String(row.provenance_json)) as ProvenanceRecord,
    };
  }

  private mapSqliteOwnerApprovalRow(row: Record<string, any>): StoredOwnerApprovalSummary {
    return {
      approval_id: String(row.approval_id),
      request_id: String(row.request_id),
      order_id: String(row.order_id),
      business_id: String(row.business_id),
      amount_cents: Number(row.amount_cents),
      approved_by_user_id: String(row.approved_by_user_id),
      status: row.status as AuthoritativeOwnerApprovalRecord['status'],
      expires_at: String(row.expires_at),
      created_at: String(row.created_at),
      consumed_at: row.consumed_at ? String(row.consumed_at) : null,
      consumed_by_request_id: row.consumed_by_request_id
        ? String(row.consumed_by_request_id)
        : null,
      consumed_by_reservation_id: row.consumed_by_reservation_id
        ? String(row.consumed_by_reservation_id)
        : null,
      owner_id: row.owner_id ? String(row.owner_id) : null,
      tenant_id: row.tenant_id ? String(row.tenant_id) : null,
      decision_note: row.decision_note ? String(row.decision_note) : null,
      updated_at: row.updated_at ? String(row.updated_at) : undefined,
    };
  }

  async recordOwnerApproval(
    input: RecordOwnerApprovalInput
  ): Promise<AuthoritativeOwnerApprovalRecord> {
    if (!input.approvalId?.trim()) {
      throw new Error('Cannot record owner approval without approvalId.');
    }
    if (!input.approvedByUserId?.trim()) {
      throw new Error('Cannot record owner approval without approvedByUserId.');
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('Cannot record owner approval without positive integer amountCents.');
    }
    if (parseStrictIsoTimestamp(input.expiresAt) === null) {
      throw new Error('Cannot record owner approval with malformed expiresAt timestamp.');
    }
    const nowIso = input.nowIso ?? new Date().toISOString();
    const status = input.status ?? 'approved';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // M2: Transition any expired unconsumed approvals for this request to 'expired'
      // so expired approvals can be safely replaced without hitting DUPLICATE_ACTIVE_APPROVAL.
      this.db
        .prepare(
          `UPDATE owner_approvals
           SET status = 'expired', updated_at = ?
           WHERE request_id = ?
             AND status IN ('pending', 'approved')
             AND consumed_at IS NULL
             AND expires_at <= ?`
        )
        .run(nowIso, input.requestId, nowIso);

      this.db
        .prepare(
          `INSERT INTO owner_approvals (
            approval_id, owner_id, tenant_id, request_id, order_id, business_id, amount_cents,
            approved_by_user_id, decision_note, status, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.approvalId.trim(),
          input.ownerId ?? null,
          input.tenantId ?? null,
          input.requestId,
          input.orderId,
          input.businessId,
          input.amountCents,
          input.approvedByUserId.trim(),
          input.decisionNote ?? null,
          status,
          input.expiresAt,
          nowIso,
          nowIso
        );
      this.db.exec('COMMIT');
      return {
        approval_id: input.approvalId.trim(),
        request_id: input.requestId,
        order_id: input.orderId,
        business_id: input.businessId,
        amount_cents: input.amountCents,
        approved_by_user_id: input.approvedByUserId.trim(),
        status,
        expires_at: input.expiresAt,
        created_at: nowIso,
        consumed_at: null,
        consumed_by_request_id: null,
      };
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      const msg = String(err?.message || '');
      if (/UNIQUE constraint failed/i.test(msg) && msg.includes('owner_approvals')) {
        const dupErr: any = new Error(
          `An active or consumed owner approval already exists for request_id "${input.requestId}".`
        );
        dupErr.code = 'DUPLICATE_ACTIVE_APPROVAL';
        throw dupErr;
      }
      throw err;
    }
  }

  async getOwnerApproval(
    approvalId: string
  ): Promise<AuthoritativeOwnerApprovalRecord | undefined> {
    return this.getOwnerApprovalDetailed(approvalId);
  }

  async getOwnerApprovalDetailed(
    approvalId: string
  ): Promise<StoredOwnerApprovalSummary | undefined> {
    const cleanId = approvalId?.trim();
    if (!cleanId) return undefined;
    const row = this.db
      .prepare('SELECT * FROM owner_approvals WHERE approval_id = ?')
      .get(cleanId) as Record<string, any> | undefined;
    return row ? this.mapSqliteOwnerApprovalRow(row) : undefined;
  }

  async listOwnerApprovals(filter?: {
    requestId?: string;
    businessId?: string;
    orderId?: string;
    scope?: GovernanceScopeFilter;
  }): Promise<StoredOwnerApprovalSummary[]> {
    const clauses: string[] = [];
    const params: any[] = [];
    if (filter?.scope) {
      const scoped = buildSqliteScopeClauses(filter.scope);
      if (scoped.impossible) return [];
      clauses.push(...scoped.clauses);
      params.push(...scoped.params);
    }
    if (filter?.requestId) {
      clauses.push('request_id = ?');
      params.push(filter.requestId);
    }
    if (filter?.businessId) {
      clauses.push('business_id = ?');
      params.push(filter.businessId);
    }
    if (filter?.orderId) {
      clauses.push('order_id = ?');
      params.push(filter.orderId);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM owner_approvals ${whereSql} ORDER BY created_at DESC LIMIT 200`)
      .all(...params) as Array<Record<string, any>>;
    return rows.map((r) => this.mapSqliteOwnerApprovalRow(r));
  }

  async findActiveApprovalForRequestOrOrder(
    requestId: string,
    orderId: string,
    businessId?: string
  ): Promise<StoredOwnerApprovalSummary | undefined> {
    const row = businessId
      ? (this.db
          .prepare(
            `SELECT * FROM owner_approvals
             WHERE (request_id = ? AND status IN ('pending', 'approved', 'consumed'))
                OR (business_id = ? AND order_id = ? AND status IN ('approved', 'consumed'))
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get(requestId, businessId, orderId) as Record<string, any> | undefined)
      : (this.db
          .prepare(
            `SELECT * FROM owner_approvals
             WHERE (request_id = ? AND status IN ('pending', 'approved', 'consumed'))
                OR (order_id = ? AND status IN ('approved', 'consumed'))
             ORDER BY created_at DESC
             LIMIT 1`
          )
          .get(requestId, orderId) as Record<string, any> | undefined);
    return row ? this.mapSqliteOwnerApprovalRow(row) : undefined;
  }

  async revokeOwnerApproval(approvalId: string): Promise<void> {
    await this.revokeOwnerApprovalWithResult(approvalId);
  }

  async revokeOwnerApprovalWithResult(
    approvalId: string,
    scope?: GovernanceScopeFilter
  ): Promise<RevokeOwnerApprovalResult> {
    const cleanId = approvalId.trim();
    const nowIso = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare('SELECT * FROM owner_approvals WHERE approval_id = ?')
        .get(cleanId) as Record<string, any> | undefined;
      if (!existing) {
        this.db.exec('COMMIT');
        return { status: 'not_found' };
      }
      const mapped = this.mapSqliteOwnerApprovalRow(existing);
      if (scope && !rowMatchesScopeFilter(mapped, scope)) {
        this.db.exec('COMMIT');
        return { status: 'forbidden_scope' };
      }
      if (mapped.status === 'consumed' || mapped.consumed_at != null) {
        this.db.exec('COMMIT');
        return { status: 'already_consumed', approval: mapped };
      }
      if (mapped.status === 'revoked') {
        this.db.exec('COMMIT');
        return { status: 'already_revoked', approval: mapped };
      }
      if (mapped.status !== 'pending' && mapped.status !== 'approved') {
        this.db.exec('COMMIT');
        return { status: 'invalid_state', approval: mapped };
      }

      const scopeClauses = scope ? buildSqliteScopeClauses(scope) : null;
      const scopeWhereSql = scopeClauses ? ` AND ${scopeClauses.clauses.join(' AND ')}` : '';
      const scopeParams = scopeClauses ? scopeClauses.params : [];

      const upd = this.db
        .prepare(
          `UPDATE owner_approvals
           SET status = 'revoked', updated_at = ?
           WHERE approval_id = ? AND status IN ('pending', 'approved') AND consumed_at IS NULL${scopeWhereSql}`
        )
        .run(nowIso, cleanId, ...scopeParams);
      if (Number(upd.changes) !== 1) {
        const latest = this.db
          .prepare('SELECT * FROM owner_approvals WHERE approval_id = ?')
          .get(cleanId) as Record<string, any>;
        this.db.exec('COMMIT');
        return {
          status: 'invalid_state',
          approval: this.mapSqliteOwnerApprovalRow(latest),
        };
      }
      const updated = this.db
        .prepare('SELECT * FROM owner_approvals WHERE approval_id = ?')
        .get(cleanId) as Record<string, any>;
      this.db.exec('COMMIT');
      return { status: 'revoked', approval: this.mapSqliteOwnerApprovalRow(updated) };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  private mapSqliteReservationRow(row: Record<string, any>): RefundReservationRecord {
    return {
      id: String(row.id),
      ownerId: row.owner_id ? String(row.owner_id) : null,
      tenantId: row.tenant_id ? String(row.tenant_id) : null,
      requestId: String(row.request_id),
      nonce: String(row.nonce),
      orderId: String(row.order_id),
      businessId: String(row.business_id),
      approvalId: row.approval_id ? String(row.approval_id) : null,
      amountCents: Number(row.amount_cents),
      idempotencyKey: String(row.idempotency_key),
      providerIdempotencyKey: String(row.provider_idempotency_key),
      providerName: row.provider_name ? String(row.provider_name) : null,
      providerTxId: row.provider_tx_id ? String(row.provider_tx_id) : null,
      providerOutcomeStatus: (row.provider_outcome_status || 'pending') as ProviderOutcomeStatus,
      retryAllowed: Number(row.retry_allowed ?? 1) === 1,
      attemptCount: Number(row.attempt_count ?? 1),
      status: row.status as RefundAuthorizationStatus,
      executionTxId: row.execution_tx_id ? String(row.execution_tx_id) : null,
      executionStartedAt: row.execution_started_at ? String(row.execution_started_at) : null,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
      consumedAt: row.consumed_at ? String(row.consumed_at) : null,
      lastReconciledAt: row.last_reconciled_at ? String(row.last_reconciled_at) : null,
      reconciliationNotes: row.reconciliation_notes ? String(row.reconciliation_notes) : null,
      expiresAt: String(row.expires_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private isLeaseExpired(leaseExpiresAt: unknown, nowMs: number): boolean {
    if (!leaseExpiresAt) return false;
    const ms = Date.parse(String(leaseExpiresAt));
    return !Number.isNaN(ms) && nowMs > ms;
  }

  async getReplayPrecheck(input: {
    requestId: string;
    nonce: string;
    orderId: string;
    businessId?: string;
    amountCents: number;
    approvalId?: string | null;
    canonicalDigest: string;
    idempotencyKey: string;
  }): Promise<ReplayPrecheckStatus | undefined> {
    const byRequest = this.db
      .prepare('SELECT * FROM refund_authorizations WHERE request_id = ?')
      .get(input.requestId) as Record<string, any> | undefined;
    if (!byRequest) return undefined;

    const sameBinding =
      byRequest.order_id === input.orderId &&
      (!input.businessId || byRequest.business_id === input.businessId) &&
      byRequest.nonce === input.nonce &&
      Number(byRequest.amount_cents) === input.amountCents &&
      byRequest.canonical_digest === input.canonicalDigest &&
      (byRequest.approval_id ?? null) === (input.approvalId ?? null);

    if (!sameBinding) {
      return {
        alreadyConsumed: true,
        conflictReason: `request_id "${input.requestId}" was already bound to different order/business/nonce/amount/approval parameters.`,
      };
    }

    if (byRequest.status === 'executed') {
      if (byRequest.idempotency_key === input.idempotencyKey) {
        return {
          idempotentOutcome: {
            execution_tx_id: String(byRequest.execution_tx_id),
            consumed_at: String(byRequest.consumed_at),
          },
        };
      }
      return {
        alreadyConsumed: true,
        conflictReason: `Refund authorization for request_id "${input.requestId}" was already consumed at ${byRequest.consumed_at}.`,
      };
    }

    if (byRequest.status === 'executing') {
      return { concurrentInFlight: true };
    }

    if (byRequest.status === 'uncertain_reconciliation_required') {
      return {
        alreadyConsumed: true,
        conflictReason: `Refund authorization for request_id "${input.requestId}" has an uncertain provider outcome and requires reconciliation.`,
      };
    }

    return undefined;
  }

  private validateOwnerApprovalInsideTx(
    input: ReserveRefundInput,
    nowMs: number,
    effectiveOwner: string | null,
    effectiveTenant: string | null,
    effectiveReqExpiresMs: number
  ): ReserveRefundOutcome | null {
    if (!input.requireOwnerApproval) return null;
    const approvalId = input.approvalId?.trim();
    if (!approvalId) {
      return {
        status: 'APPROVAL_NOT_FOUND',
        reason: 'Owner approval required but approval_id was omitted.',
      };
    }
    const row = this.db
      .prepare('SELECT * FROM owner_approvals WHERE approval_id = ?')
      .get(approvalId) as Record<string, any> | undefined;
    if (!row) {
      return {
        status: 'APPROVAL_NOT_FOUND',
        reason: `Authoritative owner approval "${approvalId}" not found.`,
      };
    }
    if (row.status === 'consumed' || row.consumed_at != null) {
      return {
        status: 'APPROVAL_ALREADY_CONSUMED',
        reason: `Owner approval "${approvalId}" has already been consumed.`,
      };
    }
    if (row.status !== 'approved') {
      return {
        status: 'APPROVAL_NOT_APPROVED',
        reason: `Owner approval "${approvalId}" has status "${row.status}", expected "approved".`,
      };
    }
    const approvalCreatedMs = parseStrictIsoTimestamp(row.created_at);
    const expiresMs = parseStrictIsoTimestamp(row.expires_at);
    if (approvalCreatedMs === null || expiresMs === null) {
      return {
        status: 'MISSING_OR_MALFORMED_TIMESTAMP',
        reason: `Owner approval "${approvalId}" has missing or malformed created_at/expires_at timestamp.`,
      };
    }
    if (expiresMs > effectiveReqExpiresMs) {
      return {
        status: 'APPROVAL_EXCEEDS_REQUEST_EXPIRATION',
        reason: `Owner approval "${approvalId}" expires at "${row.expires_at}", which exceeds refund request expiration.`,
      };
    }
    if (nowMs >= expiresMs) {
      return {
        status: 'APPROVAL_EXPIRED',
        reason: `Owner approval "${approvalId}" expired at "${row.expires_at}".`,
      };
    }
    if (expiresMs <= approvalCreatedMs) {
      return {
        status: 'MISSING_OR_MALFORMED_TIMESTAMP',
        reason: `Owner approval "${approvalId}" has invalid expires_at <= created_at.`,
      };
    }
    const rowOwner = row.owner_id ? String(row.owner_id).trim() || null : null;
    const rowTenant = row.tenant_id ? String(row.tenant_id).trim() || null : null;
    if (
      String(row.request_id) !== input.requestId ||
      String(row.order_id) !== input.orderId ||
      String(row.business_id) !== input.businessId ||
      Number(row.amount_cents) !== input.amountCents ||
      !String(row.approved_by_user_id || '').trim() ||
      (!rowOwner && !rowTenant) ||
      rowOwner !== effectiveOwner ||
      rowTenant !== effectiveTenant
    ) {
      return {
        status: 'APPROVAL_BINDING_MISMATCH',
        reason: `Owner approval "${approvalId}" does not match request_id, order_id, business_id, amount_cents, approved_by_user_id, or owner/tenant scope.`,
      };
    }
    return null;
  }

  async reserveRefundExecution(
    input: ReserveRefundInput
  ): Promise<ReserveRefundOutcome> {
    if (!input.businessId?.trim() || !input.orderId?.trim()) {
      return {
        status: 'REPLAY_CONFLICT',
        reason: 'business_id and order_id must be non-empty.',
      };
    }

    const effectiveOwner = input.ownerId?.trim() || null;
    const effectiveTenant = input.tenantId?.trim() || effectiveOwner || null;
    if (!effectiveOwner && !effectiveTenant) {
      return {
        status: 'REPLAY_CONFLICT',
        reason: 'Authoritative owner_id or tenant_id scope is required (fail-closed).',
      };
    }

    const nowIso = input.nowIso ?? new Date().toISOString();
    const nowMs = parseStrictIsoTimestamp(nowIso);
    const inputExpiresMs = parseStrictIsoTimestamp(input.expiresAt);
    if (nowMs === null || inputExpiresMs === null) {
      return {
        status: 'MISSING_OR_MALFORMED_TIMESTAMP',
        reason: 'Missing or malformed nowIso or expiresAt timestamp (fail-closed).',
      };
    }
    const leaseMs = Math.max(1000, input.executionLeaseMs ?? 60_000);
    const leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 0. Verify against persisted authenticated_refund_requests scope, binding & expiration if recorded
      const authReq = this.db
        .prepare(
          'SELECT owner_id, tenant_id, business_id, order_id, amount_cents, created_at, expires_at FROM authenticated_refund_requests WHERE request_id = ?'
        )
        .get(input.requestId) as Record<string, any> | undefined;
      let effectiveReqExpiresMs = inputExpiresMs;
      let persistedExpirationViolation: ReserveRefundOutcome | null = null;
      if (authReq) {
        const authOwner = authReq.owner_id ? String(authReq.owner_id).trim() || null : null;
        const authTenant = authReq.tenant_id ? String(authReq.tenant_id).trim() || null : null;
        if (
          String(authReq.business_id) !== input.businessId ||
          String(authReq.order_id) !== input.orderId ||
          Number(authReq.amount_cents) !== input.amountCents
        ) {
          this.db.exec('COMMIT');
          return {
            status: 'REPLAY_CONFLICT',
            reason: `Persisted request "${input.requestId}" binding parameters do not match execution request.`,
          };
        }
        if (
          (!authOwner && !authTenant) ||
          authOwner !== effectiveOwner ||
          authTenant !== effectiveTenant
        ) {
          this.db.exec('COMMIT');
          return {
            status: 'REPLAY_CONFLICT',
            reason: `Persisted request "${input.requestId}" owner or tenant scope does not match execution scope.`,
          };
        }
        const authReqCreatedMs = parseStrictIsoTimestamp(authReq.created_at);
        const authReqExpiresMs = parseStrictIsoTimestamp(authReq.expires_at);
        if (
          authReqCreatedMs === null ||
          authReqExpiresMs === null ||
          authReqExpiresMs <= authReqCreatedMs
        ) {
          persistedExpirationViolation = {
            status: 'MISSING_OR_MALFORMED_TIMESTAMP',
            reason: `Persisted request "${input.requestId}" has missing or malformed created_at/expires_at.`,
          };
        } else {
          if (authReqExpiresMs !== inputExpiresMs) {
            this.db.exec('COMMIT');
            return {
              status: 'REPLAY_CONFLICT',
              reason: `Execution expiresAt "${input.expiresAt}" does not match persisted request expires_at "${authReq.expires_at}".`,
            };
          }
          effectiveReqExpiresMs = authReqExpiresMs;
          if (nowMs >= authReqExpiresMs) {
            persistedExpirationViolation = {
              status: 'REFUND_REQUEST_EXPIRED',
              reason: `Persisted refund request "${input.requestId}" expired at "${authReq.expires_at}".`,
            };
          }
        }
      } else if (nowMs >= inputExpiresMs) {
        persistedExpirationViolation = {
          status: 'REFUND_REQUEST_EXPIRED',
          reason: `Refund request "${input.requestId}" expired at "${input.expiresAt}".`,
        };
      }

      // 1. Check same request_id
      const byRequest = this.db
        .prepare('SELECT * FROM refund_authorizations WHERE request_id = ?')
        .get(input.requestId) as Record<string, any> | undefined;

      if (byRequest) {
        const sameBinding =
          byRequest.order_id === input.orderId &&
          byRequest.business_id === input.businessId &&
          byRequest.nonce === input.nonce &&
          Number(byRequest.amount_cents) === input.amountCents &&
          byRequest.canonical_digest === input.canonicalDigest &&
          (byRequest.approval_id ?? null) === (input.approvalId ?? null);

        if (!sameBinding) {
          this.db.exec('COMMIT');
          return {
            status: 'REPLAY_CONFLICT',
            reason: `request_id "${input.requestId}" was already bound to different order/business/nonce/amount parameters.`,
          };
        }

        const existingOwner = byRequest.owner_id
          ? String(byRequest.owner_id).trim() || null
          : null;
        const existingTenant = byRequest.tenant_id
          ? String(byRequest.tenant_id).trim() || null
          : null;
        if (
          (!existingOwner && !existingTenant) ||
          existingOwner !== effectiveOwner ||
          existingTenant !== effectiveTenant
        ) {
          this.db.exec('COMMIT');
          return {
            status: 'REPLAY_CONFLICT',
            reason: `request_id "${input.requestId}" was already bound to different owner or tenant scope.`,
          };
        }

        if (byRequest.status === 'executed') {
          const sameIdempotency = byRequest.idempotency_key === input.idempotencyKey;
          this.db.exec('COMMIT');
          if (sameIdempotency) {
            return {
              status: 'IDEMPOTENT_REPLAY',
              reservationId: String(byRequest.id),
              providerIdempotencyKey: String(byRequest.provider_idempotency_key),
              executionTxId: String(byRequest.execution_tx_id),
              consumedAt: String(byRequest.consumed_at),
              outcomePayload: byRequest.outcome_json
                ? JSON.parse(String(byRequest.outcome_json))
                : {},
            };
          }
          return {
            status: 'REPLAY_ALREADY_CONSUMED',
            reason: `Refund authorization for request_id "${input.requestId}" was already consumed at ${byRequest.consumed_at}.`,
          };
        }

        if (byRequest.status === 'uncertain_reconciliation_required') {
          this.db.exec('COMMIT');
          return {
            status: 'UNCERTAIN_RECONCILIATION_REQUIRED',
            reservationId: String(byRequest.id),
            providerIdempotencyKey: String(byRequest.provider_idempotency_key),
            reason: `Refund execution for request_id "${input.requestId}" is locked pending provider reconciliation.`,
          };
        }

        if (byRequest.status === 'executing') {
          const stale = this.isLeaseExpired(byRequest.lease_expires_at, nowMs);
          this.db.exec('COMMIT');
          return {
            status: stale
              ? 'STALE_EXECUTION_REQUIRES_RECONCILIATION'
              : 'CONCURRENT_IN_FLIGHT',
            reservationId: String(byRequest.id),
            providerIdempotencyKey: String(byRequest.provider_idempotency_key),
            reason: stale
              ? `Refund execution reservation "${byRequest.id}" has a stale expired lease (${byRequest.lease_expires_at}) and requires provider reconciliation before any retry.`
              : `Refund execution for request_id "${input.requestId}" is already in flight.`,
          };
        }

        if (byRequest.status === 'rejected' || Number(byRequest.retry_allowed ?? 1) !== 1) {
          this.db.exec('COMMIT');
          return {
            status: 'RETRY_NOT_PERMITTED',
            reservationId: String(byRequest.id),
            providerIdempotencyKey: String(byRequest.provider_idempotency_key),
            reason: `Refund authorization "${byRequest.id}" is not eligible for retry (status=${byRequest.status}, retry_allowed=${byRequest.retry_allowed}).`,
          };
        }

        if (persistedExpirationViolation) {
          this.db.exec('COMMIT');
          return persistedExpirationViolation;
        }

        // Re-verify owner approval before re-acquiring lock after confirmed provider failure
        const approvalFailure = this.validateOwnerApprovalInsideTx(
          input,
          nowMs,
          effectiveOwner,
          effectiveTenant,
          effectiveReqExpiresMs
        );
        if (approvalFailure) {
          this.db.exec('COMMIT');
          return approvalFailure;
        }

        // Re-acquire failed row WITHOUT modifying immutable provider_idempotency_key or idempotency_key
        const nextAttempt = Number(byRequest.attempt_count ?? 1) + 1;
        const retryUpdate = this.db
          .prepare(
            `UPDATE refund_authorizations
             SET status = 'executing',
                 provider_outcome_status = 'pending',
                 provider_name = COALESCE(?, provider_name),
                 attempt_count = ?,
                 execution_started_at = ?,
                 lease_expires_at = ?,
                 updated_at = ?
             WHERE id = ? AND status = 'failed' AND retry_allowed = 1`
          )
          .run(
            input.providerName ?? null,
            nextAttempt,
            nowIso,
            leaseExpiresAt,
            nowIso,
            String(byRequest.id)
          );
        if (Number(retryUpdate.changes) !== 1) {
          this.db.exec('COMMIT');
          return {
            status: 'RETRY_NOT_PERMITTED',
            reason: `Reservation "${byRequest.id}" could not be re-acquired for retry.`,
          };
        }
        this.db.exec('COMMIT');
        return {
          status: 'ACQUIRED',
          reservationId: String(byRequest.id),
          providerIdempotencyKey: String(byRequest.provider_idempotency_key),
          attemptCount: nextAttempt,
          leaseExpiresAt,
        };
      }

      if (persistedExpirationViolation) {
        this.db.exec('COMMIT');
        return persistedExpirationViolation;
      }

      // 1b. Atomically validate authoritative owner approval inside write lock
      const approvalFailure = this.validateOwnerApprovalInsideTx(
        input,
        nowMs,
        effectiveOwner,
        effectiveTenant,
        effectiveReqExpiresMs
      );
      if (approvalFailure) {
        this.db.exec('COMMIT');
        return approvalFailure;
      }

      // 2. Check nonce uniqueness across all requests
      const byNonce = this.db
        .prepare('SELECT request_id, order_id FROM refund_authorizations WHERE nonce = ?')
        .get(input.nonce) as { request_id: string; order_id: string } | undefined;
      if (byNonce) {
        this.db.exec('COMMIT');
        return {
          status: 'NONCE_REUSED',
          reason: `Replay nonce "${input.nonce}" was already used by request_id "${byNonce.request_id}".`,
        };
      }

      // 3. Check approval_id binding across requests & orders
      if (input.approvalId) {
        const byApproval = this.db
          .prepare(
            'SELECT request_id, order_id FROM refund_authorizations WHERE approval_id = ?'
          )
          .get(input.approvalId) as { request_id: string; order_id: string } | undefined;
        if (byApproval) {
          this.db.exec('COMMIT');
          return {
            status: 'APPROVAL_ORDER_MISMATCH',
            reason: `Approval "${input.approvalId}" is already permanently bound to order "${byApproval.order_id}" (request "${byApproval.request_id}").`,
          };
        }
      }

      // 4. Check idempotency_key reused for a different request
      const byIdem = this.db
        .prepare(
          'SELECT request_id, status FROM refund_authorizations WHERE idempotency_key = ?'
        )
        .get(input.idempotencyKey) as { request_id: string; status: string } | undefined;
      if (byIdem) {
        this.db.exec('COMMIT');
        return {
          status: 'REPLAY_CONFLICT',
          reason: `idempotency_key "${input.idempotencyKey}" already belongs to request "${byIdem.request_id}".`,
        };
      }

      // 5. Check duplicate active/uncertain/executed refund for same (business_id, order_id)
      const byOrder = this.db
        .prepare(
          `SELECT id, request_id, status, lease_expires_at, provider_idempotency_key
           FROM refund_authorizations
           WHERE business_id = ? AND order_id = ? AND status IN ('executing', 'uncertain_reconciliation_required', 'executed')`
        )
        .get(input.businessId, input.orderId) as
        | {
            id: string;
            request_id: string;
            status: string;
            lease_expires_at: string | null;
            provider_idempotency_key: string;
          }
        | undefined;
      if (byOrder) {
        this.db.exec('COMMIT');
        if (byOrder.status === 'uncertain_reconciliation_required') {
          return {
            status: 'UNCERTAIN_RECONCILIATION_REQUIRED',
            reservationId: String(byOrder.id),
            providerIdempotencyKey: String(byOrder.provider_idempotency_key),
            reason: `Order "${input.orderId}" has an uncertain refund (request "${byOrder.request_id}") requiring reconciliation.`,
          };
        }
        if (byOrder.status === 'executing') {
          const stale = this.isLeaseExpired(byOrder.lease_expires_at, nowMs);
          return {
            status: stale
              ? 'STALE_EXECUTION_REQUIRES_RECONCILIATION'
              : 'CONCURRENT_IN_FLIGHT',
            reservationId: String(byOrder.id),
            providerIdempotencyKey: String(byOrder.provider_idempotency_key),
            reason: stale
              ? `Order "${input.orderId}" has a stale executing refund reservation requiring reconciliation.`
              : `Order "${input.orderId}" already has an in-flight refund via request "${byOrder.request_id}".`,
          };
        }
        return {
          status: 'DUPLICATE_ORDER_REFUND',
          reason: `Order "${input.orderId}" already has an executed refund via request "${byOrder.request_id}".`,
        };
      }

      // 6. Atomically generate immutable server provider_idempotency_key & reserve lock
      const reservationId = `rsv-${crypto.randomUUID()}`;
      const providerIdempotencyKey = `prov-idem-${crypto.randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO refund_authorizations (
            id, owner_id, tenant_id, request_id, nonce, order_id, business_id, approval_id,
            amount_cents, idempotency_key, provider_idempotency_key,
            provider_name, provider_outcome_status, retry_allowed, attempt_count,
            canonical_digest, key_id, status,
            execution_started_at, lease_expires_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, 1, ?, ?, 'executing', ?, ?, ?, ?, ?)`
        )
        .run(
          reservationId,
          input.ownerId ?? null,
          input.tenantId ?? input.ownerId ?? null,
          input.requestId,
          input.nonce,
          input.orderId,
          input.businessId,
          input.approvalId ?? null,
          input.amountCents,
          input.idempotencyKey,
          providerIdempotencyKey,
          input.providerName ?? null,
          input.canonicalDigest,
          input.keyId,
          nowIso,
          leaseExpiresAt,
          input.expiresAt,
          nowIso,
          nowIso
        );

      this.db.exec('COMMIT');
      return {
        status: 'ACQUIRED',
        reservationId,
        providerIdempotencyKey,
        attemptCount: 1,
        leaseExpiresAt,
      };
    } catch (err: any) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      const msg = String(err?.message || '');
      if (/UNIQUE constraint failed/i.test(msg)) {
        if (msg.includes('nonce')) {
          return {
            status: 'NONCE_REUSED',
            reason: 'Database unique constraint rejected duplicate nonce.',
          };
        }
        if (msg.includes('approval_id')) {
          return {
            status: 'APPROVAL_ORDER_MISMATCH',
            reason: 'Database unique constraint rejected reused approval_id.',
          };
        }
        if (msg.includes('order_id')) {
          return {
            status: 'DUPLICATE_ORDER_REFUND',
            reason: 'Database unique constraint rejected duplicate order refund.',
          };
        }
        return {
          status: 'REPLAY_CONFLICT',
          reason: `Database uniqueness constraint blocked duplicate execution (${msg}).`,
        };
      }
      throw err;
    }
  }

  async finalizeRefundExecution(input: {
    reservationId: string;
    executionTxId: string;
    outcomePayload: Record<string, any>;
    nowIso?: string;
  }): Promise<void> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare(
          `SELECT id, request_id, approval_id, status FROM refund_authorizations
           WHERE id = ? AND status IN ('executing', 'uncertain_reconciliation_required')`
        )
        .get(input.reservationId) as
        | { id: string; request_id: string; approval_id: string | null; status: string }
        | undefined;

      if (!existing) {
        throw new Error(
          `Could not finalize reservation "${input.reservationId}": invalid state transition.`
        );
      }

      const res = this.db
        .prepare(
          `UPDATE refund_authorizations
           SET status = 'executed',
               execution_tx_id = ?,
               provider_tx_id = COALESCE(?, provider_tx_id),
               provider_outcome_status = 'confirmed_success',
               outcome_json = ?,
               consumed_at = ?,
               last_reconciled_at = CASE WHEN status = 'uncertain_reconciliation_required' THEN ? ELSE last_reconciled_at END,
               updated_at = ?
           WHERE id = ? AND status IN ('executing', 'uncertain_reconciliation_required')`
        )
        .run(
          input.executionTxId,
          input.executionTxId,
          JSON.stringify(input.outcomePayload),
          nowIso,
          nowIso,
          nowIso,
          input.reservationId
        );
      if (Number(res.changes) !== 1) {
        throw new Error(
          `Could not finalize reservation "${input.reservationId}": invalid state transition.`
        );
      }

      if (existing.approval_id) {
        const approvalUpdate = this.db
          .prepare(
            `UPDATE owner_approvals
             SET status = 'consumed',
                 consumed_at = ?,
                 consumed_by_request_id = ?,
                 consumed_by_reservation_id = ?,
                 updated_at = ?
             WHERE approval_id = ?
               AND status = 'approved'
               AND consumed_at IS NULL`
          )
          .run(
            nowIso,
            existing.request_id,
            input.reservationId,
            nowIso,
            existing.approval_id
          );
        if (Number(approvalUpdate.changes) !== 1) {
          throw new Error(
            `Could not atomically consume owner approval "${existing.approval_id}".`
          );
        }
      }

      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  async failRefundExecution(input: {
    reservationId: string;
    reason: string;
    retryAllowed?: boolean;
    nowIso?: string;
  }): Promise<void> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const retryAllowed = input.retryAllowed === false ? 0 : 1;
    const nextStatus = retryAllowed === 1 ? 'failed' : 'rejected';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db
        .prepare(
          `UPDATE refund_authorizations
           SET status = ?,
               provider_outcome_status = 'confirmed_failure',
               retry_allowed = ?,
               outcome_json = ?,
               updated_at = ?
           WHERE id = ? AND status = 'executing'`
        )
        .run(
          nextStatus,
          retryAllowed,
          JSON.stringify({ error: input.reason }),
          nowIso,
          input.reservationId
        );
      if (Number(res.changes) !== 1) {
        throw new Error(
          `Could not mark reservation "${input.reservationId}" failed: not in executing state.`
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  async markRefundUncertain(input: {
    reservationId: string;
    reason: string;
    providerOutcomeStatus: 'timeout_or_unknown' | 'finalization_failed_after_success';
    providerTxId?: string | null;
    nowIso?: string;
  }): Promise<void> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db
        .prepare(
          `UPDATE refund_authorizations
           SET status = 'uncertain_reconciliation_required',
               provider_outcome_status = ?,
               provider_tx_id = COALESCE(?, provider_tx_id),
               reconciliation_notes = ?,
               outcome_json = ?,
               updated_at = ?
           WHERE id = ? AND status IN ('executing', 'uncertain_reconciliation_required')`
        )
        .run(
          input.providerOutcomeStatus,
          input.providerTxId ?? null,
          input.reason,
          JSON.stringify({
            uncertain: true,
            providerOutcomeStatus: input.providerOutcomeStatus,
            providerTxId: input.providerTxId ?? null,
            reason: input.reason,
          }),
          nowIso,
          input.reservationId
        );
      if (Number(res.changes) !== 1) {
        throw new Error(
          `Could not mark reservation "${input.reservationId}" uncertain: invalid state.`
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  async reconcileMarkNotExecuted(input: {
    reservationId: string;
    retryAllowed: boolean;
    reason: string;
    nowIso?: string;
  }): Promise<void> {
    const nowIso = input.nowIso ?? new Date().toISOString();
    const nextStatus = input.retryAllowed ? 'failed' : 'rejected';
    const retryBit = input.retryAllowed ? 1 : 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = this.db
        .prepare(
          `UPDATE refund_authorizations
           SET status = ?,
               provider_outcome_status = 'confirmed_failure',
               retry_allowed = ?,
               last_reconciled_at = ?,
               reconciliation_notes = ?,
               outcome_json = ?,
               updated_at = ?
           WHERE id = ? AND status IN ('executing', 'uncertain_reconciliation_required')`
        )
        .run(
          nextStatus,
          retryBit,
          nowIso,
          input.reason,
          JSON.stringify({ reconciledNotExecuted: true, reason: input.reason }),
          nowIso,
          input.reservationId
        );
      if (Number(res.changes) !== 1) {
        throw new Error(
          `Could not reconcile reservation "${input.reservationId}" to ${nextStatus}: invalid state.`
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  async getRefundReservation(filter: {
    reservationId?: string;
    requestId?: string;
    orderId?: string;
    businessId?: string;
    scope?: GovernanceScopeFilter;
  }): Promise<RefundReservationRecord | undefined> {
    const clauses: string[] = [];
    const params: any[] = [];

    if (filter.scope) {
      const scoped = buildSqliteScopeClauses(filter.scope);
      if (scoped.impossible) return undefined;
      clauses.push(...scoped.clauses);
      params.push(...scoped.params);
    }

    if (filter.reservationId) {
      clauses.push('id = ?');
      params.push(filter.reservationId);
    } else if (filter.requestId) {
      clauses.push('request_id = ?');
      params.push(filter.requestId);
    } else if (filter.orderId) {
      const cleanBiz = filter.businessId?.trim();
      if (!cleanBiz) {
        throw new Error('business_id is required when looking up refund reservation by order_id.');
      }
      clauses.push('business_id = ?');
      params.push(cleanBiz);
      clauses.push('order_id = ?');
      params.push(filter.orderId);
    } else {
      return undefined;
    }

    const row = this.db
      .prepare(
        `SELECT * FROM refund_authorizations
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(...params) as Record<string, any> | undefined;
    return row ? this.mapSqliteReservationRow(row) : undefined;
  }

  async listStaleExecutingReservations(
    nowIso?: string,
    scope?: GovernanceScopeFilter
  ): Promise<RefundReservationRecord[]> {
    const effectiveNow = nowIso ?? new Date().toISOString();
    const clauses = [
      `status = 'executing'`,
      `lease_expires_at IS NOT NULL`,
      `lease_expires_at < ?`,
    ];
    const params: any[] = [effectiveNow];

    if (scope) {
      const scoped = buildSqliteScopeClauses(scope);
      if (scoped.impossible) return [];
      clauses.push(...scoped.clauses);
      params.push(...scoped.params);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM refund_authorizations
         WHERE ${clauses.join(' AND ')}
         ORDER BY lease_expires_at ASC`
      )
      .all(...params) as Array<Record<string, any>>;
    return rows.map((r) => this.mapSqliteReservationRow(r));
  }

  async listUncertainReservations(
    scope?: GovernanceScopeFilter
  ): Promise<RefundReservationRecord[]> {
    const clauses = [`status = 'uncertain_reconciliation_required'`];
    const params: any[] = [];

    if (scope) {
      const scoped = buildSqliteScopeClauses(scope);
      if (scoped.impossible) return [];
      clauses.push(...scoped.clauses);
      params.push(...scoped.params);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM refund_authorizations
         WHERE ${clauses.join(' AND ')}
         ORDER BY updated_at ASC`
      )
      .all(...params) as Array<Record<string, any>>;
    return rows.map((r) => this.mapSqliteReservationRow(r));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Supabase Postgres Persistent Replay Store executing atomic PL/pgSQL RPCs
 * (`reserve_refund_execution` / `finalize_refund_execution`) backed by DB constraints.
 */
export class SupabasePersistentReplayStore implements PersistentReplayStore {
  private client: SupabaseClient;
  private ownerId?: string;

  constructor(
    supabaseUrl: string,
    serviceRoleKey: string,
    ownerId?: string,
    clientOverride?: SupabaseClient
  ) {
    this.client =
      clientOverride ??
      createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    this.ownerId = ownerId;
  }

  async recordProvenanceOrigin(
    provenance: ProvenanceRecord,
    orderId: string,
    scope?: { ownerId?: string | null; tenantId?: string | null }
  ): Promise<void> {
    if (!provenance.nonce) {
      throw new Error('Cannot persist provenance origin without nonce.');
    }
    const rawOwner = scope?.ownerId ?? this.ownerId ?? null;
    const effectiveOwnerUuid = this.isUuid(rawOwner) ? rawOwner!.trim() : null;
    const effectiveTenant = scope?.tenantId ?? scope?.ownerId ?? this.ownerId ?? null;

    const { error } = await this.client.from('provenance_ledger').upsert(
      {
        request_id: provenance.request_id,
        owner_id: effectiveOwnerUuid,
        tenant_id: effectiveTenant,
        nonce: provenance.nonce,
        bound_order_id: provenance.bound_order_id ?? orderId,
        source_agent: provenance.source_agent,
        trigger_type: provenance.original_trigger.type,
        trigger_id: provenance.original_trigger.id,
        trigger_raw_hash: provenance.original_trigger.raw_hash,
        initial_authority_level:
          provenance.initial_authority_level ?? provenance.authority_level,
        current_authority_level: provenance.authority_level,
        chain: provenance.chain,
        policy_version: provenance.policy_version,
        key_id: provenance.ingestion_auth?.key_id ?? 'unauthenticated',
        ingestion_signature: provenance.ingestion_auth?.signature ?? '',
        created_at: provenance.created_at,
      },
      { onConflict: 'request_id', ignoreDuplicates: true }
    );
    if (error) {
      throw new Error(`Supabase provenance_ledger insert failed: ${error.message}`);
    }
  }

  async getProvenanceSnapshot(
    requestId: string
  ): Promise<ProvenanceRecord | undefined> {
    const [authReqResult, ledgerResult] = await Promise.all([
      this.client
        .from('authenticated_refund_requests')
        .select('order_id, provenance_json')
        .eq('request_id', requestId)
        .maybeSingle(),
      this.client
        .from('provenance_ledger')
        .select('*')
        .eq('request_id', requestId)
        .maybeSingle(),
    ]);

    if (authReqResult.error) {
      throw new Error(
        `Supabase authenticated_refund_requests lookup failed: ${authReqResult.error.message}`
      );
    }
    if (ledgerResult.error) {
      throw new Error(
        `Supabase provenance_ledger lookup failed: ${ledgerResult.error.message}`
      );
    }

    const authReqData = authReqResult.data;
    const ledgerData = ledgerResult.data;

    if (!authReqData && !ledgerData) {
      return undefined;
    }

    if (!authReqData) {
      // Never substitute confidence = 1 when provenance_ledger exists without
      // an authenticated_refund_requests provenance_json baseline.
      throw new Error(
        `Incomplete provenance snapshot for request "${requestId}": provenance_ledger exists without authenticated_refund_requests.provenance_json (cannot verify confidence; fail-closed).`
      );
    }

    const provJson = authReqData.provenance_json as ProvenanceRecord | null | undefined;
    if (!provJson || typeof provJson !== 'object' || !isValidConfidence(provJson.confidence)) {
      throw new Error(
        `Corrupted authenticated provenance snapshot for request "${requestId}": missing or invalid confidence (fail-closed).`
      );
    }

    if (ledgerData) {
      const expectedBoundOrder = provJson.bound_order_id ?? authReqData.order_id;
      const expectedInitialAuth =
        provJson.initial_authority_level ?? provJson.authority_level;
      if (
        String(ledgerData.nonce ?? '') !== String(provJson.nonce ?? '') ||
        String(ledgerData.bound_order_id ?? '') !== String(expectedBoundOrder ?? '') ||
        String(ledgerData.trigger_raw_hash ?? '') !==
          String(provJson.original_trigger?.raw_hash ?? '') ||
        String(ledgerData.initial_authority_level ?? '') !== String(expectedInitialAuth ?? '')
      ) {
        throw new Error(
          `Corrupted provenance snapshot for request "${requestId}": provenance_ledger disagrees with authenticated_refund_requests.`
        );
      }
    }

    return provJson;
  }

  private isUuid(val?: string | null): boolean {
    return Boolean(
      val &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          val.trim()
        )
    );
  }

  async recordAuthenticatedRefundRequest(
    record: AuthenticatedRefundRequestRecord
  ): Promise<void> {
    const createdMs = parseStrictIsoTimestamp(record.createdAt);
    const expiresMs = parseStrictIsoTimestamp(record.expiresAt);
    if (createdMs === null || expiresMs === null || expiresMs <= createdMs) {
      throw new Error('Cannot record authenticated refund request with invalid or malformed createdAt/expiresAt timestamps.');
    }
    const effectiveOwnerUuid = this.isUuid(record.ownerId)
      ? record.ownerId!.trim()
      : this.isUuid(this.ownerId)
      ? this.ownerId!
      : null;

    const { error } = await this.client.from('authenticated_refund_requests').upsert(
      {
        request_id: record.requestId,
        owner_id: effectiveOwnerUuid,
        tenant_id: record.tenantId ?? record.ownerId ?? null,
        business_id: record.businessId,
        order_id: record.orderId,
        amount_cents: record.amountCents,
        customer_email: record.customerEmail ?? null,
        reason: record.reason ?? null,
        authority_level: record.authorityLevel,
        expires_at: record.expiresAt,
        created_at: record.createdAt,
        provenance_json: record.provenance,
      },
      { onConflict: 'request_id', ignoreDuplicates: true }
    );
    if (error) {
      throw new Error(
        `Supabase authenticated_refund_requests insert failed: ${error.message}`
      );
    }
  }

  async getAuthenticatedRefundRequest(
    requestId: string
  ): Promise<AuthenticatedRefundRequestRecord | undefined> {
    const cleanId = requestId?.trim();
    if (!cleanId) return undefined;
    const { data, error } = await this.client
      .from('authenticated_refund_requests')
      .select('*')
      .eq('request_id', cleanId)
      .maybeSingle();
    if (error || !data) return undefined;
    return {
      requestId: String(data.request_id),
      ownerId: data.owner_id ? String(data.owner_id) : null,
      tenantId: data.tenant_id ? String(data.tenant_id) : null,
      businessId: String(data.business_id),
      orderId: String(data.order_id),
      amountCents: Number(data.amount_cents),
      customerEmail: data.customer_email ? String(data.customer_email) : null,
      reason: data.reason ? String(data.reason) : null,
      authorityLevel: data.authority_level as ProvenanceRecord['authority_level'],
      expiresAt: String(data.expires_at),
      createdAt: String(data.created_at),
      provenance: data.provenance_json as ProvenanceRecord,
    };
  }

  private mapSupabaseOwnerApprovalRow(data: Record<string, any>): StoredOwnerApprovalSummary {
    return {
      approval_id: String(data.approval_id),
      request_id: String(data.request_id),
      order_id: String(data.order_id),
      business_id: String(data.business_id),
      amount_cents: Number(data.amount_cents),
      approved_by_user_id: String(data.approved_by_user_id),
      status: data.status as AuthoritativeOwnerApprovalRecord['status'],
      expires_at: String(data.expires_at),
      created_at: String(data.created_at),
      consumed_at: data.consumed_at ? String(data.consumed_at) : null,
      consumed_by_request_id: data.consumed_by_request_id
        ? String(data.consumed_by_request_id)
        : null,
      consumed_by_reservation_id: data.consumed_by_reservation_id
        ? String(data.consumed_by_reservation_id)
        : null,
      owner_id: data.owner_id ? String(data.owner_id) : null,
      tenant_id: data.tenant_id ? String(data.tenant_id) : null,
      decision_note: data.decision_note ? String(data.decision_note) : null,
      updated_at: data.updated_at ? String(data.updated_at) : undefined,
    };
  }

  async recordOwnerApproval(
    input: RecordOwnerApprovalInput
  ): Promise<AuthoritativeOwnerApprovalRecord> {
    if (!input.approvalId?.trim()) {
      throw new Error('Cannot record owner approval without approvalId.');
    }
    if (!input.approvedByUserId?.trim()) {
      throw new Error('Cannot record owner approval without approvedByUserId.');
    }
    if (parseStrictIsoTimestamp(input.expiresAt) === null) {
      throw new Error('Cannot record owner approval with malformed expiresAt timestamp.');
    }
    const nowIso = input.nowIso ?? new Date().toISOString();
    const status = input.status ?? 'approved';
    const effectiveOwnerUuid = this.isUuid(input.ownerId)
      ? input.ownerId!.trim()
      : this.isUuid(this.ownerId)
      ? this.ownerId!
      : null;

    // M2: Transition expired unconsumed approvals to 'expired' before replacement insert
    await this.client
      .from('owner_approvals')
      .update({ status: 'expired', updated_at: nowIso })
      .eq('request_id', input.requestId)
      .in('status', ['pending', 'approved'])
      .is('consumed_at', null)
      .lte('expires_at', nowIso);

    const { data, error } = await this.client
      .from('owner_approvals')
      .insert({
        approval_id: input.approvalId.trim(),
        owner_id: effectiveOwnerUuid,
        tenant_id: input.tenantId ?? input.ownerId ?? null,
        request_id: input.requestId,
        order_id: input.orderId,
        business_id: input.businessId,
        amount_cents: input.amountCents,
        approved_by_user_id: input.approvedByUserId.trim(),
        decision_note: input.decisionNote ?? null,
        status,
        expires_at: input.expiresAt,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select('*')
      .single();

    if (error || !data) {
      if (error?.code === '23505') {
        const dupErr: any = new Error(
          `An active or consumed owner approval already exists for request_id "${input.requestId}".`
        );
        dupErr.code = 'DUPLICATE_ACTIVE_APPROVAL';
        throw dupErr;
      }
      throw new Error(`Supabase owner_approvals insert failed: ${error?.message}`);
    }
    return this.mapSupabaseOwnerApprovalRow(data);
  }

  async getOwnerApproval(
    approvalId: string
  ): Promise<AuthoritativeOwnerApprovalRecord | undefined> {
    return this.getOwnerApprovalDetailed(approvalId);
  }

  async getOwnerApprovalDetailed(
    approvalId: string
  ): Promise<StoredOwnerApprovalSummary | undefined> {
    const cleanId = approvalId?.trim();
    if (!cleanId) return undefined;
    const { data, error } = await this.client
      .from('owner_approvals')
      .select('*')
      .eq('approval_id', cleanId)
      .maybeSingle();
    if (error || !data) return undefined;
    return this.mapSupabaseOwnerApprovalRow(data);
  }

  async listOwnerApprovals(filter?: {
    requestId?: string;
    businessId?: string;
    orderId?: string;
    scope?: GovernanceScopeFilter;
  }): Promise<StoredOwnerApprovalSummary[]> {
    let query = this.client.from('owner_approvals').select('*');
    if (filter?.scope) {
      const scoped = applySupabaseScopeFilter(query, filter.scope);
      if (scoped.impossible) return [];
      query = scoped.query;
    }
    if (filter?.requestId) query = query.eq('request_id', filter.requestId);
    if (filter?.businessId) query = query.eq('business_id', filter.businessId);
    if (filter?.orderId) query = query.eq('order_id', filter.orderId);
    query = query.order('created_at', { ascending: false }).limit(200);
    const { data, error } = await query;
    if (error) {
      throw new Error(`Supabase listOwnerApprovals failed: ${error.message}`);
    }
    const mapped = (data || []).map((row) => this.mapSupabaseOwnerApprovalRow(row));
    return filter?.scope
      ? mapped.filter((row) => rowMatchesScopeFilter(row, filter.scope!))
      : mapped;
  }

  async findActiveApprovalForRequestOrOrder(
    requestId: string,
    orderId: string,
    businessId?: string
  ): Promise<StoredOwnerApprovalSummary | undefined> {
    const { data: byReq } = await this.client
      .from('owner_approvals')
      .select('*')
      .eq('request_id', requestId)
      .in('status', ['pending', 'approved', 'consumed'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byReq) return this.mapSupabaseOwnerApprovalRow(byReq);

    let orderQuery = this.client
      .from('owner_approvals')
      .select('*')
      .eq('order_id', orderId)
      .in('status', ['approved', 'consumed']);
    if (businessId) {
      orderQuery = orderQuery.eq('business_id', businessId);
    }
    const { data: byOrder } = await orderQuery
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return byOrder ? this.mapSupabaseOwnerApprovalRow(byOrder) : undefined;
  }

  async revokeOwnerApproval(approvalId: string): Promise<void> {
    const res = await this.revokeOwnerApprovalWithResult(approvalId);
    if (res.status === 'already_consumed') {
      throw new Error(`Cannot revoke consumed owner approval "${approvalId}".`);
    }
  }

  async revokeOwnerApprovalWithResult(
    approvalId: string,
    scope?: GovernanceScopeFilter
  ): Promise<RevokeOwnerApprovalResult> {
    const cleanId = approvalId.trim();
    const { data: existing, error: fetchErr } = await this.client
      .from('owner_approvals')
      .select('*')
      .eq('approval_id', cleanId)
      .maybeSingle();
    if (fetchErr) {
      throw new Error(`Supabase owner_approvals lookup failed: ${fetchErr.message}`);
    }
    if (!existing) {
      return { status: 'not_found' };
    }
    const mapped = this.mapSupabaseOwnerApprovalRow(existing);
    if (scope && !rowMatchesScopeFilter(mapped, scope)) {
      return { status: 'forbidden_scope' };
    }
    if (mapped.status === 'consumed' || mapped.consumed_at != null) {
      return { status: 'already_consumed', approval: mapped };
    }
    if (mapped.status === 'revoked') {
      return { status: 'already_revoked', approval: mapped };
    }
    if (mapped.status !== 'pending' && mapped.status !== 'approved') {
      return { status: 'invalid_state', approval: mapped };
    }

    let updQuery = this.client
      .from('owner_approvals')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('approval_id', cleanId)
      .in('status', ['pending', 'approved'])
      .is('consumed_at', null);

    if (scope) {
      const scoped = applySupabaseScopeFilter(updQuery, scope);
      if (scoped.impossible) {
        return { status: 'forbidden_scope' };
      }
      updQuery = scoped.query;
    }

    const { data: updated, error } = await updQuery.select('*').maybeSingle();
    if (error) {
      throw new Error(`Supabase owner_approvals revoke failed: ${error.message}`);
    }
    if (!updated) {
      const latest = await this.getOwnerApprovalDetailed(cleanId);
      return latest
        ? { status: 'invalid_state', approval: latest }
        : { status: 'not_found' };
    }
    return { status: 'revoked', approval: this.mapSupabaseOwnerApprovalRow(updated) };
  }

  private mapSupabaseReservationRow(data: Record<string, any>): RefundReservationRecord {
    return {
      id: String(data.id),
      ownerId: data.owner_id ? String(data.owner_id) : null,
      tenantId: data.tenant_id ? String(data.tenant_id) : null,
      requestId: String(data.request_id),
      nonce: String(data.nonce),
      orderId: String(data.order_id),
      businessId: String(data.business_id),
      approvalId: data.approval_id ? String(data.approval_id) : null,
      amountCents: Number(data.amount_cents),
      idempotencyKey: String(data.idempotency_key),
      providerIdempotencyKey: String(data.provider_idempotency_key || ''),
      providerName: data.provider_name ? String(data.provider_name) : null,
      providerTxId: data.provider_tx_id ? String(data.provider_tx_id) : null,
      providerOutcomeStatus: (data.provider_outcome_status || 'pending') as ProviderOutcomeStatus,
      retryAllowed: data.retry_allowed !== false,
      attemptCount: Number(data.attempt_count ?? 1),
      status: data.status as RefundAuthorizationStatus,
      executionTxId: data.execution_tx_id ? String(data.execution_tx_id) : null,
      executionStartedAt: data.execution_started_at ? String(data.execution_started_at) : null,
      leaseExpiresAt: data.lease_expires_at ? String(data.lease_expires_at) : null,
      consumedAt: data.consumed_at ? String(data.consumed_at) : null,
      lastReconciledAt: data.last_reconciled_at ? String(data.last_reconciled_at) : null,
      reconciliationNotes: data.reconciliation_notes ? String(data.reconciliation_notes) : null,
      expiresAt: String(data.expires_at),
      createdAt: String(data.created_at),
      updatedAt: String(data.updated_at),
    };
  }

  async getReplayPrecheck(input: {
    requestId: string;
    nonce: string;
    orderId: string;
    businessId?: string;
    amountCents: number;
    approvalId?: string | null;
    canonicalDigest: string;
    idempotencyKey: string;
  }): Promise<ReplayPrecheckStatus | undefined> {
    const { data, error } = await this.client
      .from('refund_authorizations')
      .select('*')
      .eq('request_id', input.requestId)
      .maybeSingle();
    if (error || !data) return undefined;

    const sameBinding =
      data.order_id === input.orderId &&
      (!input.businessId || data.business_id === input.businessId) &&
      data.nonce === input.nonce &&
      Number(data.amount_cents) === input.amountCents &&
      data.canonical_digest === input.canonicalDigest &&
      (data.approval_id ?? null) === (input.approvalId ?? null);

    if (!sameBinding) {
      return {
        alreadyConsumed: true,
        conflictReason: `request_id "${input.requestId}" was already bound to different order/business/nonce/amount/approval parameters.`,
      };
    }

    if (data.status === 'executed') {
      if (data.idempotency_key === input.idempotencyKey) {
        return {
          idempotentOutcome: {
            execution_tx_id: String(data.execution_tx_id),
            consumed_at: String(data.consumed_at),
          },
        };
      }
      return {
        alreadyConsumed: true,
        conflictReason: `Refund authorization for request_id "${input.requestId}" was already consumed at ${data.consumed_at}.`,
      };
    }

    if (data.status === 'executing') {
      return { concurrentInFlight: true };
    }

    if (data.status === 'uncertain_reconciliation_required') {
      return {
        alreadyConsumed: true,
        conflictReason: `Refund authorization for request_id "${input.requestId}" is uncertain and requires reconciliation.`,
      };
    }

    return undefined;
  }

  async reserveRefundExecution(
    input: ReserveRefundInput
  ): Promise<ReserveRefundOutcome> {
    const leaseSeconds = Math.max(1, Math.round((input.executionLeaseMs ?? 60_000) / 1000));
    const effectiveOwnerUuid = this.isUuid(input.ownerId)
      ? input.ownerId!.trim()
      : this.isUuid(this.ownerId)
      ? this.ownerId!
      : null;

    const { data, error } = await this.client.rpc('reserve_refund_execution', {
      p_owner_id: effectiveOwnerUuid,
      p_request_id: input.requestId,
      p_nonce: input.nonce,
      p_order_id: input.orderId,
      p_business_id: input.businessId,
      p_approval_id: input.approvalId ?? null,
      p_amount_cents: input.amountCents,
      p_idempotency_key: input.idempotencyKey,
      p_canonical_digest: input.canonicalDigest,
      p_key_id: input.keyId,
      p_expires_at: input.expiresAt,
      p_require_owner_approval: Boolean(input.requireOwnerApproval),
      p_provider_name: input.providerName ?? null,
      p_lease_seconds: leaseSeconds,
      p_tenant_id: input.tenantId ?? input.ownerId ?? this.ownerId ?? null,
    });
    if (error || !data) {
      throw new Error(`Supabase reserve_refund_execution failed: ${error?.message}`);
    }

    const res = data as Record<string, any>;
    if (res.status === 'ACQUIRED') {
      return {
        status: 'ACQUIRED',
        reservationId: String(res.reservation_id),
        providerIdempotencyKey: String(res.provider_idempotency_key),
        attemptCount: Number(res.attempt_count ?? 1),
        leaseExpiresAt: String(res.lease_expires_at || ''),
      };
    }
    if (res.status === 'IDEMPOTENT_REPLAY') {
      return {
        status: 'IDEMPOTENT_REPLAY',
        reservationId: String(res.reservation_id),
        providerIdempotencyKey: String(res.provider_idempotency_key || ''),
        executionTxId: String(res.execution_tx_id),
        consumedAt: String(res.consumed_at),
        outcomePayload: res.outcome_payload || {},
      };
    }
    return {
      status: res.status,
      reservationId: res.reservation_id ? String(res.reservation_id) : undefined,
      providerIdempotencyKey: res.provider_idempotency_key
        ? String(res.provider_idempotency_key)
        : undefined,
      reason: String(res.reason || 'Replay protection blocked execution.'),
    };
  }

  async finalizeRefundExecution(input: {
    reservationId: string;
    executionTxId: string;
    outcomePayload: Record<string, any>;
  }): Promise<void> {
    const { error } = await this.client.rpc('finalize_refund_execution', {
      p_reservation_id: input.reservationId,
      p_success: true,
      p_execution_tx_id: input.executionTxId,
      p_outcome_payload: input.outcomePayload,
    });
    if (error) {
      throw new Error(`Supabase finalize_refund_execution failed: ${error.message}`);
    }
  }

  async failRefundExecution(input: {
    reservationId: string;
    reason: string;
    retryAllowed?: boolean;
  }): Promise<void> {
    const { error } = await this.client.rpc('fail_refund_execution', {
      p_reservation_id: input.reservationId,
      p_reason: input.reason,
      p_retry_allowed: input.retryAllowed !== false,
    });
    if (error) {
      throw new Error(`Supabase fail_refund_execution failed: ${error.message}`);
    }
  }

  async markRefundUncertain(input: {
    reservationId: string;
    reason: string;
    providerOutcomeStatus: 'timeout_or_unknown' | 'finalization_failed_after_success';
    providerTxId?: string | null;
  }): Promise<void> {
    const { error } = await this.client.rpc('mark_refund_uncertain', {
      p_reservation_id: input.reservationId,
      p_provider_outcome_status: input.providerOutcomeStatus,
      p_provider_tx_id: input.providerTxId ?? null,
      p_reason: input.reason,
      p_outcome_payload: {
        uncertain: true,
        providerOutcomeStatus: input.providerOutcomeStatus,
        providerTxId: input.providerTxId ?? null,
        reason: input.reason,
      },
    });
    if (error) {
      throw new Error(`Supabase mark_refund_uncertain failed: ${error.message}`);
    }
  }

  async reconcileMarkNotExecuted(input: {
    reservationId: string;
    retryAllowed: boolean;
    reason: string;
  }): Promise<void> {
    const { error } = await this.client.rpc('reconcile_mark_refund_not_executed', {
      p_reservation_id: input.reservationId,
      p_retry_allowed: input.retryAllowed,
      p_reason: input.reason,
      p_outcome_payload: { reconciledNotExecuted: true, reason: input.reason },
    });
    if (error) {
      throw new Error(`Supabase reconcile_mark_refund_not_executed failed: ${error.message}`);
    }
  }

  async getRefundReservation(filter: {
    reservationId?: string;
    requestId?: string;
    orderId?: string;
    businessId?: string;
    scope?: GovernanceScopeFilter;
  }): Promise<RefundReservationRecord | undefined> {
    let query = this.client.from('refund_authorizations').select('*');
    if (filter.scope) {
      const scoped = applySupabaseScopeFilter(query, filter.scope);
      if (scoped.impossible) return undefined;
      query = scoped.query;
    }
    if (filter.reservationId) {
      query = query.eq('id', filter.reservationId);
    } else if (filter.requestId) {
      query = query.eq('request_id', filter.requestId);
    } else if (filter.orderId) {
      const cleanBiz = filter.businessId?.trim();
      if (!cleanBiz) {
        throw new Error('business_id is required when looking up refund reservation by order_id.');
      }
      query = query
        .eq('business_id', cleanBiz)
        .eq('order_id', filter.orderId)
        .order('created_at', { ascending: false })
        .limit(1);
    } else {
      return undefined;
    }
    const { data, error } = await query.maybeSingle();
    if (error || !data) return undefined;
    const mapped = this.mapSupabaseReservationRow(data);
    if (
      filter.scope &&
      !rowMatchesScopeFilter(
        {
          owner_id: mapped.ownerId ?? null,
          tenant_id: mapped.tenantId ?? null,
          business_id: mapped.businessId,
        },
        filter.scope
      )
    ) {
      return undefined;
    }
    return mapped;
  }

  async listStaleExecutingReservations(
    nowIso?: string,
    scope?: GovernanceScopeFilter
  ): Promise<RefundReservationRecord[]> {
    const effectiveNow = nowIso ?? new Date().toISOString();
    let query = this.client
      .from('refund_authorizations')
      .select('*')
      .eq('status', 'executing')
      .lt('lease_expires_at', effectiveNow);
    if (scope) {
      const scoped = applySupabaseScopeFilter(query, scope);
      if (scoped.impossible) return [];
      query = scoped.query;
    }
    const { data, error } = await query.order('lease_expires_at', { ascending: true });
    if (error) {
      throw new Error(`Supabase listStaleExecutingReservations failed: ${error.message}`);
    }
    const rows = (data || []).map((r) => this.mapSupabaseReservationRow(r));
    return scope
      ? rows.filter((r) =>
          rowMatchesScopeFilter(
            { owner_id: r.ownerId ?? null, tenant_id: r.tenantId ?? null, business_id: r.businessId },
            scope
          )
        )
      : rows;
  }

  async listUncertainReservations(
    scope?: GovernanceScopeFilter
  ): Promise<RefundReservationRecord[]> {
    let query = this.client
      .from('refund_authorizations')
      .select('*')
      .eq('status', 'uncertain_reconciliation_required');
    if (scope) {
      const scoped = applySupabaseScopeFilter(query, scope);
      if (scoped.impossible) return [];
      query = scoped.query;
    }
    const { data, error } = await query.order('updated_at', { ascending: true });
    if (error) {
      throw new Error(`Supabase listUncertainReservations failed: ${error.message}`);
    }
    const rows = (data || []).map((r) => this.mapSupabaseReservationRow(r));
    return scope
      ? rows.filter((r) =>
          rowMatchesScopeFilter(
            { owner_id: r.ownerId ?? null, tenant_id: r.tenantId ?? null, business_id: r.businessId },
            scope
          )
        )
      : rows;
  }

  close(): void {
    // Stateless HTTP client
  }
}

export function createServerReplayStore(): PersistentReplayStore {
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (supabaseUrl && serviceRoleKey) {
    return new SupabasePersistentReplayStore(supabaseUrl, serviceRoleKey);
  }

  const dbPath =
    process.env.PROVENANCE_REPLAY_DB_PATH?.trim() ||
    path.resolve(process.cwd(), '.data/provenance-replay.sqlite');
  return new SqlitePersistentReplayStore(dbPath);
}
