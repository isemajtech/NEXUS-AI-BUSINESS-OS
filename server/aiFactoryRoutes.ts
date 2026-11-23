import { Router, type Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import {
  type GovernanceCallerIdentity,
  type AuthenticatedGovernanceRequest,
  type GovernanceAuthVerifier,
  createSupabaseGovernanceAuthFromEnv,
  isCallerAuthorizedForScope,
  requireAuthenticatedCaller,
  requireGovernancePermission,
  validateCallerHasScope,
} from './governanceAuth';
import {
  createSupabaseAuthoritativeOrderStoreFromEnv,
  type AuthoritativeOrderStore,
} from './orderStore';
import {
  SlidingFixedWindowRateLimiter,
  createRateLimitMiddleware,
  type RateLimiterBackend,
  type RateLimitRule,
} from './rateLimiter';
import { buildProductPdfBuffer, generateProductCoverSvg } from './factoryAssets';
import {
  generateProductLaunchKit,
  researchMarketOpportunity,
} from './factoryOrchestrator';

export const ALLOWED_GEMINI_MODELS = new Set<string>([
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
]);

const ALLOWED_PRODUCT_TYPES = new Set<string>([
  'saas',
  'digital_download',
  'course',
  'api_service',
  'template',
  'newsletter',
]);

const ALLOWED_BILLING_TYPES = new Set<string>([
  'one_time',
  'monthly',
  'yearly',
  'free',
]);

const ALLOWED_DELIVERABLE_FORMATS = new Set<string>([
  'pdf_guide',
  'template_pack',
  'prompt_bundle',
  'saas_license',
]);

export interface GeminiKeyInfo {
  key: string;
  source: string;
  masked: string;
}

export function resolveServerGeminiKeyInfo(
  env: NodeJS.ProcessEnv = process.env
): GeminiKeyInfo | null {
  const candidates: Array<{ name: string; val: string | undefined }> = [
    { name: 'GEMINI_API_KEY_2', val: env.GEMINI_API_KEY_2 },
    { name: 'GEMINI_API_KEY2', val: env.GEMINI_API_KEY2 },
    { name: 'API_KEY_2', val: env.API_KEY_2 },
    { name: 'GEMINI_KEY_2', val: env.GEMINI_KEY_2 },
    { name: 'GEMINI_API_KEY', val: env.GEMINI_API_KEY },
    { name: 'GOOGLE_API_KEY', val: env.GOOGLE_API_KEY },
    { name: 'GOOGLE_GENAI_API_KEY', val: env.GOOGLE_GENAI_API_KEY },
  ];

  for (const c of candidates) {
    if (c.val && c.val.trim().length > 0) {
      const trimmed = c.val.trim();
      const masked = trimmed.length > 8 ? `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}` : '****';
      return { key: trimmed, source: c.name, masked };
    }
  }
  return null;
}

export function sanitizeUntrustedText(raw: unknown, maxLength: number): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

export interface AiFactoryRouterDeps {
  getAuthVerifier?: () => GovernanceAuthVerifier;
  getOrderStore?: () => AuthoritativeOrderStore;
  getGeminiKeyInfo?: () => GeminiKeyInfo | null;
  limiter?: RateLimiterBackend;
  rateLimits?: Partial<{
    testGemini: RateLimitRule;
    coordinator: RateLimitRule;
    generateProduct: RateLimitRule;
    factory: RateLimitRule;
  }>;
  fetchFn?: typeof fetch;
  generateGeminiText?: (input: {
    apiKey: string;
    model: string;
    prompt: string;
    responseMimeType?: string;
  }) => Promise<{ text: string; model: string }>;
}

async function verifyAiCallerBusinessScope(input: {
  caller: GovernanceCallerIdentity | undefined;
  body: Record<string, any>;
  orderStore: AuthoritativeOrderStore;
  res: Response;
}): Promise<boolean> {
  const { caller, body, orderStore, res } = input;
  if (!caller) {
    res.status(401).json({
      success: false,
      code: 'AUTHENTICATION_REQUIRED',
      error: 'Caller identity could not be verified.',
    });
    return false;
  }

  const rawBusinessId =
    typeof body.businessId === 'string' && body.businessId.trim()
      ? body.businessId.trim()
      : typeof body.business_id === 'string' && body.business_id.trim()
      ? body.business_id.trim()
      : typeof body.context?.businessId === 'string' && body.context.businessId.trim()
      ? body.context.businessId.trim()
      : typeof body.context?.business_id === 'string' && body.context.business_id.trim()
      ? body.context.business_id.trim()
      : '';

  if (rawBusinessId) {
    if (orderStore.configured && orderStore.verifyCallerBusinessAccess) {
      const access = await orderStore.verifyCallerBusinessAccess({
        businessId: rawBusinessId,
        caller,
      });
      if (!access.authorized) {
        res.status(403).json({
          success: false,
          code: 'BUSINESS_SCOPE_DENIED',
          error: access.reason || 'Caller is not authorized for this business_id.',
        });
        return false;
      }
      return true;
    }

    const scopeCheck = isCallerAuthorizedForScope(caller, {
      businessId: rawBusinessId,
      requireStoredTenantOrOwnerScope: false,
    });
    if (!scopeCheck.authorized) {
      res.status(403).json({
        success: false,
        code: 'BUSINESS_SCOPE_DENIED',
        error: scopeCheck.reason || 'Caller is not authorized for this business_id.',
      });
      return false;
    }
    return true;
  }

  const hasTokenScope = validateCallerHasScope(caller).authorized;
  if (hasTokenScope) {
    return true;
  }

  if (orderStore.configured && orderStore.listAuthorizedBusinessesForCaller) {
    const memberships = await orderStore.listAuthorizedBusinessesForCaller(caller);
    if (memberships.length > 0) {
      return true;
    }
  }

  res.status(403).json({
    success: false,
    code: 'CALLER_SCOPE_MISSING',
    error: 'Caller lacks verifiable tenant, owner, or active business scope.',
  });
  return false;
}

async function defaultGenerateGeminiText(input: {
  apiKey: string;
  model: string;
  prompt: string;
  responseMimeType?: string;
}): Promise<{ text: string; model: string }> {
  const client = new GoogleGenAI({
    apiKey: input.apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
  const resp = await client.models.generateContent({
    model: input.model,
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
    ...(input.responseMimeType
      ? { config: { responseMimeType: input.responseMimeType } }
      : {}),
  });
  return { text: resp?.text || '', model: input.model };
}

export function createAiFactoryRouter(deps: AiFactoryRouterDeps = {}): Router {
  const router = Router();
  const getAuthVerifier =
    deps.getAuthVerifier ?? (() => createSupabaseGovernanceAuthFromEnv());
  const getOrderStore =
    deps.getOrderStore ?? (() => createSupabaseAuthoritativeOrderStoreFromEnv());
  const getGeminiKeyInfo =
    deps.getGeminiKeyInfo ?? (() => resolveServerGeminiKeyInfo());
  const limiter = deps.limiter ?? new SlidingFixedWindowRateLimiter();
  const fetchFn = deps.fetchFn ?? fetch;
  const generateGeminiText = deps.generateGeminiText ?? defaultGenerateGeminiText;

  const testGeminiRule: RateLimitRule = deps.rateLimits?.testGemini ?? {
    bucket: 'ai:test-gemini',
    windowMs: 5 * 60 * 1000,
    maxRequests: 10,
  };
  const coordinatorRule: RateLimitRule = deps.rateLimits?.coordinator ?? {
    bucket: 'ai:coordinator',
    windowMs: 5 * 60 * 1000,
    maxRequests: 30,
  };
  const generateProductRule: RateLimitRule = deps.rateLimits?.generateProduct ?? {
    bucket: 'ai:generate-product',
    windowMs: 5 * 60 * 1000,
    maxRequests: 10,
  };
  const factoryRule: RateLimitRule = deps.rateLimits?.factory ?? {
    bucket: 'factory:assets',
    windowMs: 5 * 60 * 1000,
    maxRequests: 20,
  };

  // Strict non-secret liveness health check (never leaks keySource, maskedKey, or env var names)
  router.get('/api/health', (_req, res: Response) => {
    const keyInfo = getGeminiKeyInfo();
    res.json({
      status: 'ok',
      os: 'Personal AI Business OS',
      version: '1.0.0',
      aiAvailable: Boolean(keyInfo),
      timestamp: new Date().toISOString(),
    });
  });

  // H4-D: Admin-only Gemini diagnostic endpoint (strict model allowlist, no key/env leaks)
  router.all(
    '/api/ai/test-gemini',
    requireGovernancePermission(getAuthVerifier, 'ai:admin'),
    createRateLimitMiddleware(limiter, testGeminiRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      if (req.body?.testKey !== undefined || req.query?.key !== undefined) {
        res.status(400).json({
          success: false,
          code: 'CLIENT_KEY_OVERRIDE_FORBIDDEN',
          error: 'Custom API keys are prohibited; server environment credentials are used exclusively.',
        });
        return;
      }

      const requestedModelRaw =
        typeof req.query?.model === 'string'
          ? req.query.model.trim()
          : typeof req.body?.model === 'string'
          ? req.body.model.trim()
          : '';

      if (requestedModelRaw && !ALLOWED_GEMINI_MODELS.has(requestedModelRaw)) {
        res.status(400).json({
          success: false,
          code: 'INVALID_MODEL_NAME',
          error: `Model "${requestedModelRaw}" is not in the server allowlist.`,
        });
        return;
      }

      const keyInfo = getGeminiKeyInfo();
      if (!keyInfo) {
        res.status(503).json({
          success: false,
          error: 'Gemini API service is not configured on the server.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const activeModel = requestedModelRaw || 'gemini-3.1-flash-lite';
      const startTime = Date.now();
      try {
        const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent`;
        const genResp = await fetchFn(generateUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': keyInfo.key,
            'User-Agent': 'aistudio-build',
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: 'Respond with exactly: "Executive Google Gemini link confirmed operational."' },
                ],
              },
            ],
          }),
        });

        const genData = await genResp.json().catch(() => null);
        const latencyMs = Date.now() - startTime;

        if (!genResp.ok) {
          res.status(genResp.status >= 400 && genResp.status < 600 ? genResp.status : 502).json({
            success: false,
            provider: 'google_gemini',
            model: activeModel,
            latencyMs,
            statusCode: genResp.status,
            error: genData?.error?.message || `Gemini API responded with HTTP ${genResp.status}.`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        const replyText =
          genData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Link verified.';
        res.json({
          success: true,
          provider: 'google_gemini',
          model: activeModel,
          latencyMs,
          liveReply: replyText,
          timestamp: new Date().toISOString(),
        });
      } catch (err: any) {
        res.status(502).json({
          success: false,
          provider: 'google_gemini',
          model: activeModel,
          latencyMs: Date.now() - startTime,
          error: err?.message || 'Gemini diagnostic probe failed.',
          timestamp: new Date().toISOString(),
        });
      }
    }
  );

  // H4-D: Authenticated & Rate-Limited AI Executive Coordinator
  router.post(
    '/api/ai/coordinator',
    requireAuthenticatedCaller(getAuthVerifier),
    createRateLimitMiddleware(limiter, coordinatorRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const body = (req.body || {}) as Record<string, any>;
      if (
        !(await verifyAiCallerBusinessScope({
          caller: req.governanceCaller,
          body,
          orderStore: getOrderStore(),
          res,
        }))
      ) {
        return;
      }
      const rawMessage = body.prompt ?? body.message ?? '';
      if (typeof rawMessage !== 'string') {
        res.status(400).json({ error: '"prompt" or "message" must be a string.' });
        return;
      }
      if (rawMessage.trim().length > 4000) {
        res.status(400).json({ error: 'Prompt exceeds maximum length of 4000 characters.' });
        return;
      }

      const message = sanitizeUntrustedText(rawMessage, 4000);
      if (!message) {
        res.status(400).json({ error: 'A non-empty string "prompt" or "message" is required.' });
        return;
      }

      const requestedModel =
        typeof body.model === 'string' && body.model.trim() ? body.model.trim() : '';
      if (requestedModel && !ALLOWED_GEMINI_MODELS.has(requestedModel)) {
        res.status(400).json({
          error: `Requested model "${requestedModel}" is not allowed.`,
        });
        return;
      }

      const context = body.context && typeof body.context === 'object' ? body.context : {};
      const selectedBusiness =
        sanitizeUntrustedText(context.selectedBusiness, 120) || 'All Ventures';
      const totalBusinesses = Number.isFinite(Number(context.totalBusinesses))
        ? Math.max(0, Math.min(1000, Math.round(Number(context.totalBusinesses))))
        : 1;
      const totalProjects = Number.isFinite(Number(context.totalProjects))
        ? Math.max(0, Math.min(10000, Math.round(Number(context.totalProjects))))
        : 1;
      const totalProducts = Number.isFinite(Number(context.totalProducts))
        ? Math.max(0, Math.min(10000, Math.round(Number(context.totalProducts))))
        : 0;
      const pendingApprovals = Number.isFinite(Number(context.pendingApprovals))
        ? Math.max(0, Math.min(10000, Math.round(Number(context.pendingApprovals))))
        : 0;

      let memoriesBlock = 'No specific prior memories retrieved for this scope.';
      if (Array.isArray(context.memories) && context.memories.length > 0) {
        memoriesBlock = context.memories
          .slice(0, 20)
          .map((m: any, i: number) => {
            const cat = (sanitizeUntrustedText(m?.category, 40) || 'memory').toUpperCase();
            const dept = sanitizeUntrustedText(m?.department, 40) || 'global';
            const impact = sanitizeUntrustedText(m?.importance, 20) || 'medium';
            const title = sanitizeUntrustedText(m?.title, 120) || 'Note';
            const content = sanitizeUntrustedText(m?.content, 500) || '';
            return `${i + 1}. [${cat} | Dept: ${dept} | Impact: ${impact}] ${title}: ${content}`;
          })
          .join('\n');
      }

      const systemPrompt = `You are the Executive AI Coordinator for "Personal AI Business OS", a private multi-business operating system for an independent founder.
You coordinate 6 specialized AI departments:
1. Development & Engineering (code, repos, deploys)
2. Product Creation (pricing, digital goods, packaging)
3. Marketing (campaigns, SEO, email funnels)
4. Customer Support (ticket handling, refund queries)
5. Finance (expenses, margins, cash flow)
6. Security (RLS governance, zero-trust permissions)

GOVERNANCE DIRECTIVE:
The system strictly prohibits autonomous execution of high-impact changes without Owner Approval.
Whenever a user asks to deploy code, publish a product, broadcast a marketing campaign, issue a refund, make a purchase, or change security settings, you must structure your answer clearly, detail the proposed changes, and specify that it will be submitted to the Approval Center for executive sign-off.

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

Tone: Concise, executive, strategic, professional, futuristic. No filler.`;

      const keyInfo = getGeminiKeyInfo();
      if (keyInfo) {
        const modelsToTry = requestedModel
          ? [requestedModel]
          : ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];

        for (const modelName of modelsToTry) {
          try {
            const out = await generateGeminiText({
              apiKey: keyInfo.key,
              model: modelName,
              prompt: `${systemPrompt}\n\nUser Executive Request:\n${message}`,
            });
            res.json({
              reply: out.text || 'Directive processed by coordinator.',
              model: out.model,
              provider: 'google_gemini_server',
              isFallback: false,
            });
            return;
          } catch {
            continue;
          }
        }
      }

      // Deterministic offline fallback (never discloses env or key metadata)
      const query = message.toLowerCase();
      let reply = '';
      if (query.includes('product') || query.includes('saas') || query.includes('pricing')) {
        reply = `[Product Creation Department]\nObjective registered for ${selectedBusiness}.\nProposed Next Steps:\n1. Formulate digital product specs & pricing tier (one-time vs recurring).\n2. Draft license/access delivery parameters in Products catalog.\n3. Dispatch to Approval Center before public store availability.`;
      } else if (query.includes('marketing') || query.includes('campaign') || query.includes('seo')) {
        reply = `[Marketing & Growth Department]\nAcquisition plan mapped for ${selectedBusiness}.\nProposed Action:\n1. Configure campaign target audience and channel (Email, Social, SEO).\n2. Allocate budget cap.\n3. Route to Approval Center for Owner authorization before outbound broadcast.`;
      } else if (query.includes('deploy') || query.includes('code') || query.includes('github')) {
        reply = `[Development & Engineering Department]\nTechnical architecture review active.\nDeployment Protocol:\n1. Verify TypeScript compilation and regression tests.\n2. Review Git commit hash and target environment.\n3. Hold production rollout pending Owner Approval in the Approval Center.`;
      } else if (query.includes('security') || query.includes('supabase') || query.includes('rls')) {
        reply = `[Security & Governance Department]\nDatabase integrity verified. Core business tables are protected under PostgreSQL Row Level Security.\nOwner tenant boundary: auth.uid() = owner_id.`;
      } else {
        reply = `[Executive AI Coordinator]\nStanding by for ${selectedBusiness}. All 6 AI departments (Development, Product, Marketing, Support, Finance, Security) are active in strict Owner-Approval mode.\n\nHow shall we advance your business objectives?`;
      }

      res.json({
        reply,
        model: 'offline_rules_simulator',
        provider: 'offline_fallback',
        isFallback: true,
      });
    }
  );

  // H4-D: Authenticated & Rate-Limited Digital Product Generator
  router.post(
    '/api/ai/generate-product',
    requireAuthenticatedCaller(getAuthVerifier),
    createRateLimitMiddleware(limiter, generateProductRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const body = (req.body || {}) as Record<string, any>;
      if (
        !(await verifyAiCallerBusinessScope({
          caller: req.governanceCaller,
          body,
          orderStore: getOrderStore(),
          res,
        }))
      ) {
        return;
      }
      const topic = sanitizeUntrustedText(body.topic, 1000);
      if (!topic) {
        res.status(400).json({ error: 'A valid product topic is required.' });
        return;
      }

      const targetAudience =
        sanitizeUntrustedText(body.targetAudience, 300) ||
        'Small business owners, solo entrepreneurs, and self-employed professionals';
      const businessName =
        sanitizeUntrustedText(body.businessName, 150) || 'Nexus Cloud Technologies';
      const productType =
        typeof body.productType === 'string' && ALLOWED_PRODUCT_TYPES.has(body.productType)
          ? body.productType
          : 'digital_download';
      const billingType =
        typeof body.billingType === 'string' && ALLOWED_BILLING_TYPES.has(body.billingType)
          ? body.billingType
          : 'one_time';
      const rawPrice = Number(body.price ?? 19);
      const price =
        Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice <= 100000 ? rawPrice : 19;

      const requestedModel =
        typeof body.model === 'string' && body.model.trim() ? body.model.trim() : '';
      if (requestedModel && !ALLOWED_GEMINI_MODELS.has(requestedModel)) {
        res.status(400).json({ error: `Requested model "${requestedModel}" is not allowed.` });
        return;
      }

      const keyInfo = getGeminiKeyInfo();
      if (!keyInfo) {
        res.status(503).json({
          error: 'Gemini API key is not configured on the server.',
        });
        return;
      }

      const prompt = `You are the Product Creation & Strategy Department for "${businessName}".
Create a COMPLETE, commercially sellable, immediately usable digital product package in clean Markdown based on this brief:
- Product Topic / Idea: ${topic}
- Target Audience: ${targetAudience}
- Product Format: ${productType}
- Price: $${price.toFixed(2)} (${billingType})

Requirements:
1. Return ONLY valid JSON (no markdown fences) matching this exact schema:
{
  "name": "Crisp, marketable product title",
  "description": "Compelling 1-2 sentence storefront description explaining buyer outcome",
  "deliverableFormat": "pdf_guide" | "template_pack" | "prompt_bundle" | "saas_license",
  "deliverableContent": "Full, non-truncated multi-section Markdown digital product ready for buyer PDF/HTML download. Include a Beginner Quick-Start Guide, concrete templates/checklists/prompts/examples tailored to the niche, a step-by-step action plan, and Commercial Use Rights."
}
2. Make deliverableContent rich, practical, original, and immediately usable (at least 900 words with clear Markdown headings, numbered lists, and real copy-paste templates).`;

      try {
        const modelsToTry = requestedModel
          ? [requestedModel]
          : ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash'];
        let rawText = '';
        let usedModel = modelsToTry[0];

        for (const modelName of modelsToTry) {
          try {
            usedModel = modelName;
            const result = await generateGeminiText({
              apiKey: keyInfo.key,
              model: modelName,
              prompt,
              responseMimeType: 'application/json',
            });
            if (result.text) {
              rawText = result.text;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!rawText) {
          res.status(503).json({ error: 'Gemini models unavailable. Please retry in a moment.' });
          return;
        }

        const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        const deliverableFormat =
          typeof parsed.deliverableFormat === 'string' &&
          ALLOWED_DELIVERABLE_FORMATS.has(parsed.deliverableFormat)
            ? parsed.deliverableFormat
            : 'pdf_guide';

        res.json({
          success: true,
          model: usedModel,
          product: {
            name: sanitizeUntrustedText(parsed.name, 180) || topic.slice(0, 180),
            description:
              sanitizeUntrustedText(parsed.description, 500) ||
              `Digital package for ${targetAudience}`,
            deliverableFormat,
            deliverableContent:
              typeof parsed.deliverableContent === 'string'
                ? parsed.deliverableContent.slice(0, 120000)
                : cleaned.slice(0, 120000),
          },
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Failed to generate digital product package.' });
      }
    }
  );

  // H4-D: Authenticated, Rate-Limited, Size-Bounded Factory Endpoints
  router.post(
    '/api/factory/build-pdf',
    requireAuthenticatedCaller(getAuthVerifier),
    createRateLimitMiddleware(limiter, factoryRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const body = (req.body || {}) as Record<string, any>;
      if (
        !(await verifyAiCallerBusinessScope({
          caller: req.governanceCaller,
          body,
          orderStore: getOrderStore(),
          res,
        }))
      ) {
        return;
      }
      const title = sanitizeUntrustedText(body.title, 200);
      if (!title) {
        res.status(400).json({ error: 'A valid product title is required to build the PDF deliverable.' });
        return;
      }

      if (
        typeof body.deliverableContent === 'string' &&
        body.deliverableContent.length > 120000
      ) {
        res.status(413).json({
          error: 'deliverableContent exceeds maximum size of 120,000 characters.',
        });
        return;
      }

      const description = sanitizeUntrustedText(body.description, 1000) || undefined;
      const businessName = sanitizeUntrustedText(body.businessName, 150) || undefined;
      const deliverableFormat =
        typeof body.deliverableFormat === 'string' &&
        ALLOWED_DELIVERABLE_FORMATS.has(body.deliverableFormat)
          ? body.deliverableFormat
          : 'pdf_guide';
      const billingType =
        typeof body.billingType === 'string' && ALLOWED_BILLING_TYPES.has(body.billingType)
          ? body.billingType
          : undefined;
      const rawPrice = Number(body.price);
      const price =
        Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice <= 100000 ? rawPrice : undefined;
      const content =
        sanitizeUntrustedText(body.deliverableContent, 120000) ||
        `# ${title}\n\n${description || 'Digital Deliverable Package'}`;

      try {
        const pdf = await buildProductPdfBuffer({
          title,
          description,
          businessName,
          deliverableFormat,
          price,
          billingType,
          deliverableContent: content,
        });

        if (req.query.download === '1') {
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
          res.setHeader('Content-Length', String(pdf.buffer.length));
          res.send(pdf.buffer);
          return;
        }

        res.json({
          success: true,
          filename: pdf.filename,
          mimeType: 'application/pdf',
          byteLength: pdf.buffer.length,
          pageCount: pdf.pageCount,
          pdfBase64: pdf.buffer.toString('base64'),
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Failed to build PDF deliverable.' });
      }
    }
  );

  router.post(
    '/api/factory/generate-cover',
    requireAuthenticatedCaller(getAuthVerifier),
    createRateLimitMiddleware(limiter, factoryRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const body = (req.body || {}) as Record<string, any>;
      if (
        !(await verifyAiCallerBusinessScope({
          caller: req.governanceCaller,
          body,
          orderStore: getOrderStore(),
          res,
        }))
      ) {
        return;
      }
      const title = sanitizeUntrustedText(body.title, 200);
      if (!title) {
        res.status(400).json({ error: 'A product title is required to generate cover art.' });
        return;
      }

      const keyInfo = getGeminiKeyInfo();
      const rawPrice = Number(body.price);
      try {
        const cover = await generateProductCoverSvg({
          title,
          description: sanitizeUntrustedText(body.description, 1000) || undefined,
          businessName: sanitizeUntrustedText(body.businessName, 150) || undefined,
          productType:
            typeof body.productType === 'string' && ALLOWED_PRODUCT_TYPES.has(body.productType)
              ? body.productType
              : undefined,
          price:
            Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice <= 100000
              ? rawPrice
              : undefined,
          geminiKey: keyInfo?.key || null,
        });

        res.json({
          success: true,
          mimeType: cover.mimeType,
          modelUsed: cover.modelUsed,
          artDirection: cover.artDirection,
          svgContent: cover.svgContent,
          coverDataUrl: cover.coverDataUrl,
        });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Failed to generate product cover art.' });
      }
    }
  );

  router.post(
    '/api/factory/research',
    requireAuthenticatedCaller(getAuthVerifier),
    createRateLimitMiddleware(limiter, factoryRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const body = (req.body || {}) as Record<string, any>;
      if (
        !(await verifyAiCallerBusinessScope({
          caller: req.governanceCaller,
          body,
          orderStore: getOrderStore(),
          res,
        }))
      ) {
        return;
      }
      const topic = sanitizeUntrustedText(body.topic, 500);
      if (!topic) {
        res.status(400).json({ error: 'A valid product topic is required for factory research.' });
        return;
      }

      const rawPrice = Number(body.price ?? 19);
      const keyInfo = getGeminiKeyInfo();
      try {
        const research = await researchMarketOpportunity({
          topic,
          targetAudience:
            sanitizeUntrustedText(body.targetAudience, 300) ||
            'Small business owners and solo founders',
          businessName:
            sanitizeUntrustedText(body.businessName, 150) || 'Nexus Cloud Technologies',
          productType:
            typeof body.productType === 'string' && ALLOWED_PRODUCT_TYPES.has(body.productType)
              ? body.productType
              : 'digital_download',
          price: Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice <= 100000 ? rawPrice : 19,
          geminiKey: keyInfo?.key || null,
        });
        res.json({ success: true, research });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Market research stage failed.' });
      }
    }
  );

  router.post(
    '/api/factory/launch-kit',
    requireAuthenticatedCaller(getAuthVerifier),
    createRateLimitMiddleware(limiter, factoryRule),
    async (req: AuthenticatedGovernanceRequest, res: Response) => {
      const body = (req.body || {}) as Record<string, any>;
      if (
        !(await verifyAiCallerBusinessScope({
          caller: req.governanceCaller,
          body,
          orderStore: getOrderStore(),
          res,
        }))
      ) {
        return;
      }
      const title = sanitizeUntrustedText(body.title, 200);
      if (!title) {
        res.status(400).json({ error: 'A valid product title is required to draft a launch kit.' });
        return;
      }

      const rawPrice = Number(body.price ?? 19);
      const keyInfo = getGeminiKeyInfo();
      try {
        const launchKit = await generateProductLaunchKit({
          title,
          description: sanitizeUntrustedText(body.description, 1000),
          price: Number.isFinite(rawPrice) && rawPrice >= 0 && rawPrice <= 100000 ? rawPrice : 19,
          billingType:
            typeof body.billingType === 'string' && ALLOWED_BILLING_TYPES.has(body.billingType)
              ? body.billingType
              : 'one_time',
          businessName:
            sanitizeUntrustedText(body.businessName, 150) || 'Nexus Cloud Technologies',
          targetAudience:
            sanitizeUntrustedText(body.targetAudience, 300) ||
            'Small business owners and solo founders',
          researchHook: sanitizeUntrustedText(body.researchHook, 500) || undefined,
          geminiKey: keyInfo?.key || null,
        });
        res.json({ success: true, launchKit });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Marketing launch kit stage failed.' });
      }
    }
  );

  return router;
}
