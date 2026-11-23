import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';

export type GovernanceRole =
  | 'owner'
  | 'admin'
  | 'finance_operator'
  | 'support_operator'
  | 'ingestion_service';

export type GovernancePermission =
  | 'provenance:ingest'
  | 'finance:refund:execute'
  | 'finance:approval:create'
  | 'finance:approval:read'
  | 'finance:approval:revoke'
  | 'commerce:gumroad:publish'
  | 'commerce:gumroad:read'
  | 'commerce:stripe:checkout'
  | 'commerce:stripe:verify'
  | 'ai:use'
  | 'ai:admin'
  | 'factory:use';

const ROLE_PERMISSIONS: Record<GovernanceRole, ReadonlyArray<GovernancePermission>> = {
  owner: [
    'provenance:ingest',
    'finance:refund:execute',
    'finance:approval:create',
    'finance:approval:read',
    'finance:approval:revoke',
    'commerce:gumroad:publish',
    'commerce:gumroad:read',
    'commerce:stripe:checkout',
    'commerce:stripe:verify',
    'ai:use',
    'ai:admin',
    'factory:use',
  ],
  admin: [
    'provenance:ingest',
    'finance:refund:execute',
    'finance:approval:create',
    'finance:approval:read',
    'finance:approval:revoke',
    'commerce:gumroad:read',
    'commerce:stripe:checkout',
    'commerce:stripe:verify',
    'ai:use',
    'ai:admin',
    'factory:use',
  ],
  finance_operator: [
    'finance:refund:execute',
    'commerce:gumroad:read',
    'commerce:stripe:checkout',
    'commerce:stripe:verify',
    'ai:use',
    'factory:use',
  ],
  support_operator: [
    'provenance:ingest',
    'commerce:stripe:checkout',
    'commerce:stripe:verify',
    'ai:use',
    'factory:use',
  ],
  ingestion_service: ['provenance:ingest'],
};

const VALID_ROLES = new Set<string>(Object.keys(ROLE_PERMISSIONS));

export interface VerifiedGovernanceUser {
  readonly id: string;
  readonly email?: string;
  /** Strictly server-controlled metadata (e.g. Supabase `app_metadata`, NEVER `user_metadata`) */
  readonly appMetadata?: Record<string, unknown>;
}

export interface GovernanceCallerIdentity {
  readonly userId: string;
  readonly email?: string;
  readonly roles: ReadonlyArray<GovernanceRole>;
  readonly permissions: ReadonlyArray<GovernancePermission>;
  readonly ownerId?: string;
  readonly tenantId?: string;
  readonly hasExplicitTenantClaim?: boolean;
  readonly hasExplicitOwnerClaim?: boolean;
  readonly allowedBusinessIds?: ReadonlyArray<string>;
  readonly hasExplicitEmptyBusinessList?: boolean;
  readonly scopeError?: string;
  readonly authProvider: 'supabase_auth';
}

export interface AuthorizedBusinessScopeBinding {
  readonly businessId: string;
  readonly ownerId?: string | null;
  readonly tenantId?: string | null;
}

export interface GovernanceScopeFilter {
  readonly tenantOrOwnerIds: ReadonlyArray<string>;
  readonly allowedBusinessIds?: ReadonlyArray<string>;
  readonly businessId?: string;
  readonly authorizedBusinessBindings?: ReadonlyArray<AuthorizedBusinessScopeBinding>;
}

export type AccessTokenVerifier = (
  token: string
) => Promise<VerifiedGovernanceUser | null>;

export interface GovernanceAuthVerifier {
  readonly configured: boolean;
  readonly reason?: string;
  readonly ownerUserIds: ReadonlySet<string>;
  readonly verifyAccessToken?: AccessTokenVerifier;
}

export interface AuthenticatedGovernanceRequest extends Request {
  governanceCaller?: GovernanceCallerIdentity;
}

function parseConfiguredOwnerIds(env: NodeJS.ProcessEnv): Set<string> {
  const raw = [
    env.GOVERNANCE_OWNER_USER_IDS,
    env.GOVERNANCE_OWNER_USER_ID,
    env.OWNER_USER_ID,
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .join(',');

  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

/**
 * Builds the server-side Governance auth verifier using existing Supabase Auth infrastructure.
 * Fails closed (`configured: false`) whenever Supabase URL + verification key are absent.
 */
export function createSupabaseGovernanceAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GovernanceAuthVerifier {
  const supabaseUrl =
    env.SUPABASE_URL?.trim() || env.VITE_SUPABASE_URL?.trim() || '';
  const supabaseKey =
    env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    env.SUPABASE_ANON_KEY?.trim() ||
    env.VITE_SUPABASE_ANON_KEY?.trim() ||
    '';
  const ownerUserIds = parseConfiguredOwnerIds(env);

  if (!supabaseUrl || !supabaseKey) {
    return {
      configured: false,
      ownerUserIds,
      reason:
        'Governance HTTP endpoints disabled (fail-closed): server-side Supabase Auth verification is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY).',
    };
  }

  let client: SupabaseClient;
  try {
    client = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (err: any) {
    return {
      configured: false,
      ownerUserIds,
      reason: `Governance HTTP endpoints disabled (fail-closed): could not initialize Supabase Auth client (${err?.message || 'invalid config'}).`,
    };
  }

  return {
    configured: true,
    ownerUserIds,
    verifyAccessToken: async (token: string): Promise<VerifiedGovernanceUser | null> => {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data?.user?.id) {
        return null;
      }
      return {
        id: data.user.id,
        email: data.user.email ?? undefined,
        appMetadata:
          data.user.app_metadata && typeof data.user.app_metadata === 'object'
            ? (data.user.app_metadata as Record<string, unknown>)
            : {},
      };
    },
  };
}

function extractAllowedBusinessIds(appMeta: Record<string, unknown>): {
  allowedBusinessIds?: string[];
  hasExplicitEmptyBusinessList: boolean;
  error?: string;
} {
  const hasBusinessIdsKey = 'business_ids' in appMeta && appMeta.business_ids !== undefined;
  const hasAllowedListKey =
    'allowed_business_ids' in appMeta && appMeta.allowed_business_ids !== undefined;
  const hasSingleBusinessKey = 'business_id' in appMeta && appMeta.business_id !== undefined;

  if (!hasBusinessIdsKey && !hasAllowedListKey && !hasSingleBusinessKey) {
    return { allowedBusinessIds: undefined, hasExplicitEmptyBusinessList: false };
  }

  let rawList: unknown[];
  if (hasBusinessIdsKey) {
    if (!Array.isArray(appMeta.business_ids)) {
      return {
        allowedBusinessIds: [],
        hasExplicitEmptyBusinessList: true,
        error: 'Ambiguous or malformed app_metadata.business_ids claim.',
      };
    }
    rawList = appMeta.business_ids;
  } else if (hasAllowedListKey) {
    if (!Array.isArray(appMeta.allowed_business_ids)) {
      return {
        allowedBusinessIds: [],
        hasExplicitEmptyBusinessList: true,
        error: 'Ambiguous or malformed app_metadata.allowed_business_ids claim.',
      };
    }
    rawList = appMeta.allowed_business_ids;
  } else {
    if (typeof appMeta.business_id !== 'string' || !appMeta.business_id.trim()) {
      return {
        allowedBusinessIds: [],
        hasExplicitEmptyBusinessList: true,
        error: 'Ambiguous or empty app_metadata.business_id claim.',
      };
    }
    rawList = [appMeta.business_id];
  }

  const cleaned: string[] = [];
  for (const item of rawList) {
    if (typeof item !== 'string' || !item.trim()) {
      return {
        allowedBusinessIds: [],
        hasExplicitEmptyBusinessList: true,
        error: 'Malformed entry inside authorized business_ids scope.',
      };
    }
    cleaned.push(item.trim());
  }

  const unique = Array.from(new Set(cleaned));
  if (unique.length === 0) {
    return {
      allowedBusinessIds: [],
      hasExplicitEmptyBusinessList: true,
    };
  }

  return {
    allowedBusinessIds: unique,
    hasExplicitEmptyBusinessList: false,
  };
}

export function resolveCallerIdentity(
  user: VerifiedGovernanceUser,
  ownerUserIds: ReadonlySet<string>
): GovernanceCallerIdentity {
  const roles = new Set<GovernanceRole>();

  if (ownerUserIds.has(user.id)) {
    roles.add('owner');
  }

  // Only inspect server-controlled app_metadata (NEVER client-writable user_metadata)
  const appMeta = user.appMetadata ?? {};
  if (typeof appMeta.role === 'string' && VALID_ROLES.has(appMeta.role)) {
    roles.add(appMeta.role as GovernanceRole);
  }
  if (Array.isArray(appMeta.roles)) {
    for (const r of appMeta.roles) {
      if (typeof r === 'string' && VALID_ROLES.has(r)) {
        roles.add(r as GovernanceRole);
      }
    }
  }

  const permissions = new Set<GovernancePermission>();
  for (const role of roles) {
    for (const perm of ROLE_PERMISSIONS[role]) {
      permissions.add(perm);
    }
  }

  let scopeError: string | undefined;

  if ('tenant_ids' in appMeta && appMeta.tenant_ids !== undefined) {
    scopeError = 'Ambiguous multi-tenant claim (tenant_ids) is not permitted.';
  }
  if ('tenants' in appMeta && appMeta.tenants !== undefined) {
    scopeError = 'Ambiguous multi-tenant claim (tenants) is not permitted.';
  }

  if (
    !scopeError &&
    'tenant_id' in appMeta &&
    appMeta.tenant_id !== undefined &&
    (typeof appMeta.tenant_id !== 'string' || !appMeta.tenant_id.trim())
  ) {
    scopeError = 'Malformed or empty app_metadata.tenant_id scope claim.';
  }
  if (
    !scopeError &&
    'owner_id' in appMeta &&
    appMeta.owner_id !== undefined &&
    (typeof appMeta.owner_id !== 'string' || !appMeta.owner_id.trim())
  ) {
    scopeError = 'Malformed or empty app_metadata.owner_id scope claim.';
  }

  const rawTenantClaim =
    typeof appMeta.tenant_id === 'string' && appMeta.tenant_id.trim()
      ? appMeta.tenant_id.trim()
      : undefined;
  const rawOwnerClaim =
    typeof appMeta.owner_id === 'string' && appMeta.owner_id.trim()
      ? appMeta.owner_id.trim()
      : undefined;

  const isOwner = roles.has('owner');
  if (!scopeError && isOwner && rawOwnerClaim && rawOwnerClaim !== user.id) {
    scopeError = 'Ambiguous owner_id claim does not match authenticated owner identity.';
  }

  const effectiveOwnerId = rawOwnerClaim ?? (isOwner ? user.id : undefined);
  const effectiveTenantId =
    rawTenantClaim ?? rawOwnerClaim ?? (isOwner ? user.id : undefined);

  const bizParsed = extractAllowedBusinessIds(appMeta);
  if (!scopeError && bizParsed.error) {
    scopeError = bizParsed.error;
  }

  return {
    userId: user.id,
    email: user.email,
    roles: Array.from(roles),
    permissions: Array.from(permissions),
    ownerId: effectiveOwnerId,
    tenantId: effectiveTenantId,
    hasExplicitTenantClaim: Boolean(rawTenantClaim),
    hasExplicitOwnerClaim: Boolean(rawOwnerClaim),
    allowedBusinessIds: bizParsed.allowedBusinessIds,
    hasExplicitEmptyBusinessList: bizParsed.hasExplicitEmptyBusinessList,
    scopeError,
    authProvider: 'supabase_auth',
  };
}

export function validateCallerHasScope(caller: GovernanceCallerIdentity): {
  authorized: boolean;
  reason?: string;
} {
  if (caller.scopeError) {
    return { authorized: false, reason: caller.scopeError };
  }
  if (
    caller.hasExplicitEmptyBusinessList ||
    (caller.allowedBusinessIds && caller.allowedBusinessIds.length === 0)
  ) {
    return {
      authorized: false,
      reason: 'Caller authorized business_ids list is empty (fail-closed).',
    };
  }

  const isOwner = caller.roles.includes('owner');
  const hasTenantOrOwner = Boolean(caller.tenantId || caller.ownerId);
  const hasBusinessScope = Boolean(
    caller.allowedBusinessIds && caller.allowedBusinessIds.length > 0
  );

  if (!isOwner && !hasTenantOrOwner && !hasBusinessScope) {
    return {
      authorized: false,
      reason:
        'Non-owner caller lacks verifiable tenant, owner, or authorized business scope (fail-closed).',
    };
  }

  return { authorized: true };
}

export function buildCallerScopeFilter(
  caller: GovernanceCallerIdentity,
  requestedBusinessId?: string,
  authorizedBusinessBindings?: ReadonlyArray<AuthorizedBusinessScopeBinding>
): GovernanceScopeFilter {
  const scopeSet = new Set<string>();
  if (caller.roles.includes('owner')) {
    scopeSet.add(caller.userId);
  }
  if (caller.ownerId) {
    scopeSet.add(caller.ownerId);
  }
  if (caller.tenantId) {
    scopeSet.add(caller.tenantId);
  }
  if (authorizedBusinessBindings) {
    for (const b of authorizedBusinessBindings) {
      if (b.ownerId && b.ownerId.trim()) scopeSet.add(b.ownerId.trim());
      if (b.tenantId && b.tenantId.trim()) scopeSet.add(b.tenantId.trim());
    }
  }
  return {
    tenantOrOwnerIds: Array.from(scopeSet),
    allowedBusinessIds: caller.allowedBusinessIds,
    businessId: requestedBusinessId?.trim() || undefined,
    authorizedBusinessBindings,
  };
}

export function isCallerAuthorizedForScope(
  caller: GovernanceCallerIdentity,
  target: {
    ownerId?: string | null;
    tenantId?: string | null;
    businessId: string;
    requireStoredTenantOrOwnerScope?: boolean;
  },
  verifiedBusinessAccess?: {
    authorized: boolean;
    businessId: string;
    businessRecordId?: string;
    ownerId?: string | null;
    tenantId?: string | null;
    reason?: string;
  }
): { authorized: boolean; reason?: string } {
  const callerScopeCheck = validateCallerHasScope(caller);
  if (!callerScopeCheck.authorized) {
    return callerScopeCheck;
  }

  const cleanBusinessId = String(target.businessId || '').trim();
  if (!cleanBusinessId) {
    return { authorized: false, reason: 'Target business_id is missing.' };
  }

  if (caller.allowedBusinessIds !== undefined) {
    const allowedMatch =
      caller.allowedBusinessIds.includes(cleanBusinessId) ||
      (verifiedBusinessAccess?.businessRecordId
        ? caller.allowedBusinessIds.includes(verifiedBusinessAccess.businessRecordId)
        : false);
    if (!allowedMatch) {
      return {
        authorized: false,
        reason: 'Caller is not authorized for the target business.',
      };
    }
  }

  const targetTenant = target.tenantId?.trim() || null;
  const targetOwner = target.ownerId?.trim() || null;
  const requireStoredScope = target.requireStoredTenantOrOwnerScope !== false;

  if (requireStoredScope && !targetTenant && !targetOwner) {
    return {
      authorized: false,
      reason: 'Target record lacks verifiable tenant or owner scope (fail-closed).',
    };
  }

  if (verifiedBusinessAccess) {
    if (!verifiedBusinessAccess.authorized) {
      return {
        authorized: false,
        reason:
          verifiedBusinessAccess.reason ||
          'Caller is not authorized for the target business membership.',
      };
    }

    const bizMatch =
      cleanBusinessId === verifiedBusinessAccess.businessId ||
      (verifiedBusinessAccess.businessRecordId
        ? cleanBusinessId === verifiedBusinessAccess.businessRecordId
        : false);
    if (!bizMatch) {
      return {
        authorized: false,
        reason: 'Target business_id does not match verified business scope.',
      };
    }

    const bizTenant = verifiedBusinessAccess.tenantId?.trim() || null;
    const bizOwner = verifiedBusinessAccess.ownerId?.trim() || null;

    if (caller.hasExplicitTenantClaim && caller.tenantId && bizTenant && caller.tenantId !== bizTenant) {
      return {
        authorized: false,
        reason: 'Cross-tenant access denied: caller tenant_id does not match business tenant_id.',
      };
    }
    if (caller.hasExplicitOwnerClaim && caller.ownerId && bizOwner && caller.ownerId !== bizOwner) {
      return {
        authorized: false,
        reason: 'Cross-tenant access denied: caller owner_id does not match business owner_id.',
      };
    }
    if (targetTenant && bizTenant && targetTenant !== bizTenant) {
      return {
        authorized: false,
        reason: 'Cross-tenant access denied: target tenant_id does not match business tenant_id.',
      };
    }
    if (targetOwner && bizOwner && targetOwner !== bizOwner) {
      return {
        authorized: false,
        reason: 'Cross-tenant access denied: target owner_id does not match business owner_id.',
      };
    }
    return { authorized: true };
  }

  const callerScopes = new Set<string>();
  if (caller.roles.includes('owner')) {
    callerScopes.add(caller.userId);
  }
  if (caller.ownerId) {
    callerScopes.add(caller.ownerId);
  }
  if (caller.tenantId) {
    callerScopes.add(caller.tenantId);
  }

  const isDirectOwnerWithoutExplicitTenantClaim =
    caller.roles.includes('owner') &&
    !caller.hasExplicitTenantClaim &&
    Boolean(targetOwner && targetOwner === caller.userId);

  if (callerScopes.size > 0) {
    if (
      targetTenant &&
      !callerScopes.has(targetTenant) &&
      !isDirectOwnerWithoutExplicitTenantClaim
    ) {
      return {
        authorized: false,
        reason: 'Cross-tenant access denied: caller scope does not match target tenant.',
      };
    }

    if (targetOwner && !callerScopes.has(targetOwner)) {
      return {
        authorized: false,
        reason: 'Cross-tenant access denied: caller scope does not match target owner.',
      };
    }
  } else {
    // Non-owner caller scoped strictly via explicit allowedBusinessIds
    if (!caller.allowedBusinessIds || !caller.allowedBusinessIds.includes(cleanBusinessId)) {
      return {
        authorized: false,
        reason: 'Caller lacks tenant/owner or matching business authorization.',
      };
    }
  }

  return { authorized: true };
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Express middleware enforcing server-side identity verification and RBAC permissions.
 * - Returns 503 if secure auth verifier is unconfigured (endpoint disabled by default).
 * - Returns 401 if Authorization Bearer token is missing or fails server-side verification.
 * - Returns 403 if the verified user does not hold a role granting `requiredPermission`.
 */
export function requireGovernancePermission(
  getVerifier: () => GovernanceAuthVerifier,
  requiredPermission: GovernancePermission
) {
  return async (
    req: AuthenticatedGovernanceRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const verifier = getVerifier();
    if (!verifier.configured || !verifier.verifyAccessToken) {
      res.status(503).json({
        success: false,
        status: 'ENDPOINT_DISABLED_NO_AUTH',
        code: 'AUTHENTICATION_UNCONFIGURED',
        error:
          verifier.reason ||
          'Governance endpoint is disabled because server-side authentication is not configured.',
      });
      return;
    }

    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({
        success: false,
        status: 'REJECTED_UNAUTHENTICATED',
        code: 'AUTHENTICATION_REQUIRED',
        error: 'Missing or malformed Authorization: Bearer <token> header.',
      });
      return;
    }

    let verifiedUser: VerifiedGovernanceUser | null = null;
    try {
      verifiedUser = await verifier.verifyAccessToken(token);
    } catch {
      res.status(401).json({
        success: false,
        status: 'REJECTED_UNAUTHENTICATED',
        code: 'INVALID_OR_EXPIRED_TOKEN',
        error: 'Bearer token verification failed.',
      });
      return;
    }

    if (!verifiedUser || !verifiedUser.id) {
      res.status(401).json({
        success: false,
        status: 'REJECTED_UNAUTHENTICATED',
        code: 'INVALID_OR_EXPIRED_TOKEN',
        error: 'Bearer token was rejected by identity provider.',
      });
      return;
    }

    const caller = resolveCallerIdentity(verifiedUser, verifier.ownerUserIds);
    if (!caller.permissions.includes(requiredPermission)) {
      res.status(403).json({
        success: false,
        status: 'REJECTED_UNAUTHORIZED',
        code: 'INSUFFICIENT_ROLE_OR_PERMISSION',
        error: `Authenticated caller lacks required permission "${requiredPermission}".`,
      });
      return;
    }

    req.governanceCaller = caller;
    next();
  };
}

/**
 * Express middleware verifying a Supabase Auth Bearer JWT without requiring a
 * governance-specific RBAC permission (still attaches resolved `governanceCaller`).
 * Fails closed (503) when auth verifier is unconfigured, and 401 when anonymous/invalid.
 */
export function requireAuthenticatedCaller(
  getVerifier: () => GovernanceAuthVerifier
) {
  return async (
    req: AuthenticatedGovernanceRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const verifier = getVerifier();
    if (!verifier.configured || !verifier.verifyAccessToken) {
      res.status(503).json({
        success: false,
        status: 'ENDPOINT_DISABLED_NO_AUTH',
        code: 'AUTHENTICATION_UNCONFIGURED',
        error:
          verifier.reason ||
          'Endpoint is disabled because server-side authentication is not configured.',
      });
      return;
    }

    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({
        success: false,
        status: 'REJECTED_UNAUTHENTICATED',
        code: 'AUTHENTICATION_REQUIRED',
        error: 'Missing or malformed Authorization: Bearer <token> header.',
      });
      return;
    }

    let verifiedUser: VerifiedGovernanceUser | null = null;
    try {
      verifiedUser = await verifier.verifyAccessToken(token);
    } catch {
      res.status(401).json({
        success: false,
        status: 'REJECTED_UNAUTHENTICATED',
        code: 'INVALID_OR_EXPIRED_TOKEN',
        error: 'Bearer token verification failed.',
      });
      return;
    }

    if (!verifiedUser || !verifiedUser.id) {
      res.status(401).json({
        success: false,
        status: 'REJECTED_UNAUTHENTICATED',
        code: 'INVALID_OR_EXPIRED_TOKEN',
        error: 'Bearer token was rejected by identity provider.',
      });
      return;
    }

    req.governanceCaller = resolveCallerIdentity(verifiedUser, verifier.ownerUserIds);
    next();
  };
}

