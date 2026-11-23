import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Local storage key for Supabase credentials configured by the owner
const SUPABASE_CONFIG_KEY = 'paio_supabase_config_v1';

export interface StoredSupabaseConfig {
  projectUrl: string;
  anonKey: string;
  isConnected: boolean;
  lastCheckedAt?: string;
  errorMessage?: string;
}

export function getStoredSupabaseConfig(): StoredSupabaseConfig {
  try {
    const raw = localStorage.getItem(SUPABASE_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.projectUrl && parsed.anonKey) {
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to read Supabase config from storage', e);
  }

  // Check Vite environment variables if configured
  const envUrl = (import.meta as any).env?.VITE_SUPABASE_URL || '';
  const envKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || '';

  return {
    projectUrl: envUrl,
    anonKey: envKey,
    isConnected: !!(envUrl && envKey),
  };
}

export function saveStoredSupabaseConfig(config: StoredSupabaseConfig): void {
  try {
    localStorage.setItem(SUPABASE_CONFIG_KEY, JSON.stringify(config));
  } catch (e) {
    console.error('Failed to save Supabase config', e);
  }
  resetSupabaseClient();
}

let activeClient: SupabaseClient | null = null;
let activeClientConfigKey = '';

export function resetSupabaseClient(): void {
  activeClient = null;
  activeClientConfigKey = '';
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function extractSupabaseProjectRef(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    const hostParts = parsed.hostname.split('.');
    return hostParts[0] || null;
  } catch {
    return null;
  }
}

export function inspectSupabaseKeyAndUrl(
  url: string,
  key: string
): { valid: boolean; error?: string; projectRef?: string | null; keyRef?: string | null } {
  const cleanUrl = url.trim();
  const cleanKey = key.trim();
  const urlRef = extractSupabaseProjectRef(cleanUrl);

  if (!cleanUrl || !cleanKey) {
    return { valid: false, error: 'Both Supabase Project URL and Anon Key are required.' };
  }

  const jwt = decodeJwtPayload(cleanKey);
  if (jwt) {
    if (jwt.role === 'service_role') {
      return {
        valid: false,
        error: 'Security block: Never enter a service_role key in the browser. Use the public anon or publishable key.',
      };
    }
    const keyRef = typeof jwt.ref === 'string' ? jwt.ref : null;
    if (urlRef && keyRef && urlRef !== keyRef) {
      return {
        valid: false,
        projectRef: urlRef,
        keyRef,
        error: `Key mismatch: Project URL points to "${urlRef}", but your Anon Key belongs to "${keyRef}". Copy the Anon/Publishable key from Project Settings → API for "${urlRef}".`,
      };
    }
    return { valid: true, projectRef: urlRef, keyRef };
  }

  if (cleanKey.startsWith('sb_secret_')) {
    return {
      valid: false,
      error: 'Security block: Never enter a Supabase secret key (sb_secret_...) in the browser. Use sb_publishable_... or anon JWT.',
    };
  }

  return { valid: true, projectRef: urlRef, keyRef: null };
}

export function getSupabaseClient(): SupabaseClient | null {
  const config = getStoredSupabaseConfig();
  const cleanUrl = config.projectUrl?.trim();
  const cleanKey = config.anonKey?.trim();
  if (cleanUrl && cleanKey) {
    const configKey = `${cleanUrl}::${cleanKey}`;
    try {
      if (!activeClient || activeClientConfigKey !== configKey) {
        activeClient = createClient(cleanUrl, cleanKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
          },
        });
        activeClientConfigKey = configKey;
      }
      return activeClient;
    } catch (e) {
      console.warn('Could not initialize Supabase client:', e);
      return null;
    }
  }
  return null;
}

export interface SupabaseHealthCheckResult {
  success: boolean;
  message: string;
  authWorking: boolean;
  tablesVerified: boolean;
  existingTables: string[];
  missingTables: string[];
}

function isInvalidApiKeyError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('invalid api key') ||
    msg.includes('signature verification failed') ||
    msg.includes('jwserror') ||
    msg.includes('invalid jwt') ||
    err?.status === 401 ||
    err?.code === 'PGRST301'
  );
}

export async function checkSupabaseHealth(
  url: string,
  key: string
): Promise<SupabaseHealthCheckResult> {
  const inspection = inspectSupabaseKeyAndUrl(url, key);
  if (!inspection.valid) {
    return {
      success: false,
      message: inspection.error || 'Invalid Supabase URL or Anon Key.',
      authWorking: false,
      tablesVerified: false,
      existingTables: [],
      missingTables: [],
    };
  }

  try {
    const client = createClient(url.trim(), key.trim(), {
      auth: { persistSession: false },
    });

    // 1. Check Auth service connectivity
    let authWorking = false;
    try {
      const { error: authError } = await client.auth.getSession();
      if (!authError || authError.message.includes('Auth session missing')) {
        authWorking = true;
      } else if (isInvalidApiKeyError(authError)) {
        return {
          success: false,
          message: `API Key rejected by ${inspection.projectRef || 'Supabase'}: ${authError.message}. Verify your Anon/Publishable key matches this Project URL.`,
          authWorking: false,
          tablesVerified: false,
          existingTables: [],
          missingTables: [],
        };
      }
    } catch (authErr) {
      console.warn('Auth ping warning:', authErr);
    }

    // 2. Check existence of key tables
    const requiredTables = ['businesses', 'projects', 'products', 'approvals', 'tasks'];
    const existingTables: string[] = [];
    const missingTables: string[] = [];

    for (const tbl of requiredTables) {
      try {
        const { error } = await client.from(tbl).select('id').limit(1);
        if (!error) {
          existingTables.push(tbl);
        } else if (isInvalidApiKeyError(error)) {
          return {
            success: false,
            message: `Invalid API Key for ${inspection.projectRef || 'this project'}: "${error.message}". Replace the Anon Key with the one from Supabase Dashboard → Project Settings → API.`,
            authWorking: false,
            tablesVerified: false,
            existingTables: [],
            missingTables: [],
          };
        } else if (error.code === '42P01' || error.message?.includes('Could not find the table')) {
          missingTables.push(tbl);
        } else {
          // Exists, e.g., permission denied under RLS
          existingTables.push(tbl);
        }
      } catch {
        missingTables.push(tbl);
      }
    }

    resetSupabaseClient();

    const tablesVerified = existingTables.length > 0;
    const message = tablesVerified
      ? `Connected to Supabase (${inspection.projectRef || 'remote'}). Verified ${existingTables.length} tables.`
      : missingTables.length > 0
      ? `Connected to ${inspection.projectRef || 'Supabase'}, but SQL schema is not deployed yet. Run the migration SQL below.`
      : 'Successfully authenticated with Supabase database instance.';

    return {
      success: true,
      message,
      authWorking,
      tablesVerified,
      existingTables,
      missingTables,
    };
  } catch (err: any) {
    return {
      success: false,
      message: err?.message || 'Failed to establish connection to Supabase endpoint.',
      authWorking: false,
      tablesVerified: false,
      existingTables: [],
      missingTables: [],
    };
  }
}

export async function testSupabaseConnection(
  url: string,
  key: string
): Promise<{ success: boolean; message: string }> {
  const result = await checkSupabaseHealth(url, key);
  return { success: result.success, message: result.message };
}

export async function getCurrentSupabaseUser(): Promise<{
  id: string;
  email?: string;
} | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email };
}

export async function getSupabaseAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data, error } = await client.auth.getSession();
    if (error) return null;
    const token = data?.session?.access_token?.trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function authorizedApiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getSupabaseAccessToken();
  const headers = new Headers(init.headers || undefined);
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, {
    ...init,
    headers,
  });
}

export async function signInSupabaseOwner(
  email: string,
  password: string
): Promise<{ success: boolean; user?: { id: string; email?: string }; message: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, message: 'Connect a valid Supabase URL and Anon Key first.' };
  }
  const { data, error } = await client.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error || !data.user) {
    return { success: false, message: error?.message || 'Sign in failed.' };
  }
  return {
    success: true,
    user: { id: data.user.id, email: data.user.email },
    message: `Signed in as ${data.user.email || data.user.id}.`,
  };
}

export async function signUpSupabaseOwner(
  email: string,
  password: string
): Promise<{ success: boolean; needsEmailConfirmation?: boolean; user?: { id: string; email?: string }; message: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, message: 'Connect a valid Supabase URL and Anon Key first.' };
  }
  const { data, error } = await client.auth.signUp({
    email: email.trim(),
    password,
  });
  if (error) {
    return { success: false, message: error.message };
  }
  if (data.user && !data.session) {
    return {
      success: true,
      needsEmailConfirmation: true,
      message: 'Account created! Check your email to confirm your Supabase Auth account, then sign in.',
    };
  }
  return {
    success: true,
    user: data.user ? { id: data.user.id, email: data.user.email } : undefined,
    message: `Authenticated as ${data.user?.email || 'owner'}.`,
  };
}

export async function signOutSupabaseOwner(): Promise<void> {
  const client = getSupabaseClient();
  if (client) {
    await client.auth.signOut().catch(() => {});
  }
}

export interface EdgeFunctionResponse {
  success: boolean;
  reply?: string;
  model?: string;
  provider?: string;
  error?: string;
  instructions?: string;
}

/**
 * Invokes the Supabase Edge Function "ai-assistant" which uses the server-side GEMINI_API_KEY.
 * Never exposes the Gemini API key or secrets to the frontend.
 */
export async function invokeAIAssistantEdgeFunction(payload: {
  message?: string;
  prompt?: string;
  context?: any;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}): Promise<EdgeFunctionResponse> {
  const config = getStoredSupabaseConfig();
  if (!config.projectUrl || !config.anonKey) {
    return {
      success: false,
      error: 'Supabase project is not connected.',
      instructions:
        'Please configure your Supabase Project URL and Public Anon Key in Settings or click "Connect Supabase" in the header.',
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    return {
      success: false,
      error: 'Supabase client could not be initialized.',
    };
  }

  try {
    const userText = (payload.prompt || payload.message || '').trim();
    const requestBody = {
      ...payload,
      prompt: userText,
      message: userText,
    };

    const { data, error } = await client.functions.invoke('ai-assistant', {
      body: requestBody,
    });

    if (error) {
      let errorMsg = error.message;
      let instructions: string | undefined;

      try {
        if ((error as any).context) {
          const ctx = (error as any).context;
          if (typeof ctx.clone === 'function') {
            const cloned = ctx.clone();
            const jsonErr = await cloned.json().catch(async () => {
              const text = await ctx.clone().text().catch(() => null);
              return text ? { error: text } : null;
            });
            if (jsonErr?.error) errorMsg = jsonErr.error;
            if (jsonErr?.instructions) instructions = jsonErr.instructions;
          } else if (typeof ctx.json === 'function') {
            const jsonErr = await ctx.json().catch(() => null);
            if (jsonErr?.error) errorMsg = jsonErr.error;
            if (jsonErr?.instructions) instructions = jsonErr.instructions;
          }
        }
      } catch (e) {
        // use error.message
      }

      if (
        errorMsg.includes('Failed to send a request') ||
        errorMsg.includes('relay error') ||
        errorMsg.includes('404') ||
        errorMsg.includes('not found') ||
        errorMsg.includes('Non-2xx') ||
        errorMsg.includes('FunctionsFetchError')
      ) {
        instructions =
          'The "ai-assistant" Edge Function is not yet deployed to your connected Supabase project. Run `supabase functions deploy ai-assistant` from your project terminal.';
      } else if (errorMsg.includes('GEMINI_API_KEY') || errorMsg.includes('API_KEY')) {
        instructions =
          'The Gemini API key secret is missing in your Supabase project. Set it using: `supabase secrets set GEMINI_API_KEY_2="AIza..."` or `supabase secrets set GEMINI_API_KEY="AIza..."` in Supabase CLI or Dashboard.';
      }

      return {
        success: false,
        error: errorMsg,
        instructions,
      };
    }

    if (data?.error) {
      return {
        success: false,
        error: data.error,
        instructions: data.instructions,
      };
    }

    return {
      success: true,
      reply: data?.reply || 'Directive processed by Gemini AI Assistant.',
      model: data?.model || 'gemini-2.5-flash',
      provider: data?.provider || 'gemini_via_supabase',
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Failed to communicate with Supabase Edge Function "ai-assistant".',
      instructions:
        'Check network connectivity and ensure the "ai-assistant" Edge Function is deployed on your Supabase instance.',
    };
  }
}

/**
 * Production-ready PostgreSQL & Supabase DDL Schema with Row Level Security (RLS)
 * Covers all requested tables:
 * - businesses
 * - projects
 * - agents
 * - tasks
 * - conversations
 * - products
 * - customers
 * - orders
 * - subscriptions
 * - integrations
 * - approvals
 * - activity_logs
 * - usage_records
 */
export const SUPABASE_SQL_SCHEMA = `-- ==============================================================================
-- PERSONAL AI BUSINESS OS - SUPABASE RELATIONAL SCHEMA & RLS SECURITY POLICIES
-- Multi-Business, Multi-Agent Autonomous Business Operating System
-- ==============================================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. BUSINESSES TABLE
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

-- 2. PROJECTS TABLE (Websites & Apps Registry)
create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade not null,
  name text not null,
  description text,
  website_url text,
  github_url text,
  tech_stack text[] default '{}',
  deployment_status text not null default 'draft' check (deployment_status in ('live', 'staging', 'in_progress', 'degraded', 'down', 'draft')),
  notes text,
  last_checked_date timestamptz,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

-- 3. AGENTS TABLE (AI Workforce Departments)
create table if not exists public.agents (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  department text not null check (department in ('development', 'product_creation', 'marketing', 'customer_support', 'finance', 'security')),
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'idle', 'paused')),
  system_instructions text not null,
  autonomy_level text not null default 'strict_approval' check (autonomy_level in ('strict_approval', 'semi_autonomous', 'read_only')),
  permissions jsonb default '{"canDeployCode": false, "canPublishProducts": false, "canSendMarketing": false, "canIssueRefunds": false, "canRecordExpenses": false, "canModifySecurity": false}'::jsonb,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

-- 4. TASKS TABLE (Agent Task Queue)
create table if not exists public.tasks (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete set null,
  department text not null,
  title text not null,
  description text,
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'awaiting_approval', 'completed', 'rejected', 'failed')),
  assigned_agent text,
  approval_request_id uuid,
  result_payload jsonb,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  completed_at timestamptz
);

-- 5. CONVERSATIONS TABLE (AI Assistant Threads)
create table if not exists public.conversations (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete set null,
  title text not null,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

create table if not exists public.messages (
  id uuid primary key default uuid_generate_v4(),
  conversation_id uuid references public.conversations(id) on delete cascade not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  metadata jsonb,
  created_at timestamptz default timezone('utc'::text, now()) not null
);

-- 6. PRODUCTS TABLE (Digital Products & Services)
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
  deliverable_content text,
  deliverable_format text check (deliverable_format is null or deliverable_format in ('pdf_guide', 'template_pack', 'prompt_bundle', 'saas_license')),
  cover_image_url text,
  pdf_storage_path text,
  gumroad_product_id text,
  gumroad_url text,
  factory_metadata jsonb,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

-- 7. CUSTOMERS TABLE
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

create unique index if not exists uq_customers_business_email
  on public.customers (business_id, lower(email));

-- 8. ORDERS TABLE
create table if not exists public.orders (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  tenant_id text,
  order_number text not null,
  business_id uuid references public.businesses(id) on delete cascade not null,
  customer_id uuid references public.customers(id) on delete restrict not null,
  product_id uuid references public.products(id) on delete restrict not null,
  amount numeric(12, 2) not null default 0.00,
  amount_cents integer,
  currency text not null default 'USD',
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'pending', 'authorized', 'paid', 'settled', 'partially_refunded', 'refunded', 'failed', 'disputed', 'cancelled')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'refunded', 'disputed', 'cancelled')),
  refunded_amount_cents integer not null default 0 check (refunded_amount_cents >= 0),
  external_refunded boolean not null default false,
  payment_method text not null default 'stripe',
  refund_reason text,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null,
  unique (business_id, order_number)
);

-- 9. SUBSCRIPTIONS TABLE
create table if not exists public.subscriptions (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade not null,
  customer_id uuid references public.customers(id) on delete cascade not null,
  product_id uuid references public.products(id) on delete cascade not null,
  external_subscription_id text,
  status text not null check (status in ('active', 'past_due', 'canceled', 'trialing')),
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  created_at timestamptz default timezone('utc'::text, now()) not null
);

-- 10. INTEGRATIONS TABLE (API Gateways & External Services)
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

-- 11. APPROVALS TABLE (Executive Owner Approval Workflow)
create table if not exists public.approvals (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade not null,
  type text not null check (type in (
    'publish_product',
    'deploy_production_code',
    'send_marketing_campaign',
    'issue_refund',
    'make_purchase',
    'change_security_settings'
  )),
  title text not null,
  description text not null,
  requested_by_department text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  urgency text not null default 'standard' check (urgency in ('routine', 'standard', 'high', 'critical')),
  payload_data jsonb default '{}'::jsonb,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz default timezone('utc'::text, now()) not null
);

-- 12. ACTIVITY_LOGS TABLE (Immutable OS Audit Trail)
create table if not exists public.activity_logs (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete set null,
  actor text not null,
  actor_type text not null check (actor_type in ('owner', 'ai_workforce', 'system')),
  action text not null,
  details text not null,
  severity text not null default 'info' check (severity in ('info', 'success', 'warning', 'critical')),
  created_at timestamptz default timezone('utc'::text, now()) not null
);

-- 13. USAGE_RECORDS TABLE (AI Tokens, compute & API quota tracking)
create table if not exists public.usage_records (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete set null,
  department text not null,
  model_name text not null,
  prompt_tokens integer default 0,
  completion_tokens integer default 0,
  estimated_cost numeric(10, 6) default 0.000000,
  created_at timestamptz default timezone('utc'::text, now()) not null
);

-- ==============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- Enforce strict owner isolation across every single business and record
-- ==============================================================================

alter table public.businesses enable row level security;
alter table public.projects enable row level security;
alter table public.agents enable row level security;
alter table public.tasks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.orders enable row level security;
alter table public.subscriptions enable row level security;
alter table public.integrations enable row level security;
alter table public.approvals enable row level security;
alter table public.activity_logs enable row level security;
alter table public.usage_records enable row level security;

-- Policies for Businesses
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'businesses' and policyname = 'Owners have full control over their businesses') then
    create policy "Owners have full control over their businesses"
      on public.businesses for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Projects
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'projects' and policyname = 'Owners have full control over their projects') then
    create policy "Owners have full control over their projects"
      on public.projects for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Agents
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agents' and policyname = 'Owners manage their AI agent workforce') then
    create policy "Owners manage their AI agent workforce"
      on public.agents for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Tasks
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tasks' and policyname = 'Owners manage tasks') then
    create policy "Owners manage tasks"
      on public.tasks for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Conversations
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversations' and policyname = 'Owners access their conversations') then
    create policy "Owners access their conversations"
      on public.conversations for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Messages
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'Owners access messages belonging to their conversations') then
    create policy "Owners access messages belonging to their conversations"
      on public.messages for all
      using (
        exists (
          select 1 from public.conversations c
          where c.id = messages.conversation_id
          and c.owner_id = auth.uid()
        )
      );
  end if;
end $$;

-- Policies for Products
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'products' and policyname = 'Owners control their products') then
    create policy "Owners control their products"
      on public.products for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Customers (tenant & active-member scoped select, owner-only mutations)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'Authorized business owners and members view customers') then
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
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'Owners insert customers for own businesses') then
    create policy "Owners insert customers for own businesses"
      on public.customers for insert
      to authenticated
      with check (
        auth.uid() = owner_id
        and exists (
          select 1 from public.businesses b
          where b.id = customers.business_id and b.owner_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'Owners update customers for own businesses') then
    create policy "Owners update customers for own businesses"
      on public.customers for update
      to authenticated
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'Owners delete customers for own businesses') then
    create policy "Owners delete customers for own businesses"
      on public.customers for delete
      to authenticated
      using (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Orders (authoritative financial state is server/service_role managed)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'orders' and policyname = 'Authorized business owners and active members view orders') then
    create policy "Authorized business owners and active members view orders"
      on public.orders for select
      to authenticated
      using (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Subscriptions
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'subscriptions' and policyname = 'Owners manage subscriptions') then
    create policy "Owners manage subscriptions"
      on public.subscriptions for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Integrations
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'integrations' and policyname = 'Owners configure integrations securely') then
    create policy "Owners configure integrations securely"
      on public.integrations for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Approvals (granular policies; pending tickets only for client mutations, never issue_refund tamper)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners view own approvals') then
    create policy "Owners view own approvals"
      on public.approvals for select
      to authenticated
      using (auth.uid() = owner_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners create own pending approvals') then
    create policy "Owners create own pending approvals"
      on public.approvals for insert
      to authenticated
      with check (
        auth.uid() = owner_id
        and status = 'pending'
        and exists (
          select 1 from public.businesses b
          where b.id = approvals.business_id and b.owner_id = auth.uid()
        )
      );
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners update pending non-financial approvals') then
    create policy "Owners update pending non-financial approvals"
      on public.approvals for update
      to authenticated
      using (auth.uid() = owner_id and status = 'pending' and type <> 'issue_refund')
      with check (auth.uid() = owner_id and type <> 'issue_refund');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'approvals' and policyname = 'Owners delete pending approvals') then
    create policy "Owners delete pending approvals"
      on public.approvals for delete
      to authenticated
      using (auth.uid() = owner_id and status = 'pending');
  end if;
end $$;

-- Policies for Activity Logs
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_logs' and policyname = 'Owners view their activity audit log') then
    create policy "Owners view their activity audit log"
      on public.activity_logs for select
      using (auth.uid() = owner_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_logs' and policyname = 'System and owners insert activity logs') then
    create policy "System and owners insert activity logs"
      on public.activity_logs for insert
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- Policies for Usage Records
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'usage_records' and policyname = 'Owners view their AI usage telemetry') then
    create policy "Owners view their AI usage telemetry"
      on public.usage_records for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- 14. BUSINESS_MEMORIES TABLE & RLS POLICIES
create table if not exists public.business_memories (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
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

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_memories' and policyname = 'Owners have full control over their business memories') then
    create policy "Owners have full control over their business memories"
      on public.business_memories for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;

-- 15. FACTORY_JOBS TABLE & RLS POLICIES (Digital Product Factory)
create table if not exists public.factory_jobs (
  id uuid primary key default uuid_generate_v4(),
  owner_id uuid references auth.users(id) on delete cascade default auth.uid(),
  business_id uuid references public.businesses(id) on delete cascade not null,
  product_id uuid references public.products(id) on delete set null,
  current_stage text not null default 'queued' check (current_stage in ('queued', 'researching', 'writing_content', 'generating_cover', 'building_pdf', 'uploading_assets', 'drafting_marketing', 'awaiting_approval', 'completed', 'failed')),
  job_status text not null default 'pending' check (job_status in ('pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  error_message text,
  stage_logs jsonb default '[]'::jsonb,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

alter table public.factory_jobs enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'factory_jobs' and policyname = 'Owners manage their factory jobs') then
    create policy "Owners manage their factory jobs"
      on public.factory_jobs for all
      using (auth.uid() = owner_id)
      with check (auth.uid() = owner_id);
  end if;
end $$;
`;

/**
 * Idempotent Phase 1 Additive Migration SQL (mirrors supabase/migrations/20261116000001_digital_product_factory_phase1.sql)
 */
export const PHASE1_FACTORY_MIGRATION_SQL = `-- ==============================================================================
-- PHASE 1 MIGRATION: iSemaj Digital Product Factory (Additive & Idempotent)
-- Safe to rerun on existing Business OS databases OR fresh Supabase projects.
-- ==============================================================================

create extension if not exists "uuid-ossp";

-- 0. Ensure core dependency tables exist if running on a fresh project
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

-- 1. Extend public.products with nullable factory fields (non-destructive)
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

-- 2. Create public.factory_jobs table to track pipeline execution
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

-- 3. Add owner-isolated RLS policies for public.factory_jobs
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

-- 4. Extend public.integrations provider check constraint safely to support 'gumroad'
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

-- 5. Create private Supabase Storage buckets
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

-- 6. Owner-isolated storage RLS policies (path: <auth.uid()>/<business_id>/<product_id>/<file>)
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
`;

export const PHASE1_FACTORY_ROLLBACK_SQL = `-- ==============================================================================
-- PHASE 1 ROLLBACK: iSemaj Digital Product Factory
-- Reverts ONLY additive Phase 1 changes while leaving core Business OS intact.
-- ==============================================================================

drop policy if exists "Factory owners can read own files" on storage.objects;
drop policy if exists "Factory owners can upload own files" on storage.objects;
drop policy if exists "Factory owners can update own files" on storage.objects;
drop policy if exists "Factory owners can delete own files" on storage.objects;

delete from storage.buckets
where id in ('product-assets', 'digital-deliverables');

do $$
begin
  if not exists (select 1 from public.integrations where provider = 'gumroad') then
    alter table public.integrations drop constraint if exists integrations_provider_check;
    alter table public.integrations
      add constraint integrations_provider_check
      check (provider in ('stripe', 'github', 'vercel', 'sendgrid', 'resend', 'analytics', 'gemini'));
  end if;
end $$;

drop trigger if exists trg_factory_jobs_updated_at on public.factory_jobs;
drop function if exists public.set_factory_job_updated_at();
drop policy if exists "Owners manage their factory jobs" on public.factory_jobs;
drop table if exists public.factory_jobs;

alter table public.products drop constraint if exists products_deliverable_format_check;
alter table public.products
  drop column if exists deliverable_content,
  drop column if exists deliverable_format,
  drop column if exists cover_image_url,
  drop column if exists pdf_storage_path,
  drop column if exists gumroad_product_id,
  drop column if exists gumroad_url,
  drop column if exists factory_metadata;
`;

export const FACTORY_STORAGE_BUCKETS = {
  ASSETS: 'product-assets',
  DELIVERABLES: 'digital-deliverables',
} as const;

/**
 * Enforces owner-isolated storage object paths: <ownerId>/<businessId>/<productId>/<filename>
 */
export function buildOwnerStoragePath(
  ownerId: string,
  businessId: string,
  productId: string,
  filename: string
): string {
  const safeSegment = (val: string) =>
    val
      .trim()
      .replace(/\.{2,}/g, '.')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default';
  return `${safeSegment(ownerId)}/${safeSegment(businessId)}/${safeSegment(productId)}/${safeSegment(filename)}`;
}

export async function uploadOwnerStorageAsset(
  bucket: (typeof FACTORY_STORAGE_BUCKETS)[keyof typeof FACTORY_STORAGE_BUCKETS],
  businessId: string,
  productId: string,
  filename: string,
  fileData: Blob | ArrayBuffer | File,
  contentType: string
): Promise<{ success: boolean; path?: string; error?: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  const { data: userData, error: authErr } = await client.auth.getUser();
  if (authErr || !userData?.user?.id) {
    return {
      success: false,
      error: 'Authenticated Supabase user session is required to upload owner-scoped assets.',
    };
  }

  const objectPath = buildOwnerStoragePath(userData.user.id, businessId, productId, filename);
  const { error } = await client.storage.from(bucket).upload(objectPath, fileData, {
    contentType,
    upsert: true,
  });

  if (error) {
    return { success: false, error: error.message };
  }
  return { success: true, path: objectPath };
}

export async function createSignedFactoryUrl(
  bucket: (typeof FACTORY_STORAGE_BUCKETS)[keyof typeof FACTORY_STORAGE_BUCKETS],
  storagePath: string,
  expiresInSeconds = 3600
): Promise<{ success: boolean; url?: string; error?: string }> {
  const client = getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase client is not configured.' };
  }

  const { data, error } = await client.storage
    .from(bucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    return { success: false, error: error?.message || 'Could not generate signed URL.' };
  }
  return { success: true, url: data.signedUrl };
}

export interface Phase1CheckItem {
  name: string;
  passed: boolean;
  details: string;
}

export interface Phase1VerificationResult {
  connected: boolean;
  authenticatedUserId: string | null;
  checks: Phase1CheckItem[];
  allPassed: boolean;
}

/**
 * Verifies Phase 1 Digital Product Factory tables, nullable columns, business_memories preservation,
 * and private owner-isolated storage bucket access against the connected Supabase instance.
 */
export async function verifyPhase1Infrastructure(): Promise<Phase1VerificationResult> {
  const cfg = getStoredSupabaseConfig();
  const inspection = inspectSupabaseKeyAndUrl(cfg.projectUrl, cfg.anonKey);
  if (!inspection.valid) {
    return {
      connected: false,
      authenticatedUserId: null,
      checks: [
        {
          name: 'Supabase URL & Key Match',
          passed: false,
          details: inspection.error || 'Invalid Supabase URL or Anon Key.',
        },
      ],
      allPassed: false,
    };
  }

  const client = getSupabaseClient();
  if (!client) {
    return {
      connected: false,
      authenticatedUserId: null,
      checks: [
        {
          name: 'Supabase Client',
          passed: false,
          details: 'Not connected. Configure Supabase Project URL and Anon Key first.',
        },
      ],
      allPassed: false,
    };
  }

  const checks: Phase1CheckItem[] = [];
  const { data: authData } = await client.auth.getUser();
  const userId = authData?.user?.id || null;

  checks.push({
    name: 'Authenticated Session',
    passed: Boolean(userId),
    details: userId
      ? `Authenticated as owner ${userId.slice(0, 8)}... (RLS active)`
      : 'No active Supabase Auth session. Sign in below using Supabase Owner Auth to verify owner-scoped RLS & buckets.',
  });

  // 1. Check extended public.products columns
  const { error: prodColErr } = await client
    .from('products')
    .select(
      'id, deliverable_content, deliverable_format, cover_image_url, pdf_storage_path, gumroad_product_id, gumroad_url, factory_metadata'
    )
    .limit(1);

  checks.push({
    name: 'public.products Factory Columns',
    passed: !prodColErr,
    details: prodColErr
      ? prodColErr.message
      : 'All 7 nullable factory columns are present and queryable.',
  });

  // 2. Check public.factory_jobs table + RLS
  const { error: jobsErr } = await client
    .from('factory_jobs')
    .select('id, owner_id, business_id, product_id, current_stage, job_status, progress, error_message, created_at, updated_at')
    .limit(1);

  checks.push({
    name: 'public.factory_jobs Table & RLS',
    passed: !jobsErr,
    details: jobsErr
      ? jobsErr.message
      : 'factory_jobs table exists and passes owner-scoped SELECT under RLS.',
  });

  // 3. Verify existing business_memories table remains intact
  const { error: memErr } = await client
    .from('business_memories')
    .select('id')
    .limit(1);

  checks.push({
    name: 'Existing business_memories Intact',
    passed: !memErr,
    details: memErr
      ? memErr.message
      : 'business_memories table remains intact and accessible.',
  });

  // 4. Verify private storage buckets & owner isolation
  for (const bucket of [FACTORY_STORAGE_BUCKETS.ASSETS, FACTORY_STORAGE_BUCKETS.DELIVERABLES]) {
    const prefix = userId || 'anonymous-probe';
    const { data: ownList, error: ownErr } = await client.storage.from(bucket).list(prefix, { limit: 1 });
    const { data: foreignList } = await client.storage
      .from(bucket)
      .list('00000000-0000-0000-0000-000000000000', { limit: 1 });

    const foreignIsolated = !foreignList || foreignList.length === 0;
    checks.push({
      name: `Storage Bucket: ${bucket}`,
      passed: !ownErr && foreignIsolated,
      details: ownErr
        ? ownErr.message
        : `Bucket reachable (${ownList?.length ?? 0} root entries checked); cross-owner path probe isolated.`,
    });
  }

  const allPassed = checks.every((c) => c.passed);
  return {
    connected: true,
    authenticatedUserId: userId,
    checks,
    allPassed,
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function upsertFactoryJobToSupabase(job: {
  id: string;
  businessId: string;
  productId?: string | null;
  currentStage: string;
  jobStatus: string;
  progress: number;
  errorMessage?: string | null;
  stageLogs?: Array<{ stage: string; timestamp: string; message: string }>;
}): Promise<boolean> {
  // Supabase schema defines uuid foreign keys on factory_jobs; skip remote sync for local string IDs
  if (!UUID_REGEX.test(job.id) || !UUID_REGEX.test(job.businessId)) {
    return false;
  }

  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { data: userData } = await client.auth.getUser();
    if (!userData?.user?.id) return false;

    const payload = {
      id: job.id,
      owner_id: userData.user.id,
      business_id: job.businessId,
      product_id: job.productId && UUID_REGEX.test(job.productId) ? job.productId : null,
      current_stage: job.currentStage,
      job_status: job.jobStatus,
      progress: Math.max(0, Math.min(100, Math.round(job.progress))),
      error_message: job.errorMessage || null,
      stage_logs: job.stageLogs || [],
    };

    const { error } = await client.from('factory_jobs').upsert(payload);
    return !error;
  } catch {
    return false;
  }
}

export interface SupabaseProductGumroadRow {
  id: string;
  name: string;
  gumroad_product_id: string | null;
  gumroad_url: string | null;
  sales_count: number | null;
  total_revenue: number | null;
}

export async function fetchProductsGumroadFieldsFromSupabase(): Promise<{
  connected: boolean;
  authenticated: boolean;
  rows: SupabaseProductGumroadRow[];
  error?: string;
}> {
  const client = getSupabaseClient();
  if (!client) {
    return { connected: false, authenticated: false, rows: [] };
  }

  try {
    const { data: userData } = await client.auth.getUser();
    if (!userData?.user?.id) {
      return { connected: true, authenticated: false, rows: [] };
    }

    const { data, error } = await client
      .from('products')
      .select('id, name, gumroad_product_id, gumroad_url, sales_count, total_revenue');

    if (error) {
      return { connected: true, authenticated: true, rows: [], error: error.message };
    }

    return {
      connected: true,
      authenticated: true,
      rows: (data || []) as SupabaseProductGumroadRow[],
    };
  } catch (err: any) {
    return {
      connected: true,
      authenticated: false,
      rows: [],
      error: err?.message || 'Supabase products lookup failed.',
    };
  }
}

export async function syncProductGumroadFieldsToSupabase(input: {
  productId: string;
  gumroadProductId?: string;
  gumroadUrl?: string;
  salesCount?: number;
  totalRevenue?: number;
}): Promise<boolean> {
  if (!UUID_REGEX.test(input.productId)) {
    return false;
  }

  const client = getSupabaseClient();
  if (!client) return false;

  try {
    const { data: userData } = await client.auth.getUser();
    if (!userData?.user?.id) return false;

    const patch: Record<string, any> = {};
    if (input.gumroadProductId !== undefined) {
      patch.gumroad_product_id = input.gumroadProductId || null;
    }
    if (input.gumroadUrl !== undefined) {
      patch.gumroad_url = input.gumroadUrl || null;
    }
    if (input.salesCount !== undefined) {
      patch.sales_count = input.salesCount;
    }
    if (input.totalRevenue !== undefined) {
      patch.total_revenue = input.totalRevenue;
    }
    if (Object.keys(patch).length === 0) return true;

    const { error } = await client
      .from('products')
      .update(patch)
      .eq('id', input.productId)
      .eq('owner_id', userData.user.id);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Supabase Data Sync Helpers for Business Memories
 */
export async function fetchBusinessMemoriesFromSupabase(): Promise<any[] | null> {
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from('business_memories')
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) {
      console.warn('Could not fetch business_memories from Supabase:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

export async function saveBusinessMemoryToSupabase(memory: any): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    const dbPayload = {
      id: memory.id,
      business_id: memory.businessId || null,
      project_id: memory.projectId || null,
      department: memory.department || 'global',
      category: memory.category,
      importance: memory.importance || 'medium',
      title: memory.title,
      content: memory.content,
      tags: memory.tags || [],
      source: memory.source || 'user_defined',
      is_pinned: !!memory.isPinned,
      updated_at: new Date().toISOString(),
    };
    const { error } = await client.from('business_memories').upsert(dbPayload);
    if (error) {
      console.warn('Could not save business_memory to Supabase:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

export async function deleteBusinessMemoryFromSupabase(id: string): Promise<boolean> {
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    const { error } = await client.from('business_memories').delete().eq('id', id);
    return !error;
  } catch (e) {
    return false;
  }
}
