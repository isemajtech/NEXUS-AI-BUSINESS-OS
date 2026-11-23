import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Product } from '../../types';
import { PAYPAL_QR_ASSETS } from '../../data/contentMachineProduct';
import {
  DeliverableViewerModal,
  ProductCheckoutModal,
} from '../modals/ProductPackagerModal';
import {
  Store,
  QrCode,
  FileText,
  HeartHandshake,
  ArrowLeft,
  ExternalLink,
  CheckCircle2,
} from 'lucide-react';

interface PublicStorefrontPageProps {
  onReturnToOS: () => void;
}

export const PublicStorefrontPage: React.FC<PublicStorefrontPageProps> = ({
  onReturnToOS,
}) => {
  const { products, businesses } = useOS();
  const [checkoutProduct, setCheckoutProduct] = useState<Product | null>(null);
  const [unlockedProduct, setUnlockedProduct] = useState<Product | null>(null);
  const [previewProduct, setPreviewProduct] = useState<Product | null>(null);

  const publishedProducts = products.filter((p) => p.status === 'published');

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100">
      {/* Clean 3-Zone Top Bar */}
      <header className="border-b border-[#1b2232] bg-[#0a0d14]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="/?store=1"
            className="text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
          >
            Nexus AI Store
          </a>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
            <a
              href="#catalog"
              className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              Digital Catalog
            </a>
            <a
              href="#paypal-direct"
              className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              PayPal Direct
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onReturnToOS}
              className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#141b2a] hover:bg-[#1c2538] border border-[#26334d] rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Owner Console
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-12">
        {/* Storefront Hero */}
        <section className="space-y-3 border-b border-[#192132] pb-8">
          <p className="text-xs font-mono text-emerald-400 uppercase tracking-wider">
            Instant Digital Delivery · Verified Checkout
          </p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-100 max-w-2xl [text-wrap:balance]">
            Turnkey Digital Playbooks, Templates & Business Systems
          </h1>
          <p className="text-sm text-slate-400 max-w-2xl leading-relaxed">
            Every product unlocks immediate formatted download (PDF, Markdown & Printable HTML) upon payment via Stripe Card, PayPal Direct QR, or Gumroad.
          </p>
        </section>

        {/* Published Products Catalog */}
        <section id="catalog" className="space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <Store className="w-4 h-4 text-emerald-400" />
              Available Digital Releases ({publishedProducts.length})
            </h2>
          </div>

          {publishedProducts.length === 0 ? (
            <div className="p-10 rounded-2xl bg-[#0e131d] border border-[#1e2638] text-center space-y-3">
              <p className="text-sm font-semibold text-slate-200">
                No products are live on the storefront yet.
              </p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Open the Owner Console, create or package a digital product, and approve it to publish live here.
              </p>
              <button
                type="button"
                onClick={onReturnToOS}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl transition-colors"
              >
                Open Owner Console
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {publishedProducts.map((prod) => {
                const biz = businesses.find((b) => b.id === prod.businessId);
                return (
                  <article
                    key={prod.id}
                    className="p-6 rounded-2xl bg-[#0e131d] border border-[#1e273a] flex flex-col justify-between space-y-5"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3 text-xs text-slate-400">
                        <span className="truncate">
                          {biz?.name || 'Nexus Cloud Technologies'} ·{' '}
                          {prod.type.replace(/_/g, ' ')}
                        </span>
                        <span className="text-xl font-bold font-mono tabular-nums text-slate-100 shrink-0">
                          ${prod.price.toFixed(2)}
                        </span>
                      </div>

                      <div className="flex items-start gap-4">
                        {prod.coverImageUrl ? (
                          <img
                            src={prod.coverImageUrl}
                            alt={`${prod.name} cover`}
                            referrerPolicy="no-referrer"
                            className="w-20 h-25 rounded-xl object-cover border border-[#283652] shrink-0"
                          />
                        ) : (
                          <div className="w-20 h-25 rounded-xl bg-gradient-to-br from-[#141e33] to-[#0f172a] border border-[#263450] flex items-center justify-center shrink-0">
                            <FileText className="w-6 h-6 text-cyan-400" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <h3 className="text-lg font-bold text-slate-100 leading-snug">
                            {prod.name}
                          </h3>
                          <p className="text-xs sm:text-sm text-slate-300 leading-relaxed mt-1.5">
                            {prod.description}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 pt-3 border-t border-[#1a2234]">
                      <button
                        type="button"
                        onClick={() => setCheckoutProduct(prod)}
                        className="flex-1 py-2.5 px-4 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                      >
                        <QrCode className="w-4 h-4" />
                        Buy Now — ${prod.price.toFixed(2)}
                      </button>

                      <button
                        type="button"
                        onClick={() => setPreviewProduct(prod)}
                        className="py-2.5 px-3.5 text-xs font-medium text-slate-200 bg-[#172033] hover:bg-[#1e2a42] border border-[#293754] rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <FileText className="w-3.5 h-3.5 text-cyan-400" />
                        Preview
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
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {/* Direct PayPal QR & Tip Jar */}
        <section
          id="paypal-direct"
          className="p-6 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-bold text-slate-100 flex items-center gap-2">
                <HeartHandshake className="w-4 h-4 text-cyan-400" />
                Money Maker — Direct PayPal & Tip Jar
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Scan with the PayPal app for instant mobile payment or tips.
              </p>
            </div>
            <span className="text-xs text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Direct PayPal Active
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl bg-[#f4f7fb] text-slate-900 flex items-center gap-4 border border-slate-200">
              <img
                src={PAYPAL_QR_ASSETS.paymentQr}
                alt="Money Maker PayPal Direct QR Code"
                referrerPolicy="no-referrer"
                className="w-24 h-28 rounded-lg object-contain bg-white border border-slate-200 shrink-0"
              />
              <div className="space-y-1">
                <div className="text-sm font-bold">Money Maker — PayPal Direct</div>
                <p className="text-xs text-slate-600">
                  Scan with the PayPal app to complete any digital product purchase.
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
        </section>
      </main>

      <ProductCheckoutModal
        product={checkoutProduct}
        onClose={() => setCheckoutProduct(null)}
        onUnlockedDeliverable={(unlocked) => setUnlockedProduct(unlocked)}
      />

      <DeliverableViewerModal
        product={unlockedProduct || previewProduct}
        onClose={() => {
          setUnlockedProduct(null);
          setPreviewProduct(null);
        }}
        subtitle={
          unlockedProduct
            ? 'Payment Recorded · Instant Download Unlocked'
            : 'Public Storefront Preview — Complete Purchase to Download PDF'
        }
      />
    </div>
  );
};
