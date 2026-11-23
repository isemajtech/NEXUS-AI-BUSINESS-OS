import React from 'react';
import { useOS } from '../../context/OSContext';
import { MetricCard, Badge } from '../common/UIComponents';
import {
  Building2,
  Globe,
  PackageCheck,
  Receipt,
  DollarSign,
  AlertTriangle,
  Cpu,
  ArrowUpRight,
  Plus,
  Bot,
  CheckCheck,
  ChevronRight,
  ShieldCheck,
  Activity,
  Sparkles,
  Workflow,
  Store,
  ExternalLink,
} from 'lucide-react';

interface CommandCenterProps {
  onOpenNewBusinessModal: () => void;
  onOpenNewProjectModal: () => void;
  onOpenNewProductModal: () => void;
  onOpenSupabaseModal: () => void;
}

export const CommandCenter: React.FC<CommandCenterProps> = ({
  onOpenNewBusinessModal,
  onOpenNewProjectModal,
  onOpenNewProductModal,
  onOpenSupabaseModal,
}) => {
  const {
    businesses,
    projects,
    products,
    factoryJobs,
    orders,
    approvals,
    tasks,
    activityLogs,
    selectedBusinessId,
    selectedBusiness,
    setActiveSection,
    setProductsViewMode,
    departments,
    seedRealisticStarterData,
    supabaseConfig,
  } = useOS();

  // Filter based on selected business
  const filteredProjects = selectedBusinessId === 'all'
    ? projects
    : projects.filter((p) => p.businessId === selectedBusinessId);

  const filteredProducts = selectedBusinessId === 'all'
    ? products
    : products.filter((p) => p.businessId === selectedBusinessId);

  const filteredOrders = selectedBusinessId === 'all'
    ? orders
    : orders.filter((o) => o.businessId === selectedBusinessId);

  const filteredApprovals = selectedBusinessId === 'all'
    ? approvals
    : approvals.filter((a) => a.businessId === selectedBusinessId);

  // Calculate real revenue from completed orders
  const totalRevenue = filteredOrders
    .filter((o) => o.status === 'completed')
    .reduce((sum, o) => sum + o.amount, 0);

  const pendingApprovals = filteredApprovals.filter((a) => a.status === 'pending');
  const activeWebsitesCount = filteredProjects.filter((p) => p.deploymentStatus === 'live').length;
  const publishedProductsCount = filteredProducts.filter((p) => p.status === 'published').length;
  const activeTasksCount = tasks.filter((t) => t.status === 'in_progress' || t.status === 'pending').length;

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Top Banner & Context */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-gradient-to-r from-[#101625] via-[#121827] to-[#15132a] border border-[#20293d]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex rounded-full h-2 w-2 bg-emerald-400" />
            <span className="text-xs font-mono font-medium text-blue-400 uppercase tracking-wider">
              Autonomous OS Kernel Online
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">
            {selectedBusiness ? selectedBusiness.name : 'Executive Command Center'}
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-xl">
            {selectedBusiness
              ? selectedBusiness.description || `Viewing telemetry and operational units for ${selectedBusiness.name}.`
              : 'Holistic portfolio overview across all ventures, AI departments, assets, and capital flows.'}
          </p>
        </div>

        {/* Quick Actions */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          <button
            onClick={onOpenSupabaseModal}
            className={`px-3 py-2 text-xs font-semibold rounded-xl border transition-all flex items-center gap-1.5 ${
              supabaseConfig.isConnected
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                : 'bg-blue-600/15 text-blue-400 border-blue-500/30 hover:bg-blue-600/25'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span>{supabaseConfig.isConnected ? 'Supabase Synced' : 'Connect Supabase'}</span>
          </button>
          <button
            onClick={() => setActiveSection('ai_assistant')}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center gap-1.5"
          >
            <Bot className="w-3.5 h-3.5" />
            AI Coordinator
          </button>
          <button
            onClick={() => {
              setProductsViewMode('factory');
              setActiveSection('products');
            }}
            className="px-3 py-2 text-xs font-semibold text-cyan-200 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/35 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Workflow className="w-3.5 h-3.5" />
            Launch Product Factory
          </button>
          <a
            href="/?store=1"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-2 text-xs font-semibold text-emerald-200 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Store className="w-3.5 h-3.5" />
            Public Storefront ({publishedProductsCount})
            <ExternalLink className="w-3 h-3" />
          </a>
          <button
            onClick={onOpenNewBusinessModal}
            className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#161d2d] hover:bg-[#1d273c] border border-[#233048] rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5 text-blue-400" />
            New Venture
          </button>
        </div>
      </div>

      {/* Pending Approvals Critical Notice if any pending */}
      {pendingApprovals.length > 0 && (
        <div className="flex items-center justify-between p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/20 text-amber-400">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-semibold">
                {pendingApprovals.length} Executive Approval{pendingApprovals.length > 1 ? 's' : ''} Required
              </div>
              <div className="text-xs text-amber-300/80">
                AI agents have queued actions requiring your sign-off before execution.
              </div>
            </div>
          </div>
          <button
            onClick={() => setActiveSection('approval_center')}
            className="px-3 py-1.5 text-xs font-semibold bg-amber-500 text-black rounded-lg hover:bg-amber-400 transition-colors flex items-center gap-1 shrink-0"
          >
            Review Now
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Executive Metric Cards (Real state - zero fake figures) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard
          title="Total Businesses"
          value={businesses.length}
          subtitle={selectedBusinessId === 'all' ? 'All active entities' : 'Current scope: 1 selected'}
          icon={<Building2 className="w-4 h-4 text-blue-400" />}
          accentColor="blue"
          onClick={() => setActiveSection('businesses')}
        />

        <MetricCard
          title="Websites & Apps"
          value={filteredProjects.length}
          subtitle={`${activeWebsitesCount} live in production`}
          icon={<Globe className="w-4 h-4 text-violet-400" />}
          accentColor="violet"
          onClick={() => setActiveSection('websites_apps')}
        />

        <MetricCard
          title="Total Products"
          value={filteredProducts.length}
          subtitle={`${filteredProducts.filter((p) => p.status === 'published').length} published in catalog`}
          icon={<PackageCheck className="w-4 h-4 text-cyan-400" />}
          accentColor="cyan"
          onClick={() => setActiveSection('products')}
        />

        <MetricCard
          title="Total Orders"
          value={filteredOrders.length}
          subtitle={filteredOrders.length === 0 ? 'No orders processed yet' : `${filteredOrders.filter(o => o.status === 'completed').length} completed`}
          icon={<Receipt className="w-4 h-4 text-emerald-400" />}
          accentColor="emerald"
          onClick={() => setActiveSection('orders_customers')}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <MetricCard
          title="Logged Revenue"
          value={`$${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subtitle={totalRevenue === 0 ? 'Realistic zero-start state' : 'Verified order gross'}
          icon={<DollarSign className="w-4 h-4 text-emerald-400" />}
          accentColor="emerald"
          onClick={() => setActiveSection('financial_center')}
        />

        <MetricCard
          title="Pending Approvals"
          value={pendingApprovals.length}
          subtitle={pendingApprovals.length === 0 ? 'Zero pending requests' : 'Requires owner sign-off'}
          icon={<CheckCheck className="w-4 h-4 text-amber-400" />}
          accentColor="amber"
          onClick={() => setActiveSection('approval_center')}
        />

        <MetricCard
          title="Active AI Tasks"
          value={activeTasksCount}
          subtitle={`${departments.length} AI departments online`}
          icon={<Cpu className="w-4 h-4 text-violet-400" />}
          accentColor="violet"
          onClick={() => setActiveSection('ai_workforce')}
        />
      </div>

      {/* Quick Launchpad & Department Status Radar */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: AI Workforce Departments Overview */}
        <div className="lg:col-span-2 p-5 rounded-2xl bg-[#0e131d]/90 border border-[#1e2638] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-slate-200">AI Workforce Departments</h2>
            </div>
            <button
              onClick={() => setActiveSection('ai_workforce')}
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium"
            >
              Configure Workforce
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {departments.map((dept) => (
              <div
                key={dept.id}
                onClick={() => setActiveSection('ai_workforce')}
                className="p-3.5 rounded-xl bg-[#131926] border border-[#202b3d] hover:border-blue-500/30 transition-colors cursor-pointer group"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-200 group-hover:text-blue-400 transition-colors">
                    {dept.name}
                  </span>
                  <Badge variant={dept.status === 'active' ? 'emerald' : 'neutral'}>
                    {dept.status}
                  </Badge>
                </div>
                <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                  {dept.description}
                </p>
                <div className="mt-2.5 flex items-center justify-between text-[10px] font-mono text-slate-400 pt-2 border-t border-[#1a2334]">
                  <span>Autonomy: {dept.autonomyLevel.replace('_', ' ')}</span>
                  <span>Tasks: {dept.activeTasksCount}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right 1 Col: Quick Launch & Seed State */}
        <div className="p-5 rounded-2xl bg-[#0e131d]/90 border border-[#1e2638] flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-violet-400" />
              <h2 className="text-sm font-semibold text-slate-200">Owner Quick Operations</h2>
            </div>

            <div className="space-y-2">
              <button
                onClick={() => {
                  setProductsViewMode('factory');
                  setActiveSection('products');
                }}
                className="w-full p-2.5 rounded-xl bg-blue-600/15 hover:bg-blue-600/25 border border-blue-500/30 text-left text-xs font-semibold text-blue-200 flex items-center justify-between transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Workflow className="w-4 h-4 text-cyan-400" />
                  Run Product Factory ({factoryJobs.length} runs)
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-cyan-400" />
              </button>

              <button
                onClick={() => {
                  setProductsViewMode('storefront');
                  setActiveSection('products');
                }}
                className="w-full p-2.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-left text-xs font-semibold text-emerald-200 flex items-center justify-between transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Store className="w-4 h-4 text-emerald-400" />
                  Open Live Storefront ({publishedProductsCount} live)
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-emerald-400" />
              </button>

              <button
                onClick={onOpenNewProjectModal}
                className="w-full p-2.5 rounded-xl bg-[#131926] hover:bg-[#182133] border border-[#202b3e] text-left text-xs font-medium text-slate-300 flex items-center justify-between transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-blue-400" />
                  Register App or Website
                </span>
                <Plus className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={onOpenNewProductModal}
                className="w-full p-2.5 rounded-xl bg-[#131926] hover:bg-[#182133] border border-[#202b3e] text-left text-xs font-medium text-slate-300 flex items-center justify-between transition-colors"
              >
                <span className="flex items-center gap-2">
                  <PackageCheck className="w-4 h-4 text-cyan-400" />
                  Create Digital Product
                </span>
                <Plus className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => setActiveSection('financial_center')}
                className="w-full p-2.5 rounded-xl bg-[#131926] hover:bg-[#182133] border border-[#202b3e] text-left text-xs font-medium text-slate-300 flex items-center justify-between transition-colors"
              >
                <span className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  Record Expense or Sale
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>

              <button
                onClick={() => setActiveSection('automations')}
                className="w-full p-2.5 rounded-xl bg-[#131926] hover:bg-[#182133] border border-[#202b3e] text-left text-xs font-medium text-slate-300 flex items-center justify-between transition-colors"
              >
                <span className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-violet-400" />
                  Configure Automations
                </span>
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              </button>
            </div>
          </div>

          {/* Testing helper */}
          {products.length === 0 && orders.length === 0 && (
            <div className="p-3 rounded-xl bg-blue-500/5 border border-blue-500/20 text-center">
              <p className="text-[11px] text-slate-400 mb-2">
                Starting clean with zero fabricated figures. You can populate realistic starter data for UI testing anytime.
              </p>
              <button
                onClick={seedRealisticStarterData}
                className="w-full py-1.5 px-3 text-xs font-medium text-blue-300 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 rounded-lg transition-colors"
              >
                Seed Realistic Baseline
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Recent Activity Stream */}
      <div className="p-5 rounded-2xl bg-[#0e131d]/90 border border-[#1e2638] space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-400" />
            <h2 className="text-sm font-semibold text-slate-200">OS Audit & Activity Stream</h2>
          </div>
          <button
            onClick={() => setActiveSection('activity_history')}
            className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium"
          >
            Full Audit Log
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {activityLogs.length === 0 ? (
          <div className="py-6 text-center text-xs text-slate-400">
            No activity recorded yet.
          </div>
        ) : (
          <div className="divide-y divide-[#182131]">
            {activityLogs.slice(0, 5).map((log) => {
              const severityColor = {
                info: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
                warning: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
                critical: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
              }[log.severity || 'info'];

              return (
                <div key={log.id} className="py-2.5 flex items-start justify-between gap-3 text-xs">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono border uppercase shrink-0 mt-0.5 ${severityColor}`}>
                      {log.severity}
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium text-slate-200 truncate">{log.action}</div>
                      <div className="text-slate-400 text-[11px] truncate">{log.details}</div>
                    </div>
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 shrink-0 text-right">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
