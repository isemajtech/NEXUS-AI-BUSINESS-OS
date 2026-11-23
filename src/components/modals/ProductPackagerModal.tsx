import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Product } from '../../types';
import { useOS } from '../../context/OSContext';
import { PAYPAL_QR_ASSETS } from '../../data/contentMachineProduct';
import { buildProductPdfAsset, triggerBlobDownload } from '../../lib/factoryClient';
import { authorizedApiFetch } from '../../lib/supabase';
import {
  X,
  Download,
  Printer,
  Copy,
  Check,
  CreditCard,
  QrCode,
  HeartHandshake,
  CheckCircle2,
  AlertCircle,
  FileText,
  Lock,
  Loader2,
  FileDown,
} from 'lucide-react';

interface DeliverableViewerModalProps {
  product: Product | null;
  onClose: () => void;
  subtitle?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function markdownToPrintableHtml(title: string, md: string): string {
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  let inTable = false;

  const formatInline = (str: string) =>
    escapeHtml(str)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      if (/^\|[\s|:-]+\|$/.test(trimmed)) {
        continue;
      }
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (!inTable) {
        html += '<table><thead><tr>';
        cells.forEach((c) => (html += `<th>${formatInline(c)}</th>`));
        html += '</tr></thead><tbody>';
        inTable = true;
      } else {
        html += '<tr>';
        cells.forEach((c) => (html += `<td>${formatInline(c)}</td>`));
        html += '</tr>';
      }
      continue;
    } else if (inTable) {
      html += '</tbody></table>';
      inTable = false;
    }

    if (trimmed.startsWith('### ')) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<h3>${formatInline(trimmed.slice(4))}</h3>`;
    } else if (trimmed.startsWith('## ')) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<h2>${formatInline(trimmed.slice(3))}</h2>`;
    } else if (trimmed.startsWith('# ')) {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<h1>${formatInline(trimmed.slice(2))}</h1>`;
    } else if (trimmed === '---') {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += '<hr />';
    } else if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      const itemText = trimmed.replace(/^([-*]|\d+\.)\s+/, '');
      html += `<li>${formatInline(itemText)}</li>`;
    } else if (trimmed === '') {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
    } else {
      if (inList) {
        html += '</ul>';
        inList = false;
      }
      html += `<p>${formatInline(trimmed)}</p>`;
    }
  }

  if (inList) html += '</ul>';
  if (inTable) html += '</tbody></table>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; line-height: 1.65; max-width: 820px; margin: 40px auto; padding: 0 24px; }
    h1 { font-size: 28px; border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 16px; }
    h2 { font-size: 20px; color: #1e293b; margin-top: 32px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; page-break-after: avoid; }
    h3 { font-size: 16px; color: #334155; margin-top: 20px; page-break-after: avoid; }
    p { margin: 10px 0; font-size: 14px; }
    ul { margin: 8px 0 16px 20px; font-size: 14px; }
    li { margin-bottom: 6px; }
    code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px; font-size: 13px; }
    hr { border: none; border-top: 1px solid #cbd5e1; margin: 24px 0; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
    th, td { border: 1px solid #cbd5e1; padding: 8px 10px; text-align: left; }
    th { background: #f8fafc; font-weight: 600; }
    @media print { body { margin: 0; padding: 12px; } }
  </style>
</head>
<body>${html}</body>
</html>`;
}

export function triggerFileDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export const DeliverableViewerModal: React.FC<DeliverableViewerModalProps> = ({
  product,
  onClose,
  subtitle,
}) => {
  const { businesses, updateProduct } = useOS();
  const [copied, setCopied] = useState(false);
  const [isBuildingPdf, setIsBuildingPdf] = useState(false);
  const [pdfFeedback, setPdfFeedback] = useState<string | null>(null);

  if (!product) return null;

  const content =
    product.deliverableContent ||
    `# ${product.name}\n\n${product.description}\n\nPrice: $${product.price.toFixed(2)} (${product.billingType})\nAccess URL: ${product.downloadOrAccessUrl || 'Configured upon purchase'}`;

  const businessName =
    businesses.find((b) => b.id === product.businessId)?.name || 'Personal AI Business OS';

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadHtml = () => {
    const html = markdownToPrintableHtml(product.name, content);
    triggerFileDownload(`${product.slug || 'digital-product'}.html`, html, 'text/html;charset=utf-8');
  };

  const handleDownloadMarkdown = () => {
    triggerFileDownload(`${product.slug || 'digital-product'}.md`, content, 'text/markdown;charset=utf-8');
  };

  const handleDownloadRealPdf = async () => {
    setIsBuildingPdf(true);
    setPdfFeedback(null);
    const res = await buildProductPdfAsset(product, businessName);
    setIsBuildingPdf(false);

    if (!res.success || !res.blob || !res.filename) {
      setPdfFeedback(res.error || 'Could not build PDF.');
      return;
    }

    if (res.storagePath || res.signedUrl) {
      updateProduct(product.id, {
        pdfStoragePath: res.storagePath || product.pdfStoragePath,
        factoryMetadata: {
          ...(product.factoryMetadata || {}),
          pdfFilename: res.filename,
          pdfPageCount: res.pageCount,
          pdfByteLength: res.byteLength,
          pdfBuiltAt: new Date().toISOString(),
          storageSynced: Boolean(res.storagePath),
        },
      });
    }

    triggerBlobDownload(res.filename, res.blob);
    setPdfFeedback(
      res.storagePath
        ? `Built ${res.pageCount}-page PDF & synced to Supabase Storage.`
        : `Downloaded ${res.pageCount}-page PDF deliverable.`
    );
  };

  const handlePrintPdf = () => {
    window.print();
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm print-modal-root">
      <div className="w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl bg-[#0e131d] border border-[#222c42] shadow-2xl overflow-hidden print-only-document">
        {/* Toolbar (hidden when printing to PDF) */}
        <div className="no-print flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 bg-[#121826] border-b border-[#1f293e]">
          <div className="flex items-center gap-2.5 min-w-0">
            <FileText className="w-4 h-4 text-cyan-400 shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-slate-100 truncate">{product.name}</h3>
              <p className="text-[11px] text-slate-400">
                {subtitle ||
                  `Digital Deliverable Preview · $${product.price.toFixed(2)} · ${product.billingType.replace('_', ' ')}`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#182032] hover:bg-[#202b42] border border-[#293652] rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy Text'}
            </button>

            <button
              onClick={handleDownloadMarkdown}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#182032] hover:bg-[#202b42] border border-[#293652] rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              .MD
            </button>

            <button
              onClick={handleDownloadHtml}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#182032] hover:bg-[#202b42] border border-[#293652] rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              HTML
            </button>

            <button
              onClick={handleDownloadRealPdf}
              disabled={isBuildingPdf}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              {isBuildingPdf ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <FileDown className="w-3.5 h-3.5" />
              )}
              {isBuildingPdf ? 'Building .PDF...' : 'Download .PDF'}
            </button>

            <button
              onClick={handlePrintPdf}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#182032] hover:bg-[#202b42] border border-[#293652] rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              Print
            </button>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-[#1a2234]"
              aria-label="Close Preview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {pdfFeedback && (
          <div className="no-print px-5 py-2 bg-emerald-500/10 border-b border-emerald-500/20 text-[11px] font-mono text-emerald-300">
            {pdfFeedback}
          </div>
        )}

        {/* Crisp Paper Editorial Document Body */}
        <div className="flex-1 overflow-y-auto bg-white text-slate-900 p-6 sm:p-10">
          {product.coverImageUrl && (
            <div className="max-w-3xl mx-auto mb-6 flex items-center gap-5 p-4 rounded-xl bg-slate-950 text-white border border-slate-800">
              <img
                src={product.coverImageUrl}
                alt={`${product.name} cover artwork`}
                referrerPolicy="no-referrer"
                className="w-24 h-30 object-cover rounded-lg border border-slate-700 shrink-0"
              />
              <div className="min-w-0">
                <div className="text-[11px] font-mono uppercase tracking-wider text-cyan-400">
                  {businessName} · Official Digital Edition
                </div>
                <div className="text-lg font-bold text-white mt-0.5">{product.name}</div>
                {product.pdfStoragePath && (
                  <div className="text-[11px] font-mono text-emerald-400 mt-1 truncate">
                    Vault Path: {product.pdfStoragePath}
                  </div>
                )}
              </div>
            </div>
          )}
          <div
            className="max-w-3xl mx-auto space-y-3 text-slate-800 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:text-slate-950 [&_h1]:border-b-2 [&_h1]:border-slate-900 [&_h1]:pb-2 [&_h1]:mb-4 [&_h2]:text-lg [&_h2]:font-bold [&_h2]:text-slate-900 [&_h2]:mt-6 [&_h2]:border-b [&_h2]:border-slate-200 [&_h2]:pb-1 [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-slate-800 [&_h3]:mt-4 [&_p]:text-sm [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_li]:text-sm [&_li]:my-1 [&_hr]:my-4 [&_hr]:border-slate-200 [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-xs [&_th]:bg-slate-100 [&_th]:border [&_th]:border-slate-300 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-slate-300 [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top"
            dangerouslySetInnerHTML={{
              __html: markdownToPrintableHtml(product.name, content).replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, ''),
            }}
          />
        </div>
      </div>
    </div>,
    document.body
  );
};

interface CheckoutModalProps {
  product: Product | null;
  onClose: () => void;
  onUnlockedDeliverable?: (product: Product) => void;
}

export const ProductCheckoutModal: React.FC<CheckoutModalProps> = ({
  product,
  onClose,
}) => {
  const [paymentMethod, setPaymentMethod] = useState<'stripe' | 'paypal' | 'tip'>('stripe');
  const [stripeStatus, setStripeStatus] = useState<{ configured: boolean; mode: string } | null>(null);
  const [isStripeLoading, setIsStripeLoading] = useState(false);
  const [stripeError, setStripeError] = useState<string | null>(null);

  const [buyerEmail, setBuyerEmail] = useState('');
  const [qrImgError, setQrImgError] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!product) return;
    setStripeError(null);

    authorizedApiFetch('/api/stripe/status')
      .then((r) => r.json())
      .then((data) => setStripeStatus(data))
      .catch(() => setStripeStatus({ configured: false, mode: 'unconfigured' }));
  }, [product]);

  if (!product) return null;

  const handleStripeCheckout = async () => {
    setIsStripeLoading(true);
    setStripeError(null);
    try {
      const resp = await authorizedApiFetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: product.id,
          businessId: product.businessId,
          ...(buyerEmail.trim() ? { buyerEmail: buyerEmail.trim() } : {}),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setStripeError(data.error || 'Could not initialize Stripe checkout.');
        setIsStripeLoading(false);
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      setStripeError(err?.message || 'Network error while connecting to Stripe.');
      setIsStripeLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl bg-[#0e131d] border border-[#222c42] shadow-2xl overflow-hidden max-h-[92vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 bg-[#121826] border-b border-[#1f293e]">
          <div>
            <h3 className="text-sm font-bold text-slate-100">{product.name}</h3>
            <p className="text-xs text-slate-400 mt-0.5 tabular-nums">
              Checkout · ${product.price.toFixed(2)} USD · {product.billingType.replace('_', ' ')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-[#1a2234]"
            aria-label="Close Checkout"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-5">
          {/* Payment Method Tabs */}
          <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-[#090d15] border border-[#1d2638]">
            <button
              type="button"
              onClick={() => setPaymentMethod('stripe')}
              className={`py-2 px-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                paymentMethod === 'stripe'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <CreditCard className="w-3.5 h-3.5" />
              Stripe Card
            </button>
            <button
              type="button"
              onClick={() => setPaymentMethod('paypal')}
              className={`py-2 px-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                paymentMethod === 'paypal'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <QrCode className="w-3.5 h-3.5" />
              PayPal QR
            </button>
            <button
              type="button"
              onClick={() => setPaymentMethod('tip')}
              className={`py-2 px-2 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-colors ${
                paymentMethod === 'tip'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <HeartHandshake className="w-3.5 h-3.5" />
              Tip Jar QR
            </button>
          </div>

          {/* Tab Content: Stripe Hosted Checkout (Server-Verified Fulfillment) */}
          {paymentMethod === 'stripe' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-[#131926] border border-[#222d43] space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200">Stripe Hosted Checkout</span>
                  <span className="text-xs text-slate-400">
                    {stripeStatus?.configured ? `Configured (${stripeStatus.mode})` : 'Server Key Needed'}
                  </span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Processes card and wallet payments via server-verified Stripe Checkout Sessions and webhook settlement before unlocking digital fulfillment.
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Receipt & Delivery Email (optional)
                </label>
                <input
                  type="email"
                  placeholder="buyer@example.com"
                  value={buyerEmail}
                  onChange={(e) => setBuyerEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              {!stripeStatus?.configured && (
                <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-start gap-2.5">
                  <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    Set <code className="font-mono text-amber-200">STRIPE_SECRET_KEY</code> and{' '}
                    <code className="font-mono text-amber-200">STRIPE_WEBHOOK_SECRET</code> on the server to process live Stripe payments.
                  </div>
                </div>
              )}

              {stripeError && (
                <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{stripeError}</span>
                </div>
              )}

              <button
                type="button"
                disabled={isStripeLoading || !stripeStatus?.configured}
                onClick={handleStripeCheckout}
                className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl transition-colors flex items-center justify-center gap-2"
              >
                <CreditCard className="w-4 h-4" />
                {isStripeLoading
                  ? 'Creating Stripe Session...'
                  : `Pay $${product.price.toFixed(2)} via Stripe Checkout`}
              </button>
            </div>
          )}

          {/* Tab Content: PayPal QR Checkout (Read-Only QR Display, No Client-Side Self-Completion) */}
          {(paymentMethod === 'paypal' || paymentMethod === 'tip') && (
            <div className="space-y-4">
              <div className="flex flex-col items-center p-4 rounded-xl bg-[#f4f7fb] text-slate-900 border border-slate-200">
                <div className="text-sm font-bold tracking-tight mb-1">
                  {paymentMethod === 'tip' ? 'Money Maker · Tip Jar' : 'Money Maker · PayPal Direct'}
                </div>
                <p className="text-xs text-slate-600 mb-3 tabular-nums">
                  {paymentMethod === 'tip'
                    ? 'Scan with PayPal app to send a voluntary contribution'
                    : `Scan with PayPal app to send $${product.price.toFixed(2)} USD`}
                </p>

                {!qrImgError[paymentMethod] ? (
                  <img
                    src={
                      paymentMethod === 'tip'
                        ? PAYPAL_QR_ASSETS.tipJarQr
                        : PAYPAL_QR_ASSETS.paymentQr
                    }
                    alt={paymentMethod === 'tip' ? 'Money Maker PayPal Tip Jar QR Code' : 'Money Maker PayPal Payment QR Code'}
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setQrImgError((prev) => ({ ...prev, [paymentMethod]: true }))
                    }
                    className="w-56 h-auto rounded-xl border border-slate-200 shadow-sm object-contain bg-white"
                  />
                ) : (
                  <div className="w-56 h-56 rounded-xl bg-slate-100 border border-slate-300 flex flex-col items-center justify-center p-4 text-center">
                    <QrCode className="w-10 h-10 text-slate-400 mb-2" />
                    <span className="text-xs font-semibold text-slate-700">Money Maker PayPal QR</span>
                  </div>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2.5">
                <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  {paymentMethod === 'tip' ? (
                    <span>
                      Direct PayPal tips are settled in PayPal and do not issue automated digital product licenses.
                    </span>
                  ) : (
                    <span>
                      Direct PayPal QR transfers require manual verification by the business owner before fulfillment. For instant verified checkout and immediate download delivery, use <strong>Stripe Card</strong> or <strong>Gumroad</strong>.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
