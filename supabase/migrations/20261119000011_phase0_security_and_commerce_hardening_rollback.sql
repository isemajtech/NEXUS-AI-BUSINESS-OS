-- ==============================================================================
-- ROLLBACK FOR PHASE 0 HARDENING MIGRATION (000011)
-- Restores prior H4 (000010) trigger/policies without dropping live financial
-- audit tables or customer/order records destructively.
-- ==============================================================================

-- 1. Drop Phase 0 RPCs
drop function if exists public.consume_api_rate_limit(text, text, integer, integer, bigint);
drop function if exists public.record_gumroad_sale_and_sync_order(text, text, text, text, text, integer, text, boolean, timestamptz, timestamptz);
drop function if exists public.sync_stripe_charge_refunded(text, integer, text, timestamptz);
drop function if exists public.mark_stripe_checkout_session_terminal(text, text, timestamptz);
drop function if exists public.settle_stripe_checkout_session(text, text, integer, text, timestamptz);
drop function if exists public.create_stripe_checkout_order_and_session(text, uuid, text, uuid, text, uuid, text, uuid, uuid, integer, text, text, timestamptz, timestamptz);
drop function if exists public.consume_product_publish_approval(text, uuid, uuid, text, text, text, timestamptz);
drop function if exists public.revoke_product_publish_approval(text, uuid, timestamptz);
drop function if exists public.create_or_replace_product_publish_approval(text, uuid, text, uuid, uuid, text, timestamptz, text, boolean, timestamptz);

-- 2. Restore H4 trigger behavior on public.products
create or replace function public.guard_products_authoritative_fields()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      if new.status = 'published'
         or new.published_approval_id is not null
         or new.published_at is not null
         or new.gumroad_product_id is not null
         or new.gumroad_url is not null then
        raise exception 'Server authorization required to set published status, approval binding, or Gumroad product fields.';
      end if;
    elsif tg_op = 'UPDATE' then
      if (new.status = 'published' and old.status is distinct from 'published')
         or new.published_approval_id is distinct from old.published_approval_id
         or new.published_at is distinct from old.published_at
         or new.gumroad_product_id is distinct from old.gumroad_product_id
         or new.gumroad_url is distinct from old.gumroad_url
         or new.sales_count is distinct from old.sales_count
         or new.total_revenue is distinct from old.total_revenue then
        raise exception 'Server authorization required to modify published status, approval binding, Gumroad product fields, or sales totals.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop index if exists public.uq_products_gumroad_product_id;

-- 3. Restore H4 check constraints if no 'expired' rows exist
do $$
begin
  if not exists (select 1 from public.product_publish_approvals where status = 'expired') then
    alter table public.product_publish_approvals drop constraint if exists product_publish_approvals_status_check;
    alter table public.product_publish_approvals
      add constraint product_publish_approvals_status_check
      check (status in ('pending', 'approved', 'rejected', 'revoked', 'consumed'));
  end if;

  if not exists (select 1 from public.owner_approvals where status = 'expired') then
    alter table public.owner_approvals drop constraint if exists owner_approvals_status_check;
    alter table public.owner_approvals
      add constraint owner_approvals_status_check
      check (status in ('pending', 'approved', 'rejected', 'revoked', 'consumed'));
  end if;
end $$;

-- 4. Drop non-essential ephemeral rate limit cache; preserve audit tables safely
drop table if exists public.api_rate_limits;
drop policy if exists "Owners view own business stripe webhook events" on public.stripe_webhook_events;
