-- ==============================================================================
-- PHASE 1 ROLLBACK: iSemaj Digital Product Factory
-- Reverts ONLY the additive Phase 1 changes while leaving core Business OS intact.
-- ==============================================================================

-- 1. Remove Factory Storage RLS policies (scoped to factory buckets only)
drop policy if exists "Factory owners can read own files" on storage.objects;
drop policy if exists "Factory owners can upload own files" on storage.objects;
drop policy if exists "Factory owners can update own files" on storage.objects;
drop policy if exists "Factory owners can delete own files" on storage.objects;

-- 2. Delete empty buckets (will safely fail if objects still exist inside)
delete from storage.buckets
where id in ('product-assets', 'digital-deliverables');

-- 3. Restore original integrations.provider check constraint (if no gumroad rows exist)
do $$
begin
  if not exists (select 1 from public.integrations where provider = 'gumroad') then
    alter table public.integrations drop constraint if exists integrations_provider_check;
    alter table public.integrations
      add constraint integrations_provider_check
      check (provider in ('stripe', 'github', 'vercel', 'sendgrid', 'resend', 'analytics', 'gemini'));
  end if;
end $$;

-- 4. Remove factory_jobs trigger, function, RLS policy, and table
drop trigger if exists trg_factory_jobs_updated_at on public.factory_jobs;
drop function if exists public.set_factory_job_updated_at();
drop policy if exists "Owners manage their factory jobs" on public.factory_jobs;
drop table if exists public.factory_jobs;

-- 5. Remove additive factory columns from public.products
alter table public.products drop constraint if exists products_deliverable_format_check;
alter table public.products
  drop column if exists deliverable_content,
  drop column if exists deliverable_format,
  drop column if exists cover_image_url,
  drop column if exists pdf_storage_path,
  drop column if exists gumroad_product_id,
  drop column if exists gumroad_url,
  drop column if exists factory_metadata;
