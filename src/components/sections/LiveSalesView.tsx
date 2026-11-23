import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { useOS } from '../../context/OSContext';
import {
  authorizedApiFetch,
  fetchProductsGumroadFieldsFromSupabase,
  syncProductGumroadFieldsToSupabase,
} from '../../lib/supabase';
import { Product } from '../../types';
import {
  RefreshCw,
  ExternalLink,
  TrendingUp,
  DollarSign,
  ShoppingBag,
  Percent,
  CheckCircle2,
  AlertCircle,
  Link2,
  Database,
  UploadCloud,
  Loader2,
  PlusCircle,
} from 'lucide-react';

interface RemoteGumroadProduct {
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
}

interface RemoteGumroadSale {
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

interface LiveSalesViewProps {
  onNotify: (msg: string) => void;
  onOpenStudio: () => void;
}

export const LiveSalesView: React.FC<LiveSalesViewProps> = ({
  onNotify,
  onOpenStudio,
}) => {
  const {
    products,
    businesses,
    orders,
    selectedBusinessId,
    updateProduct,
    addProduct,
    syncGumroadSales,
  } = useOS();

  const [isLoading, setIsLoading] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [accountStatus, setAccountStatus] = useState<{
    configured: boolean;
    verified?: boolean;
    accountName?: string;
    accountHandle?: string;
    error?: string;
  } | null>(null);
  const [remoteProducts, setRemoteProducts] = useState<RemoteGumroadProduct[]>([]);
  const [remoteSales, setRemoteSales] = useState<RemoteGumroadSale[]>([]);
  const [dbSyncMeta, setDbSyncMeta] = useState<{
    connected: boolean;
    authenticated: boolean;
    linkedRowsCount: number;
  }>({ connected: false, authenticated: false, linkedRowsCount: 0 });
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [chartMetricMode, setChartMetricMode] = useState<'revenue_sales' | 'conversion'>('revenue_sales');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [linkingProductId, setLinkingProductId] = useState<string | null>(null);

  // Manual DB field binder state (assigns existing gumroad_product_id & gumroad_url to a product)
  const [bindTargetProductId, setBindTargetProductId] = useState('');
  const [bindGumroadId, setBindGumroadId] = useState('');
  const [bindGumroadUrl, setBindGumroadUrl] = useState('');

  const scopedProducts = useMemo(
    () =>
      selectedBusinessId === 'all'
        ? products
        : products.filter((p) => p.businessId === selectedBusinessId),
    [products, selectedBusinessId]
  );

  // Strict DB-field filter: products utilizing gumroad_product_id or gumroad_url
  const gumroadLinkedProducts = useMemo(
    () =>
      scopedProducts.filter(
        (p) => Boolean(p.gumroadProductId?.trim() || p.gumroadUrl?.trim())
      ),
    [scopedProducts]
  );

  const unlinkedPublishedProducts = useMemo(
    () =>
      scopedProducts.filter(
        (p) => p.status === 'published' && !p.gumroadProductId?.trim()
      ),
    [scopedProducts]
  );

  const loadLiveTelemetry = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoading(true);
      setFetchError(null);

      try {
        // 1. Hydrate stored gumroad_product_id and gumroad_url columns from Supabase DB when authenticated
        const sbRes = await fetchProductsGumroadFieldsFromSupabase();
        const dbGumroadLinked = sbRes.rows.filter(
          (r) => Boolean(r.gumroad_product_id || r.gumroad_url)
        );
        setDbSyncMeta({
          connected: sbRes.connected,
          authenticated: sbRes.authenticated,
          linkedRowsCount: dbGumroadLinked.length,
        });

        for (const row of dbGumroadLinked) {
          const localMatch = products.find((p) => p.id === row.id);
          if (
            localMatch &&
            ((row.gumroad_product_id &&
              row.gumroad_product_id !== localMatch.gumroadProductId) ||
              (row.gumroad_url && row.gumroad_url !== localMatch.gumroadUrl))
          ) {
            updateProduct(localMatch.id, {
              gumroadProductId: row.gumroad_product_id || localMatch.gumroadProductId,
              gumroadUrl: row.gumroad_url || localMatch.gumroadUrl,
            });
          }
        }

        // 2. Fetch real-time Gumroad creator verification, live products, and live sales
        const [statusResp, prodResp, salesResp] = await Promise.all([
          authorizedApiFetch('/api/gumroad/status?verify=1').then((r) => r.json()).catch(() => null),
          authorizedApiFetch('/api/gumroad/products').then((r) => r.json()).catch(() => null),
          authorizedApiFetch('/api/gumroad/sales').then((r) => r.json()).catch(() => null),
        ]);

        if (statusResp) {
          setAccountStatus(statusResp);
        }

        const fetchedProducts: RemoteGumroadProduct[] = Array.isArray(prodResp?.products)
          ? prodResp.products
          : [];
        const fetchedSales: RemoteGumroadSale[] = Array.isArray(salesResp?.sales)
          ? salesResp.sales
          : [];

        setRemoteProducts(fetchedProducts);
        setRemoteSales(fetchedSales);

        if (prodResp && !prodResp.success && prodResp.error) {
          setFetchError(prodResp.error);
        } else if (salesResp && !salesResp.success && salesResp.error) {
          setFetchError(salesResp.error);
        }

        // 3. Reconcile real-time Gumroad metrics back onto OS products matching gumroadProductId
        for (const rp of fetchedProducts) {
          const matchingLocal = products.find(
            (p) =>
              (p.gumroadProductId && p.gumroadProductId === rp.gumroadProductId) ||
              (p.gumroadUrl && rp.gumroadUrl && p.gumroadUrl === rp.gumroadUrl)
          );
          if (matchingLocal) {
            const patch: Partial<Product> = {};
            if (!matchingLocal.gumroadProductId && rp.gumroadProductId) {
              patch.gumroadProductId = rp.gumroadProductId;
            }
            if (!matchingLocal.gumroadUrl && rp.gumroadUrl) {
              patch.gumroadUrl = rp.gumroadUrl;
            }
            if (rp.salesCount > (matchingLocal.salesCount || 0)) {
              patch.salesCount = rp.salesCount;
            }
            if (rp.revenueDollars > (matchingLocal.totalRevenue || 0)) {
              patch.totalRevenue = Number(rp.revenueDollars.toFixed(2));
            }
            if (Object.keys(patch).length > 0) {
              updateProduct(matchingLocal.id, patch);
            }
          }
        }

        // 4. Sync deduplicated live Gumroad sales into Orders & Customers ledger
        if (fetchedSales.length > 0) {
          const syncRes = syncGumroadSales(fetchedSales);
          if (syncRes.imported > 0 && !silent) {
            onNotify(
              `Synced ${syncRes.imported} new live Gumroad order${syncRes.imported === 1 ? '' : 's'} into catalog metrics.`
            );
          }
        }

        setLastRefreshedAt(new Date().toISOString());
      } catch (err: any) {
        setFetchError(err?.message || 'Could not fetch real-time Gumroad telemetry.');
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [products, updateProduct, syncGumroadSales, onNotify]
  );

  useEffect(() => {
    loadLiveTelemetry(false);
    // Intentionally run on mount & business scope change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBusinessId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      loadLiveTelemetry(true);
    }, 60000);
    return () => clearInterval(timer);
  }, [autoRefresh, loadLiveTelemetry]);

  // Build normalized per-product conversion & revenue metrics strictly anchored to gumroad_product_id / gumroad_url
  const productMetrics = useMemo(() => {
    const remoteById = new Map<string, RemoteGumroadProduct>(
      remoteProducts.map((rp) => [rp.gumroadProductId, rp])
    );

    const rows = gumroadLinkedProducts.map((prod) => {
      const gid = (prod.gumroadProductId || '').trim();
      const remote = gid
        ? remoteById.get(gid)
        : remoteProducts.find((rp) => rp.gumroadUrl === prod.gumroadUrl);

      const matchingSales = remoteSales.filter(
        (s) =>
          (gid && s.gumroadProductId === gid) ||
          s.productName.trim().toLowerCase() === prod.name.trim().toLowerCase()
      );
      const localOrdersForProduct = orders.filter((o) => o.productId === prod.id);

      const refundedCount = matchingSales.filter((s) => s.refunded).length;
      const netRemoteSalesFromEvents = matchingSales.filter((s) => !s.refunded).length;

      const grossSalesCount =
        remote?.salesCount ??
        Math.max(
          matchingSales.length,
          localOrdersForProduct.length,
          prod.salesCount || 0
        );
      const netSalesCount =
        remote !== undefined
          ? Math.max(0, remote.salesCount - refundedCount)
          : Math.max(netRemoteSalesFromEvents, prod.salesCount || 0);

      const liveRevenue =
        remote?.revenueDollars ??
        (matchingSales.length > 0
          ? matchingSales
              .filter((s) => !s.refunded)
              .reduce((acc, s) => acc + s.amountDollars, 0)
          : prod.totalRevenue || 0);

      const viewCount = remote?.viewCount ?? null;
      const viewToPurchasePct =
        viewCount && viewCount > 0 ? Number(((grossSalesCount / viewCount) * 100).toFixed(2)) : null;

      const checkoutCompletionPct =
        grossSalesCount > 0
          ? Number(((netSalesCount / grossSalesCount) * 100).toFixed(1))
          : 0;

      const avgOrderValue =
        netSalesCount > 0 ? Number((liveRevenue / netSalesCount).toFixed(2)) : prod.price;

      return {
        product: prod,
        gumroadProductId: gid || remote?.gumroadProductId || 'url-linked',
        gumroadUrl: prod.gumroadUrl || remote?.gumroadUrl || '',
        remotePublished: remote ? remote.published : prod.status === 'published',
        livePrice: remote ? remote.priceDollars : prod.price,
        grossSalesCount,
        netSalesCount,
        refundedCount,
        liveRevenue: Number(liveRevenue.toFixed(2)),
        viewCount,
        viewToPurchasePct,
        checkoutCompletionPct,
        avgOrderValue,
      };
    });

    const totalNetRevenue = rows.reduce((sum, r) => sum + r.liveRevenue, 0);
    const totalCatalogSales = Math.max(
      rows.reduce((sum, r) => sum + r.netSalesCount, 0),
      orders.filter((o) => o.status === 'completed').length
    );

    return rows.map((r) => ({
      ...r,
      shortName: r.product.name.length > 22 ? `${r.product.name.slice(0, 21)}…` : r.product.name,
      revenueSharePct:
        totalNetRevenue > 0 ? Number(((r.liveRevenue / totalNetRevenue) * 100).toFixed(1)) : 0,
      conversionDisplayPct:
        r.viewToPurchasePct !== null
          ? r.viewToPurchasePct
          : totalCatalogSales > 0
          ? Number(((r.netSalesCount / totalCatalogSales) * 100).toFixed(1))
          : 0,
    }));
  }, [gumroadLinkedProducts, remoteProducts, remoteSales, orders]);

  // Also capture unlinked remote Gumroad products so the owner can import/bind their gumroad_product_id & gumroad_url
  const unlinkedRemoteProducts = useMemo(() => {
    const linkedIds = new Set(
      products.map((p) => p.gumroadProductId).filter(Boolean) as string[]
    );
    const linkedUrls = new Set(
      products.map((p) => p.gumroadUrl).filter(Boolean) as string[]
    );
    return remoteProducts.filter(
      (rp) => !linkedIds.has(rp.gumroadProductId) && !linkedUrls.has(rp.gumroadUrl)
    );
  }, [remoteProducts, products]);

  // Aggregate KPI totals
  const summaryStats = useMemo(() => {
    const linkedIdsSet = new Set(
      gumroadLinkedProducts.map((p) => p.gumroadProductId).filter(Boolean)
    );
    const matchingRemoteSales = remoteSales.filter(
      (s) => linkedIdsSet.size === 0 || linkedIdsSet.has(s.gumroadProductId)
    );

    const totalRevenue = productMetrics.reduce((acc, m) => acc + m.liveRevenue, 0);
    const netPurchases = productMetrics.reduce((acc, m) => acc + m.netSalesCount, 0);
    const refundedPurchases = productMetrics.reduce((acc, m) => acc + m.refundedCount, 0);
    const totalViewsKnown = productMetrics.reduce(
      (acc, m) => acc + (m.viewCount ?? 0),
      0
    );
    const hasViewTelemetry = productMetrics.some((m) => m.viewCount !== null && m.viewCount > 0);

    const totalAttempts = netPurchases + refundedPurchases;
    const netCompletionRate =
      totalAttempts > 0 ? (netPurchases / totalAttempts) * 100 : 0;
    const viewConversionRate =
      hasViewTelemetry && totalViewsKnown > 0 ? (netPurchases / totalViewsKnown) * 100 : null;

    const avgOrderValue = netPurchases > 0 ? totalRevenue / netPurchases : 0;

    return {
      linkedCount: gumroadLinkedProducts.length,
      totalRevenue,
      netPurchases,
      refundedPurchases,
      hasViewTelemetry,
      viewConversionRate,
      netCompletionRate,
      avgOrderValue,
      recentEventsCount: matchingRemoteSales.length,
    };
  }, [gumroadLinkedProducts, productMetrics, remoteSales]);

  // Chronological Recharts time-series built from real Gumroad sales + verified Gumroad orders
  const timelineChartData = useMemo(() => {
    const byDate = new Map<string, { date: string; revenue: number; purchases: number; refunds: number }>();

    const relevantOrders =
      remoteSales.length > 0
        ? remoteSales.map((s) => ({
            createdAt: s.createdAt,
            amount: s.amountDollars,
            refunded: s.refunded,
          }))
        : orders
            .filter(
              (o) =>
                o.paymentMethod.toLowerCase().includes('gumroad') ||
                gumroadLinkedProducts.some((p) => p.id === o.productId)
            )
            .map((o) => ({
              createdAt: o.createdAt,
              amount: o.amount,
              refunded: o.status === 'refunded',
            }));

    for (const item of relevantOrders) {
      const dt = new Date(item.createdAt);
      if (Number.isNaN(dt.getTime())) continue;
      const dayKey = dt.toISOString().slice(0, 10);
      const curr = byDate.get(dayKey) || { date: dayKey, revenue: 0, purchases: 0, refunds: 0 };
      if (item.refunded) {
        curr.refunds += 1;
      } else {
        curr.purchases += 1;
        curr.revenue = Number((curr.revenue + item.amount).toFixed(2));
      }
      byDate.set(dayKey, curr);
    }

    return Array.from(byDate.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        ...d,
        label: new Date(`${d.date}T12:00:00Z`).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
      }));
  }, [remoteSales, orders, gumroadLinkedProducts]);

  const handleImportRemoteProduct = (rp: RemoteGumroadProduct) => {
    const bizId =
      selectedBusinessId !== 'all'
        ? selectedBusinessId
        : businesses[0]?.id || 'biz-prime';

    const created = addProduct({
      name: rp.name,
      slug: rp.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, ''),
      description: rp.description || 'Imported from live Gumroad storefront',
      businessId: bizId,
      type: 'digital_download',
      price: rp.priceDollars,
      billingType: 'one_time',
      status: rp.published ? 'published' : 'draft',
      downloadOrAccessUrl: rp.gumroadUrl,
      gumroadProductId: rp.gumroadProductId,
      gumroadUrl: rp.gumroadUrl,
      factoryMetadata: {
        importedFromGumroadAt: new Date().toISOString(),
      },
    });

    updateProduct(created.id, {
      salesCount: rp.salesCount,
      totalRevenue: Number(rp.revenueDollars.toFixed(2)),
    });
    onNotify(
      `Imported "${rp.name}" with gumroad_product_id (${rp.gumroadProductId}) & gumroad_url.`
    );
  };

  const handlePublishAndLinkProduct = async (prod: Product) => {
    setLinkingProductId(prod.id);
    try {
      const apprResp = await authorizedApiFetch('/api/commerce/publish-approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: prod.id,
          businessId: prod.businessId,
          replaceExisting: true,
          decisionNote: `Owner initiated Gumroad publish for "${prod.name}"`,
        }),
      });
      const apprData = await apprResp.json().catch(() => ({}));
      if (!apprResp.ok || !apprData?.approval?.approvalId) {
        onNotify(
          apprData?.error ||
            'Server Owner Publish Approval required. Sign in as the verified business owner.'
        );
        return;
      }
      const approvalId = String(apprData.approval.approvalId);

      const resp = await authorizedApiFetch('/api/gumroad/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: prod.id,
          businessId: prod.businessId,
          approvalId,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.success) {
        onNotify(data?.error || 'Could not publish listing to Gumroad.');
        return;
      }

      updateProduct(prod.id, {
        gumroadProductId: data.gumroadProductId,
        gumroadUrl: data.gumroadUrl,
        publishedApprovalId: undefined,
      });
      onNotify(
        `Linked "${prod.name}" to gumroad_product_id ${data.gumroadProductId} (${data.gumroadUrl}).`
      );
      await loadLiveTelemetry(true);
    } finally {
      setLinkingProductId(null);
    }
  };

  const handleBindExistingFields = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bindTargetProductId || (!bindGumroadId.trim() && !bindGumroadUrl.trim())) return;

    const cleanId = bindGumroadId.trim();
    const cleanUrl = bindGumroadUrl.trim();

    updateProduct(bindTargetProductId, {
      gumroadProductId: cleanId || undefined,
      gumroadUrl: cleanUrl || undefined,
    });
    await syncProductGumroadFieldsToSupabase({
      productId: bindTargetProductId,
      gumroadProductId: cleanId || undefined,
      gumroadUrl: cleanUrl || undefined,
    });

    setBindGumroadId('');
    setBindGumroadUrl('');
    onNotify('Saved gumroad_product_id & gumroad_url onto product record.');
    await loadLiveTelemetry(true);
  };

  return (
    <div className="space-y-6">
      {/* Live Sales Telemetry Top Bar */}
      <div className="p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                accountStatus?.verified
                  ? 'bg-emerald-400'
                  : accountStatus?.configured
                  ? 'bg-cyan-400'
                  : 'bg-amber-400'
              }`}
            />
            <span className="font-mono text-pink-300 uppercase tracking-wider">
              Gumroad Live Sales & Conversion Telemetry
            </span>
            {accountStatus?.accountName && (
              <span className="text-slate-400">· Creator: {accountStatus.accountName}</span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Real-time conversion analytics bound strictly to DB fields{' '}
            <code className="text-cyan-300 font-mono">gumroad_product_id</code> and{' '}
            <code className="text-cyan-300 font-mono">gumroad_url</code>
            {dbSyncMeta.authenticated ? ` (${dbSyncMeta.linkedRowsCount} DB rows synced)` : ''}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#131a29] border border-[#212c42] text-xs text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded border-[#33415c] bg-[#0e131d] text-pink-500"
            />
            Auto-Poll (60s)
          </label>

          <button
            type="button"
            disabled={isLoading}
            onClick={() => loadLiveTelemetry(false)}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-pink-600 hover:bg-pink-500 disabled:opacity-60 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            {isLoading ? 'Fetching Live Gumroad Data...' : 'Fetch Live Gumroad Data'}
          </button>
        </div>
      </div>

      {fetchError && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Gumroad API Telemetry Notice</div>
            <div className="text-amber-300/90 mt-0.5">{fetchError}</div>
          </div>
        </div>
      )}

      {/* 4 Conversion & Revenue KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="p-4 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Linked Gumroad Listings</span>
            <Link2 className="w-4 h-4 text-pink-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-slate-100">
            {summaryStats.linkedCount}
          </div>
          <div className="text-[11px] text-slate-400 tabular-nums">
            of {scopedProducts.length} catalog products have gumroad_product_id
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Live Gumroad Revenue</span>
            <DollarSign className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-emerald-400">
            ${summaryStats.totalRevenue.toFixed(2)}
          </div>
          <div className="text-[11px] text-slate-400 tabular-nums">
            AOV ${summaryStats.avgOrderValue.toFixed(2)} · Real API ledger
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Completed Purchases</span>
            <ShoppingBag className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-slate-100">
            {summaryStats.netPurchases}
          </div>
          <div className="text-[11px] text-slate-400 tabular-nums">
            {summaryStats.refundedPurchases} refunded · {summaryStats.recentEventsCount} API/ping events
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>
              {summaryStats.viewConversionRate !== null
                ? 'View-to-Buy Conversion'
                : 'Purchase Completion Rate'}
            </span>
            <Percent className="w-4 h-4 text-violet-400" />
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-violet-300">
            {(summaryStats.viewConversionRate ?? summaryStats.netCompletionRate).toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400 tabular-nums">
            {lastRefreshedAt
              ? `Synced ${new Date(lastRefreshedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : 'Waiting for sync'}
          </div>
        </div>
      </div>

      {/* Recharts Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Chart 1: Daily Gumroad Revenue & Purchase Volume */}
        <div className="p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                Real-Time Sales Velocity
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Daily completed Gumroad revenue ($ USD) & order count
              </p>
            </div>
          </div>

          <div className="h-64 w-full">
            {timelineChartData.length === 0 ? (
              <div className="h-full rounded-xl bg-[#0a0e16] border border-[#182131] flex flex-col items-center justify-center text-center px-6 space-y-1.5">
                <p className="text-xs font-semibold text-slate-300">
                  No Gumroad Transactions Recorded Yet
                </p>
                <p className="text-[11px] text-slate-500 max-w-sm">
                  Completed orders fetched from <code className="text-slate-300">/api/gumroad/sales</code> or incoming Gumroad Ping webhooks appear here chronologically.
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={timelineChartData}
                  margin={{ top: 10, right: 12, left: -10, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="gumroadRevGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1b2436" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0f1420',
                      borderColor: '#25324b',
                      borderRadius: '12px',
                      fontSize: '12px',
                      color: '#f1f5f9',
                    }}
                    formatter={(value: any, name: any) =>
                      name === 'revenue'
                        ? [`$${Number(value).toFixed(2)}`, 'Revenue']
                        : [Number(value), 'Purchases']
                    }
                  />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    name="revenue"
                    stroke="#10b981"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#gumroadRevGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Chart 2: Per-Product Conversion & Sales Comparison */}
        <div className="p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-slate-100">
                Per-Product Conversion & Revenue
              </h3>
              <p className="text-[11px] text-slate-400 mt-0.5">
                Metrics filtered by linked <code className="text-cyan-300">gumroad_product_id</code>
              </p>
            </div>
            <div className="flex items-center p-0.5 rounded-lg bg-[#090d15] border border-[#1d2638] text-[11px]">
              <button
                type="button"
                onClick={() => setChartMetricMode('revenue_sales')}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  chartMetricMode === 'revenue_sales'
                    ? 'bg-[#1a2438] text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Revenue & Orders
              </button>
              <button
                type="button"
                onClick={() => setChartMetricMode('conversion')}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  chartMetricMode === 'conversion'
                    ? 'bg-[#1a2438] text-slate-100'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Conversion & Share %
              </button>
            </div>
          </div>

          <div className="h-64 w-full">
            {productMetrics.length === 0 ? (
              <div className="h-full rounded-xl bg-[#0a0e16] border border-[#182131] flex flex-col items-center justify-center text-center px-6 space-y-2">
                <p className="text-xs font-semibold text-slate-300">
                  No Products Linked to Gumroad Yet
                </p>
                <p className="text-[11px] text-slate-500 max-w-sm">
                  Publish a live product to Gumroad or import an existing Gumroad listing below to track conversion charts using <code className="text-slate-300">gumroad_product_id</code> & <code className="text-slate-300">gumroad_url</code>.
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={productMetrics}
                  margin={{ top: 10, right: 12, left: -10, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#1b2436" vertical={false} />
                  <XAxis
                    dataKey="shortName"
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis stroke="#64748b" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#0f1420',
                      borderColor: '#25324b',
                      borderRadius: '12px',
                      fontSize: '12px',
                      color: '#f1f5f9',
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  {chartMetricMode === 'revenue_sales' ? (
                    <>
                      <Bar
                        dataKey="liveRevenue"
                        name="Revenue ($)"
                        fill="#ec4899"
                        radius={[6, 6, 0, 0]}
                      />
                      <Bar
                        dataKey="netSalesCount"
                        name="Net Purchases"
                        fill="#06b6d4"
                        radius={[6, 6, 0, 0]}
                      />
                    </>
                  ) : (
                    <>
                      <Bar
                        dataKey="checkoutCompletionPct"
                        name="Completion Rate (%)"
                        fill="#8b5cf6"
                        radius={[6, 6, 0, 0]}
                      />
                      <Bar
                        dataKey="revenueSharePct"
                        name="Revenue Share (%)"
                        fill="#10b981"
                        radius={[6, 6, 0, 0]}
                      />
                    </>
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Linked Products Ledger (Strictly Utilizing gumroad_product_id & gumroad_url) */}
      <div className="rounded-2xl bg-[#0e131d] border border-[#1e2638] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#1a2234] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-semibold text-slate-100">
              Linked Gumroad Products ({productMetrics.length})
            </h3>
          </div>
          <span className="text-[11px] text-slate-400">
            Strictly mapped to database columns <code className="text-cyan-300">gumroad_product_id</code> & <code className="text-cyan-300">gumroad_url</code>
          </span>
        </div>

        {productMetrics.length === 0 ? (
          <div className="p-6 space-y-4">
            <div className="text-xs text-slate-400">
              None of your catalog products have <code className="text-cyan-300">gumroad_product_id</code> populated yet. Push an approved product below or bind an existing Gumroad listing ID.
            </div>
            {unlinkedPublishedProducts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {unlinkedPublishedProducts.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={linkingProductId === p.id}
                    onClick={() => handlePublishAndLinkProduct(p)}
                    className="px-3 py-2 text-xs font-semibold text-pink-200 bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/35 rounded-xl flex items-center gap-1.5 transition-colors disabled:opacity-60"
                  >
                    {linkingProductId === p.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <UploadCloud className="w-3.5 h-3.5" />
                    )}
                    Publish "{p.name}" to Gumroad
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#121826] border-b border-[#1d2638] text-slate-400 font-mono text-[11px]">
                <tr>
                  <th className="px-4 py-2.5">Product</th>
                  <th className="px-4 py-2.5">gumroad_product_id</th>
                  <th className="px-4 py-2.5">gumroad_url</th>
                  <th className="px-4 py-2.5 text-right">Price</th>
                  <th className="px-4 py-2.5 text-right">Net Purchases</th>
                  <th className="px-4 py-2.5 text-right">Conversion / Completion</th>
                  <th className="px-4 py-2.5 text-right">Live Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#182131]">
                {productMetrics.map((row) => (
                  <tr key={row.product.id} className="hover:bg-[#121826] transition-colors">
                    <td className="px-4 py-3 font-semibold text-slate-100">
                      {row.product.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-cyan-300">
                      {row.gumroadProductId}
                    </td>
                    <td className="px-4 py-3">
                      {row.gumroadUrl ? (
                        <a
                          href={row.gumroadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-pink-300 hover:text-pink-200 inline-flex items-center gap-1 font-mono text-[11px]"
                        >
                          {row.gumroadUrl.replace(/^https?:\/\//, '')}
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </a>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-300">
                      ${row.livePrice.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-100">
                      {row.netSalesCount}
                      {row.refundedCount > 0 ? ` (${row.refundedCount} ref)` : ''}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-violet-300">
                      {row.viewToPurchasePct !== null
                        ? `${row.viewToPurchasePct.toFixed(2)}% (${row.viewCount} views)`
                        : `${row.checkoutCompletionPct.toFixed(1)}% completion`}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-emerald-400">
                      ${row.liveRevenue.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Import Unlinked Live Gumroad Account Products + Bind Existing DB Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Remote Gumroad Account Products Discovery */}
        <div className="p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Discovered Gumroad Account Products ({unlinkedRemoteProducts.length})
            </h3>
            <button
              type="button"
              onClick={onOpenStudio}
              className="text-[11px] text-cyan-400 hover:text-cyan-300 font-medium"
            >
              Open Owner Studio
            </button>
          </div>

          {unlinkedRemoteProducts.length === 0 ? (
            <p className="text-xs text-slate-400 py-2">
              {remoteProducts.length > 0
                ? 'All active listings on your Gumroad account are linked via gumroad_product_id.'
                : 'No unlinked listings returned from Gumroad /v2/products yet.'}
            </p>
          ) : (
            <div className="divide-y divide-[#182131] border-y border-[#182131]">
              {unlinkedRemoteProducts.map((rp) => (
                <div
                  key={rp.gumroadProductId}
                  className="py-3 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-100 truncate">{rp.name}</div>
                    <div className="text-[11px] font-mono text-slate-400 truncate">
                      ID: {rp.gumroadProductId} · {rp.salesCount} sales · ${rp.revenueDollars.toFixed(2)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleImportRemoteProduct(rp)}
                    className="px-3 py-1.5 text-[11px] font-semibold text-cyan-200 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/35 rounded-lg flex items-center gap-1 shrink-0 whitespace-nowrap"
                  >
                    <PlusCircle className="w-3.5 h-3.5" />
                    Import & Link ID
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Manual Gumroad DB Field Binder (Strict DB Column Sync) */}
        <form
          onSubmit={handleBindExistingFields}
          className="p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Bind <code className="text-cyan-300 font-mono">gumroad_product_id</code> &{' '}
              <code className="text-cyan-300 font-mono">gumroad_url</code>
            </h3>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <select
              required
              value={bindTargetProductId}
              onChange={(e) => setBindTargetProductId(e.target.value)}
              className="px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-cyan-500"
            >
              <option value="">Select Catalog Product...</option>
              {scopedProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <input
              type="text"
              placeholder="gumroad_product_id"
              value={bindGumroadId}
              onChange={(e) => setBindGumroadId(e.target.value)}
              className="px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-cyan-500"
            />

            <input
              type="url"
              placeholder="https://gumroad.com/l/..."
              value={bindGumroadUrl}
              onChange={(e) => setBindGumroadUrl(e.target.value)}
              className="px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!bindTargetProductId || (!bindGumroadId.trim() && !bindGumroadUrl.trim())}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl transition-colors"
            >
              Save Fields to Product Record
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
