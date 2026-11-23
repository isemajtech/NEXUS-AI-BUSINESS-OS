-- ==============================================================================
-- FAIL-SAFE ROLLBACK GUARD FOR H2 MIGRATION (20261117000007_h2_tenant_business_isolation.sql)
--
-- Previously, reverting to 20261117000004 would drop the business-scoped
-- (business_id, order_id) lock, restore global (order_id) cross-business locking,
-- and drop the 15-argument reserve_refund_execution signature required by active
-- server callers. Fail closed explicitly instead of weakening H2 isolation or
-- breaking production execution paths.
-- ==============================================================================

do $$
begin
  raise exception 'Unsafe rollback blocked: H2 tenant & business isolation (20261117000007) cannot be automatically reverted without reintroducing global cross-business order_id locks and breaking 15-argument reserve_refund_execution server callers. Apply a targeted forward fix instead.';
end $$;
