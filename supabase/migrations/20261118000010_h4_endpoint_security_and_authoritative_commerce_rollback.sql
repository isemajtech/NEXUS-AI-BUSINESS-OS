-- ==============================================================================
-- H4 SECURITY ROLLBACK: Reverts additive H4 schema changes cleanly while keeping
-- P0-A, P0-B, P0-C, H1, H2, and H3 tables and functions intact.
-- ==============================================================================

drop policy if exists "Owners view own business gumroad webhook sales"
  on public.gumroad_webhook_events;
drop table if exists public.gumroad_webhook_events;

drop policy if exists "Creators and owners view bound checkout sessions"
  on public.stripe_checkout_sessions;
drop table if exists public.stripe_checkout_sessions;

drop policy if exists "Owners view their product publish approvals"
  on public.product_publish_approvals;
drop table if exists public.product_publish_approvals;

drop trigger if exists trg_guard_products_authoritative_fields on public.products;
drop function if exists public.guard_products_authoritative_fields();

drop index if exists public.idx_products_tenant_owner;
drop index if exists public.idx_products_gumroad_id;
drop index if exists public.idx_products_business_status;

alter table public.products drop constraint if exists products_price_cents_check;
alter table public.products
  drop column if exists published_at,
  drop column if exists published_approval_id,
  drop column if exists stripe_price_id,
  drop column if exists currency,
  drop column if exists price_cents,
  drop column if exists tenant_id;
