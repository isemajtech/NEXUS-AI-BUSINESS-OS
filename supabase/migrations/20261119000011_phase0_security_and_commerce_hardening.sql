-- ==============================================================================
-- PHASE 0 HARDENING MIGRATION (000011):
-- Resolves C2, C3, C4, H1, H2, H3, M2, M4
-- Additive & Idempotent. Preserves all P0/H1/H2/H3/H4 security invariants.
-- ==============================================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. H2: ENSURE public.customers EXISTS WITH TENANT SCOPE & RLS
-- ------------------------------------------------------------------------------
create table if not exists public.customers (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  tenant_id text,
  business_id uuid references public.businesses(id) on delete cascade not null,
  name text not null,
  email text not null,
  status text not null default 'lead' check (status in ('active', 'churned', 'lead')),
  total_spend numeric(14, 2) default 0.00,
  orders_count integer default 0,
  notes text,
  first_purchased_at timestamptz,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.customers
  add column if not exists tenant_id text,
  add column if not exists updated_at timestamptz not null default timezone('utc'::text, now());

update public.customers c
set tenant_id = coalesce(nullif(btrim(b.tenant_id), ''), b.owner_id::text, c.owner_id::text)
from public.businesses b
where c.business_id = b.id
  and (c.tenant_id is null or btrim(c.tenant_id) = '')
  and coalesce(nullif(btrim(b.tenant_id), ''), b.owner_id::text, c.owner_id::text) is not null;

create unique index if not exists uq_customers_business_email
  on public.customers (business_id, lower(email));

create index if not exists idx_customers_business_status
  on public.customers (business_id, status, created_at desc);

alter table public.customers enable row level security;

drop policy if exists "Owners view and manage their customers" on public.customers;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'customers'
      and policyname = 'Authorized business owners and members view customers'
  ) then
    create policy "Authorized business owners and members view customers"
      on public.customers for select
      to authenticated
      using (
        auth.uid() = owner_id
        or exists (
          select 1
          from public.business_memberships m
          join public.businesses b on b.id = m.business_id
          where m.business_id = customers.business_id
            and m.user_id = auth.uid()
            and m.status = 'active'
            and b.status = 'active'
            and (customers.tenant_id is null or m.tenant_id = customers.tenant_id)
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'customers'
      and policyname = 'Owners insert customers for own businesses'
  ) then
    create policy "Owners insert customers for own businesses"
      on public.customers for insert
      to authenticated
      with check (
        auth.uid() = owner_id
        and exists (
          select 1
          from public.businesses b
          where b.id = customers.business_id
            and b.owner_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'customers'
      and policyname = 'Owners update customers for own businesses'
  ) then
    create policy "Owners update customers for own businesses"
      on public.customers for update
      to authenticated
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'customers'
      and policyname = 'Owners delete customers for own businesses'
  ) then
    create policy "Owners delete customers for own businesses"
      on public.customers for delete
      to authenticated
      using (auth.uid() = owner_id);
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 2. H1: HARDEN public.products AUTHORITATIVE PRICING & PUBLISHING TRIGGER
-- Blocks authenticated browser users (auth.uid() is not null) from mutating
-- price/currency/billing_type on published products or setting stripe_price_id.
-- ------------------------------------------------------------------------------
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
         or new.gumroad_url is not null
         or new.stripe_price_id is not null
         or coalesce(new.sales_count, 0) <> 0
         or coalesce(new.total_revenue, 0) <> 0 then
        raise exception 'Server authorization required to set published status, approval binding, Gumroad/Stripe pricing fields, or sales totals.';
      end if;
      if new.price_cents is not null and new.price_cents is distinct from round(coalesce(new.price, 0) * 100)::integer then
        raise exception 'Client price_cents must match price on draft creation.';
      end if;
      if new.price_cents is null and new.price is not null then
        new.price_cents := round(new.price * 100)::integer;
      end if;
    elsif tg_op = 'UPDATE' then
      if (new.status = 'published' and old.status is distinct from 'published')
         or new.published_approval_id is distinct from old.published_approval_id
         or new.published_at is distinct from old.published_at
         or new.gumroad_product_id is distinct from old.gumroad_product_id
         or new.gumroad_url is distinct from old.gumroad_url
         or new.stripe_price_id is distinct from old.stripe_price_id
         or new.sales_count is distinct from old.sales_count
         or new.total_revenue is distinct from old.total_revenue then
        raise exception 'Server authorization required to modify published status, approval binding, Stripe/Gumroad product fields, or sales totals.';
      end if;

      if old.status = 'published' and (
         new.price is distinct from old.price
         or new.price_cents is distinct from old.price_cents
         or upper(coalesce(new.currency, 'USD')) is distinct from upper(coalesce(old.currency, 'USD'))
         or new.billing_type is distinct from old.billing_type
      ) then
        raise exception 'Server authorization required to modify pricing or billing terms of a published product.';
      end if;

      if new.price is distinct from old.price and new.price_cents is not distinct from old.price_cents then
        new.price_cents := round(coalesce(new.price, 0) * 100)::integer;
      elsif new.price_cents is distinct from old.price_cents then
        new.price := round((coalesce(new.price_cents, 0)::numeric / 100.0), 2);
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
-- 3. C4: PREVENT DUPLICATE GUMROAD PRODUCT BINDINGS & ORPHAN WEBHOOKS
-- ------------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'products'
      and indexname = 'uq_products_gumroad_product_id'
  ) then
    if not exists (
      select gumroad_product_id
      from public.products
      where gumroad_product_id is not null
      group by gumroad_product_id
      having count(*) > 1
    ) then
      create unique index uq_products_gumroad_product_id
        on public.products (gumroad_product_id)
        where gumroad_product_id is not null;
    end if;
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 4. C2 & M2: ALLOW 'expired' STATE ON APPROVALS + ATOMIC LIFECYCLE RPCs
-- ------------------------------------------------------------------------------
do $$
declare
  v_con record;
begin
  for v_con in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.product_publish_approvals'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%revoked%'
  loop
    execute format('alter table public.product_publish_approvals drop constraint if exists %I', v_con.conname);
  end loop;

  alter table public.product_publish_approvals
    add constraint product_publish_approvals_status_check
    check (status in ('pending', 'approved', 'rejected', 'revoked', 'consumed', 'expired'));

  for v_con in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.owner_approvals'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%revoked%'
  loop
    execute format('alter table public.owner_approvals drop constraint if exists %I', v_con.conname);
  end loop;

  alter table public.owner_approvals
    add constraint owner_approvals_status_check
    check (status in ('pending', 'approved', 'rejected', 'revoked', 'consumed', 'expired'));
end $$;

create or replace function public.create_or_replace_product_publish_approval(
  p_approval_id text,
  p_owner_id uuid,
  p_tenant_id text,
  p_business_id uuid,
  p_product_id uuid,
  p_approved_by_user_id text,
  p_expires_at timestamptz,
  p_decision_note text default 'Approved for publish',
  p_replace_existing boolean default true,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, timezone('utc'::text, now()));
  v_existing public.product_publish_approvals%rowtype;
  v_inserted public.product_publish_approvals%rowtype;
begin
  if nullif(btrim(p_approval_id), '') is null
     or p_business_id is null
     or p_product_id is null
     or nullif(btrim(p_approved_by_user_id), '') is null
     or nullif(btrim(p_tenant_id), '') is null
     or p_expires_at is null
     or p_expires_at <= v_now then
    return jsonb_build_object(
      'status', 'INVALID_INPUT',
      'reason', 'Valid approval_id, scope, product_id, and future expires_at are required.'
    );
  end if;

  perform pg_advisory_xact_lock(hashtext('pubappr:' || p_business_id::text || ':' || p_product_id::text));

  -- Always expire stale unconsumed approvals first
  update public.product_publish_approvals
  set status = 'expired',
      updated_at = v_now
  where business_id = p_business_id
    and product_id = p_product_id
    and status in ('pending', 'approved')
    and expires_at <= v_now;

  select * into v_existing
  from public.product_publish_approvals
  where business_id = p_business_id
    and product_id = p_product_id
    and status in ('pending', 'approved')
  limit 1
  for update;

  if found then
    if not p_replace_existing then
      return jsonb_build_object(
        'status', 'ALREADY_EXISTS',
        'approval', to_jsonb(v_existing)
      );
    end if;

    update public.product_publish_approvals
    set status = 'revoked',
        updated_at = v_now
    where approval_id = v_existing.approval_id
      and status in ('pending', 'approved');
  end if;

  insert into public.product_publish_approvals (
    approval_id, owner_id, tenant_id, business_id, product_id,
    approved_by_user_id, status, decision_note, expires_at, created_at, updated_at
  ) values (
    btrim(p_approval_id),
    p_owner_id,
    btrim(p_tenant_id),
    p_business_id,
    p_product_id,
    btrim(p_approved_by_user_id),
    'approved',
    coalesce(nullif(btrim(p_decision_note), ''), 'Approved for publish'),
    p_expires_at,
    v_now,
    v_now
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'status', 'CREATED',
    'approval', to_jsonb(v_inserted)
  );
end;
$$;

create or replace function public.revoke_product_publish_approval(
  p_approval_id text,
  p_business_id uuid,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, timezone('utc'::text, now()));
  v_existing public.product_publish_approvals%rowtype;
  v_updated public.product_publish_approvals%rowtype;
begin
  if nullif(btrim(p_approval_id), '') is null or p_business_id is null then
    return jsonb_build_object('status', 'INVALID_INPUT', 'reason', 'approval_id and business_id are required.');
  end if;

  select * into v_existing
  from public.product_publish_approvals
  where approval_id = btrim(p_approval_id)
    and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  if v_existing.status = 'consumed' or v_existing.consumed_at is not null then
    return jsonb_build_object('status', 'ALREADY_CONSUMED', 'approval', to_jsonb(v_existing));
  end if;

  if v_existing.status = 'revoked' then
    return jsonb_build_object('status', 'ALREADY_REVOKED', 'approval', to_jsonb(v_existing));
  end if;

  update public.product_publish_approvals
  set status = 'revoked',
      updated_at = v_now
  where approval_id = v_existing.approval_id
    and status in ('pending', 'approved')
    and consumed_at is null
  returning * into v_updated;

  if not found then
    return jsonb_build_object('status', 'INVALID_STATE', 'approval', to_jsonb(v_existing));
  end if;

  return jsonb_build_object('status', 'REVOKED', 'approval', to_jsonb(v_updated));
end;
$$;

create or replace function public.consume_product_publish_approval(
  p_approval_id text,
  p_business_id uuid,
  p_product_id uuid,
  p_gumroad_product_id text default null,
  p_gumroad_url text default null,
  p_stripe_price_id text default null,
  p_consumed_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_consumed_at, timezone('utc'::text, now()));
  v_appr public.product_publish_approvals%rowtype;
begin
  if nullif(btrim(p_approval_id), '') is null or p_business_id is null or p_product_id is null then
    return jsonb_build_object('status', 'INVALID_INPUT', 'reason', 'approval_id, business_id, and product_id are required.');
  end if;

  perform pg_advisory_xact_lock(hashtext('pubappr:' || p_business_id::text || ':' || p_product_id::text));

  select * into v_appr
  from public.product_publish_approvals
  where approval_id = btrim(p_approval_id)
    and business_id = p_business_id
    and product_id = p_product_id
  for update;

  if not found then
    return jsonb_build_object('status', 'APPROVAL_NOT_FOUND', 'reason', 'Authoritative product publish approval not found.');
  end if;

  if v_appr.status = 'consumed' or v_appr.consumed_at is not null then
    return jsonb_build_object('status', 'APPROVAL_ALREADY_CONSUMED', 'reason', 'Publish approval already consumed.');
  end if;

  if v_appr.status <> 'approved' then
    return jsonb_build_object('status', 'APPROVAL_NOT_APPROVED', 'reason', 'Publish approval is not in approved state.');
  end if;

  if v_appr.expires_at <= v_now then
    update public.product_publish_approvals
    set status = 'expired',
        updated_at = v_now
    where approval_id = v_appr.approval_id;
    return jsonb_build_object('status', 'APPROVAL_EXPIRED', 'reason', 'Publish approval has expired.');
  end if;

  update public.product_publish_approvals
  set status = 'consumed',
      consumed_at = v_now,
      updated_at = v_now
  where approval_id = v_appr.approval_id
    and status = 'approved'
    and consumed_at is null;

  update public.products
  set status = 'published',
      gumroad_product_id = coalesce(nullif(btrim(p_gumroad_product_id), ''), gumroad_product_id),
      gumroad_url = coalesce(nullif(btrim(p_gumroad_url), ''), gumroad_url),
      stripe_price_id = coalesce(nullif(btrim(p_stripe_price_id), ''), stripe_price_id),
      published_approval_id = v_appr.approval_id,
      published_at = v_now,
      updated_at = v_now
  where id = p_product_id
    and business_id = p_business_id;

  if not found then
    raise exception 'Target product % not found for business % during atomic publish.', p_product_id, p_business_id;
  end if;

  return jsonb_build_object('status', 'PUBLISHED', 'approval_id', v_appr.approval_id, 'published_at', v_now);
end;
$$;

-- ------------------------------------------------------------------------------
-- 5. C3: STRIPE WEBHOOK EVENTS & TRANSACTIONAL CHECKOUT / SETTLEMENT RPCs
-- ------------------------------------------------------------------------------
create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  stripe_object_id text,
  session_id text,
  payment_intent_id text,
  business_id uuid references public.businesses(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  status text not null default 'processed' check (status in ('processed', 'ignored', 'failed')),
  payload_summary jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default timezone('utc'::text, now()),
  processed_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists idx_stripe_webhook_events_biz_type
  on public.stripe_webhook_events (business_id, event_type, received_at desc);

alter table public.stripe_webhook_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'stripe_webhook_events'
      and policyname = 'Owners view own business stripe webhook events'
  ) then
    create policy "Owners view own business stripe webhook events"
      on public.stripe_webhook_events for select
      to authenticated
      using (
        business_id is not null
        and exists (
          select 1
          from public.businesses b
          where b.id = stripe_webhook_events.business_id
            and b.owner_id = auth.uid()
        )
      );
  end if;
end $$;

create or replace function public.create_stripe_checkout_order_and_session(
  p_session_id text,
  p_order_id uuid,
  p_order_number text,
  p_created_by_user_id uuid,
  p_created_by_email text,
  p_owner_id uuid,
  p_tenant_id text,
  p_business_id uuid,
  p_product_id uuid,
  p_expected_amount_cents integer,
  p_currency text,
  p_billing_type text,
  p_expires_at timestamptz default null,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, timezone('utc'::text, now()));
  v_email text := lower(coalesce(nullif(btrim(p_created_by_email), ''), 'user-' || left(p_created_by_user_id::text, 8) || '@authenticated.local'));
  v_name text := coalesce(nullif(split_part(v_email, '@', 1), ''), 'Authenticated Buyer');
  v_customer_id uuid;
  v_currency text := upper(coalesce(nullif(btrim(p_currency), ''), 'USD'));
  v_session public.stripe_checkout_sessions%rowtype;
begin
  if nullif(btrim(p_session_id), '') is null
     or p_order_id is null
     or nullif(btrim(p_order_number), '') is null
     or p_created_by_user_id is null
     or p_business_id is null
     or p_product_id is null
     or p_expected_amount_cents is null
     or p_expected_amount_cents <= 0
     or nullif(btrim(p_tenant_id), '') is null then
    raise exception 'Invalid checkout session persistence parameters.';
  end if;

  insert into public.customers (
    owner_id, tenant_id, business_id, name, email, status, total_spend, orders_count, created_at, updated_at
  ) values (
    coalesce(p_owner_id, p_created_by_user_id),
    btrim(p_tenant_id),
    p_business_id,
    v_name,
    v_email,
    'lead',
    0.00,
    0,
    v_now,
    v_now
  )
  on conflict (business_id, lower(email)) do update
    set updated_at = v_now
  returning id into v_customer_id;

  insert into public.orders (
    id, owner_id, tenant_id, business_id, order_number, customer_id, product_id,
    amount, amount_cents, currency, payment_status, status,
    refunded_amount_cents, external_refunded, payment_method, payment_provider,
    created_at, updated_at
  ) values (
    p_order_id,
    coalesce(p_owner_id, p_created_by_user_id),
    btrim(p_tenant_id),
    p_business_id,
    btrim(p_order_number),
    v_customer_id,
    p_product_id,
    round((p_expected_amount_cents::numeric / 100.0), 2),
    p_expected_amount_cents,
    v_currency,
    'pending',
    'pending',
    0,
    false,
    'stripe',
    'stripe',
    v_now,
    v_now
  );

  insert into public.stripe_checkout_sessions (
    session_id, created_by_user_id, owner_id, tenant_id, business_id, product_id,
    order_id, expected_amount_cents, currency, billing_type, status,
    expires_at, created_at, updated_at
  ) values (
    btrim(p_session_id),
    p_created_by_user_id,
    coalesce(p_owner_id, p_created_by_user_id),
    btrim(p_tenant_id),
    p_business_id,
    p_product_id,
    p_order_id,
    p_expected_amount_cents,
    v_currency,
    p_billing_type,
    'created',
    p_expires_at,
    v_now,
    v_now
  )
  returning * into v_session;

  return to_jsonb(v_session);
end;
$$;

create or replace function public.settle_stripe_checkout_session(
  p_session_id text,
  p_payment_intent_id text,
  p_amount_total_cents integer,
  p_currency text,
  p_paid_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_paid_at, timezone('utc'::text, now()));
  v_session public.stripe_checkout_sessions%rowtype;
  v_updated_session public.stripe_checkout_sessions%rowtype;
  v_order public.orders%rowtype;
  v_settled_order boolean := false;
begin
  if nullif(btrim(p_session_id), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'session_id is required.');
  end if;

  select * into v_session
  from public.stripe_checkout_sessions
  where session_id = btrim(p_session_id)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Checkout session binding record not found.');
  end if;

  if v_session.expected_amount_cents is distinct from p_amount_total_cents then
    return jsonb_build_object(
      'ok', false,
      'reason', format('Stripe amount_total (%s) mismatches expected amount (%s).', p_amount_total_cents, v_session.expected_amount_cents)
    );
  end if;

  if upper(coalesce(v_session.currency, '')) is distinct from upper(coalesce(p_currency, '')) then
    return jsonb_build_object(
      'ok', false,
      'reason', format('Stripe currency (%s) mismatches expected currency (%s).', p_currency, v_session.currency)
    );
  end if;

  if v_session.order_id is not null then
    select * into v_order
    from public.orders
    where id = v_session.order_id
      and business_id = v_session.business_id
    for update;

    if found and v_order.payment_status in ('unpaid', 'pending', 'authorized') then
      update public.orders
      set payment_status = 'paid',
          status = 'completed',
          paid_at = coalesce(paid_at, v_now),
          payment_provider = coalesce(payment_provider, 'stripe'),
          payment_intent_id = coalesce(nullif(btrim(p_payment_intent_id), ''), payment_intent_id),
          updated_at = v_now
      where id = v_order.id
        and business_id = v_session.business_id
        and payment_status in ('unpaid', 'pending', 'authorized');

      if found then
        v_settled_order := true;

        if v_order.customer_id is not null then
          update public.customers
          set status = 'active',
              total_spend = coalesce(total_spend, 0) + round((v_session.expected_amount_cents::numeric / 100.0), 2),
              orders_count = coalesce(orders_count, 0) + 1,
              first_purchased_at = coalesce(first_purchased_at, v_now),
              updated_at = v_now
          where id = v_order.customer_id
            and business_id = v_session.business_id;
        end if;

        if v_order.product_id is not null then
          update public.products
          set sales_count = coalesce(sales_count, 0) + 1,
              total_revenue = coalesce(total_revenue, 0) + round((v_session.expected_amount_cents::numeric / 100.0), 2),
              updated_at = v_now
          where id = v_order.product_id
            and business_id = v_session.business_id;
        end if;
      end if;
    end if;
  end if;

  update public.stripe_checkout_sessions
  set status = 'paid',
      stripe_payment_intent_id = coalesce(nullif(btrim(p_payment_intent_id), ''), stripe_payment_intent_id),
      verified_at = coalesce(verified_at, v_now),
      updated_at = v_now
  where session_id = v_session.session_id
  returning * into v_updated_session;

  return jsonb_build_object(
    'ok', true,
    'settled_order', v_settled_order,
    'session', to_jsonb(v_updated_session)
  );
end;
$$;

create or replace function public.mark_stripe_checkout_session_terminal(
  p_session_id text,
  p_terminal_status text,
  p_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_updated_at, timezone('utc'::text, now()));
  v_session public.stripe_checkout_sessions%rowtype;
  v_order_status text;
  v_payment_status text;
begin
  if p_terminal_status not in ('expired', 'failed', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'Unsupported terminal status.');
  end if;

  select * into v_session
  from public.stripe_checkout_sessions
  where session_id = btrim(p_session_id)
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'Session not found.');
  end if;

  if v_session.status = 'paid' then
    return jsonb_build_object('ok', true, 'already_paid', true);
  end if;

  v_order_status := case when p_terminal_status = 'failed' then 'pending' else 'cancelled' end;
  v_payment_status := case when p_terminal_status = 'failed' then 'failed' else 'cancelled' end;

  update public.stripe_checkout_sessions
  set status = p_terminal_status,
      updated_at = v_now
  where session_id = v_session.session_id
    and status <> 'paid';

  if v_session.order_id is not null then
    update public.orders
    set payment_status = v_payment_status,
        status = v_order_status,
        updated_at = v_now
    where id = v_session.order_id
      and business_id = v_session.business_id
      and payment_status in ('unpaid', 'pending', 'authorized');
  end if;

  return jsonb_build_object('ok', true, 'status', p_terminal_status);
end;
$$;

create or replace function public.sync_stripe_charge_refunded(
  p_payment_intent_id text,
  p_refunded_amount_cents integer,
  p_refund_tx_id text default null,
  p_refunded_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_refunded_at, timezone('utc'::text, now()));
  v_order public.orders%rowtype;
  v_new_payment_status text;
  v_new_order_status text;
begin
  if nullif(btrim(p_payment_intent_id), '') is null or coalesce(p_refunded_amount_cents, 0) < 0 then
    return jsonb_build_object('ok', false, 'reason', 'Invalid payment_intent_id or refund amount.');
  end if;

  select * into v_order
  from public.orders
  where payment_intent_id = btrim(p_payment_intent_id)
  limit 1
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'No authoritative order bound to payment_intent_id.');
  end if;

  if v_order.amount_cents is null then
    return jsonb_build_object('ok', false, 'reason', 'Order missing authoritative amount_cents.');
  end if;

  if p_refunded_amount_cents >= v_order.amount_cents then
    v_new_payment_status := 'refunded';
    v_new_order_status := 'refunded';
  elsif p_refunded_amount_cents > 0 then
    v_new_payment_status := 'partially_refunded';
    v_new_order_status := v_order.status;
  else
    return jsonb_build_object('ok', true, 'noop', true);
  end if;

  update public.orders
  set refunded_amount_cents = least(v_order.amount_cents, greatest(coalesce(refunded_amount_cents, 0), p_refunded_amount_cents)),
      payment_status = v_new_payment_status,
      status = v_new_order_status,
      external_refunded = true,
      refund_tx_id = coalesce(refund_tx_id, nullif(btrim(p_refund_tx_id), '')),
      refunded_at = coalesce(refunded_at, v_now),
      updated_at = v_now
  where id = v_order.id;

  return jsonb_build_object(
    'ok', true,
    'order_id', v_order.id,
    'business_id', v_order.business_id,
    'payment_status', v_new_payment_status
  );
end;
$$;

-- ------------------------------------------------------------------------------
-- 6. C4: ATOMIC GUMROAD WEBHOOK SALE / REFUND LEDGER & ORDER SYNC RPC
-- Requires valid linked product (zero business_id = null orphans).
-- ------------------------------------------------------------------------------
create or replace function public.record_gumroad_sale_and_sync_order(
  p_sale_id text,
  p_gumroad_product_id text,
  p_product_name text,
  p_buyer_name text,
  p_buyer_email text,
  p_amount_cents integer,
  p_currency text,
  p_refunded boolean,
  p_sale_created_at timestamptz,
  p_now timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, timezone('utc'::text, now()));
  v_product public.products%rowtype;
  v_existing_evt public.gumroad_webhook_events%rowtype;
  v_buyer_email text := lower(coalesce(nullif(btrim(p_buyer_email), ''), 'buyer-' || left(btrim(p_sale_id), 12) || '@gumroad.verified'));
  v_buyer_name text := coalesce(nullif(btrim(p_buyer_name), ''), 'Gumroad Buyer');
  v_currency text := upper(coalesce(nullif(btrim(p_currency), ''), 'USD'));
  v_amount_cents integer := greatest(0, coalesce(p_amount_cents, 0));
  v_customer_id uuid;
  v_order_id uuid;
  v_order_number text := 'GUM-' || btrim(p_sale_id);
  v_tenant_id text;
  v_inserted_new boolean := false;
  v_transitioned_refunded boolean := false;
begin
  if nullif(btrim(p_sale_id), '') is null or nullif(btrim(p_gumroad_product_id), '') is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SALE_PAYLOAD', 'reason', 'sale_id and gumroad_product_id are required.');
  end if;

  select * into v_product
  from public.products
  where gumroad_product_id = btrim(p_gumroad_product_id)
  limit 1;

  if not found or v_product.business_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'UNLINKED_GUMROAD_PRODUCT',
      'reason', format('No Nexus product is bound to gumroad_product_id "%s".', btrim(p_gumroad_product_id))
    );
  end if;

  v_tenant_id := coalesce(nullif(btrim(v_product.tenant_id), ''), v_product.owner_id::text);

  perform pg_advisory_xact_lock(hashtext('gumroad:' || btrim(p_sale_id)));

  select * into v_existing_evt
  from public.gumroad_webhook_events
  where sale_id = btrim(p_sale_id)
  for update;

  if not found then
    v_inserted_new := true;
    insert into public.gumroad_webhook_events (
      sale_id, gumroad_product_id, business_id, product_id, tenant_id, owner_id,
      product_name, buyer_name, buyer_email, amount_cents, currency, refunded, sale_created_at, received_at
    ) values (
      btrim(p_sale_id),
      btrim(p_gumroad_product_id),
      v_product.business_id,
      v_product.id,
      v_tenant_id,
      v_product.owner_id,
      coalesce(nullif(btrim(p_product_name), ''), v_product.name),
      v_buyer_name,
      v_buyer_email,
      v_amount_cents,
      v_currency,
      coalesce(p_refunded, false),
      coalesce(p_sale_created_at, v_now),
      v_now
    );
  else
    if v_existing_evt.refunded = false and coalesce(p_refunded, false) = true then
      v_transitioned_refunded := true;
    end if;

    update public.gumroad_webhook_events
    set business_id = coalesce(business_id, v_product.business_id),
        product_id = coalesce(product_id, v_product.id),
        tenant_id = coalesce(tenant_id, v_tenant_id),
        owner_id = coalesce(owner_id, v_product.owner_id),
        refunded = coalesce(p_refunded, false) or refunded
    where sale_id = btrim(p_sale_id);
  end if;

  if v_amount_cents > 0 and (v_inserted_new or v_transitioned_refunded) then
    insert into public.customers (
      owner_id, tenant_id, business_id, name, email, status, total_spend, orders_count, first_purchased_at, created_at, updated_at
    ) values (
      v_product.owner_id,
      v_tenant_id,
      v_product.business_id,
      v_buyer_name,
      v_buyer_email,
      'active',
      case when v_inserted_new and not coalesce(p_refunded, false) then round((v_amount_cents::numeric / 100.0), 2) else 0.00 end,
      case when v_inserted_new then 1 else 0 end,
      coalesce(p_sale_created_at, v_now),
      v_now,
      v_now
    )
    on conflict (business_id, lower(email)) do update
      set status = 'active',
          total_spend = case
            when v_inserted_new and not coalesce(p_refunded, false)
              then coalesce(public.customers.total_spend, 0) + round((v_amount_cents::numeric / 100.0), 2)
            when v_transitioned_refunded
              then greatest(0, coalesce(public.customers.total_spend, 0) - round((v_amount_cents::numeric / 100.0), 2))
            else public.customers.total_spend
          end,
          orders_count = case when v_inserted_new then coalesce(public.customers.orders_count, 0) + 1 else public.customers.orders_count end,
          first_purchased_at = coalesce(public.customers.first_purchased_at, coalesce(p_sale_created_at, v_now)),
          updated_at = v_now
    returning id into v_customer_id;

    insert into public.orders (
      owner_id, tenant_id, business_id, order_number, customer_id, product_id,
      amount, amount_cents, currency, payment_status, status,
      refunded_amount_cents, external_refunded, payment_method, payment_provider,
      paid_at, refunded_at, created_at, updated_at
    ) values (
      v_product.owner_id,
      v_tenant_id,
      v_product.business_id,
      v_order_number,
      v_customer_id,
      v_product.id,
      round((v_amount_cents::numeric / 100.0), 2),
      v_amount_cents,
      v_currency,
      case when coalesce(p_refunded, false) then 'refunded' else 'paid' end,
      case when coalesce(p_refunded, false) then 'refunded' else 'completed' end,
      case when coalesce(p_refunded, false) then v_amount_cents else 0 end,
      coalesce(p_refunded, false),
      'gumroad',
      'gumroad',
      coalesce(p_sale_created_at, v_now),
      case when coalesce(p_refunded, false) then v_now else null end,
      coalesce(p_sale_created_at, v_now),
      v_now
    )
    on conflict (business_id, order_number) do update
      set payment_status = case when coalesce(p_refunded, false) then 'refunded' else public.orders.payment_status end,
          status = case when coalesce(p_refunded, false) then 'refunded' else public.orders.status end,
          refunded_amount_cents = case when coalesce(p_refunded, false) then greatest(public.orders.refunded_amount_cents, v_amount_cents) else public.orders.refunded_amount_cents end,
          external_refunded = public.orders.external_refunded or coalesce(p_refunded, false),
          refunded_at = case when coalesce(p_refunded, false) then coalesce(public.orders.refunded_at, v_now) else public.orders.refunded_at end,
          updated_at = v_now
    returning id into v_order_id;

    if v_inserted_new and not coalesce(p_refunded, false) then
      update public.products
      set sales_count = coalesce(sales_count, 0) + 1,
          total_revenue = coalesce(total_revenue, 0) + round((v_amount_cents::numeric / 100.0), 2),
          updated_at = v_now
      where id = v_product.id
        and business_id = v_product.business_id;
    elsif v_transitioned_refunded then
      update public.products
      set sales_count = greatest(0, coalesce(sales_count, 0) - 1),
          total_revenue = greatest(0, coalesce(total_revenue, 0) - round((v_amount_cents::numeric / 100.0), 2)),
          updated_at = v_now
      where id = v_product.id
        and business_id = v_product.business_id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'sale_id', btrim(p_sale_id),
    'business_id', v_product.business_id,
    'product_id', v_product.id,
    'order_id', v_order_id,
    'inserted_new', v_inserted_new,
    'transitioned_refunded', v_transitioned_refunded
  );
end;
$$;

-- ------------------------------------------------------------------------------
-- 7. H2 & M4: REPLACE BLANKET APPROVALS POLICY & LOCK DOWN SIGNING KEY METADATA
-- ------------------------------------------------------------------------------
drop policy if exists "Owners process approvals" on public.approvals;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners view own approvals'
  ) then
    create policy "Owners view own approvals"
      on public.approvals for select
      to authenticated
      using (auth.uid() = owner_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners create approvals for own businesses'
  ) then
    create policy "Owners create approvals for own businesses"
      on public.approvals for insert
      to authenticated
      with check (
        auth.uid() = owner_id
        and exists (
          select 1 from public.businesses b
          where b.id = approvals.business_id
            and b.owner_id = auth.uid()
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners update own pending approvals'
  ) then
    create policy "Owners update own pending approvals"
      on public.approvals for update
      to authenticated
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners delete own approvals'
  ) then
    create policy "Owners delete own approvals"
      on public.approvals for delete
      to authenticated
      using (auth.uid() = owner_id);
  end if;
end $$;

-- M4: Prevent arbitrary authenticated users from inspecting provenance signing key metadata
drop policy if exists "Authenticated users inspect key metadata" on public.provenance_signing_keys;

-- ------------------------------------------------------------------------------
-- 8. H3: DISTRIBUTED API RATE LIMITING TABLE & ATOMIC RPC
-- ------------------------------------------------------------------------------
create table if not exists public.api_rate_limits (
  bucket text not null,
  subject_key text not null,
  window_start_ms bigint not null,
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  primary key (bucket, subject_key)
);

alter table public.api_rate_limits enable row level security;

create or replace function public.consume_api_rate_limit(
  p_bucket text,
  p_subject_key text,
  p_window_ms integer,
  p_max_requests integer,
  p_now_ms bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_now_ms bigint := coalesce(p_now_ms, floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
  v_window_ms integer := greatest(1000, coalesce(p_window_ms, 60000));
  v_max_req integer := greatest(1, coalesce(p_max_requests, 60));
  v_row public.api_rate_limits%rowtype;
  v_allowed boolean;
  v_remaining integer;
  v_retry_after_ms bigint;
begin
  if nullif(btrim(p_bucket), '') is null or nullif(btrim(p_subject_key), '') is null then
    return jsonb_build_object('allowed', false, 'remaining', 0, 'retry_after_ms', v_window_ms);
  end if;

  insert into public.api_rate_limits (
    bucket, subject_key, window_start_ms, request_count, updated_at
  ) values (
    btrim(p_bucket),
    btrim(p_subject_key),
    v_now_ms,
    1,
    timezone('utc'::text, now())
  )
  on conflict (bucket, subject_key) do update
    set window_start_ms = case
          when public.api_rate_limits.window_start_ms + v_window_ms <= v_now_ms
            then v_now_ms
          else public.api_rate_limits.window_start_ms
        end,
        request_count = case
          when public.api_rate_limits.window_start_ms + v_window_ms <= v_now_ms
            then 1
          when public.api_rate_limits.request_count <= v_max_req
            then public.api_rate_limits.request_count + 1
          else public.api_rate_limits.request_count
        end,
        updated_at = timezone('utc'::text, now())
  returning * into v_row;

  v_allowed := v_row.request_count <= v_max_req;
  v_remaining := greatest(0, v_max_req - v_row.request_count);
  v_retry_after_ms := greatest(0, (v_row.window_start_ms + v_window_ms) - v_now_ms);

  return jsonb_build_object(
    'allowed', v_allowed,
    'remaining', v_remaining,
    'retry_after_ms', v_retry_after_ms,
    'window_start_ms', v_row.window_start_ms,
    'request_count', v_row.request_count
  );
end;
$$;

-- ------------------------------------------------------------------------------
-- 9. LOCK DOWN ALL NEW SECURITY DEFINER RPCs TO service_role ONLY
-- ------------------------------------------------------------------------------
do $$
declare
  v_fn record;
  v_fn_sig text;
  v_has_anon boolean := exists (select 1 from pg_roles where rolname = 'anon');
  v_has_authenticated boolean := exists (select 1 from pg_roles where rolname = 'authenticated');
  v_has_service_role boolean := exists (select 1 from pg_roles where rolname = 'service_role');
  v_leaked text[];
begin
  for v_fn in
    select
      p.oid,
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid) as identity_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'create_or_replace_product_publish_approval',
        'revoke_product_publish_approval',
        'consume_product_publish_approval',
        'create_stripe_checkout_order_and_session',
        'settle_stripe_checkout_session',
        'mark_stripe_checkout_session_terminal',
        'sync_stripe_charge_refunded',
        'record_gumroad_sale_and_sync_order',
        'consume_api_rate_limit',
        'guard_products_authoritative_fields'
      )
  loop
    v_fn_sig := format('%I.%I(%s)', v_fn.nspname, v_fn.proname, v_fn.identity_args);
    execute format('revoke all on function %s from public', v_fn_sig);
    execute format('revoke execute on function %s from public', v_fn_sig);
    if v_has_anon then
      execute format('revoke all on function %s from anon', v_fn_sig);
      execute format('revoke execute on function %s from anon', v_fn_sig);
    end if;
    if v_has_authenticated then
      execute format('revoke all on function %s from authenticated', v_fn_sig);
      execute format('revoke execute on function %s from authenticated', v_fn_sig);
    end if;
    if v_has_service_role and v_fn.proname <> 'guard_products_authoritative_fields' then
      execute format('grant execute on function %s to service_role', v_fn_sig);
    end if;
    execute format('alter function %s set search_path = pg_catalog, public, extensions, pg_temp', v_fn_sig);
  end loop;

  select array_agg(format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)))
  into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.proname in (
      'create_or_replace_product_publish_approval',
      'revoke_product_publish_approval',
      'consume_product_publish_approval',
      'create_stripe_checkout_order_and_session',
      'settle_stripe_checkout_session',
      'mark_stripe_checkout_session_terminal',
      'sync_stripe_charge_refunded',
      'record_gumroad_sale_and_sync_order',
      'consume_api_rate_limit',
      'guard_products_authoritative_fields'
    )
    and (
      has_function_privilege('public', p.oid, 'EXECUTE')
      or (v_has_anon and has_function_privilege('anon', p.oid, 'EXECUTE'))
      or (v_has_authenticated and has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    );

  if coalesce(array_length(v_leaked, 1), 0) > 0 then
    raise exception 'Phase0-000011 migration failed; overexposed SECURITY DEFINER functions: %', v_leaked;
  end if;
end $$;
