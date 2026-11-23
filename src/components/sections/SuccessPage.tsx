import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Product } from '../../types';
import { authorizedApiFetch } from '../../lib/supabase';
import {
  DeliverableViewerModal,
  markdownToPrintableHtml,
  triggerFileDownload,
} from '../modals/ProductPackagerModal';
import {
  CheckCircle2,
  AlertCircle,
  Download,
  FileText,
  ArrowLeft,
  Loader2,
  Mail,
  ShieldCheck,
} from 'lucide-react';

interface VerifySessionResponse {
  success: boolean;
  paymentStatus?: string;
  customerEmail?: string | null;
  customerName?: string | null;
  contentId?: string;
  productId?: string;
  amountTotal?: number | null;
  error?: string;
}

interface SuccessPageProps {
  sessionId: string | null;
  fallbackProductId?: string;
  onReturnHome: () => void;
}

export const SuccessPage: React.FC<SuccessPageProps> = ({
  sessionId,
  fallbackProductId,
  onReturnHome,
}) => {
  const { products, recordCustomerPurchase } = useOS();

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [purchaseData, setPurchaseData] = useState<VerifySessionResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>(
    "We couldn't verify your payment session. If you completed payment, check your email for your receipt and download link."
  );
  const [isViewerOpen, setIsViewerOpen] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setErrorMessage('Missing Stripe checkout session_id for verification.');
      setStatus('error');
      return;
    }

    let cancelled = false;
    setStatus('loading');

    authorizedApiFetch(`/api/verify-session?session_id=${encodeURIComponent(sessionId)}`)
      .then(async (res) => {
        const data: VerifySessionResponse = await res.json();
        if (cancelled) return;

        if (res.ok && data.success) {
          setPurchaseData(data);
          setStatus('success');

          const resolvedProductId = data.productId || data.contentId || fallbackProductId || '';
          const dedupeKey = `paio_stripe_recorded_${sessionId}`;
          let alreadyRecorded = false;
          try {
            alreadyRecorded = Boolean(sessionStorage.getItem(dedupeKey));
            if (!alreadyRecorded) {
              sessionStorage.setItem(dedupeKey, '1');
            }
          } catch {
            // ignore storage errors
          }

          if (!alreadyRecorded && resolvedProductId) {
            recordCustomerPurchase(
              resolvedProductId,
              data.customerName || 'Stripe Verified Buyer',
              data.customerEmail || 'buyer@stripe.verified',
              'Stripe Card Checkout (Verified)'
            );
          }
        } else {
          setErrorMessage(data?.error || 'Payment verification failed.');
          setStatus('error');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Verification error:', err);
        setErrorMessage('Network error while verifying your payment with Stripe.');
        setStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const resolvedProductId =
    purchaseData?.productId || purchaseData?.contentId || fallbackProductId || '';
  const purchasedProduct: Product | undefined =
    products.find((p) => p.id === resolvedProductId) || products[0];

  const deliverableText =
    purchasedProduct?.deliverableContent ||
    `# ${purchasedProduct?.name || 'Digital Product'}\n\n${
      purchasedProduct?.description || 'Verified digital product purchase.'
    }\n\nAccess URL: ${purchasedProduct?.downloadOrAccessUrl || 'Unlocked via Business OS'}`;

  const handleDirectHtmlDownload = () => {
    const title = purchasedProduct?.name || 'Digital Product';
    const slug = purchasedProduct?.slug || 'digital-product';
    const html = markdownToPrintableHtml(title, deliverableText);
    triggerFileDownload(`${slug}.html`, html, 'text/html;charset=utf-8');
  };

  const handleDirectMarkdownDownload = () => {
    const slug = purchasedProduct?.slug || 'digital-product';
    triggerFileDownload(`${slug}.md`, deliverableText, 'text/markdown;charset=utf-8');
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#07090e] text-slate-100 px-4">
        <div className="max-w-md w-full p-8 rounded-2xl bg-[#0e131d] border border-[#1e2638] text-center space-y-4">
          <Loader2 className="w-10 h-10 text-blue-400 animate-spin mx-auto" />
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-slate-100">
              Verifying your payment with Stripe...
            </h2>
            <p className="text-xs text-slate-400">
              Confirming payment status and unlocking your digital deliverable.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#07090e] text-slate-100 px-4">
        <div className="max-w-md w-full p-8 rounded-2xl bg-[#0e131d] border border-rose-500/30 text-center space-y-5">
          <div className="w-12 h-12 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center mx-auto">
            <AlertCircle className="w-6 h-6 text-rose-400" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-100">Verification Failed</h2>
            <p className="text-xs text-slate-400 leading-relaxed">{errorMessage}</p>
          </div>
          <button
            type="button"
            onClick={onReturnHome}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Return to Storefront
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#07090e] text-slate-100 px-4 py-10">
      <div className="max-w-lg w-full p-7 sm:p-8 rounded-2xl bg-[#0e131d] border border-emerald-500/30 shadow-2xl space-y-6">
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center mx-auto">
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <div>
            <div className="inline-flex items-center gap-1.5 text-[11px] font-mono text-emerald-400 uppercase tracking-wider mb-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Stripe Verified Fulfillment
            </div>
            <h1 className="text-2xl font-bold text-slate-100">Payment Successful!</h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Thank you for your purchase. Your digital product is unlocked and ready for download.
            </p>
          </div>
        </div>

        {/* Purchased Item & Receipt Summary */}
        <div className="p-4 rounded-xl bg-[#131927] border border-[#222d43] space-y-2.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-slate-400">Product</span>
            <span className="font-semibold text-slate-100 text-right">
              {purchasedProduct?.name || 'Digital Product Package'}
            </span>
          </div>
          {typeof purchaseData?.amountTotal === 'number' && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-400">Amount Paid</span>
              <span className="font-mono font-bold text-emerald-400 tabular-nums">
                ${purchaseData.amountTotal.toFixed(2)} USD
              </span>
            </div>
          )}
          {purchaseData?.customerEmail && (
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#1e273b]">
              <span className="text-slate-400 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5" />
                Receipt Email
              </span>
              <span className="font-medium text-slate-200">{purchaseData.customerEmail}</span>
            </div>
          )}
        </div>

        {/* Fulfillment Download Actions */}
        <div className="space-y-2.5">
          <button
            type="button"
            onClick={() => setIsViewerOpen(true)}
            className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2"
          >
            <FileText className="w-4 h-4" />
            Open Package & Save as PDF
          </button>

          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={handleDirectHtmlDownload}
              className="py-2.5 px-3 bg-[#172033] hover:bg-[#1f2b44] border border-[#293754] text-slate-200 text-xs font-medium rounded-xl transition-colors flex items-center justify-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
              Download .HTML
            </button>
            <button
              type="button"
              onClick={handleDirectMarkdownDownload}
              className="py-2.5 px-3 bg-[#172033] hover:bg-[#1f2b44] border border-[#293754] text-slate-200 text-xs font-medium rounded-xl transition-colors flex items-center justify-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
              Download .MD
            </button>
          </div>
        </div>

        <div className="pt-2 border-t border-[#1b2336] text-center">
          <button
            type="button"
            onClick={onReturnHome}
            className="text-xs font-medium text-slate-400 hover:text-slate-200 inline-flex items-center gap-1.5 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Return to Digital Products & Business OS
          </button>
        </div>
      </div>

      {isViewerOpen && purchasedProduct && (
        <DeliverableViewerModal
          product={purchasedProduct}
          onClose={() => setIsViewerOpen(false)}
        />
      )}
    </div>
  );
};
