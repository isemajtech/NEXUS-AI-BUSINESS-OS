-- ==============================================================================
-- P0-C SECURITY MIGRATION: Authoritative Refund Request Ledger & Single-Active-Approval Uniqueness
-- Additive & Idempotent. Do not apply automatically without review/approval.
-- ==============================================================================

-- 1. Persist original authenticated refund request context (bound order, business,
--    amount_cents, owner/tenant ownership, and expiry) for server-side verification
--    when POST /api/governance/approvals is invoked.
create table if not exists public.authenticated_refund_requests (
  request_id uuid primary key,
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  tenant_id text,
  business_id text not null,
  order_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  customer_email text,
  reason text,
  authority_level text not null check (authority_level in ('recommend_only', 'execute_under_policy', 'owner_approved')),
  expires_at timestamptz not null,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  provenance_json jsonb not null
);

create index if not exists idx_auth_refund_requests_order_created
  on public.authenticated_refund_requests (order_id, created_at desc);

create index if not exists idx_auth_refund_requests_business_created
  on public.authenticated_refund_requests (business_id, created_at desc);

alter table public.authenticated_refund_requests enable row level security;

-- Strictly read-only for authenticated owners; NEVER grant client INSERT/UPDATE/DELETE.
-- All writes go through verified server endpoints using service_role.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'authenticated_refund_requests'
      and policyname = 'Owners view their authenticated refund requests'
  ) then
    create policy "Owners view their authenticated refund requests"
      on public.authenticated_refund_requests for select
      using (auth.uid() = owner_id or auth.uid()::text = tenant_id);
  end if;
end $$;

-- 2. Extend public.owner_approvals with tenant/decision metadata and active uniqueness
alter table public.owner_approvals
  add column if not exists tenant_id text,
  add column if not exists decision_note text;

-- Enforce at most one non-revoked/non-rejected approval per request_id atomically in DB
create unique index if not exists uq_owner_approvals_active_request
  on public.owner_approvals (request_id)
  where status in ('pending', 'approved', 'consumed');
