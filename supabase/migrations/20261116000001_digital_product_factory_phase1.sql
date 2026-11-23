-- ==============================================================================
-- PHASE 1 MIGRATION: iSemaj Digital Product Factory (Additive & Idempotent)
-- Safe to rerun on existing Business OS databases OR fresh Supabase projects.
-- Target project ref: kpcliebbaveaxlnwuhgo (or linked project)
-- ==============================================================================

create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 0. ENSURE CORE DEPENDENCY TABLES EXIST IF RUNNING ON A FRESH PROJECT
-- Non-destructive: no-ops if tables/policies already exist.
-- ------------------------------------------------------------------------------
create table if not exists public.businesses (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  slug text not null unique,
  description text,
  industry text not null,
  currency text default 'USD',
  target_market text,
  website_url text,
  status text not null default 'active' check (status in ('active', 'planning', 'paused', 'archived')),
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.businesses enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'businesses'
  ) then
    create policy "Owners have full control over their businesses"
      on public.businesses for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

create table if not exists public.products (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade not null,
  name text not null,
  slug text not null,
  description text,
  type text not null check (type in ('saas', 'digital_download', 'course', 'api_service', 'template', 'newsletter')),
  price numeric(12, 2) not null default 0.00,
  billing_type text not null default 'one_time' check (billing_type in ('one_time', 'monthly', 'yearly', 'free')),
  status text not null default 'draft' check (status in ('draft', 'awaiting_approval', 'published', 'archived')),
  sales_count integer default 0,
  total_revenue numeric(14, 2) default 0.00,
  delivery_url text,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.products enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'products'
  ) then
    create policy "Owners control their products"
      on public.products for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

create table if not exists public.integrations (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade,
  provider text not null check (provider in ('stripe', 'github', 'vercel', 'sendgrid', 'resend', 'analytics', 'gemini', 'gumroad')),
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'error', 'testing')),
  settings jsonb default '{}'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.integrations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'integrations'
  ) then
    create policy "Owners configure integrations securely"
      on public.integrations for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

create table if not exists public.business_memories (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade,
  project_id uuid,
  department text default 'global',
  category text not null check (category in ('goal', 'strategy', 'decision', 'preference', 'instruction', 'product_info', 'project_status', 'financial_target', 'approval_policy')),
  importance text not null default 'medium' check (importance in ('high', 'medium', 'low')),
  title text not null,
  content text not null,
  tags text[] default '{}',
  source text not null default 'user_defined' check (source in ('conversation_extracted', 'user_defined', 'system_initialized')),
  is_pinned boolean default false,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.business_memories enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'business_memories'
  ) then
    create policy "Owners have full control over their business memories"
      on public.business_memories for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 1. EXTEND public.products WITH NULLABLE FACTORY FIELDS (NON-DESTRUCTIVE)
-- ------------------------------------------------------------------------------
alter table public.products
  add column if not exists deliverable_content text,
  add column if not exists deliverable_format text,
  add column if not exists cover_image_url text,
  add column if not exists pdf_storage_path text,
  add column if not exists gumroad_product_id text,
  add column if not exists gumroad_url text,
  add column if not exists factory_metadata jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.products'::regclass
      and c.conname = 'products_deliverable_format_check'
  ) then
    alter table public.products
      add constraint products_deliverable_format_check
      check (
        deliverable_format is null
        or deliverable_format in ('pdf_guide', 'template_pack', 'prompt_bundle', 'saas_license')
      );
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 2. CREATE public.factory_jobs TABLE TO TRACK PIPELINE EXECUTION
-- ------------------------------------------------------------------------------
create table if not exists public.factory_jobs (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade not null,
  product_id uuid references public.products(id) on delete set null,
  current_stage text not null default 'queued'
    check (
      current_stage in (
        'queued',
        'researching',
        'writing_content',
        'generating_cover',
        'building_pdf',
        'uploading_assets',
        'drafting_marketing',
        'awaiting_approval',
        'completed',
        'failed'
      )
    ),
  job_status text not null default 'pending'
    check (job_status in ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  error_message text,
  stage_logs jsonb default '[]'::jsonb,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

create index if not exists idx_factory_jobs_owner_business
  on public.factory_jobs (owner_id, business_id, created_at desc);

create index if not exists idx_factory_jobs_product
  on public.factory_jobs (product_id);

-- ------------------------------------------------------------------------------
-- 3. ADD OWNER-ISOLATED RLS POLICIES FOR public.factory_jobs
-- ------------------------------------------------------------------------------
alter table public.factory_jobs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'factory_jobs'
      and policyname = 'Owners manage their factory jobs'
  ) then
    create policy "Owners manage their factory jobs"
      on public.factory_jobs for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Keep updated_at current on factory_jobs updates
create or replace function public.set_factory_job_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

drop trigger if exists trg_factory_jobs_updated_at on public.factory_jobs;
create trigger trg_factory_jobs_updated_at
  before update on public.factory_jobs
  for each row
  execute function public.set_factory_job_updated_at();

-- ------------------------------------------------------------------------------
-- 4. EXTEND public.integrations PROVIDER CONSTRAINT TO SUPPORT 'gumroad'
-- Inspects existing constraint dynamically; keeps all existing providers/rows.
-- ------------------------------------------------------------------------------
do $$
declare
  constraint_rec record;
  has_gumroad boolean := false;
begin
  for constraint_rec in
    select c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c
    where c.conrelid = 'public.integrations'::regclass
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%provider%'
  loop
    if constraint_rec.def ilike '%gumroad%' then
      has_gumroad := true;
    else
      execute format('alter table public.integrations drop constraint %I', constraint_rec.conname);
    end if;
  end loop;

  if not has_gumroad then
    alter table public.integrations
      add constraint integrations_provider_check
      check (
        provider in (
          'stripe',
          'github',
          'vercel',
          'sendgrid',
          'resend',
          'analytics',
          'gemini',
          'gumroad'
        )
      );
  end if;
end $$;

-- ------------------------------------------------------------------------------
-- 5. CREATE PRIVATE SUPABASE STORAGE BUCKETS (product-assets, digital-deliverables)
-- ------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-assets',
  'product-assets',
  false,
  20971520,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'digital-deliverables',
  'digital-deliverables',
  false,
  52428800,
  array['application/pdf', 'text/html', 'text/markdown', 'text/plain', 'application/zip']
)
on conflict (id) do nothing;

-- ------------------------------------------------------------------------------
-- 6. CONFIGURE OWNER-ISOLATED STORAGE ACCESS POLICIES ON storage.objects
-- Required object path convention: <auth.uid()>/<business_id>/<product_id>/<file>
-- Additive policies scoped ONLY to ('product-assets', 'digital-deliverables').
-- Note: If SQL Editor role lacks ownership of storage.objects (42501),
-- this block raises a NOTICE rather than failing the table migration so you can
-- add the 4 rules via Supabase Dashboard -> Storage -> Policies.
-- ------------------------------------------------------------------------------
do $$
begin
  begin
    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname = 'Factory owners can read own files'
    ) then
      create policy "Factory owners can read own files"
        on storage.objects for select
        using (
          bucket_id in ('product-assets', 'digital-deliverables')
          and auth.role() = 'authenticated'
          and (storage.foldername(name))[1] = auth.uid()::text
        );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname = 'Factory owners can upload own files'
    ) then
      create policy "Factory owners can upload own files"
        on storage.objects for insert
        with check (
          bucket_id in ('product-assets', 'digital-deliverables')
          and auth.role() = 'authenticated'
          and (storage.foldername(name))[1] = auth.uid()::text
        );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname = 'Factory owners can update own files'
    ) then
      create policy "Factory owners can update own files"
        on storage.objects for update
        using (
          bucket_id in ('product-assets', 'digital-deliverables')
          and auth.role() = 'authenticated'
          and (storage.foldername(name))[1] = auth.uid()::text
        )
        with check (
          bucket_id in ('product-assets', 'digital-deliverables')
          and auth.role() = 'authenticated'
          and (storage.foldername(name))[1] = auth.uid()::text
        );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname = 'Factory owners can delete own files'
    ) then
      create policy "Factory owners can delete own files"
        on storage.objects for delete
        using (
          bucket_id in ('product-assets', 'digital-deliverables')
          and auth.role() = 'authenticated'
          and (storage.foldername(name))[1] = auth.uid()::text
        );
    end if;
  exception when insufficient_privilege then
    raise notice 'Skipped storage.objects policies due to role privileges (42501). Create the 4 owner-folder policies in Supabase Dashboard -> Storage -> Policies for product-assets and digital-deliverables.';
  end;
end $$;
