-- ==============================================================================
-- P0-C SECURITY MIGRATION ROLLBACK: Safe Rollback for 20261117000006
-- Aborts if dropping authenticated_refund_requests would silently lose persisted data.
-- Never touches provenance_ledger, owner_approvals, or refund_authorizations rows.
-- ==============================================================================

do $$
declare
  v_req_count bigint := 0;
begin
  if to_regclass('public.authenticated_refund_requests') is not null then
    select count(*) into v_req_count from public.authenticated_refund_requests;
    if v_req_count > 0 then
      raise exception 'Refusing destructive rollback: public.authenticated_refund_requests contains % rows. Archive/drain before rolling back P0-C.', v_req_count;
    end if;
  end if;
end $$;

drop index if exists public.uq_owner_approvals_active_request;

alter table if exists public.owner_approvals
  drop column if exists decision_note,
  drop column if exists tenant_id;

drop table if exists public.authenticated_refund_requests;
