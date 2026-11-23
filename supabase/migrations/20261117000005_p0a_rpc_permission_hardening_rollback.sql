-- ==============================================================================
-- ROLLBACK FOR P0-A RPC PERMISSION HARDENING (20261117000005)
-- Fail-safe security guard: refuses to automatically re-open PUBLIC, anon, or
-- authenticated EXECUTE privileges on SECURITY DEFINER financial RPCs.
-- ==============================================================================

do $$
begin
  raise exception 'Unsafe rollback blocked: P0-A RPC permission hardening (20261117000005) cannot be automatically reverted to re-grant PUBLIC/anon/authenticated EXECUTE on financial SECURITY DEFINER RPCs. Roll back individual feature migrations in reverse dependency order instead.';
end $$;
