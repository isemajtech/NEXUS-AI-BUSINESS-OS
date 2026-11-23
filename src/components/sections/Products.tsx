import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Product, ProductType, ProductStatus } from '../../types';
import { Badge, Modal, EmptyState } from '../common/UIComponents';
import {
  DeliverableViewerModal,
  ProductCheckoutModal,
} from '../modals/ProductPackagerModal';
import {
  FLAGSHIP_CONTENT_MACHINE_PRODUCT,
  PAYPAL_QR_ASSETS,
} from '../../data/contentMachineProduct';
import {
  buildProductPdfAsset,
  generateProductCoverAsset,
  triggerBlobDownload,
} from '../../lib/factoryClient';
import { authorizedApiFetch } from '../../lib/supabase';
import {
  PackageCheck,
  Plus,
  Send,
  Trash2,
  CheckCircle2,
  Lock,
  Sparkles,
  FileText,
  QrCode,
  Store,
  LayoutGrid,
  Rocket,
  Loader2,
  AlertCircle,
  HeartHandshake,
  RotateCcw,
  Image as ImageIcon,
  FileDown,
  ExternalLink,
  UploadCloud,
  Workflow,
  Copy,
  Check,
  TrendingUp,
} from 'lucide-react';
import { FactoryPipelinePanel } from './FactoryPipelinePanel';
import { LiveSalesView } from './LiveSalesView';

export const Products: React.FC = () => {
  const {
    products,
    factoryJobs,
    businesses,
    selectedBusinessId,
    productsViewMode: viewMode,
    setProductsViewMode: setViewMode,
    addProduct,
    updateProduct,
    submitProductForApproval,
    approveAndPublishProductDirect,
    deleteProduct,
    restoreFlagshipContentMachine,
  } = useOS();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);

  const [previewProduct, setPreviewProduct] = useState<Product | null>(null);
  const [checkoutProduct, setCheckoutProduct] = useState<Product | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [buildingAssetIds, setBuildingAssetIds] = useState<Record<string, boolean>>({});
  const [publishingGumroadIds, setPublishingGumroadIds] = useState<Record<string, boolean>>({});
  const [gumroadConfigured, setGumroadConfigured] = useState<boolean | null>(null);
  const [stripeStatus, setStripeStatus] = useState<{ configured: boolean; mode: string } | null>(null);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [copiedUrlKey, setCopiedUrlKey] = useState<'store' | 'ping' | null>(null);
  const [builtPdfBlobs, setBuiltPdfBlobs] = useState<Record<string, { filename: string; blob: Blob }>>({});

  // Manual Form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [businessId, setBusinessId] = useState(
    selectedBusinessId !== 'all' ? selectedBusinessId : businesses[0]?.id || 'biz-prime'
  );
  const [type, setType] = useState<ProductType>('digital_download');
  const [price, setPrice] = useState(19);
  const [billingType, setBillingType] = useState<Product['billingType']>('one_time');
  const [downloadOrAccessUrl, setDownloadOrAccessUrl] = useState('');
  const [stripePriceId, setStripePriceId] = useState('');
  const [deliverableContent, setDeliverableContent] = useState('');

  // AI Generator Form state
  const [aiTopic, setAiTopic] = useState('');
  const [aiAudience, setAiAudience] = useState(
    'Small business owners, solo entrepreneurs, and service founders'
  );
  const [aiType, setAiType] = useState<ProductType>('digital_download');
  const [aiPrice, setAiPrice] = useState(29);
  const [aiBillingType, setAiBillingType] = useState<Product['billingType']>('one_time');
  const [aiBusinessId, setAiBusinessId] = useState(
    selectedBusinessId !== 'all' ? selectedBusinessId : businesses[0]?.id || 'biz-prime'
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const filteredProducts =
    selectedBusinessId === 'all'
      ? products
      : products.filter((p) => p.businessId === selectedBusinessId);

  const publishedProducts = filteredProducts.filter((p) => p.status === 'published');
  const flagshipExists = products.some(
    (p) => p.id === FLAGSHIP_CONTENT_MACHINE_PRODUCT.id
  );

  const totalGrossRevenue = filteredProducts.reduce(
    (acc, p) => acc + (p.totalRevenue || 0),
    0
  );
  const draftsOrPendingCount = filteredProducts.filter(
    (p) => p.status === 'draft' || p.status === 'awaiting_approval'
  ).length;

  const showNotice = (msg: string) => {
    setStatusNotice(msg);
    setTimeout(() => {
      setStatusNotice((curr) => (curr === msg ? null : curr));
    }, 5000);
  };

  const handleBuildCoverAndPdf = async (prod: Product, autoDownloadPdf = false) => {
    setBuildingAssetIds((prev) => ({ ...prev, [prod.id]: true }));
    const bizName =
      businesses.find((b) => b.id === prod.businessId)?.name || 'Nexus Cloud Technologies';

    const [coverRes, pdfRes] = await Promise.all([
      generateProductCoverAsset(prod, bizName),
      buildProductPdfAsset(prod, bizName),
    ]);

    setBuildingAssetIds((prev) => ({ ...prev, [prod.id]: false }));

    if (!coverRes.success && !pdfRes.success) {
      showNotice(`Asset build failed: ${coverRes.error || pdfRes.error}`);
      return;
    }

    if (pdfRes.success && pdfRes.blob && pdfRes.filename) {
      setBuiltPdfBlobs((prev) => ({
        ...prev,
        [prod.id]: { filename: pdfRes.filename!, blob: pdfRes.blob! },
      }));
      if (autoDownloadPdf) {
        triggerBlobDownload(pdfRes.filename, pdfRes.blob);
      }
    }

    updateProduct(prod.id, {
      coverImageUrl: coverRes.coverDataUrl || prod.coverImageUrl,
      pdfStoragePath: pdfRes.storagePath || prod.pdfStoragePath,
      factoryMetadata: {
        ...(prod.factoryMetadata || {}),
        coverModel: coverRes.modelUsed,
        coverStoragePath: coverRes.storagePath || prod.factoryMetadata?.coverStoragePath,
        pdfFilename: pdfRes.filename || prod.factoryMetadata?.pdfFilename,
        pdfPageCount: pdfRes.pageCount || prod.factoryMetadata?.pdfPageCount,
        pdfByteLength: pdfRes.byteLength || prod.factoryMetadata?.pdfByteLength,
        pdfBuiltAt: pdfRes.success ? new Date().toISOString() : prod.factoryMetadata?.pdfBuiltAt,
        storageSynced: Boolean(coverRes.storagePath || pdfRes.storagePath),
      },
    });

    const syncedNote =
      coverRes.storagePath || pdfRes.storagePath
        ? 'Uploaded to private Supabase Storage.'
        : 'Saved locally (sign in to Supabase Auth in Settings to sync to private cloud buckets).';

    showNotice(
      `Built cover art${pdfRes.success ? ` & ${pdfRes.pageCount}-page .PDF` : ''} for "${prod.name}". ${syncedNote}`
    );
  };

  React.useEffect(() => {
    let active = true;
    Promise.all([
      authorizedApiFetch('/api/gumroad/status').then((r) => r.json()).catch(() => null),
      authorizedApiFetch('/api/stripe/status').then((r) => r.json()).catch(() => null),
      fetch('/api/health').then((r) => r.json()).catch(() => null),
    ]).then(([gumroad, stripe, health]) => {
      if (!active) return;
      if (typeof gumroad?.configured === 'boolean') {
        setGumroadConfigured(gumroad.configured);
      }
      if (typeof stripe?.configured === 'boolean') {
        setStripeStatus({
          configured: stripe.configured,
          mode: String(stripe.mode || 'test'),
        });
      }
      if (typeof health?.aiAvailable === 'boolean') {
        setAiAvailable(health.aiAvailable);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const storefrontUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/?store=1` : '/?store=1';
  const gumroadWebhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/gumroad/webhook`
      : '/api/gumroad/webhook';

  const handleCopyShareUrl = async (key: 'store' | 'ping', value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedUrlKey(key);
      showNotice(`Copied ${label}: ${value}`);
      setTimeout(() => setCopiedUrlKey((curr) => (curr === key ? null : curr)), 2000);
    } catch {
      showNotice(`${label}: ${value}`);
    }
  };

  const handlePublishToGumroad = async (prod: Product) => {
    if (prod.status !== 'published') {
      showNotice(
        `Governance Lock: "${prod.name}" must be Owner-Approved & Live before publishing to Gumroad.`
      );
      return;
    }

    setPublishingGumroadIds((prev) => ({ ...prev, [prod.id]: true }));
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
        showNotice(
          apprData?.error ||
            'Server Owner Publish Approval required. Sign in as the verified business owner to publish.'
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
        if (data?.missingSecret) {
          setGumroadConfigured(false);
        }
        showNotice(
          data?.error || 'Could not publish to Gumroad. Check server environment configuration.'
        );
        return;
      }

      setGumroadConfigured(true);
      updateProduct(prod.id, {
        gumroadProductId: data.gumroadProductId,
        gumroadUrl: data.gumroadUrl,
        downloadOrAccessUrl: prod.downloadOrAccessUrl || data.gumroadUrl,
        factoryMetadata: {
          ...(prod.factoryMetadata || {}),
          gumroadPublishedAt: new Date().toISOString(),
        },
      });
      showNotice(
        `${prod.gumroadProductId ? 'Updated' : 'Published'} "${prod.name}" on Gumroad (${data.gumroadUrl}).`
      );
    } catch (err: any) {
      showNotice(err?.message || 'Network error publishing product to Gumroad.');
    } finally {
      setPublishingGumroadIds((prev) => ({ ...prev, [prod.id]: false }));
    }
  };

  const handleCreateManual = (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedBizId = businessId || businesses[0]?.id || 'biz-prime';
    if (!name.trim()) return;

    const finalSlug =
      slug.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const created = addProduct({
      name: name.trim(),
      slug: finalSlug,
      description: description.trim(),
      businessId: resolvedBizId,
      type,
      price: Number(price) || 0,
      billingType,
      status: 'draft',
      downloadOrAccessUrl: downloadOrAccessUrl.trim(),
      stripePriceId: stripePriceId.trim() || undefined,
      deliverableContent: deliverableContent.trim() || undefined,
      deliverableFormat:
        type === 'template'
          ? 'template_pack'
          : type === 'saas' || type === 'api_service'
          ? 'saas_license'
          : 'pdf_guide',
    });

    setName('');
    setSlug('');
    setDescription('');
    setPrice(19);
    setDownloadOrAccessUrl('');
    setStripePriceId('');
    setDeliverableContent('');
    setIsAddModalOpen(false);
    showNotice(
      `Saved draft "${created.name}". Approve & deploy live or route to Approval Center when ready.`
    );
  };

  const handleGenerateWithAI = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiTopic.trim()) return;
    setIsGenerating(true);
    setAiError(null);

    const resolvedBizId = aiBusinessId || businesses[0]?.id || 'biz-prime';
    const bizName =
      businesses.find((b) => b.id === resolvedBizId)?.name ||
      'Nexus Cloud Technologies';

    try {
      const resp = await authorizedApiFetch('/api/ai/generate-product', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: aiTopic.trim(),
          targetAudience: aiAudience.trim(),
          productType: aiType,
          price: Number(aiPrice) || 19,
          billingType: aiBillingType,
          businessName: bizName,
        }),
      });

      const data = await resp.json();
      if (!resp.ok || !data?.product) {
        setAiError(
          data?.error || 'Could not generate digital product package.'
        );
        setIsGenerating(false);
        return;
      }

      const generatedName = String(data.product.name || aiTopic.trim());
      const created = addProduct({
        name: generatedName,
        slug: generatedName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, ''),
        description: String(data.product.description || ''),
        businessId: resolvedBizId,
        type: aiType,
        price: Number(aiPrice) || 19,
        billingType: aiBillingType,
        status: 'draft',
        deliverableFormat: data.product.deliverableFormat || 'pdf_guide',
        deliverableContent: data.product.deliverableContent || '',
      });

      setAiTopic('');
      setIsGenerating(false);
      setIsAiModalOpen(false);
      setPreviewProduct(created);
      showNotice(
        `AI packaged "${created.name}" as a draft. Review the deliverable and click "Approve & Deploy Live" when ready.`
      );
    } catch (err: any) {
      setAiError(err?.message || 'Network error calling AI Product Generator.');
      setIsGenerating(false);
    }
  };

  const getStatusBadge = (status: ProductStatus) => {
    switch (status) {
      case 'published':
        return <Badge variant="emerald">Live</Badge>;
      case 'awaiting_approval':
        return <Badge variant="amber">Pending Approval</Badge>;
      case 'archived':
        return <Badge variant="rose">Archived</Badge>;
      default:
        return <Badge variant="neutral">Draft</Badge>;
    }
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Studio Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <PackageCheck className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-mono font-medium text-cyan-400 uppercase tracking-wider">
              Digital Product Studio & Live Storefront
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">
              {viewMode === 'storefront'
              ? 'store.nexusai.com — Live Storefront'
              : viewMode === 'live_sales'
              ? 'Gumroad Live Sales & Conversion Metrics'
              : viewMode === 'factory'
              ? 'Digital Product Factory Orchestrator'
              : 'Digital Products Studio'}
          </h1>
          <p className="text-xs text-slate-400 mt-1 tabular-nums">
            {filteredProducts.length} Total Products · {publishedProducts.length} Live ·{' '}
            {draftsOrPendingCount} Draft / Pending · ${totalGrossRevenue.toFixed(2)} Gross Revenue
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Studio / Factory Pipeline / Live Storefront Switcher */}
          <div className="flex items-center p-1 rounded-xl bg-[#090d15] border border-[#1d2638]">
            <button
              type="button"
              onClick={() => setViewMode('studio')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewMode === 'studio'
                  ? 'bg-[#1a2438] text-slate-100 border border-[#2c3b5a]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Owner Studio
            </button>
            <button
              type="button"
              onClick={() => setViewMode('factory')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewMode === 'factory'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Workflow className="w-3.5 h-3.5" />
              Factory Pipeline{factoryJobs.length > 0 ? ` (${factoryJobs.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('live_sales')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewMode === 'live_sales'
                  ? 'bg-pink-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              Live Sales
            </button>
            <button
              type="button"
              onClick={() => setViewMode('storefront')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                viewMode === 'storefront'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Store className="w-3.5 h-3.5" />
              Live Storefront ({publishedProducts.length})
            </button>
          </div>

          {!flagshipExists && (
            <button
              type="button"
              onClick={() => {
                restoreFlagshipContentMachine();
                showNotice(
                  'Loaded "The 30-Day Small Business Content Machine ($19)" into live catalog.'
                );
              }}
              className="px-3 py-2 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Load $19 Content Machine
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setAiError(null);
              setIsAiModalOpen(true);
            }}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Generate with AI
          </button>

          <button
            type="button"
            onClick={() => setIsAddModalOpen(true)}
            className="px-3.5 py-2 text-xs font-semibold text-slate-100 bg-[#182133] hover:bg-[#212d45] border border-[#2c3a56] rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Create Manual
          </button>
          <a
            href="/?store=1"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3.5 py-2 text-xs font-semibold text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open Public Storefront
          </a>
        </div>
      </div>

      {/* Live Creation & Sales Readiness Strip */}
      <div className="p-4 rounded-2xl bg-[#0e131d] border border-[#1e2638] flex flex-col xl:flex-row xl:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                aiAvailable === true
                  ? 'bg-emerald-400'
                  : aiAvailable === false
                  ? 'bg-amber-400'
                  : 'bg-slate-500'
              }`}
            />
            <span className="text-slate-300 font-medium">
              Factory AI: {aiAvailable === true ? 'Gemini Online' : aiAvailable === false ? 'Deterministic Mode' : 'Checking'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-slate-300 font-medium">PayPal QR Direct: Active</span>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                stripeStatus?.configured ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span className="text-slate-300 font-medium">
              Stripe Card:{' '}
              {stripeStatus
                ? stripeStatus.configured
                  ? `Connected (${stripeStatus.mode})`
                  : 'Needs STRIPE_SECRET_KEY'
                : 'Checking'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                gumroadConfigured ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span className="text-slate-300 font-medium">
              Gumroad Sync:{' '}
              {gumroadConfigured === true
                ? 'Ready'
                : gumroadConfigured === false
                ? 'Needs GUMROAD_ACCESS_TOKEN'
                : 'Checking'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleCopyShareUrl('store', storefrontUrl, 'Public Storefront URL')}
            className="px-3 py-1.5 text-[11px] font-medium text-slate-200 bg-[#141b2a] hover:bg-[#1b2538] border border-[#24314a] rounded-lg flex items-center gap-1.5 whitespace-nowrap"
          >
            {copiedUrlKey === 'store' ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-cyan-400" />
            )}
            Copy Shareable Store URL
          </button>

          <button
            type="button"
            onClick={() => handleCopyShareUrl('ping', gumroadWebhookUrl, 'Gumroad Ping Webhook URL')}
            className="px-3 py-1.5 text-[11px] font-medium text-slate-200 bg-[#141b2a] hover:bg-[#1b2538] border border-[#24314a] rounded-lg flex items-center gap-1.5 whitespace-nowrap"
          >
            {copiedUrlKey === 'ping' ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5 text-pink-400" />
            )}
            Copy Gumroad Ping URL
          </button>
        </div>
      </div>

      {/* Transient Confirmation Banner */}
      {statusNotice && (
        <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{statusNotice}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            className="text-emerald-400 hover:text-emerald-200 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* VIEW MODE 1: OWNER STUDIO CATALOG */}
      {viewMode === 'studio' ? (
        filteredProducts.length === 0 ? (
          <EmptyState
            icon={<PackageCheck className="w-8 h-8 text-cyan-400" />}
            title="No Digital Products Yet"
            description="Generate a complete, ready-to-sell digital product with AI or package one manually. Approved products deploy directly to your live storefront."
            actionText="Generate Product with AI"
            onAction={() => setIsAiModalOpen(true)}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredProducts.map((prod) => {
              const biz = businesses.find((b) => b.id === prod.businessId);
              const hasPackage = Boolean(prod.deliverableContent);

              return (
                <div
                  key={prod.id}
                  className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] hover:border-[#2d3b57] transition-all flex flex-col justify-between space-y-4"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-300">
                        {prod.type.replace('_', ' ')}
                        {hasPackage ? ' · Pack Ready' : ''}
                        {prod.factoryMetadata?.pdfPageCount ? ` · ${prod.factoryMetadata.pdfPageCount}p PDF` : ''}
                      </span>
                      {getStatusBadge(prod.status)}
                    </div>

                    <div className="flex items-start gap-3">
                      {prod.coverImageUrl && (
                        <img
                          src={prod.coverImageUrl}
                          alt={`${prod.name} cover`}
                          referrerPolicy="no-referrer"
                          className="w-16 h-20 rounded-lg object-cover border border-[#283652] shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <h3 className="text-base font-bold text-slate-100 leading-snug">
                          {prod.name}
                        </h3>
                        <p className="text-xs text-slate-400 mt-0.5 truncate">
                          {biz?.name || 'Nexus Cloud Technologies'} ·{' '}
                          <span className="font-mono text-slate-500">/{prod.slug}</span>
                        </p>
                      </div>
                    </div>

                    <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                      {prod.description || 'Digital product package configured in catalog.'}
                    </p>

                    {prod.pdfStoragePath && (
                      <div className="text-[10px] font-mono text-emerald-400 truncate">
                        Vault: {prod.pdfStoragePath}
                      </div>
                    )}

                    {prod.gumroadUrl && (
                      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-pink-500/10 border border-pink-500/25 text-[11px]">
                        <span className="font-mono text-pink-300 truncate">
                          Gumroad ID: {prod.gumroadProductId || 'linked'}
                        </span>
                        <a
                          href={prod.gumroadUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-pink-200 hover:text-white font-semibold flex items-center gap-1 shrink-0"
                        >
                          Listing
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    {/* Pricing & Sales Metric Strip */}
                    <div className="p-3 rounded-xl bg-[#141b2b] border border-[#1f293d] flex items-center justify-between text-xs">
                      <div>
                        <div className="text-[10px] font-mono text-slate-400 uppercase">
                          Price
                        </div>
                        <div className="text-sm font-bold font-mono text-slate-100 tabular-nums">
                          ${prod.price.toFixed(2)}
                          <span className="text-[11px] text-slate-400 font-normal">
                            {' '}
                            / {prod.billingType.replace('_', ' ')}
                          </span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-mono text-slate-400 uppercase">
                          Orders / Gross
                        </div>
                        <div className="text-sm font-bold font-mono text-emerald-400 tabular-nums">
                          {prod.salesCount} / ${prod.totalRevenue.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {/* Deliverable + Checkout + Factory Asset Action Row */}
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewProduct(prod)}
                        className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#172033] hover:bg-[#1e2a42] border border-[#283552] rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <FileText className="w-3.5 h-3.5 text-cyan-400" />
                        View / .PDF
                      </button>
                      <button
                        type="button"
                        onClick={() => setCheckoutProduct(prod)}
                        className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#172033] hover:bg-[#1e2a42] border border-[#283552] rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <QrCode className="w-3.5 h-3.5 text-emerald-400" />
                        Checkout / QR
                      </button>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={Boolean(buildingAssetIds[prod.id])}
                        onClick={() => handleBuildCoverAndPdf(prod, false)}
                        className="flex-1 px-3 py-1.5 text-[11px] font-semibold text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 disabled:opacity-60 border border-cyan-500/30 rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        {buildingAssetIds[prod.id] ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5" />
                        )}
                        {buildingAssetIds[prod.id]
                          ? 'Building Cover & .PDF...'
                          : prod.coverImageUrl
                          ? 'Rebuild Cover & .PDF'
                          : 'Build Cover & .PDF'}
                      </button>

                      {builtPdfBlobs[prod.id] && (
                        <button
                          type="button"
                          onClick={() =>
                            triggerBlobDownload(
                              builtPdfBlobs[prod.id].filename,
                              builtPdfBlobs[prod.id].blob
                            )
                          }
                          className="px-2.5 py-1.5 text-[11px] font-semibold text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg flex items-center gap-1 whitespace-nowrap"
                        >
                          <FileDown className="w-3.5 h-3.5" />
                          .PDF
                        </button>
                      )}
                    </div>

                    {/* Phase 3 Gumroad Distribution Control (Approval-Gated) */}
                    {prod.status === 'published' ? (
                      <button
                        type="button"
                        disabled={Boolean(publishingGumroadIds[prod.id])}
                        onClick={() => handlePublishToGumroad(prod)}
                        title={
                          gumroadConfigured === false
                            ? 'Requires GUMROAD_ACCESS_TOKEN configured in server environment secrets'
                            : 'Push approved listing to Gumroad API v2'
                        }
                        className="w-full px-3 py-1.5 text-[11px] font-semibold text-pink-200 bg-pink-500/10 hover:bg-pink-500/20 disabled:opacity-60 border border-pink-500/30 rounded-lg flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        {publishingGumroadIds[prod.id] ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <UploadCloud className="w-3.5 h-3.5" />
                        )}
                        {publishingGumroadIds[prod.id]
                          ? 'Syncing with Gumroad...'
                          : prod.gumroadProductId
                          ? 'Update Listing on Gumroad'
                          : 'Publish to Gumroad'}
                      </button>
                    ) : (
                      <div className="px-2.5 py-1.5 rounded-lg bg-[#121928] border border-[#1d273c] text-[10px] font-mono text-slate-400 flex items-center gap-1.5">
                        <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                        <span>Owner Approval required before pushing to Gumroad</span>
                      </div>
                    )}

                    {/* Governance & Deployment Bar */}
                    <div className="flex items-center justify-between gap-2 pt-2.5 border-t border-[#1a2335]">
                      {prod.status === 'draft' ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              submitProductForApproval(prod.id);
                              showNotice(
                                `"${prod.name}" sent to Approval Center for governance review.`
                              );
                            }}
                            className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-colors flex items-center gap-1 whitespace-nowrap"
                          >
                            <Send className="w-3 h-3" />
                            Route to Queue
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              approveAndPublishProductDirect(prod.id);
                              showNotice(
                                `Owner authorized & deployed "${prod.name}" live on store.nexusai.com.`
                              );
                            }}
                            className="px-2.5 py-1.5 text-[11px] font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors flex items-center gap-1 whitespace-nowrap"
                          >
                            <Rocket className="w-3 h-3" />
                            Approve & Deploy Live
                          </button>
                        </div>
                      ) : prod.status === 'awaiting_approval' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-mono text-amber-400 flex items-center gap-1">
                            <Lock className="w-3 h-3" />
                            In Approval Queue
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              approveAndPublishProductDirect(prod.id);
                              showNotice(
                                `Owner authorized & deployed "${prod.name}" live.`
                              );
                            }}
                            className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors whitespace-nowrap"
                          >
                            Deploy Live
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setCheckoutProduct(prod)}
                          className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Live on Storefront · Open Checkout
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => deleteProduct(prod.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-[#182133] transition-colors shrink-0"
                        title="Delete Product"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : viewMode === 'factory' ? (
        /* VIEW MODE 2: PHASE 4 UNIFIED DIGITAL PRODUCT FACTORY PIPELINE */
        <FactoryPipelinePanel
          onInspectProduct={(p) => setPreviewProduct(p)}
          onCachePdfBlob={(pid, filename, blob) =>
            setBuiltPdfBlobs((prev) => ({ ...prev, [pid]: { filename, blob } }))
          }
          onNotify={showNotice}
        />
      ) : viewMode === 'live_sales' ? (
        /* VIEW MODE 3: LIVE SALES & CONVERSION TELEMETRY (RECHARTS + GUMROAD DB FIELDS) */
        <LiveSalesView
          onNotify={showNotice}
          onOpenStudio={() => setViewMode('studio')}
        />
      ) : (
        /* VIEW MODE 4: LIVE PUBLIC STOREFRONT PREVIEW */
        <div className="space-y-6">
          {publishedProducts.length === 0 ? (
            <EmptyState
              icon={<Store className="w-8 h-8 text-emerald-400" />}
              title="No Live Storefront Products Yet"
              description="Approve a draft digital product in Owner Studio to publish it live to store.nexusai.com for customer purchases."
              actionText="Return to Owner Studio"
              onAction={() => setViewMode('studio')}
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {publishedProducts.map((prod) => (
                <div
                  key={prod.id}
                  className="p-6 rounded-2xl bg-[#0f1422] border border-[#222d44] flex flex-col justify-between space-y-5"
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-emerald-400">
                        Instant Digital Delivery · {prod.type.replace('_', ' ')}
                      </span>
                      <span className="text-xl font-bold font-mono text-slate-100 tabular-nums">
                        ${prod.price.toFixed(2)}
                      </span>
                    </div>

                    <div className="flex items-start gap-4">
                      {prod.coverImageUrl && (
                        <img
                          src={prod.coverImageUrl}
                          alt={`${prod.name} cover`}
                          referrerPolicy="no-referrer"
                          className="w-20 h-25 rounded-xl object-cover border border-[#283652] shrink-0"
                        />
                      )}
                      <div>
                        <h2 className="text-lg font-bold text-slate-100">{prod.name}</h2>
                        <p className="text-xs sm:text-sm text-slate-300 leading-relaxed mt-1">
                          {prod.description}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 pt-2 border-t border-[#1c2539]">
                    <button
                      type="button"
                      onClick={() => setCheckoutProduct(prod)}
                      className="flex-1 py-2.5 px-4 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                    >
                      <QrCode className="w-4 h-4" />
                      Buy Now — ${prod.price.toFixed(2)} (PayPal / Card)
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewProduct(prod)}
                      className="py-2.5 px-3.5 text-xs font-medium text-slate-200 bg-[#172033] hover:bg-[#1e2a42] border border-[#293754] rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <FileText className="w-3.5 h-3.5 text-cyan-400" />
                      Inspect Package
                    </button>
                    {prod.gumroadUrl && (
                      <a
                        href={prod.gumroadUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="py-2.5 px-3.5 text-xs font-semibold text-pink-200 bg-pink-500/15 hover:bg-pink-500/25 border border-pink-500/35 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
                      >
                        Gumroad
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Direct PayPal QR & Tip Jar Strip */}
          <div className="p-6 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-slate-100 flex items-center gap-2">
                  <HeartHandshake className="w-4 h-4 text-cyan-400" />
                  Money Maker — Direct PayPal & Tip Jar
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Live PayPal QR codes active for instant mobile payments and buyer tips.
                </p>
              </div>
              <span className="text-xs font-mono text-emerald-400">
                store.nexusai.com · Payments Active
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl bg-[#f4f7fb] text-slate-900 flex items-center gap-4 border border-slate-200">
                <img
                  src={PAYPAL_QR_ASSETS.paymentQr}
                  alt="Money Maker PayPal QR Code"
                  referrerPolicy="no-referrer"
                  className="w-24 h-28 rounded-lg object-contain bg-white border border-slate-200 shrink-0"
                />
                <div className="space-y-1">
                  <div className="text-sm font-bold">Money Maker — PayPal Direct</div>
                  <p className="text-xs text-slate-600">
                    Scan with the PayPal app to complete any digital product order.
                  </p>
                </div>
              </div>

              <div className="p-4 rounded-xl bg-[#f4f7fb] text-slate-900 flex items-center gap-4 border border-slate-200">
                <img
                  src={PAYPAL_QR_ASSETS.tipJarQr}
                  alt="Money Maker PayPal Tip Jar QR Code"
                  referrerPolicy="no-referrer"
                  className="w-24 h-28 rounded-lg object-contain bg-white border border-slate-200 shrink-0"
                />
                <div className="space-y-1">
                  <div className="text-sm font-bold">Money Maker — Tip Jar</div>
                  <p className="text-xs text-slate-600">
                    Scan to leave an appreciation tip or custom contribution.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI Product Generator Modal */}
      <Modal
        isOpen={isAiModalOpen}
        onClose={() => !isGenerating && setIsAiModalOpen(false)}
        title="Generate Full Digital Product with Gemini AI"
        maxWidth="lg"
      >
        <form onSubmit={handleGenerateWithAI} className="space-y-4">
          <div className="p-3.5 rounded-xl bg-violet-500/10 border border-violet-500/25 text-xs text-slate-300 leading-relaxed">
            Gemini AI writes a complete, sellable digital product package (quick-start guide, copy-paste templates, workflows, and commercial terms) ready to inspect, export as PDF, and deploy live.
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Product Topic / Concept *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Local Plumber & HVAC Lead Generation Email & SMS Vault"
              value={aiTopic}
              onChange={(e) => setAiTopic(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Target Buyer / Niche
            </label>
            <input
              type="text"
              value={aiAudience}
              onChange={(e) => setAiAudience(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Product Format
              </label>
              <select
                value={aiType}
                onChange={(e) => setAiType(e.target.value as ProductType)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
              >
                <option value="digital_download">Digital Playbook / PDF</option>
                <option value="template">Templates & Swipe Files</option>
                <option value="course">Mini-Course / Guide</option>
                <option value="saas">SaaS Toolkit / SOPs</option>
                <option value="newsletter">Paid Briefing Series</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Price (USD)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={aiPrice}
                onChange={(e) => setAiPrice(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Billing Model
              </label>
              <select
                value={aiBillingType}
                onChange={(e) =>
                  setAiBillingType(e.target.value as Product['billingType'])
                }
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
              >
                <option value="one_time">One-Time</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Business Venture
            </label>
            <select
              value={aiBusinessId}
              onChange={(e) => setAiBusinessId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          {aiError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{aiError}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              disabled={isGenerating}
              onClick={() => setIsAiModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isGenerating || !aiTopic.trim()}
              className="px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 disabled:opacity-50 rounded-lg shadow-sm flex items-center gap-2"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Packaging Product with Gemini...
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  Generate & Package Draft
                </>
              )}
            </button>
          </div>
        </form>
      </Modal>

      {/* Manual Create Product Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Create Digital Product Manually"
        maxWidth="lg"
      >
        <form onSubmit={handleCreateManual} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Product Name *
              </label>
              <input
                type="text"
                required
                placeholder="e.g. Agency Onboarding Kit"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Business Venture *
              </label>
              <select
                required
                value={businessId}
                onChange={(e) => setBusinessId(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Product Type
              </label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ProductType)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="digital_download">Digital Download</option>
                <option value="template">Code / Design Template</option>
                <option value="saas">SaaS Subscription</option>
                <option value="api_service">API Service Access</option>
                <option value="course">Educational Course</option>
                <option value="newsletter">Paid Newsletter</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Billing Model
              </label>
              <select
                value={billingType}
                onChange={(e) =>
                  setBillingType(e.target.value as Product['billingType'])
                }
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="one_time">One-Time Purchase</option>
                <option value="monthly">Monthly Recurring</option>
                <option value="yearly">Yearly Recurring</option>
                <option value="free">Free / Lead Magnet</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Price (USD)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={price}
                onChange={(e) => setPrice(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Delivery URL (optional)
              </label>
              <input
                type="text"
                placeholder="https://store.nexusai.com/access/..."
                value={downloadOrAccessUrl}
                onChange={(e) => setDownloadOrAccessUrl(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Stripe Price ID (optional)
              </label>
              <input
                type="text"
                placeholder="price_1..."
                value={stripePriceId}
                onChange={(e) => setStripePriceId(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Storefront Description
            </label>
            <textarea
              rows={2}
              placeholder="What outcome does this digital product deliver?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Deliverable Content (Markdown — enables instant HTML/MD/PDF export)
            </label>
            <textarea
              rows={5}
              placeholder="# Guide Title&#10;&#10;Paste your guide, templates, or checklist in Markdown..."
              value={deliverableContent}
              onChange={(e) => setDeliverableContent(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsAddModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Save Draft
            </button>
          </div>
        </form>
      </Modal>

      {/* Deliverable White-Paper Viewer & PDF Export Modal */}
      <DeliverableViewerModal
        product={previewProduct}
        onClose={() => setPreviewProduct(null)}
      />

      {/* PayPal QR + Stripe Checkout Modal */}
      <ProductCheckoutModal
        product={checkoutProduct}
        onClose={() => setCheckoutProduct(null)}
        onUnlockedDeliverable={(unlocked) => setPreviewProduct(unlocked)}
      />
    </div>
  );
};
