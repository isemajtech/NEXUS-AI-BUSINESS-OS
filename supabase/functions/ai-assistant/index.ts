// This code runs inside a Supabase Edge Function environment (Deno runtime).
declare const Deno: any;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://ais-dev-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app',
  'https://ais-pre-vpjge6cgg3dhtybdhvckad-64801348667.us-west1.run.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

function isLocalhostOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

export function getAllowedOrigins(options?: {
  isProduction?: boolean;
  allowLocalhost?: boolean;
}): Set<string> {
  const out = new Set<string>();
  const envGet = (k: string) =>
    typeof Deno !== 'undefined' && Deno?.env?.get ? Deno.env.get(k) : undefined;
  const isProduction =
    options?.isProduction ??
    Boolean(
      envGet('DENO_DEPLOYMENT_ID') ||
        envGet('NODE_ENV') === 'production' ||
        envGet('ENVIRONMENT') === 'production'
    );
  const allowLocalhost =
    options?.allowLocalhost ?? envGet('ALLOW_LOCALHOST_ORIGINS') === 'true';

  const envRaw = envGet('ALLOWED_ORIGINS') || envGet('ALLOWED_APP_ORIGINS') || '';
  const candidates = [
    ...DEFAULT_ALLOWED_ORIGINS,
    ...(typeof envRaw === 'string'
      ? envRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        if (isProduction && !allowLocalhost && isLocalhostOrigin(parsed.origin)) {
          continue;
        }
        out.add(parsed.origin.toLowerCase());
      }
    } catch {
      // Ignore malformed origin config
    }
  }
  return out;
}

export function buildScopedCorsHeaders(
  requestOrigin: string | null,
  options?: { isProduction?: boolean; allowLocalhost?: boolean }
): {
  allowed: boolean;
  headers: Record<string, string>;
} {
  const allowedOrigins = getAllowedOrigins(options);
  const baseHeaders: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };

  if (!requestOrigin) {
    return { allowed: true, headers: baseHeaders };
  }

  let normalizedOrigin = '';
  try {
    normalizedOrigin = new URL(requestOrigin).origin.toLowerCase();
  } catch {
    return { allowed: false, headers: baseHeaders };
  }

  if (!allowedOrigins.has(normalizedOrigin)) {
    return { allowed: false, headers: baseHeaders };
  }

  return {
    allowed: true,
    headers: {
      ...baseHeaders,
      'Access-Control-Allow-Origin': new URL(requestOrigin).origin,
    },
  };
}

function sanitizeText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLen);
}

interface ChatPayload {
  message?: string;
  prompt?: string;
  text?: string;
  businessId?: string;
  business_id?: string;
  conversationId?: string;
  context?: {
    businessId?: string;
    business_id?: string;
    selectedBusiness?: string;
    totalBusinesses?: number;
    totalProjects?: number;
    totalProducts?: number;
    pendingApprovals?: number;
    memories?: Array<{
      category?: string;
      importance?: string;
      department?: string;
      title: string;
      content: string;
    }>;
  };
  department?: string;
  history?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}

async function verifyAuthenticatedSupabaseUser(
  authHeader: string | null
): Promise<{ ok: true; userId: string } | { ok: false; status: number; error: string }> {
  if (!authHeader) {
    return { ok: false, status: 401, error: 'Missing Authorization Bearer token.' };
  }
  const match = authHeader.match(/^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i);
  const token = match?.[1]?.trim();
  if (!token) {
    return { ok: false, status: 401, error: 'Malformed Authorization Bearer token.' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() || '';
  const supabaseApiKey =
    Deno.env.get('SUPABASE_ANON_KEY')?.trim() ||
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() ||
    '';

  if (!supabaseUrl || !supabaseApiKey) {
    return {
      ok: false,
      status: 503,
      error: 'Supabase authentication verification environment is not configured.',
    };
  }

  try {
    const authResp = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseApiKey,
      },
    });
    if (!authResp.ok) {
      return { ok: false, status: 401, error: 'Invalid or expired Supabase user session.' };
    }
    const userData = await authResp.json().catch(() => null);
    if (!userData?.id) {
      return { ok: false, status: 401, error: 'Authenticated Supabase user could not be verified.' };
    }
    return { ok: true, userId: String(userData.id) };
  } catch {
    return { ok: false, status: 401, error: 'Failed to validate Supabase user session.' };
  }
}

const isolateRateBuckets = new Map<string, { count: number; resetAtMs: number }>();

async function enforceEdgeRateLimit(
  userId: string
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const windowMs = 5 * 60 * 1000;
  const maxRequests = 30;
  const nowMs = Date.now();
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() || '';

  if (supabaseUrl && serviceRoleKey) {
    try {
      const rpcResp = await fetch(
        `${supabaseUrl.replace(/\/+$/, '')}/rest/v1/rpc/consume_api_rate_limit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceRoleKey}`,
            apikey: serviceRoleKey,
          },
          body: JSON.stringify({
            p_bucket: 'edge:ai-assistant',
            p_subject_key: `user:${userId}`,
            p_window_ms: windowMs,
            p_max_requests: maxRequests,
            p_now_ms: nowMs,
          }),
        }
      );
      if (rpcResp.ok) {
        const result = await rpcResp.json().catch(() => null);
        if (result && typeof result.allowed === 'boolean') {
          const retryMs = Math.max(1000, Number(result.retry_after_ms ?? windowMs));
          return {
            allowed: result.allowed,
            retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)),
          };
        }
      }
    } catch {
      // Fallback to per-isolate limiter below
    }
  }

  const key = `edge:user:${userId}`;
  const existing = isolateRateBuckets.get(key);
  if (!existing || existing.resetAtMs <= nowMs) {
    isolateRateBuckets.set(key, { count: 1, resetAtMs: nowMs + windowMs });
    return { allowed: true, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  if (existing.count >= maxRequests) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
    };
  }
  existing.count += 1;
  return {
    allowed: true,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
  };
}

async function verifyEdgeBusinessMembership(
  userId: string,
  businessId: string
): Promise<{ authorized: boolean; status: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.trim() || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.trim() || '';
  if (!supabaseUrl || !serviceRoleKey) {
    return {
      authorized: false,
      status: 503,
      error: 'Business scope verification requires server SUPABASE_SERVICE_ROLE_KEY.',
    };
  }
  const baseUrl = supabaseUrl.replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
  };

  try {
    const bizResp = await fetch(
      `${baseUrl}/rest/v1/businesses?id=eq.${encodeURIComponent(businessId)}&select=id,owner_id,status&limit=1`,
      { headers }
    );
    if (!bizResp.ok) {
      return {
        authorized: false,
        status: 503,
        error: 'Failed to verify business ownership in database.',
      };
    }
    const bizRows = await bizResp.json().catch(() => []);
    if (!Array.isArray(bizRows) || bizRows.length === 0) {
      return {
        authorized: false,
        status: 403,
        error: 'Requested business_id was not found or caller is not authorized.',
      };
    }
    const biz = bizRows[0];
    if (String(biz.status || '').toLowerCase() !== 'active') {
      return {
        authorized: false,
        status: 409,
        error: `Business is not active (status="${biz.status || 'unknown'}").`,
      };
    }
    if (biz.owner_id === userId) {
      return { authorized: true, status: 200 };
    }

    const memResp = await fetch(
      `${baseUrl}/rest/v1/business_memberships?business_id=eq.${encodeURIComponent(
        businessId
      )}&user_id=eq.${encodeURIComponent(userId)}&status=eq.active&select=id,role,status&limit=1`,
      { headers }
    );
    if (!memResp.ok) {
      return {
        authorized: false,
        status: 503,
        error: 'Failed to verify business membership in database.',
      };
    }
    const memRows = await memResp.json().catch(() => []);
    if (Array.isArray(memRows) && memRows.length > 0) {
      return { authorized: true, status: 200 };
    }

    return {
      authorized: false,
      status: 403,
      error: 'Caller is not an active owner or member of the specified business.',
    };
  } catch {
    return {
      authorized: false,
      status: 503,
      error: 'Error verifying business membership.',
    };
  }
}

function resolveGeminiKeyFromEnv(): string | null {
  const keyCandidates = [
    Deno.env.get('GEMINI_API_KEY_2'),
    Deno.env.get('GEMINI_API_KEY2'),
    Deno.env.get('API_KEY_2'),
    Deno.env.get('GEMINI_KEY_2'),
    Deno.env.get('GEMINI_API_KEY'),
    Deno.env.get('GOOGLE_API_KEY'),
  ];
  for (const val of keyCandidates) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
}

if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(async (req: Request) => {
    const cors = buildScopedCorsHeaders(req.headers.get('origin'));
    if (!cors.allowed) {
      return new Response(
        JSON.stringify({ error: 'Origin is not permitted by CORS policy.' }),
        {
          status: 403,
          headers: { ...cors.headers, 'Content-Type': 'application/json' },
        }
      );
    }

    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: cors.headers });
    }

    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
        status: 405,
        headers: { ...cors.headers, 'Content-Type': 'application/json' },
      });
    }

    const authCheck = await verifyAuthenticatedSupabaseUser(req.headers.get('authorization'));
    if (!authCheck.ok) {
      return new Response(JSON.stringify({ error: authCheck.error }), {
        status: authCheck.status,
        headers: { ...cors.headers, 'Content-Type': 'application/json' },
      });
    }

    const rateCheck = await enforceEdgeRateLimit(authCheck.userId);
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: `Rate limit exceeded. Retry in ${rateCheck.retryAfterSeconds}s.`,
          retryAfterSeconds: rateCheck.retryAfterSeconds,
        }),
        {
          status: 429,
          headers: {
            ...cors.headers,
            'Retry-After': String(rateCheck.retryAfterSeconds),
            'Content-Type': 'application/json',
          },
        }
      );
    }

    try {
      const geminiApiKey = resolveGeminiKeyFromEnv();
      if (!geminiApiKey) {
        return new Response(
          JSON.stringify({
            error: 'Gemini API key is not configured in Supabase secrets.',
            source: 'supabase_edge_function:ai-assistant',
          }),
          {
            status: 503,
            headers: { ...cors.headers, 'Content-Type': 'application/json' },
          }
        );
      }

      const rawTextBody = await req.text();
      if (rawTextBody.length > 262_144) {
        return new Response(JSON.stringify({ error: 'Request payload exceeds 256KB limit.' }), {
          status: 413,
          headers: { ...cors.headers, 'Content-Type': 'application/json' },
        });
      }

      const body: ChatPayload = JSON.parse(rawTextBody);
      const requestedBusinessId =
        sanitizeText(
          body.businessId ||
            body.business_id ||
            body.context?.businessId ||
            body.context?.business_id,
          120
        ) || '';
      if (requestedBusinessId) {
        const bizScope = await verifyEdgeBusinessMembership(
          authCheck.userId,
          requestedBusinessId
        );
        if (!bizScope.authorized) {
          return new Response(JSON.stringify({ error: bizScope.error || 'Business access denied.' }), {
            status: bizScope.status,
            headers: { ...cors.headers, 'Content-Type': 'application/json' },
          });
        }
      }

      const rawUserMessage = body.prompt ?? body.message ?? body.text ?? '';
      if (typeof rawUserMessage !== 'string') {
        return new Response(JSON.stringify({ error: '"prompt" or "message" must be a string.' }), {
          status: 400,
          headers: { ...cors.headers, 'Content-Type': 'application/json' },
        });
      }

      const userMessage = sanitizeText(rawUserMessage, 4000);
      if (!userMessage) {
        return new Response(
          JSON.stringify({ error: 'A non-empty string "prompt" or "message" is required.' }),
          {
            status: 400,
            headers: { ...cors.headers, 'Content-Type': 'application/json' },
          }
        );
      }

      let memoriesBlock = 'No specific prior memories retrieved for this scope.';
      if (
        body.context?.memories &&
        Array.isArray(body.context.memories) &&
        body.context.memories.length > 0
      ) {
        memoriesBlock = body.context.memories
          .slice(0, 20)
          .map((m: any, i: number) => {
            const category = (sanitizeText(m?.category, 40) || 'memory').toUpperCase();
            const dept = sanitizeText(m?.department, 40) || 'global';
            const impact = sanitizeText(m?.importance, 20) || 'medium';
            const title = sanitizeText(m?.title, 120) || 'Note';
            const content = sanitizeText(m?.content, 500) || '';
            return `${i + 1}. [${category} | Dept: ${dept} | Impact: ${impact}] ${title}: ${content}`;
          })
          .join('\n');
      }

      const selectedBusiness =
        sanitizeText(body.context?.selectedBusiness, 120) || 'All Portfolio Ventures';
      const totalBusinesses = Number.isFinite(Number(body.context?.totalBusinesses))
        ? Math.max(0, Math.min(1000, Math.round(Number(body.context?.totalBusinesses))))
        : 1;
      const totalProjects = Number.isFinite(Number(body.context?.totalProjects))
        ? Math.max(0, Math.min(10000, Math.round(Number(body.context?.totalProjects))))
        : 1;
      const totalProducts = Number.isFinite(Number(body.context?.totalProducts))
        ? Math.max(0, Math.min(10000, Math.round(Number(body.context?.totalProducts))))
        : 0;
      const pendingApprovals = Number.isFinite(Number(body.context?.pendingApprovals))
        ? Math.max(0, Math.min(10000, Math.round(Number(body.context?.pendingApprovals))))
        : 0;

      const systemPrompt = `You are the Central Executive AI Coordinator for "Personal AI Business OS", a sovereign business management and multi-agent coordination platform.
You oversee and coordinate 6 specialized AI departments:
1. Development & Engineering (full-stack codebase, GitHub repos, deployment checks)
2. Product Creation & Strategy (digital products, pricing tiers, PRDs, catalog releases)
3. Marketing & Growth (omni-channel acquisition, SEO positioning, email sequences)
4. Customer Support & Success (ticket resolution, onboarding, refund requests)
5. Financial Intelligence (cashflow monitoring, operating expenses, profit margins)
6. Security & RLS Governance (Row Level Security audits, tenant isolation, zero-trust rules)

STRICT EXECUTIVE GOVERNANCE DIRECTIVE:
You operate under strict owner-authorization guardrails. You CANNOT autonomously mutate or release high-impact changes without Owner Approval.
Whenever a directive involves:
- Publishing a digital product
- Deploying production code
- Sending an outbound marketing campaign
- Issuing a customer refund
- Making a purchase or capital expenditure
- Changing security settings or database RLS
You must clearly outline the action plan, specify the affected department and business, and instruct that this action requires submission to the Approval Center for Owner Sign-off.

Current Portfolio Context:
- Active Scope: ${selectedBusiness}
- Total Businesses: ${totalBusinesses}
- Total Projects: ${totalProjects}
- Total Products: ${totalProducts}
- Pending Approvals: ${pendingApprovals}

PERSISTENT BUSINESS MEMORY BANK (Verified Long-Term Memory Storage):
${memoriesBlock}

DIRECTIVE ON MEMORY CONTINUITY:
Actively utilize these verified persistent business memories to inform your decisions, maintain absolute continuity across sessions, and reference prior owner decisions or preferences accurately. NEVER invent facts inconsistent with these records.

Tone: Executive, concise, proactive, authoritative, strategic, and tech-forward. Avoid unnecessary fluff.`;

      const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
      if (body.history && Array.isArray(body.history)) {
        for (const h of body.history.slice(-10)) {
          const text = sanitizeText(h?.content, 2000);
          if (!text) continue;
          if (h.role === 'user') {
            contents.push({ role: 'user', parts: [{ text }] });
          } else if (h.role === 'assistant') {
            contents.push({ role: 'model', parts: [{ text }] });
          }
        }
      }
      contents.push({ role: 'user', parts: [{ text: userMessage }] });

      const requestPayload = {
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
        },
      };

      const modelCandidates = ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-3.8-flash'];
      let successfulData: any = null;
      let activeModelUsed = '';
      let lastErrorDetails = '';

      for (const modelName of modelCandidates) {
        let successForThisModel = false;

        for (let attempt = 1; attempt <= 3; attempt++) {
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
          try {
            const resp = await fetch(geminiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': geminiApiKey,
              },
              body: JSON.stringify(requestPayload),
            });

            if (resp.status === 200) {
              successfulData = await resp.json();
              activeModelUsed = modelName;
              successForThisModel = true;
              break;
            } else if (resp.status === 503 || resp.status === 429) {
              const errBody = await resp.json().catch(() => ({}));
              lastErrorDetails = errBody?.error?.message || `HTTP ${resp.status}`;
              if (attempt < 3) {
                const backoffMs = Math.pow(2, attempt) * 500;
                await new Promise((res) => setTimeout(res, backoffMs));
                continue;
              }
            } else {
              const errBody = await resp.json().catch(() => ({}));
              lastErrorDetails = errBody?.error?.message || `HTTP ${resp.status}`;
              break;
            }
          } catch (fetchErr: any) {
            lastErrorDetails = fetchErr?.message || 'Network fetch exception';
            if (attempt < 3) {
              await new Promise((res) => setTimeout(res, 1000));
              continue;
            }
          }
        }

        if (successForThisModel) {
          break;
        }
      }

      if (!successfulData) {
        return new Response(
          JSON.stringify({
            error: `All Gemini model fallbacks exhausted. Last error: ${lastErrorDetails}`,
            statusCode: 503,
            source: 'gemini_api_fallback_exhausted',
          }),
          {
            status: 503,
            headers: { ...cors.headers, 'Content-Type': 'application/json' },
          }
        );
      }

      const candidate = successfulData.candidates?.[0];
      const replyText =
        candidate?.content?.parts?.[0]?.text || 'Directive processed by Gemini AI Assistant.';

      return new Response(
        JSON.stringify({
          reply: replyText,
          model: activeModelUsed,
          usage: successfulData.usageMetadata,
          provider: 'gemini_via_supabase_edge_function_resilient',
        }),
        {
          status: 200,
          headers: { ...cors.headers, 'Content-Type': 'application/json' },
        }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          error: error?.message || 'An unexpected error occurred in Supabase Edge Function.',
          source: 'supabase_edge_function_exception',
        }),
        {
          status: 500,
          headers: { ...cors.headers, 'Content-Type': 'application/json' },
        }
      );
    }
  });
}
