import type { FinanceRefundRequest } from '../governance/provenance';

export interface ServerOwnerApprovalRecord {
  approval_id: string;
  request_id: string;
  order_id: string;
  business_id: string;
  amount_cents: number;
  approved_by_user_id: string;
  decision_note?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'consumed';
  expires_at: string;
  created_at?: string;
  consumed_at?: string | null;
  consumed_by_request_id?: string | null;
  consumed_by_reservation_id?: string | null;
}

export interface GovernanceApiResult<T> {
  ok: boolean;
  status: number;
  code?: string;
  error?: string;
  data?: T;
}

async function parseJsonSafe(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function ingestRefundProvenance(
  input: {
    business_id: string;
    order_id: string;
    customer_email?: string;
    amount_usd: number;
    reason: string;
    trigger_id?: string;
    confidence?: number;
  },
  accessToken: string
): Promise<GovernanceApiResult<{ request: FinanceRefundRequest }>> {
  try {
    const res = await fetch('/api/governance/provenance/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        business_id: input.business_id,
        order_id: input.order_id,
        customer_email: input.customer_email || '',
        amount_usd: input.amount_usd,
        reason: input.reason,
        source_agent: 'customer_support',
        trigger_type: 'customer_ticket',
        trigger_id: input.trigger_id,
        confidence: input.confidence ?? 0.9,
        authority_level: 'recommend_only',
      }),
    });
    const body = await parseJsonSafe(res);
    if (!res.ok || !body?.success || !body?.request) {
      return {
        ok: false,
        status: res.status,
        code: body?.code,
        error: body?.error || `Server rejected provenance ingestion (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: { request: body.request as FinanceRefundRequest },
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || 'Network error while ingesting refund provenance.',
    };
  }
}

export async function createAuthoritativeOwnerApproval(
  input: {
    request_id: string;
    order_id: string;
    business_id: string;
    amount_cents: number;
    decision_note?: string;
  },
  accessToken: string
): Promise<GovernanceApiResult<{ approval: ServerOwnerApprovalRecord }>> {
  try {
    const res = await fetch('/api/governance/approvals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(input),
    });
    const body = await parseJsonSafe(res);
    if (!res.ok || !body?.success || !body?.approval) {
      return {
        ok: false,
        status: res.status,
        code: body?.code,
        error: body?.error || `Server rejected owner approval creation (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: { approval: body.approval as ServerOwnerApprovalRecord },
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || 'Network error while creating authoritative owner approval.',
    };
  }
}

export async function fetchAuthoritativeOwnerApprovals(
  accessToken: string,
  businessId?: string
): Promise<GovernanceApiResult<{ approvals: ServerOwnerApprovalRecord[] }>> {
  try {
    const qs =
      businessId && businessId !== 'all'
        ? `?business_id=${encodeURIComponent(businessId)}`
        : '';
    const res = await fetch(`/api/governance/approvals${qs}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const body = await parseJsonSafe(res);
    if (!res.ok || !body?.success || !Array.isArray(body?.approvals)) {
      return {
        ok: false,
        status: res.status,
        code: body?.code,
        error: body?.error || `Failed to load authoritative approvals (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: { approvals: body.approvals as ServerOwnerApprovalRecord[] },
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || 'Network error while loading authoritative owner approvals.',
    };
  }
}

export async function revokeAuthoritativeOwnerApproval(
  approvalId: string,
  accessToken: string
): Promise<GovernanceApiResult<{ approval: ServerOwnerApprovalRecord }>> {
  try {
    const res = await fetch(
      `/api/governance/approvals/${encodeURIComponent(approvalId)}/revoke`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );
    const body = await parseJsonSafe(res);
    if (!res.ok || !body?.success || !body?.approval) {
      return {
        ok: false,
        status: res.status,
        code: body?.code,
        error: body?.error || `Failed to revoke approval (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      status: res.status,
      data: { approval: body.approval as ServerOwnerApprovalRecord },
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      error: err?.message || 'Network error while revoking owner approval.',
    };
  }
}
