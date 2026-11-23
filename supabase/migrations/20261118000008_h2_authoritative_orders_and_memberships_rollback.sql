-- ==============================================================================
-- FAIL-SAFE ROLLBACK GUARD FOR 20261118000008_h2_authoritative_orders_and_memberships.sql
-- Refuses automated destructive rollback of authoritative public.orders,
-- public.business_memberships, and DB-layer owner/tenant RPC scope checks.
-- ==============================================================================

do $$
begin
  raise exception 'Unsafe rollback blocked: 20261118000008 establishes authoritative public.orders, public.business_memberships, and DB-layer owner/tenant RPC scope enforcement. Automated rollback would risk destroying order/refund records or reopening H2 authorization bypasses. Perform manual forward remediation instead.';
end $$;
