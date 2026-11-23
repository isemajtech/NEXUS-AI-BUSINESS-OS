import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { FactoryJob, FactoryPipelineStage, Product, ProductType } from '../../types';
import {
  CheckCircle2,
  Loader2,
  AlertCircle,
  Lock,
  FileText,
  Megaphone,
  Users2,
  ArrowRight,
  Play,
  FileDown,
} from 'lucide-react';
import { triggerBlobDownload } from '../../lib/factoryClient';

interface FactoryPipelinePanelProps {
  onInspectProduct: (product: Product) => void;
  onCachePdfBlob: (productId: string, filename: string, blob: Blob) => void;
  onNotify: (message: string) => void;
}

const PIPELINE_STAGES: Array<{
  key: FactoryPipelineStage;
  label: string;
  dept: string;
}> = [
  { key: 'researching', label: '01. Market Research', dept: 'Product Strategy' },
  { key: 'writing_content', label: '02. Deliverable Copy', dept: 'Product Creation' },
  { key: 'generating_cover', label: '03. Cover Artwork', dept: 'Visual Studio' },
  { key: 'building_pdf', label: '04. Binary .PDF Build', dept: 'Engineering' },
  { key: 'uploading_assets', label: '05. Vault Sync', dept: 'Security' },
  { key: 'drafting_marketing', label: '06. Launch Kit Draft', dept: 'Marketing' },
  { key: 'awaiting_approval', label: '07. Owner Approval Gate', dept: 'Approval Center' },
];

const STAGE_ORDER: Record<FactoryPipelineStage, number> = {
  queued: 0,
  researching: 1,
  writing_content: 2,
  generating_cover: 3,
  building_pdf: 4,
  uploading_assets: 5,
  drafting_marketing: 6,
  awaiting_approval: 7,
  completed: 8,
  failed: -1,
};

export const FactoryPipelinePanel: React.FC<FactoryPipelinePanelProps> = ({
  onInspectProduct,
  onCachePdfBlob,
  onNotify,
}) => {
  const {
    businesses,
    products,
    factoryJobs,
    selectedBusinessId,
    runDigitalProductFactory,
    setActiveSection,
  } = useOS();

  const [topic, setTopic] = useState('');
  const [targetAudience, setTargetAudience] = useState(
    'Small business owners, solo founders, and independent operators'
  );
  const [businessId, setBusinessId] = useState(
    selectedBusinessId !== 'all' ? selectedBusinessId : businesses[0]?.id || 'biz-prime'
  );
  const [productType, setProductType] = useState<ProductType>('digital_download');
  const [price, setPrice] = useState(29);
  const [billingType, setBillingType] = useState<Product['billingType']>('one_time');

  const [isRunning, setIsRunning] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(
    factoryJobs[0]?.id || null
  );
  const [latestPdf, setLatestPdf] = useState<{
    productId: string;
    filename: string;
    blob: Blob;
  } | null>(null);

  const visibleJobs =
    selectedBusinessId === 'all'
      ? factoryJobs
      : factoryJobs.filter((j) => j.businessId === selectedBusinessId);

  const inspectedJob: FactoryJob | null =
    visibleJobs.find((j) => j.id === activeJobId) || visibleJobs[0] || null;

  const inspectedProduct = inspectedJob?.productId
    ? products.find((p) => p.id === inspectedJob.productId) || null
    : null;

  const handleRunPipeline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim() || isRunning) return;

    setIsRunning(true);
    setPipelineError(null);
    setLatestPdf(null);

    try {
      const result = await runDigitalProductFactory({
        topic: topic.trim(),
        targetAudience: targetAudience.trim(),
        businessId: businessId || businesses[0]?.id || 'biz-prime',
        productType,
        price: Number(price) || 19,
        billingType,
      });

      setActiveJobId(result.job.id);
      if (result.pdfBlob && result.pdfFilename) {
        onCachePdfBlob(result.product.id, result.pdfFilename, result.pdfBlob);
        setLatestPdf({
          productId: result.product.id,
          filename: result.pdfFilename,
          blob: result.pdfBlob,
        });
      }

      setTopic('');
      onNotify(
        `Factory packaged "${result.product.name}", drafted launch campaign "${result.campaign.name}", and queued Owner Approval.`
      );
    } catch (err: any) {
      setPipelineError(err?.message || 'Digital Product Factory pipeline stopped.');
    } finally {
      setIsRunning(false);
    }
  };

  const formatJobStatusText = (job: FactoryJob) => {
    if (job.jobStatus === 'completed') return 'Approved & Live';
    if (job.jobStatus === 'awaiting_approval') return 'Awaiting Owner Approval';
    if (job.jobStatus === 'running') return 'Pipeline Running';
    if (job.jobStatus === 'failed') return 'Pipeline Failed';
    if (job.jobStatus === 'cancelled') return 'Returned to Draft';
    return 'Queued';
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left: Factory Orchestrator Brief Form */}
        <form
          onSubmit={handleRunPipeline}
          className="lg:col-span-5 p-6 rounded-2xl bg-[#0e131d] border border-[#1e2638] flex flex-col justify-between space-y-5"
        >
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-100">
                Unified Product Factory Pipeline
              </h2>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Coordinates Product Strategy, Content Authoring, Cover Art, PDFKit Build, Marketing Launch Kit, and Owner Approval in one governed workflow.
              </p>
            </div>

            <div>
              <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400 mb-2">
                Quick-Start Product Blueprints
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {[
                  {
                    topic: 'Local Service AI Booking & Review Playbook',
                    audience: 'Local plumbers, HVAC, dental, and home-service founders',
                    type: 'digital_download' as ProductType,
                    price: 29,
                  },
                  {
                    topic: 'Solo Consultant Retainer & Onboarding Kit',
                    audience: 'Independent consultants, fractional operators, and boutique agencies',
                    type: 'template' as ProductType,
                    price: 39,
                  },
                  {
                    topic: 'Small Business Cashflow & Tax Prep SOP Pack',
                    audience: 'Bootstrapped founders, freelancers, and LLC operators',
                    type: 'digital_download' as ProductType,
                    price: 19,
                  },
                ].map((preset) => (
                  <button
                    key={preset.topic}
                    type="button"
                    disabled={isRunning}
                    onClick={() => {
                      setTopic(preset.topic);
                      setTargetAudience(preset.audience);
                      setProductType(preset.type);
                      setPrice(preset.price);
                      setBillingType('one_time');
                    }}
                    className={`px-3 py-2 rounded-lg border text-left text-xs flex items-center justify-between gap-2 transition-colors disabled:opacity-50 ${
                      topic === preset.topic
                        ? 'bg-blue-600/15 border-blue-500/40 text-blue-200'
                        : 'bg-[#121826] border-[#1f293d] text-slate-300 hover:border-[#2e3c59]'
                    }`}
                  >
                    <span className="truncate font-medium">{preset.topic}</span>
                    <span className="font-mono text-[11px] text-emerald-400 tabular-nums shrink-0">
                      ${preset.price}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Product Concept / Working Title *
              </label>
              <input
                type="text"
                required
                disabled={isRunning}
                placeholder="e.g. Solo Consultant Retainer & Onboarding Playbook"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Target Buyer & Niche
              </label>
              <input
                type="text"
                disabled={isRunning}
                value={targetAudience}
                onChange={(e) => setTargetAudience(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Business Venture
                </label>
                <select
                  disabled={isRunning}
                  value={businessId}
                  onChange={(e) => setBusinessId(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
                >
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Product Format
                </label>
                <select
                  disabled={isRunning}
                  value={productType}
                  onChange={(e) => setProductType(e.target.value as ProductType)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
                >
                  <option value="digital_download">Digital Playbook / PDF</option>
                  <option value="template">Templates & Swipe Files</option>
                  <option value="course">Mini-Course / Workbook</option>
                  <option value="saas">SaaS Toolkit / SOPs</option>
                  <option value="newsletter">Paid Briefing Series</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Price (USD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  disabled={isRunning}
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Billing Cadence
                </label>
                <select
                  disabled={isRunning}
                  value={billingType}
                  onChange={(e) =>
                    setBillingType(e.target.value as Product['billingType'])
                  }
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500 disabled:opacity-60"
                >
                  <option value="one_time">One-Time Purchase</option>
                  <option value="monthly">Monthly Subscription</option>
                  <option value="yearly">Yearly Subscription</option>
                </select>
              </div>
            </div>

            {pipelineError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{pipelineError}</span>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-[#1a2234] space-y-3">
            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span>
                Strict Governance: Builds draft assets & routes to Approval Center — never auto-publishes.
              </span>
            </div>

            <button
              type="submit"
              disabled={isRunning || !topic.trim()}
              className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Executing 7-Stage Factory Pipeline...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Run End-to-End Factory Pipeline
                </>
              )}
            </button>
          </div>
        </form>

        {/* Right: Active Pipeline Stage Monitor */}
        <div className="lg:col-span-7 p-6 rounded-2xl bg-[#0e131d] border border-[#1e2638] flex flex-col justify-between space-y-5">
          {!inspectedJob ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-12 space-y-2">
              <h3 className="text-sm font-bold text-slate-200">
                No Factory Runs Recorded Yet
              </h3>
              <p className="text-xs text-slate-400 max-w-md leading-relaxed">
                Enter a product concept on the left and start the pipeline. All AI department tasks, cover artwork, compiled .PDF pages, and campaign drafts will appear here in real time.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-[#1a2234]">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span className="font-mono">{inspectedJob.id}</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          inspectedJob.jobStatus === 'completed'
                            ? 'text-emerald-400 font-medium'
                            : inspectedJob.jobStatus === 'failed'
                            ? 'text-rose-400 font-medium'
                            : inspectedJob.jobStatus === 'awaiting_approval'
                            ? 'text-amber-300 font-medium'
                            : 'text-blue-400 font-medium'
                        }
                      >
                        {formatJobStatusText(inspectedJob)}
                      </span>
                    </div>
                    <h3 className="text-base font-bold text-slate-100 mt-1 truncate">
                      {inspectedProduct?.name || 'Preparing Digital Product Package'}
                    </h3>
                  </div>

                  <div className="text-right font-mono tabular-nums">
                    <div className="text-lg font-bold text-slate-100">
                      {inspectedJob.progress}%
                    </div>
                    <div className="text-[11px] text-slate-400">Pipeline Progress</div>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="w-full h-1.5 rounded-full bg-[#151d2e] overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ${
                      inspectedJob.jobStatus === 'failed'
                        ? 'bg-rose-500'
                        : inspectedJob.jobStatus === 'completed'
                        ? 'bg-emerald-500'
                        : 'bg-blue-500'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(0, inspectedJob.progress))}%` }}
                  />
                </div>

                {/* 7-Stage Step Table (single-elevation hairline list, zero nested cards) */}
                <div className="divide-y divide-[#182131] border-y border-[#182131]">
                  {PIPELINE_STAGES.map((st) => {
                    const currentRank = STAGE_ORDER[inspectedJob.currentStage] ?? 0;
                    const stepRank = STAGE_ORDER[st.key];
                    const isDone =
                      inspectedJob.jobStatus === 'completed' ||
                      (currentRank > stepRank && inspectedJob.jobStatus !== 'failed') ||
                      (inspectedJob.currentStage === 'awaiting_approval' &&
                        st.key !== 'awaiting_approval');
                    const isCurrent =
                      inspectedJob.currentStage === st.key &&
                      inspectedJob.jobStatus !== 'completed';

                    return (
                      <div
                        key={st.key}
                        className="py-2.5 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          {isDone ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                          ) : isCurrent && inspectedJob.jobStatus === 'running' ? (
                            <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                          ) : isCurrent && inspectedJob.jobStatus === 'awaiting_approval' ? (
                            <Lock className="w-4 h-4 text-amber-400 shrink-0" />
                          ) : (
                            <span className="w-4 h-4 rounded-full border border-[#2c3b59] inline-block shrink-0" />
                          )}
                          <span
                            className={`font-medium truncate ${
                              isDone
                                ? 'text-slate-200'
                                : isCurrent
                                ? 'text-slate-100'
                                : 'text-slate-500'
                            }`}
                          >
                            {st.label}
                          </span>
                        </div>
                        <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap shrink-0">
                          {st.dept}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Latest Stage Log Entries */}
                {inspectedJob.stageLogs && inspectedJob.stageLogs.length > 0 && (
                  <div className="space-y-1 max-h-28 overflow-y-auto pr-1">
                    {inspectedJob.stageLogs.slice(-4).map((entry, idx) => (
                      <div
                        key={`${entry.timestamp}-${idx}`}
                        className="text-[11px] text-slate-400 flex items-baseline justify-between gap-3"
                      >
                        <span className="truncate">{entry.message}</span>
                        <span className="font-mono text-[10px] text-slate-500 tabular-nums shrink-0">
                          {new Date(entry.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Cross-Department Handoff Actions */}
              <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-[#1a2234]">
                {inspectedProduct && (
                  <button
                    type="button"
                    onClick={() => onInspectProduct(inspectedProduct)}
                    className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#172033] hover:bg-[#1e2a42] border border-[#293754] rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    Inspect Deliverable & .PDF
                  </button>
                )}

                {latestPdf &&
                  inspectedProduct &&
                  latestPdf.productId === inspectedProduct.id && (
                    <button
                      type="button"
                      onClick={() =>
                        triggerBlobDownload(latestPdf.filename, latestPdf.blob)
                      }
                      className="px-3.5 py-2 text-xs font-semibold text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      Download .PDF
                    </button>
                  )}

                {inspectedJob.jobStatus === 'awaiting_approval' && (
                  <button
                    type="button"
                    onClick={() => setActiveSection('approval_center')}
                    className="px-3.5 py-2 text-xs font-semibold text-amber-200 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                  >
                    Authorize in Approval Center
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setActiveSection('marketing')}
                  className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-slate-100 flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Megaphone className="w-3.5 h-3.5 text-violet-400" />
                  Marketing Draft
                </button>

                <button
                  type="button"
                  onClick={() => setActiveSection('ai_workforce')}
                  className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-slate-100 flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Users2 className="w-3.5 h-3.5 text-blue-400" />
                  Workforce Tasks
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Pipeline Runs Ledger Table */}
      {visibleJobs.length > 0 && (
        <div className="rounded-2xl bg-[#0e131d] border border-[#1e2638] overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#1a2234] flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Factory Pipeline History ({visibleJobs.length})
            </h3>
            <span className="text-xs text-slate-400">
              Click any run to inspect stage logs & linked deliverables
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#121826] border-b border-[#1d2638] text-slate-400 font-mono text-[11px]">
                <tr>
                  <th className="px-4 py-2.5">Product</th>
                  <th className="px-4 py-2.5">Venture</th>
                  <th className="px-4 py-2.5">Current Stage</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Progress</th>
                  <th className="px-4 py-2.5 text-right">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#182131]">
                {visibleJobs.map((job) => {
                  const prod = job.productId
                    ? products.find((p) => p.id === job.productId)
                    : null;
                  const biz = businesses.find((b) => b.id === job.businessId);
                  const isSelected = inspectedJob?.id === job.id;

                  return (
                    <tr
                      key={job.id}
                      onClick={() => setActiveJobId(job.id)}
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-[#151e30]' : 'hover:bg-[#121826]'
                      }`}
                    >
                      <td className="px-4 py-3 font-medium text-slate-100">
                        {prod?.name || job.id}
                      </td>
                      <td className="px-4 py-3 text-slate-400">
                        {biz?.name || 'Portfolio'}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-300">
                        {job.currentStage.replace(/_/g, ' ')}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            job.jobStatus === 'completed'
                              ? 'text-emerald-400 font-medium'
                              : job.jobStatus === 'failed'
                              ? 'text-rose-400 font-medium'
                              : job.jobStatus === 'awaiting_approval'
                              ? 'text-amber-300 font-medium'
                              : 'text-blue-400 font-medium'
                          }
                        >
                          {formatJobStatusText(job)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-200">
                        {job.progress}%
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-400">
                        {new Date(job.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
