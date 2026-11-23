import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedGovernanceRequest } from './governanceAuth';

export interface RateLimitRule {
  readonly bucket: string;
  readonly windowMs: number;
  readonly maxRequests: number;
}

export interface RateLimitCheckResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiterBackend {
  checkAndConsume(
    key: string,
    rule: RateLimitRule
  ): RateLimitCheckResult | Promise<RateLimitCheckResult>;
}

interface WindowCounter {
  count: number;
  resetAtMs: number;
}

export class SlidingFixedWindowRateLimiter implements RateLimiterBackend {
  private readonly counters = new Map<string, WindowCounter>();
  private readonly getNowMs: () => number;
  private opsSincePrune = 0;

  constructor(getNowMs: () => number = () => Date.now()) {
    this.getNowMs = getNowMs;
  }

  checkAndConsume(key: string, rule: RateLimitRule): RateLimitCheckResult {
    const now = this.getNowMs();
    this.opsSincePrune += 1;
    if (this.opsSincePrune >= 200) {
      this.opsSincePrune = 0;
      for (const [k, v] of this.counters.entries()) {
        if (v.resetAtMs <= now) {
          this.counters.delete(k);
        }
      }
    }

    const existing = this.counters.get(key);
    if (!existing || existing.resetAtMs <= now) {
      const resetAtMs = now + rule.windowMs;
      this.counters.set(key, { count: 1, resetAtMs });
      return {
        allowed: true,
        limit: rule.maxRequests,
        remaining: Math.max(0, rule.maxRequests - 1),
        retryAfterSeconds: Math.ceil(rule.windowMs / 1000),
      };
    }

    if (existing.count >= rule.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000));
      return {
        allowed: false,
        limit: rule.maxRequests,
        remaining: 0,
        retryAfterSeconds,
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      limit: rule.maxRequests,
      remaining: Math.max(0, rule.maxRequests - existing.count),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000)),
    };
  }
}

/**
 * H3 Remediation: Distributed Postgres-backed rate limiter executing
 * atomic `public.consume_api_rate_limit(...)` in Supabase so limits hold
 * across serverless/multi-instance deployments and process restarts.
 */
export class SupabasePostgresRateLimiter implements RateLimiterBackend {
  private readonly client: SupabaseClient;
  private readonly fallback: SlidingFixedWindowRateLimiter;
  private readonly getNowMs: () => number;

  constructor(
    client: SupabaseClient,
    getNowMs: () => number = () => Date.now()
  ) {
    this.client = client;
    this.getNowMs = getNowMs;
    this.fallback = new SlidingFixedWindowRateLimiter(getNowMs);
  }

  async checkAndConsume(
    key: string,
    rule: RateLimitRule
  ): Promise<RateLimitCheckResult> {
    try {
      const { data, error } = await this.client.rpc('consume_api_rate_limit', {
        p_bucket: rule.bucket,
        p_subject_key: key,
        p_window_ms: Math.max(1000, rule.windowMs),
        p_max_requests: Math.max(1, rule.maxRequests),
        p_now_ms: this.getNowMs(),
      });

      if (error || !data || typeof data !== 'object') {
        return this.fallback.checkAndConsume(`${rule.bucket}:${key}`, rule);
      }

      const rec = data as Record<string, any>;
      const retryAfterMs = Math.max(1000, Number(rec.retry_after_ms ?? rule.windowMs));
      return {
        allowed: Boolean(rec.allowed),
        limit: rule.maxRequests,
        remaining: Math.max(0, Number(rec.remaining ?? 0)),
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    } catch {
      return this.fallback.checkAndConsume(`${rule.bucket}:${key}`, rule);
    }
  }
}

export function createDefaultServerRateLimiter(
  env: NodeJS.ProcessEnv = process.env
): RateLimiterBackend {
  const supabaseUrl =
    env.SUPABASE_URL?.trim() || env.VITE_SUPABASE_URL?.trim() || '';
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';

  if (supabaseUrl && serviceRoleKey) {
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return new SupabasePostgresRateLimiter(client);
  }

  return new SlidingFixedWindowRateLimiter();
}

export function createRateLimitMiddleware(
  limiter: RateLimiterBackend,
  rule: RateLimitRule
) {
  return async (
    req: AuthenticatedGovernanceRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const userId = req.governanceCaller?.userId;
    const rawIp =
      (typeof req.ip === 'string' && req.ip) ||
      (typeof req.socket?.remoteAddress === 'string' && req.socket.remoteAddress) ||
      'unknown';

    const subjectKey = userId ? `user:${userId}` : `ip:${rawIp}`;
    const cacheKey =
      limiter instanceof SupabasePostgresRateLimiter
        ? subjectKey
        : `${rule.bucket}:${subjectKey}`;

    const result = await limiter.checkAndConsume(cacheKey, rule);

    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({
        success: false,
        code: 'RATE_LIMIT_EXCEEDED',
        error: `Rate limit exceeded for ${rule.bucket}. Retry in ${result.retryAfterSeconds}s.`,
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }

    next();
  };
}
