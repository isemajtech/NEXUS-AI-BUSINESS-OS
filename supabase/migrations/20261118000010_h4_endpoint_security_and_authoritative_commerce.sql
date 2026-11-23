-- ==============================================================================
-- H4 SECURITY MIGRATION: Application-Wide Financial Endpoint Security,
-- Authoritative Products, Publish Approvals, Stripe Sessions & Gumroad Events
-- Additive & Idempotent. Do not apply automatically without review/approval.
-- ==============================================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. HARDEN public.products FOR SERVER-AUTHORITATIVE PRICING & PUBLISHING
-- ------------------------------------------------------------------------------
alter table public.products
  add column if not exists tenant_id text,
  add column if not exists price_cents integer,
  add column if not exists currency text not null default 'USD',
  add column if not exists stripe_price_id text,
  add column if not exists published_approval_id text,
  add column if not exists published_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'products_price_cents_check'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_price_cents_check
      check (price_cents is null or price_cents >= 0);
  end if;
end $$;

-- Safely backfill tenant_id & integer price_cents from authoritative business/price
update public.products p
set tenant_id = coalesce(nullif(btrim(b.tenant_id), ''), b.owner_id::text, p.owner_id::text)
from public.businesses b
where p.business_id = b.id
  and (p.tenant_id is null or btrim(p.tenant_id) = '')
  and coalesce(nullif(btrim(b.tenant_id), ''), b.owner_id::text, p.owner_id::text) is not null;

update public.products
set price_cents = round(price * 100)::integer
where price_cents is null
  and price is not null
  and price >= 0;

create index if not exists idx_products_business_status
  on public.products (business_id, status);

create index if not exists idx_products_gumroad_id
  on public.products (gumroad_product_id)
  where gumroad_product_id is not null;

create index if not exists idx_products_tenant_owner
  on public.products (tenant_id, owner_id, business_id);

-- Prevent authenticated browser clients from forging published status,
-- approval bindings, Gumroad product bindings, or revenue counters directly via RLS.
-- Server endpoints running with service_role (auth.uid() is null) manage those fields.
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

drop trigger if exists trg_guard_products_authoritative_fields on public.products;
create trigger trg_guard_products_authoritative_fields
  before insert or update on public.products
  for each row
  execute function public.guard_products_authoritative_fields();

-- ------------------------------------------------------------------------------
-- 2. AUTHORITATIVE PRODUCT PUBLISH APPROVALS (H4-A Gumroad Governance)
-- ------------------------------------------------------------------------------
create table if not exists public.product_publish_approvals (
  approval_id text primary key,
  owner_id uuid references auth.users(id) on delete restrict,
  tenant_id text not null,
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  approved_by_user_id text not null,
  status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected', 'revoked', 'consumed')),
  decision_note text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  check (expires_at > created_at)
);

create index if not exists idx_product_publish_approvals_product_status
  on public.product_publish_approvals (business_id, product_id, status, expires_at);

create unique index if not exists uq_product_publish_approvals_active
  on public.product_publish_approvals (business_id, product_id)
  where status in ('pending', 'approved');

alter table public.product_publish_approvals enable row level security;

-- Read-only for authenticated owners; NEVER grant client INSERT/UPDATE/DELETE.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'product_publish_approvals'
      and policyname = 'Owners view their product publish approvals'
  ) then
    create policy "Owners view their product publish approvals"
      on public.product_publish_approvals for select
      to authenticated
      using (
        auth.uid() = owner_id
        or auth.uid()::text = approved_by_user_id
      );
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 3. AUTHORITATIVE STRIPE CHECKOUT SESSIONS (H4-B Checkout & Verification Binding)
-- ------------------------------------------------------------------------------
create table if not exists public.stripe_checkout_sessions (
  session_id text primary key,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  owner_id uuid references auth.users(id) on delete restrict,
  tenant_id text not null,
  business_id uuid not null references public.businesses(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  expected_amount_cents integer not null check (expected_amount_cents > 0),
  currency text not null default 'USD',
  billing_type text not null default 'one_time'
    check (billing_type in ('one_time', 'monthly', 'yearly')),
  status text not null default 'created'
    check (status in ('created', 'paid', 'expired', 'failed', 'cancelled')),
  stripe_payment_intent_id text,
  verified_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_stripe_checkout_sessions_user_biz
  on public.stripe_checkout_sessions (created_by_user_id, business_id, created_at desc);

create index if not exists idx_stripe_checkout_sessions_order
  on public.stripe_checkout_sessions (order_id)
  where order_id is not null;

alter table public.stripe_checkout_sessions enable row level security;

-- Read-only for creator or owning business owner; ZERO client writes.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'stripe_checkout_sessions'
      and policyname = 'Creators and owners view bound checkout sessions'
  ) then
    create policy "Creators and owners view bound checkout sessions"
      on public.stripe_checkout_sessions for select
      to authenticated
      using (
        auth.uid() = created_by_user_id
        or auth.uid() = owner_id
      );
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 4. BUSINESS-SCOPED GUMROAD WEBHOOK EVENTS (H4-A / H4-C)
-- ------------------------------------------------------------------------------
create table if not exists public.gumroad_webhook_events (
  sale_id text primary key,
  gumroad_product_id text not null,
  business_id uuid references public.businesses(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  tenant_id text,
  owner_id uuid references auth.users(id) on delete set null,
  product_name text not null,
  buyer_name text,
  buyer_email text,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'USD',
  refunded boolean not null default false,
  sale_created_at timestamptz not null,
  received_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_gumroad_webhook_events_product_biz
  on public.gumroad_webhook_events (gumroad_product_id, business_id, sale_created_at desc);

alter table public.gumroad_webhook_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'gumroad_webhook_events'
      and policyname = 'Owners view own business gumroad webhook sales'
  ) then
    create policy "Owners view own business gumroad webhook sales"
      on public.gumroad_webhook_events for select
      to authenticated
      using (owner_id is not null and auth.uid() = owner_id);
  end if;
end $$;
