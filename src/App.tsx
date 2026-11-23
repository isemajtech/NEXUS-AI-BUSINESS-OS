import React, { useState, useEffect } from 'react';
import { OSProvider, useOS } from './context/OSContext';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { MobileNav } from './components/layout/MobileNav';
import { LockScreen } from './components/auth/LockScreen';
import { Modal } from './components/common/UIComponents';
import { SupabaseConnectModal } from './components/modals/SupabaseConnectModal';
import { DeliverableViewerModal } from './components/modals/ProductPackagerModal';
import { SuccessPage } from './components/sections/SuccessPage';
import { PublicStorefrontPage } from './components/sections/PublicStorefrontPage';

// Sections
import { CommandCenter } from './components/sections/CommandCenter';
import { AIAssistant } from './components/sections/AIAssistant';
import { Businesses } from './components/sections/Businesses';
import { WebsitesApps } from './components/sections/WebsitesApps';
import { AIWorkforce } from './components/sections/AIWorkforce';
import { Products } from './components/sections/Products';
import { OrdersCustomers } from './components/sections/OrdersCustomers';
import { Marketing } from './components/sections/Marketing';
import { FinancialCenter } from './components/sections/FinancialCenter';
import { Automations } from './components/sections/Automations';
import { ApprovalCenter } from './components/sections/ApprovalCenter';
import { ActivityHistory } from './components/sections/ActivityHistory';
import { Settings } from './components/sections/Settings';
import { DeploymentStatus, ProductType } from './types';

const MainShell: React.FC = () => {
  const {
    activeSection,
    setActiveSection,
    ownerProfile,
    businesses,
    products,
    addBusiness,
    addProject,
    addProduct,
    recordCustomerPurchase,
    selectedBusinessId,
  } = useOS();

  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [isSupabaseModalOpen, setIsSupabaseModalOpen] = useState(false);
  const [checkoutBanner, setCheckoutBanner] = useState<{
    type: 'success' | 'cancelled' | 'verifying' | 'error';
    productId?: string;
    message: string;
  } | null>(null);
  const [unlockedDeliverableId, setUnlockedDeliverableId] = useState<string | null>(null);
  const [isPublicStoreRoute, setIsPublicStoreRoute] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return window.location.pathname === '/store' || params.get('store') === '1';
  });
  const [checkoutSuccessState, setCheckoutSuccessState] = useState<{
    active: boolean;
    sessionId: string | null;
    productId: string;
  }>(() => {
    const params = new URLSearchParams(window.location.search);
    const isSuccessRoute =
      window.location.pathname === '/success' || params.get('checkout') === 'success';
    return {
      active: isSuccessRoute,
      sessionId: params.get('session_id'),
      productId: params.get('productId') || '',
    };
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutState = params.get('checkout');

    if (checkoutState === 'cancelled') {
      const productId = params.get('productId') || '';
      window.history.replaceState({}, '', '/');
      setActiveSection('products');
      setCheckoutBanner({
        type: 'cancelled',
        productId,
        message: 'Stripe checkout was cancelled. You can complete checkout anytime with Card or PayPal QR.',
      });
    }
  }, []);

  // Global Quick Modals
  const [isGlobalBizModalOpen, setIsGlobalBizModalOpen] = useState(false);
  const [bizName, setBizName] = useState('');
  const [bizIndustry, setBizIndustry] = useState('Software & Technology');
  const [bizDesc, setBizDesc] = useState('');

  const [isGlobalProjectModalOpen, setIsGlobalProjectModalOpen] = useState(false);
  const [projName, setProjName] = useState('');
  const [projBizId, setProjBizId] = useState(selectedBusinessId !== 'all' ? selectedBusinessId : (businesses[0]?.id || ''));
  const [projUrl, setProjUrl] = useState('');
  const [projStack, setProjStack] = useState('React, TypeScript, Tailwind');
  const [projStatus, setProjStatus] = useState<DeploymentStatus>('live');

  const [isGlobalProductModalOpen, setIsGlobalProductModalOpen] = useState(false);
  const [prodName, setProdName] = useState('');
  const [prodBizId, setProdBizId] = useState(selectedBusinessId !== 'all' ? selectedBusinessId : (businesses[0]?.id || ''));
  const [prodPrice, setProdPrice] = useState(49);
  const [prodType, setProdType] = useState<ProductType>('saas');

  if (checkoutSuccessState.active) {
    return (
      <SuccessPage
        sessionId={checkoutSuccessState.sessionId}
        fallbackProductId={checkoutSuccessState.productId}
        onReturnHome={() => {
          window.history.replaceState({}, '', '/');
          setCheckoutSuccessState({ active: false, sessionId: null, productId: '' });
          setActiveSection('products');
        }}
      />
    );
  }

  if (isPublicStoreRoute) {
    return (
      <PublicStorefrontPage
        onReturnToOS={() => {
          window.history.replaceState({}, '', '/');
          setIsPublicStoreRoute(false);
        }}
      />
    );
  }

  if (ownerProfile.isLocked) {
    return <LockScreen />;
  }

  const handleCreateQuickBusiness = (e: React.FormEvent) => {
    e.preventDefault();
    if (!bizName.trim()) return;
    addBusiness({
      name: bizName.trim(),
      slug: bizName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      industry: bizIndustry,
      currency: 'USD',
      description: bizDesc.trim(),
      status: 'active',
    });
    setBizName('');
    setBizDesc('');
    setIsGlobalBizModalOpen(false);
  };

  const handleCreateQuickProject = (e: React.FormEvent) => {
    e.preventDefault();
    if (!projName.trim() || !projBizId) return;
    addProject({
      name: projName.trim(),
      businessId: projBizId,
      description: 'Registered via Command Center Quick Launcher',
      websiteUrl: projUrl.trim(),
      techStack: projStack.split(',').map((s) => s.trim()).filter(Boolean),
      deploymentStatus: projStatus,
      lastCheckedDate: new Date().toISOString(),
    });
    setProjName('');
    setProjUrl('');
    setIsGlobalProjectModalOpen(false);
  };

  const handleCreateQuickProduct = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prodName.trim() || !prodBizId) return;
    addProduct({
      name: prodName.trim(),
      slug: prodName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      description: 'Draft digital product ready for pricing verification',
      businessId: prodBizId,
      type: prodType,
      price: Number(prodPrice) || 0,
      billingType: 'monthly',
      status: 'draft',
    });
    setProdName('');
    setProdPrice(49);
    setIsGlobalProductModalOpen(false);
  };

  const renderActiveSection = () => {
    switch (activeSection) {
      case 'command_center':
        return (
          <CommandCenter
            onOpenNewBusinessModal={() => setIsGlobalBizModalOpen(true)}
            onOpenNewProjectModal={() => setIsGlobalProjectModalOpen(true)}
            onOpenNewProductModal={() => setIsGlobalProductModalOpen(true)}
            onOpenSupabaseModal={() => setIsSupabaseModalOpen(true)}
          />
        );
      case 'ai_assistant':
        return <AIAssistant />;
      case 'businesses':
        return <Businesses />;
      case 'websites_apps':
        return <WebsitesApps />;
      case 'ai_workforce':
        return <AIWorkforce />;
      case 'products':
        return <Products />;
      case 'orders_customers':
        return <OrdersCustomers />;
      case 'marketing':
        return <Marketing />;
      case 'financial_center':
        return <FinancialCenter />;
      case 'automations':
        return <Automations />;
      case 'approval_center':
        return <ApprovalCenter />;
      case 'activity_history':
        return <ActivityHistory />;
      case 'settings':
        return <Settings />;
      default:
        return (
          <CommandCenter
            onOpenNewBusinessModal={() => setIsGlobalBizModalOpen(true)}
            onOpenNewProjectModal={() => setIsGlobalProjectModalOpen(true)}
            onOpenNewProductModal={() => setIsGlobalProductModalOpen(true)}
            onOpenSupabaseModal={() => setIsSupabaseModalOpen(true)}
          />
        );
    }
  };

  const isAssistant = activeSection === 'ai_assistant';

  return (
    <div className="min-h-screen bg-[#07090e] text-slate-100 flex flex-col">
      {isAssistant ? (
        /* Full-screen Focused Assistant View (hides top header, portfolio dropdown, sidebar, and metadata cards) */
        <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#07090e]">
          <main className="flex-1 w-full h-[calc(100vh-3.5rem)] overflow-hidden">
            {renderActiveSection()}
          </main>

          {/* Bottom Navigation Bar */}
          <MobileNav
            isOpen={isMobileNavOpen}
            onClose={() => setIsMobileNavOpen(false)}
            onOpen={() => setIsMobileNavOpen(true)}
            forceShowBottomBar={true}
          />
        </div>
      ) : (
        /* Standard Multi-Business Dashboard Layout */
        <>
          {/* Top Header */}
          <Header
            onOpenMobileMenu={() => setIsMobileNavOpen(true)}
            onOpenNewBusinessModal={() => setIsGlobalBizModalOpen(true)}
            onOpenSupabaseModal={() => setIsSupabaseModalOpen(true)}
          />

          {/* Main Layout */}
          <div className="flex-1 flex max-w-[1600px] w-full mx-auto">
            {/* Desktop Sidebar */}
            <Sidebar />

            {/* Mobile Navigation Bottom Bar + Slide-in Drawer */}
            <MobileNav
              isOpen={isMobileNavOpen}
              onClose={() => setIsMobileNavOpen(false)}
              onOpen={() => setIsMobileNavOpen(true)}
            />

            {/* Dynamic Section Container */}
            <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 overflow-y-auto max-h-[calc(100vh-4rem)]">
              {checkoutBanner && (
                <div
                  className={`mb-5 px-4 py-3 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-3 ${
                    checkoutBanner.type === 'success'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                      : checkoutBanner.type === 'verifying'
                      ? 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                      : checkoutBanner.type === 'error'
                      ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                      : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                  }`}
                >
                  <span>{checkoutBanner.message}</span>
                  <div className="flex items-center gap-3">
                    {checkoutBanner.type === 'success' && checkoutBanner.productId && (
                      <button
                        type="button"
                        onClick={() => setUnlockedDeliverableId(checkoutBanner.productId || null)}
                        className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                      >
                        Open & Download Asset
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setCheckoutBanner(null)}
                      className="font-semibold hover:underline"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              )}
              {renderActiveSection()}
            </main>
          </div>
        </>
      )}

      {/* Quick Business Modal */}
      <Modal
        isOpen={isGlobalBizModalOpen}
        onClose={() => setIsGlobalBizModalOpen(false)}
        title="Register New Venture"
        maxWidth="md"
      >
        <form onSubmit={handleCreateQuickBusiness} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Company / Venture Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. Apex Edge Technologies"
              value={bizName}
              onChange={(e) => setBizName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Industry</label>
            <input
              type="text"
              value={bizIndustry}
              onChange={(e) => setBizIndustry(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Mission / Description</label>
            <textarea
              rows={2}
              placeholder="Primary products and market segment..."
              value={bizDesc}
              onChange={(e) => setBizDesc(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsGlobalBizModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Create Business
            </button>
          </div>
        </form>
      </Modal>

      {/* Quick Project Modal */}
      <Modal
        isOpen={isGlobalProjectModalOpen}
        onClose={() => setIsGlobalProjectModalOpen(false)}
        title="Register Website or App"
        maxWidth="md"
      >
        <form onSubmit={handleCreateQuickProject} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Project Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. Nexus Edge API Gateway"
              value={projName}
              onChange={(e) => setProjName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Business Venture *</label>
            <select
              required
              value={projBizId}
              onChange={(e) => setProjBizId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Website URL</label>
            <input
              type="url"
              placeholder="https://app.nexuscloud.internal"
              value={projUrl}
              onChange={(e) => setProjUrl(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Deployment Status</label>
            <select
              value={projStatus}
              onChange={(e) => setProjStatus(e.target.value as DeploymentStatus)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              <option value="live">Live Production</option>
              <option value="staging">Staging</option>
              <option value="in_progress">In Development</option>
              <option value="draft">Draft</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsGlobalProjectModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Save Project
            </button>
          </div>
        </form>
      </Modal>

      {/* Quick Product Modal */}
      <Modal
        isOpen={isGlobalProductModalOpen}
        onClose={() => setIsGlobalProductModalOpen(false)}
        title="Create Digital Product"
        maxWidth="md"
      >
        <form onSubmit={handleCreateQuickProduct} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Product Title *</label>
            <input
              type="text"
              required
              placeholder="e.g. Pro Developer API Pass"
              value={prodName}
              onChange={(e) => setProdName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Price ($ USD) *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                required
                value={prodPrice}
                onChange={(e) => setProdPrice(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Type</label>
              <select
                value={prodType}
                onChange={(e) => setProdType(e.target.value as ProductType)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="saas">SaaS Subscription</option>
                <option value="digital_download">Digital Download</option>
                <option value="template">Template</option>
                <option value="api_service">API Access</option>
                <option value="course">Course</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Venture *</label>
            <select
              required
              value={prodBizId}
              onChange={(e) => setProdBizId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsGlobalProductModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Create Draft
            </button>
          </div>
        </form>
      </Modal>

      {/* Supabase Connection & Configuration Modal */}
      <SupabaseConnectModal
        isOpen={isSupabaseModalOpen}
        onClose={() => setIsSupabaseModalOpen(false)}
      />

      {/* Post-Stripe-Redirect Deliverable Modal */}
      <DeliverableViewerModal
        product={products.find((p) => p.id === unlockedDeliverableId) || null}
        onClose={() => setUnlockedDeliverableId(null)}
      />
    </div>
  );
};

export default function App() {
  return (
    <OSProvider>
      <MainShell />
    </OSProvider>
  );
}
