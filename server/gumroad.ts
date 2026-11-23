export interface GumroadStatusResult {
  configured: boolean;
  verified?: boolean;
  accountName?: string;
  accountHandle?: string;
  error?: string;
}

export interface PublishGumroadInput {
  name: string;
  description: string;
  priceDollars: number;
  slug: string;
  gumroadProductId?: string;
  customDeliverySummary?: string;
}

export interface PublishGumroadResult {
  success: boolean;
  gumroadProductId?: string;
  gumroadUrl?: string;
  name?: string;
  priceCents?: number;
  published?: boolean;
  error?: string;
  missingSecret?: boolean;
}

export interface NormalizedGumroadSale {
  saleId: string;
  gumroadProductId: string;
  productName: string;
  buyerName: string;
  buyerEmail: string;
  amountDollars: number;
  currency: string;
  refunded: boolean;
  createdAt: string;
  source: 'api' | 'webhook';
}

const recentWebhookEvents: NormalizedGumroadSale[] = [];

export function getGumroadToken(): string | null {
  const token = process.env.GUMROAD_ACCESS_TOKEN?.trim();
  return token && token.length > 0 ? token : null;
}

export async function getGumroadStatus(verifyRemote = false): Promise<GumroadStatusResult> {
  const token = getGumroadToken();
  if (!token) {
    return {
      configured: false,
      verified: false,
      error: 'GUMROAD_ACCESS_TOKEN is not set in server environment secrets.',
    };
  }

  if (!verifyRemote) {
    return { configured: true };
  }

  try {
    const resp = await fetch('https://api.gumroad.com/v2/user', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data?.success) {
      return {
        configured: true,
        verified: false,
        error: data?.message || `Gumroad API responded with HTTP ${resp.status}.`,
      };
    }

    return {
      configured: true,
      verified: true,
      accountName: data.user?.name || data.user?.display_name || 'Gumroad Creator',
      accountHandle: data.user?.twitter_handle || data.user?.url || undefined,
    };
  } catch (err: any) {
    return {
      configured: true,
      verified: false,
      error: err?.message || 'Could not reach Gumroad API.',
    };
  }
}

export async function publishProductToGumroad(
  input: PublishGumroadInput
): Promise<PublishGumroadResult> {
  const token = getGumroadToken();
  if (!token) {
    return {
      success: false,
      missingSecret: true,
      error:
        'GUMROAD_ACCESS_TOKEN is not configured in server environment secrets. Add it to publish products to Gumroad.',
    };
  }

  const priceCents = Math.max(0, Math.round(Number(input.priceDollars || 0) * 100));
  const form = new URLSearchParams();
  form.set('name', input.name.trim());
  form.set('description', input.description.trim() || input.name.trim());
  form.set('price', String(priceCents));
  form.set('published', 'true');
  if (input.slug?.trim()) {
    form.set('custom_permalink', input.slug.trim().slice(0, 60));
  }
  if (input.customDeliverySummary?.trim()) {
    form.set('custom_summary', input.customDeliverySummary.trim().slice(0, 240));
  }

  const isUpdate = Boolean(input.gumroadProductId?.trim());
  const endpoint = isUpdate
    ? `https://api.gumroad.com/v2/products/${encodeURIComponent(input.gumroadProductId!.trim())}`
    : 'https://api.gumroad.com/v2/products';

  try {
    const resp = await fetch(endpoint, {
      method: isUpdate ? 'PUT' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data?.success || !data?.product) {
      return {
        success: false,
        error: data?.message || `Gumroad publish failed (HTTP ${resp.status}).`,
      };
    }

    const gp = data.product;
    // Ensure product is enabled/published if created in disabled state
    if (gp.id && gp.published === false) {
      await fetch(`https://api.gumroad.com/v2/products/${encodeURIComponent(gp.id)}/enable`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }

    return {
      success: true,
      gumroadProductId: String(gp.id),
      gumroadUrl: String(gp.short_url || `https://gumroad.com/l/${gp.custom_permalink || gp.id}`),
      name: String(gp.name || input.name),
      priceCents: Number(gp.price ?? priceCents),
      published: true,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'Network error calling Gumroad API.',
    };
  }
}

export async function fetchGumroadSales(afterDate?: string): Promise<{
  success: boolean;
  sales: NormalizedGumroadSale[];
  missingSecret?: boolean;
  error?: string;
}> {
  const token = getGumroadToken();
  if (!token) {
    return {
      success: false,
      sales: [...recentWebhookEvents],
      missingSecret: true,
      error: 'GUMROAD_ACCESS_TOKEN is not configured in server environment secrets.',
    };
  }

  try {
    const url = new URL('https://api.gumroad.com/v2/sales');
    if (afterDate) {
      url.searchParams.set('after', afterDate);
    }

    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data?.success) {
      return {
        success: false,
        sales: [...recentWebhookEvents],
        error: data?.message || `Gumroad sales lookup failed (HTTP ${resp.status}).`,
      };
    }

    const apiSales: NormalizedGumroadSale[] = Array.isArray(data.sales)
      ? data.sales.map((s: any) => ({
          saleId: String(s.id || s.order_number || `gum-${Date.now()}`),
          gumroadProductId: String(s.product_id || ''),
          productName: String(s.product_name || 'Gumroad Digital Product'),
          buyerName: String(s.full_name || s.email || 'Gumroad Buyer'),
          buyerEmail: String(s.email || 'buyer@gumroad.verified'),
          amountDollars: Number(s.price || 0) / 100,
          currency: String(s.currency_symbol === '$' ? 'USD' : 'USD'),
          refunded: Boolean(s.refunded),
          createdAt: String(s.created_at || new Date().toISOString()),
          source: 'api' as const,
        }))
      : [];

    // Merge webhook events without duplicating saleId
    const seen = new Set(apiSales.map((s) => s.saleId));
    const merged = [...apiSales];
    for (const evt of recentWebhookEvents) {
      if (!seen.has(evt.saleId)) {
        merged.push(evt);
        seen.add(evt.saleId);
      }
    }

    return { success: true, sales: merged };
  } catch (err: any) {
    return {
      success: false,
      sales: [...recentWebhookEvents],
      error: err?.message || 'Network error fetching Gumroad sales.',
    };
  }
}

export interface GumroadRemoteProduct {
  gumroadProductId: string;
  gumroadUrl: string;
  name: string;
  description: string;
  priceCents: number;
  priceDollars: number;
  currency: string;
  published: boolean;
  salesCount: number;
  salesUsdCents: number;
  revenueDollars: number;
  viewCount: number | null;
  previewUrl?: string;
  thumbnailUrl?: string;
}

export async function fetchGumroadProducts(): Promise<{
  success: boolean;
  products: GumroadRemoteProduct[];
  missingSecret?: boolean;
  error?: string;
}> {
  const token = getGumroadToken();
  if (!token) {
    return {
      success: false,
      products: [],
      missingSecret: true,
      error: 'GUMROAD_ACCESS_TOKEN is not configured in server environment secrets.',
    };
  }

  try {
    const resp = await fetch('https://api.gumroad.com/v2/products', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await resp.json().catch(() => null);

    if (!resp.ok || !data?.success) {
      return {
        success: false,
        products: [],
        error: data?.message || `Gumroad products lookup failed (HTTP ${resp.status}).`,
      };
    }

    const products: GumroadRemoteProduct[] = Array.isArray(data.products)
      ? data.products.map((p: any) => {
          const priceCents = Number(p.price || 0);
          const salesUsdCents = Number(p.sales_usd_cents || 0);
          const salesCount = Number(p.sales_count || 0);
          const fallbackRevenue =
            salesUsdCents > 0 ? salesUsdCents / 100 : (salesCount * priceCents) / 100;
          const rawViews = p.view_count ?? p.views_count ?? null;
          const viewCount =
            typeof rawViews === 'number' && Number.isFinite(rawViews) && rawViews >= 0
              ? rawViews
              : null;

          return {
            gumroadProductId: String(p.id || ''),
            gumroadUrl: String(
              p.short_url ||
                (p.custom_permalink
                  ? `https://gumroad.com/l/${p.custom_permalink}`
                  : `https://gumroad.com/l/${p.id}`)
            ),
            name: String(p.name || 'Untitled Gumroad Product'),
            description: String(p.description || ''),
            priceCents,
            priceDollars: priceCents / 100,
            currency: String(p.currency || 'usd').toUpperCase(),
            published: Boolean(p.published),
            salesCount,
            salesUsdCents,
            revenueDollars: fallbackRevenue,
            viewCount,
            previewUrl: p.preview_url ? String(p.preview_url) : undefined,
            thumbnailUrl: p.thumbnail_url ? String(p.thumbnail_url) : undefined,
          };
        })
      : [];

    return { success: true, products };
  } catch (err: any) {
    return {
      success: false,
      products: [],
      error: err?.message || 'Network error fetching Gumroad products.',
    };
  }
}

export function ingestGumroadWebhookPayload(payload: Record<string, any>): NormalizedGumroadSale | null {
  const saleId = String(payload?.sale_id || payload?.order_number || '').trim();
  const productId = String(payload?.product_id || '').trim();
  const email = String(payload?.email || '').trim();

  if (!saleId && !productId && !email) {
    return null;
  }

  const normalized: NormalizedGumroadSale = {
    saleId: saleId || `ping-${Date.now()}`,
    gumroadProductId: productId,
    productName: String(payload?.product_name || 'Gumroad Digital Product'),
    buyerName: String(payload?.full_name || payload?.purchaser_id || email || 'Gumroad Buyer'),
    buyerEmail: email || 'buyer@gumroad.verified',
    amountDollars: Number(payload?.price || 0) / 100,
    currency: String(payload?.currency || 'USD').toUpperCase(),
    refunded: payload?.refunded === 'true' || payload?.refunded === true,
    createdAt: String(payload?.sale_timestamp || new Date().toISOString()),
    source: 'webhook',
  };

  const existingIdx = recentWebhookEvents.findIndex((e) => e.saleId === normalized.saleId);
  if (existingIdx >= 0) {
    recentWebhookEvents[existingIdx] = normalized;
  } else {
    recentWebhookEvents.unshift(normalized);
    if (recentWebhookEvents.length > 200) {
      recentWebhookEvents.pop();
    }
  }

  return normalized;
}

export async function verifyGumroadSaleById(saleId: string): Promise<{
  verified: boolean;
  sellerId?: string;
  sale?: NormalizedGumroadSale;
  error?: string;
}> {
  const token = getGumroadToken();
  const cleanSaleId = saleId.trim();
  if (!token) {
    return {
      verified: false,
      error: 'GUMROAD_ACCESS_TOKEN is not configured for remote sale verification.',
    };
  }
  if (!cleanSaleId) {
    return { verified: false, error: 'sale_id is required.' };
  }

  try {
    const resp = await fetch(
      `https://api.gumroad.com/v2/sales/${encodeURIComponent(cleanSaleId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data?.success || !data?.sale) {
      return {
        verified: false,
        error: data?.message || `Gumroad sale verification failed (HTTP ${resp.status}).`,
      };
    }

    const s = data.sale;
    const verifiedSale: NormalizedGumroadSale = {
      saleId: String(s.id || s.order_number || cleanSaleId),
      gumroadProductId: String(s.product_id || ''),
      productName: String(s.product_name || 'Gumroad Digital Product'),
      buyerName: String(s.full_name || s.email || 'Gumroad Buyer'),
      buyerEmail: String(s.email || 'buyer@gumroad.verified'),
      amountDollars: Number(s.price || 0) / 100,
      currency: String(s.currency_symbol === '$' ? 'USD' : s.currency || 'USD').toUpperCase(),
      refunded: Boolean(s.refunded),
      createdAt: String(s.created_at || new Date().toISOString()),
      source: 'api',
    };

    return {
      verified: true,
      sellerId: s.seller_id ? String(s.seller_id) : undefined,
      sale: verifiedSale,
    };
  } catch (err: any) {
    return {
      verified: false,
      error: err?.message || 'Network error verifying Gumroad sale.',
    };
  }
}
