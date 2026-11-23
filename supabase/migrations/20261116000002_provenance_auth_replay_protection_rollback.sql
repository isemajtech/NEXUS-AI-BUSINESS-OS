-- ==============================================================================
-- PHASE 2 SECURITY ROLLBACK: Authenticated Provenance & Replay Protection
-- Reverts ONLY the additive Phase 2 security tables, indexes, and functions.
-- Preserves all Phase 1 and core Business OS tables cleanly.
-- ==============================================================================

drop function if exists public.finalize_refund_execution(uuid, boolean, text, jsonb);
drop function if exists public.reserve_refund_execution(uuid, uuid, text, text, text, text, integer, text, text, text, timestamptz);

drop policy if exists "Owners view their refund authorizations" on public.refund_authorizations;
drop index if exists public.idx_refund_auth_order_created;
drop index if exists public.uq_refund_active_or_executed_order;
drop index if exists public.uq_refund_auth_approval_id;
drop table if exists public.refund_authorizations;

drop policy if exists "Owners view their provenance ledger" on public.provenance_ledger;
drop table if exists public.provenance_ledger;

drop policy if exists "Authenticated users inspect key metadata" on public.provenance_signing_keys;
drop table if exists public.provenance_signing_keys;
