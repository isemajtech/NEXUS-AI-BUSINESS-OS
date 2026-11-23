import express, { Request, Response } from 'express';
import fs from 'fs';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServerReplayStore } from './server/replayStore';
import { createGovernanceRouter } from './server/governanceRoutes';
import { createCommerceRouter } from './server/commerceRoutes';
import { createSupabaseAuthoritativeOrderStoreFromEnv } from './server/orderStore';
import { createServerPaymentRefundProvider } from './server/paymentProvider';
import { createDefaultServerRateLimiter } from './server/rateLimiter';
import {
  createAiFactoryRouter,
  resolveServerGeminiKeyInfo,
} from './server/aiFactoryRoutes';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// C1: Trust reverse proxy headers so rate limiting sees real client IPs behind Cloud Run / LB
app.set('trust proxy', 1);

// Capture raw Buffer alongside parsed JSON for Stripe webhook cryptographic signature verification
app.use(
  express.json({
    limit: '1mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true, limit: '512kb' }));

export function getGeminiApiKeyInfo() {
  return resolveServerGeminiKeyInfo();
}

const serverRateLimiter = createDefaultServerRateLimiter();
const serverOrderStore = createSupabaseAuthoritativeOrderStoreFromEnv();
const serverPaymentProvider = createServerPaymentRefundProvider({
  orderStore: serverOrderStore,
});
const serverReplayStore = createServerReplayStore();

// H4-D & Phase 0 H3: Authenticated, Membership-Scoped & Rate-Limited AI / Factory Routes
app.use(
  createAiFactoryRouter({
    getOrderStore: () => serverOrderStore,
    limiter: serverRateLimiter,
  })
);

// H4-A..C & Phase 0 C2/C3/C4/H1: Commerce, Publish Approvals, Stripe Checkout & Webhooks
app.use(
  createCommerceRouter({
    getOrderStore: () => serverOrderStore,
    limiter: serverRateLimiter,
  })
);

// Phase 2 + P0/H1/H2/H3 + Phase 0 C5: Governance Boundary with Real Stripe Refund Provider
app.use(
  createGovernanceRouter({
    replayStore: serverReplayStore,
    orderStore: serverOrderStore,
    paymentProvider: serverPaymentProvider,
    limiter: serverRateLimiter,
  })
);

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    // C1: Lazy-load Vite only in development so production never requires vite dev runtime
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Support running from both source (`tsx server.ts`) and compiled bundle (`node dist/server.js`)
    const distPath = fs.existsSync(path.resolve(__dirname, 'index.html'))
      ? __dirname
      : path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Personal AI Business OS running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
