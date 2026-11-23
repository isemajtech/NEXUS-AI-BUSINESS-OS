-- ==============================================================================
-- FAIL-SAFE ROLLBACK GUARD FOR 20261118000009_h3_expiration_consistency.sql
-- Refuses automated destructive rollback of H3 request/approval expiration
-- consistency enforcement inside reserve_refund_execution.
-- ==============================================================================

do $$
begin
  raise exception 'Unsafe rollback blocked: 20261118000009 enforces request expiration, approval <= request expiration capping, and fail-closed timestamp checks inside reserve_refund_execution. Automated rollback would reopen H3 expiration bypasses. Perform manual forward remediation instead.';
end $$;
