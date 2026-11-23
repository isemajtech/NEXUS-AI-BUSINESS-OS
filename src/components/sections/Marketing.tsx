import React, { useState, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { authorizedApiFetch, invokeAIAssistantEdgeFunction } from '../../lib/supabase';
import {
  DeliverableViewerModal,
  triggerFileDownload,
} from '../modals/ProductPackagerModal';
import { MarketingCampaign, MarketingChannel, CampaignStatus, Product } from '../../types';
import { Badge, Modal, EmptyState } from '../common/UIComponents';
import {
  Megaphone,
  Plus,
  Send,
  Calendar,
  Target,
  Trash2,
  CheckCircle2,
  Lock,
  Sparkles,
  Loader2,
  Copy,
  Check,
  Download,
  Printer,
  AlertCircle,
  LayoutGrid,
} from 'lucide-react';

interface SocialContentDay {
  day: number;
  week: number;
  platform: string;
  pillar: string;
  format: string;
  hook: string;
  caption: string;
  cta: string;
  hashtags: string;
}

interface StoredSocialPlan {
  businessId: string;
  businessName: string;
  targetIndustry: string;
  goal: string;
  platforms: string[];
  model: string;
  generatedAt: string;
  days: SocialContentDay[];
}

const PLAN_STORAGE_KEY = 'paio_social_content_plans_v1';
const PLATFORM_OPTIONS = [
  'LinkedIn',
  'X / Twitter',
  'Instagram',
  'TikTok / Reels',
  'YouTube Shorts',
];

function parseSocialPlanJSON(rawReply: string): SocialContentDay[] | null {
  if (!rawReply) return null;
  let cleaned = rawReply
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    return parsed.slice(0, 30).map((item: any, idx: number) => {
      const dayNum = Number(item?.day) || idx + 1;
      const weekNum =
        Number(item?.week) || (dayNum <= 7 ? 1 : dayNum <= 14 ? 2 : dayNum <= 21 ? 3 : 4);
      return {
        day: dayNum,
        week: weekNum,
        platform: String(item?.platform || 'LinkedIn'),
        pillar: String(item?.pillar || 'Authority & Insights'),
        format: String(item?.format || 'Post'),
        hook: String(item?.hook || `Day ${dayNum} Spotlight`),
        caption: String(item?.caption || ''),
        cta: String(item?.cta || 'Learn more via our link in bio.'),
        hashtags: String(item?.hashtags || '#BusinessGrowth'),
      };
    });
  } catch {
    return null;
  }
}

export const Marketing: React.FC = () => {
  const {
    campaigns,
    businesses,
    products,
    approvals,
    selectedBusinessId,
    selectedBusiness,
    supabaseConfig,
    addCampaign,
    submitCampaignForApproval,
    deleteCampaign,
    getMemoriesForContext,
    logActivity,
  } = useOS();

  const [activeTab, setActiveTab] = useState<'campaigns' | 'social_planner'>('campaigns');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Campaign Form state
  const [name, setName] = useState('');
  const [businessId, setBusinessId] = useState(
    selectedBusinessId !== 'all' ? selectedBusinessId : businesses[0]?.id || ''
  );
  const [channel, setChannel] = useState<MarketingChannel>('email');
  const [targetAudience, setTargetAudience] = useState('');
  const [budget, setBudget] = useState(0);
  const [conversionGoal, setConversionGoal] = useState('New Subscribers');
  const [keyCopy, setKeyCopy] = useState('');

  // 30-Day AI Social Planner state
  const defaultBiz = selectedBusiness || businesses[0] || null;
  const [planBizId, setPlanBizId] = useState<string>(defaultBiz?.id || '');
  const [targetIndustry, setTargetIndustry] = useState<string>(
    defaultBiz?.industry || 'Software & Technology'
  );
  const [planAudience, setPlanAudience] = useState<string>(
    defaultBiz?.targetMarket || 'Small business owners, solo founders, and decision makers'
  );
  const [planGoal, setPlanGoal] = useState<string>('Brand Authority & Product Conversions');
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([
    'LinkedIn',
    'X / Twitter',
    'Instagram',
  ]);
  const [selectedWeek, setSelectedWeek] = useState<'all' | 1 | 2 | 3 | 4>('all');
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [copiedDay, setCopiedDay] = useState<number | null>(null);

  const [savedPlans, setSavedPlans] = useState<Record<string, StoredSocialPlan>>(() => {
    try {
      const raw = localStorage.getItem(PLAN_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  // Keep planner synced when user changes top-level selected business
  useEffect(() => {
    if (selectedBusiness) {
      setPlanBizId(selectedBusiness.id);
      setTargetIndustry(selectedBusiness.industry || 'Software & Technology');
      if (selectedBusiness.targetMarket) {
        setPlanAudience(selectedBusiness.targetMarket);
      }
      setBusinessId(selectedBusiness.id);
    } else if (businesses.length > 0 && !planBizId) {
      setPlanBizId(businesses[0].id);
      setTargetIndustry(businesses[0].industry || 'Software & Technology');
      setBusinessId(businesses[0].id);
    }
  }, [selectedBusinessId, businesses]);

  useEffect(() => {
    try {
      localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(savedPlans));
    } catch {
      // ignore storage quota issues
    }
  }, [savedPlans]);

  const activePlanBiz =
    businesses.find((b) => b.id === planBizId) || selectedBusiness || businesses[0] || null;
  const currentPlan = activePlanBiz ? savedPlans[activePlanBiz.id] || null : null;

  const filteredCampaigns =
    selectedBusinessId === 'all'
      ? campaigns
      : campaigns.filter((c) => c.businessId === selectedBusinessId);

  const showToast = (msg: string) => {
    setNotice(msg);
    setTimeout(() => {
      setNotice((curr) => (curr === msg ? null : curr));
    }, 5000);
  };

  const handlePlanBusinessChange = (newId: string) => {
    setPlanBizId(newId);
    const biz = businesses.find((b) => b.id === newId);
    if (biz) {
      setTargetIndustry(biz.industry || '');
      if (biz.targetMarket) setPlanAudience(biz.targetMarket);
    }
  };

  const togglePlatform = (platform: string) => {
    setSelectedPlatforms((prev) => {
      if (prev.includes(platform)) {
        return prev.length > 1 ? prev.filter((p) => p !== platform) : prev;
      }
      return [...prev, platform];
    });
  };

  const handleCreateCampaign = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !businessId) return;

    addCampaign({
      name: name.trim(),
      businessId,
      channel,
      status: 'draft',
      targetAudience: targetAudience.trim() || 'General portfolio audience',
      budget: Number(budget) || 0,
      conversionGoal: conversionGoal.trim(),
      keyCopyOrContent: keyCopy.trim(),
    });

    setName('');
    setTargetAudience('');
    setBudget(0);
    setKeyCopy('');
    setIsAddModalOpen(false);
    showToast('Marketing campaign saved as draft.');
  };

  const handleGenerate30DayPlan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePlanBiz || !targetIndustry.trim()) return;

    setIsGeneratingPlan(true);
    setPlanError(null);

    const bizProducts = products
      .filter((p) => p.businessId === activePlanBiz.id)
      .slice(0, 5)
      .map((p) => `${p.name} ($${p.price})`)
      .join(', ');

    const marketingMemories = getMemoriesForContext(activePlanBiz.id, 'marketing')
      .slice(0, 6)
      .map((m) => ({
        category: m.category,
        importance: m.importance,
        department: m.department || 'marketing',
        title: m.title,
        content: m.content,
      }));

    const aiPrompt = `Create a complete 30-day social media content plan for the following business.
Return ONLY a valid raw JSON array (no markdown fences, no commentary before or after) containing exactly 30 objects, one per day (day 1 through day 30).

Business Context:
- Business Name: ${activePlanBiz.name}
- Description: ${activePlanBiz.description || 'Modern digital products & services company'}
- Target Industry: ${targetIndustry.trim()}
- Target Audience: ${planAudience.trim()}
- Primary Marketing Goal: ${planGoal.trim()}
- Active Products to weave in naturally: ${bizProducts || 'Core flagship offerings'}
- Allowed Platforms (distribute posts across these): ${selectedPlatforms.join(', ')}

JSON Schema for EACH of the 30 items:
{
  "day": number (1 to 30),
  "week": number (1 for days 1-7, 2 for days 8-14, 3 for days 15-21, 4 for days 22-30),
  "platform": string (one of: ${selectedPlatforms.join(', ')}),
  "pillar": string (e.g. "Thought Leadership", "Educational", "Behind the Scenes", "Product Spotlight", "Customer Proof", "Direct Offer"),
  "format": string (e.g. "Carousel", "Short Video", "Thread", "Text Post", "Case Study"),
  "hook": string (punchy scroll-stopping opening line under 14 words),
  "caption": string (practical, ready-to-publish body copy of 2 sentences tailored to ${targetIndustry.trim()}),
  "cta": string (clear next step for the reader),
  "hashtags": string (3-4 relevant hashtags)
}`;

    const contextPayload = {
      selectedBusiness: activePlanBiz.name,
      totalBusinesses: businesses.length,
      totalProducts: products.length,
      pendingApprovals: approvals.filter((a) => a.status === 'pending').length,
      memories: marketingMemories,
    };

    try {
      let rawReply = '';
      let usedModel = 'gemini-3.1-flash-lite';

      if (supabaseConfig.isConnected && supabaseConfig.projectUrl && supabaseConfig.anonKey) {
        const edgeRes = await invokeAIAssistantEdgeFunction({
          prompt: aiPrompt,
          message: aiPrompt,
          context: contextPayload,
        });
        if (!edgeRes.success || !edgeRes.reply) {
          throw new Error(edgeRes.error || 'Supabase AI Edge Function did not return a plan.');
        }
        rawReply = edgeRes.reply;
        usedModel = edgeRes.model || 'gemini-edge';
      } else {
        const resp = await authorizedApiFetch('/api/ai/coordinator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: aiPrompt,
            message: aiPrompt,
            context: contextPayload,
          }),
        });

        const data = await resp.json();
        if (!resp.ok) {
          throw new Error(data?.error || 'Failed to invoke AI coordinator service.');
        }
        if (data?.isFallback) {
          throw new Error(
            'AI service is currently running in offline fallback mode. Configure your Gemini API key to generate a live 30-day plan.'
          );
        }
        rawReply = data.reply || '';
        usedModel = data.model || usedModel;
      }

      const days = parseSocialPlanJSON(rawReply);
      if (!days || days.length === 0) {
        throw new Error(
          'AI response could not be parsed into a structured 30-day schedule. Please try generating again.'
        );
      }

      const newPlan: StoredSocialPlan = {
        businessId: activePlanBiz.id,
        businessName: activePlanBiz.name,
        targetIndustry: targetIndustry.trim(),
        goal: planGoal.trim(),
        platforms: [...selectedPlatforms],
        model: usedModel,
        generatedAt: new Date().toISOString(),
        days,
      };

      setSavedPlans((prev) => ({
        ...prev,
        [activePlanBiz.id]: newPlan,
      }));
      setSelectedWeek('all');
      logActivity(
        'SOCIAL_PLAN_GENERATED',
        `Generated 30-day AI social media content plan for "${activePlanBiz.name}" (${targetIndustry.trim()}) via ${usedModel}`,
        'success',
        activePlanBiz.id
      );
      showToast(
        `Generated ${days.length}-day social content plan for ${activePlanBiz.name}.`
      );
    } catch (err: any) {
      setPlanError(err?.message || 'Error generating 30-day social media plan.');
    } finally {
      setIsGeneratingPlan(false);
    }
  };

  const handleCopyDay = (item: SocialContentDay) => {
    const formatted = `${item.hook}\n\n${item.caption}\n\n${item.cta}\n\n${item.hashtags}`;
    navigator.clipboard.writeText(formatted);
    setCopiedDay(item.day);
    setTimeout(() => setCopiedDay((c) => (c === item.day ? null : c)), 2000);
  };

  const handleSaveDayAsDraft = (item: SocialContentDay) => {
    if (!activePlanBiz) return;
    addCampaign({
      name: `Day ${item.day} (${item.platform}): ${item.hook.slice(0, 48)}`,
      businessId: activePlanBiz.id,
      channel: 'social_media',
      status: 'draft',
      targetAudience: `${targetIndustry.trim()} — ${planAudience.trim()}`,
      budget: 0,
      conversionGoal: item.cta || planGoal,
      keyCopyOrContent: `[${item.platform} · ${item.format} · ${item.pillar}]\n${item.hook}\n\n${item.caption}\n\nCTA: ${item.cta}\n${item.hashtags}`,
    });
    showToast(`Saved Day ${item.day} post as a Social Media Campaign Draft.`);
  };

  const handleSaveFullPlanAsDraft = () => {
    if (!currentPlan || !activePlanBiz) return;
    const summaryText = currentPlan.days
      .map(
        (d) =>
          `Day ${d.day} [${d.platform} · ${d.format}]: ${d.hook} — ${d.caption} (${d.cta})`
      )
      .join('\n\n');

    addCampaign({
      name: `30-Day Social Calendar: ${currentPlan.targetIndustry}`,
      businessId: activePlanBiz.id,
      channel: 'social_media',
      status: 'draft',
      targetAudience: `${currentPlan.targetIndustry} — ${planAudience.trim()}`,
      budget: 0,
      conversionGoal: currentPlan.goal,
      keyCopyOrContent: summaryText,
    });
    setActiveTab('campaigns');
    showToast(
      `Saved full 30-day content plan as a Campaign Draft. Submit to Approval Center when ready to launch.`
    );
  };

  const buildPlanMarkdown = (plan: StoredSocialPlan) => {
    const safeCell = (val: string | number) => String(val ?? '').replace(/\|/g, '/').replace(/\n+/g, ' ');
    return [
      `# 30-Day Social Media Content Plan — ${plan.businessName}`,
      `**Target Industry:** ${plan.targetIndustry} | **Goal:** ${plan.goal}`,
      `**Platforms:** ${plan.platforms.join(', ')} | **Generated:** ${new Date(plan.generatedAt).toLocaleDateString()}`,
      '',
      '---',
      '',
      '## 30-Day Master Schedule Overview',
      '| Day | Week | Platform | Pillar | Format | Hook |',
      '| --- | --- | --- | --- | --- | --- |',
      ...plan.days.map(
        (d) =>
          `| Day ${d.day} | Week ${d.week} | ${safeCell(d.platform)} | ${safeCell(d.pillar)} | ${safeCell(d.format)} | ${safeCell(d.hook)} |`
      ),
      '',
      '---',
      '',
      '## Daily Post Copy, CTAs & Hashtags',
      ...plan.days.map(
        (d) =>
          `### Day ${d.day} (Week ${d.week}) — ${d.platform} · ${d.format} · ${d.pillar}\n**Hook:** ${d.hook}\n\n${d.caption}\n\n**CTA:** ${d.cta}\n\n\`${d.hashtags}\`\n`
      ),
    ].join('\n');
  };

  const handleExportMarkdown = () => {
    if (!currentPlan) return;
    const md = buildPlanMarkdown(currentPlan);
    const slug = currentPlan.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    triggerFileDownload(`${slug}-30-day-social-plan.md`, md, 'text/markdown;charset=utf-8');
  };

  const printablePlanProduct: Product | null =
    isPrintModalOpen && currentPlan
      ? {
          id: `plan-${currentPlan.businessId}`,
          businessId: currentPlan.businessId,
          name: `30-Day Social Media Content Plan — ${currentPlan.businessName}`,
          slug: `${currentPlan.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-30-day-social-plan`,
          description: `${currentPlan.targetIndustry} · ${currentPlan.goal}`,
          type: 'digital_download',
          price: 0,
          billingType: 'free',
          status: 'published',
          salesCount: 0,
          totalRevenue: 0,
          createdAt: currentPlan.generatedAt,
          updatedAt: currentPlan.generatedAt,
          deliverableContent: buildPlanMarkdown(currentPlan),
        }
      : null;

  const handleExportCsv = () => {
    if (!currentPlan) return;
    const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Day', 'Week', 'Platform', 'Pillar', 'Format', 'Hook', 'Caption', 'CTA', 'Hashtags'].join(',');
    const rows = currentPlan.days.map((d) =>
      [d.day, d.week, d.platform, d.pillar, d.format, d.hook, d.caption, d.cta, d.hashtags]
        .map(esc)
        .join(',')
    );
    const slug = currentPlan.businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    triggerFileDownload(
      `${slug}-30-day-social-plan.csv`,
      [header, ...rows].join('\n'),
      'text/csv;charset=utf-8'
    );
  };

  const getStatusBadge = (status: CampaignStatus) => {
    switch (status) {
      case 'active':
        return <Badge variant="emerald">Active</Badge>;
      case 'awaiting_approval':
        return <Badge variant="amber">Awaiting Approval</Badge>;
      case 'scheduled':
        return <Badge variant="blue">Scheduled</Badge>;
      case 'completed':
        return <Badge variant="emerald">Completed</Badge>;
      case 'paused':
        return <Badge variant="rose">Paused</Badge>;
      default:
        return <Badge variant="neutral">Draft</Badge>;
    }
  };

  const visibleDays =
    currentPlan?.days.filter((d) => selectedWeek === 'all' || d.week === selectedWeek) || [];

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Megaphone className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-mono font-medium text-cyan-400 uppercase tracking-wider">
              Growth & Outbound Engine
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">
            Marketing Center
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5 tabular-nums">
            {filteredCampaigns.length} Campaigns ·{' '}
            {currentPlan
              ? `${currentPlan.days.length}-Day Plan Ready (${currentPlan.businessName})`
              : 'AI 30-Day Social Content Planner Ready'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Sub-view Switcher */}
          <div className="flex items-center p-1 rounded-xl bg-[#090d15] border border-[#1d2638]">
            <button
              type="button"
              onClick={() => setActiveTab('campaigns')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                activeTab === 'campaigns'
                  ? 'bg-[#1a2438] text-slate-100 border border-[#2c3b5a]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Campaigns ({filteredCampaigns.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('social_planner')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                activeTab === 'social_planner'
                  ? 'bg-gradient-to-r from-violet-600 to-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              30-Day AI Social Plan
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsAddModalOpen(true)}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            Draft Campaign
          </button>
        </div>
      </div>

      {/* Transient Confirmation Toast */}
      {notice && (
        <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{notice}</span>
          </div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-400 hover:text-emerald-200 font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* TAB 1: OUTBOUND CAMPAIGNS */}
      {activeTab === 'campaigns' ? (
        filteredCampaigns.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="w-8 h-8 text-cyan-400" />}
            title="No Marketing Campaigns Created"
            description="Draft outbound broadcasts manually or generate a complete 30-day AI social media calendar tailored to your business and industry."
            actionText="Open 30-Day AI Social Planner"
            onAction={() => setActiveTab('social_planner')}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredCampaigns.map((camp) => {
              const biz = businesses.find((b) => b.id === camp.businessId);

              return (
                <div
                  key={camp.id}
                  className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] hover:border-slate-600 transition-all flex flex-col justify-between space-y-4"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-[#161f30] text-cyan-300 border border-[#23314c]">
                        {camp.channel.replace('_', ' ')}
                      </span>
                      {getStatusBadge(camp.status)}
                    </div>

                    <h3 className="text-base font-bold text-slate-100">{camp.name}</h3>
                    <div className="text-xs font-mono text-slate-400 mt-0.5">
                      Venture: <strong className="text-slate-300">{biz?.name || 'Unassigned'}</strong>
                    </div>

                    <div className="mt-3 space-y-1.5 text-xs text-slate-300">
                      <div className="flex items-center gap-1.5 text-slate-400">
                        <Target className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        <span className="truncate">Audience: {camp.targetAudience}</span>
                      </div>
                      <div className="text-[11px] text-slate-400">Goal: {camp.conversionGoal}</div>
                    </div>

                    {camp.keyCopyOrContent && (
                      <p className="mt-2.5 p-2.5 rounded-lg bg-[#121825] border border-[#1c2538] text-xs text-slate-300 font-mono line-clamp-3 whitespace-pre-line">
                        {camp.keyCopyOrContent}
                      </p>
                    )}
                  </div>

                  <div>
                    <div className="p-3 rounded-xl bg-[#141b2b] border border-[#1f293d] flex items-center justify-between text-xs mb-3">
                      <div>
                        <div className="text-[10px] font-mono text-slate-400 uppercase">Budget</div>
                        <div className="text-sm font-bold font-mono text-slate-200 tabular-nums">
                          ${camp.budget}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-mono text-slate-400 uppercase">Spent</div>
                        <div className="text-sm font-bold font-mono text-emerald-400 tabular-nums">
                          ${camp.spent}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-[#1a2335]">
                      {camp.status === 'draft' ? (
                        <button
                          onClick={() => {
                            submitCampaignForApproval(camp.id);
                            showToast(`Submitted "${camp.name}" to Approval Center.`);
                          }}
                          className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 transition-colors flex items-center gap-1.5"
                        >
                          <Send className="w-3.5 h-3.5" />
                          Submit for Owner Approval
                        </button>
                      ) : camp.status === 'awaiting_approval' ? (
                        <span className="text-[11px] font-mono text-amber-400 flex items-center gap-1">
                          <Lock className="w-3 h-3" />
                          Pending in Approval Center
                        </span>
                      ) : (
                        <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          Campaign Authorized
                        </span>
                      )}

                      <button
                        onClick={() => deleteCampaign(camp.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-[#182133] transition-colors"
                        title="Delete Campaign"
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
      ) : (
        /* TAB 2: 30-DAY AI SOCIAL MEDIA CONTENT PLANNER */
        <div className="space-y-6">
          {/* Generator Configuration Card */}
          <form
            onSubmit={handleGenerate30DayPlan}
            className="p-5 sm:p-6 rounded-2xl bg-[#0e131d] border border-[#1e2638] space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base sm:text-lg font-bold text-slate-100 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-violet-400" />
                  30-Day AI Social Media Content Planner
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Uses the Executive AI service + your business memory bank to map 30 daily posts, hooks, captions, CTAs, and hashtags.
                </p>
              </div>
              {currentPlan && (
                <span className="text-[11px] font-mono text-slate-400">
                  Last generated via {currentPlan.model}
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Selected Business *
                </label>
                <select
                  value={activePlanBiz?.id || ''}
                  onChange={(e) => handlePlanBusinessChange(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
                >
                  {businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Target Industry *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. SaaS & Cloud Automation"
                  value={targetIndustry}
                  onChange={(e) => setTargetIndustry(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Target Audience
                </label>
                <input
                  type="text"
                  placeholder="e.g. Small business owners, founders"
                  value={planAudience}
                  onChange={(e) => setPlanAudience(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Campaign Focus / Goal
                </label>
                <input
                  type="text"
                  placeholder="e.g. Product sales & email list growth"
                  value={planGoal}
                  onChange={(e) => setPlanGoal(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-violet-500"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-[#1a2234]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-slate-400 mr-1">Platforms:</span>
                {PLATFORM_OPTIONS.map((platform) => {
                  const active = selectedPlatforms.includes(platform);
                  return (
                    <button
                      key={platform}
                      type="button"
                      onClick={() => togglePlatform(platform)}
                      className={`px-3 py-1 text-xs font-medium rounded-lg border transition-colors ${
                        active
                          ? 'bg-violet-500/20 text-violet-200 border-violet-500/40'
                          : 'bg-[#141b2a] text-slate-400 border-[#232f45] hover:text-slate-200'
                      }`}
                    >
                      {platform}
                    </button>
                  );
                })}
              </div>

              <button
                type="submit"
                disabled={isGeneratingPlan || !activePlanBiz}
                className="px-4 py-2.5 text-xs font-semibold text-white bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-500 hover:to-blue-500 disabled:opacity-50 rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
              >
                {isGeneratingPlan ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating 30-Day Plan...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    {currentPlan ? 'Regenerate 30-Day AI Plan' : 'Generate 30-Day Content Plan'}
                  </>
                )}
              </button>
            </div>

            {planError && (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{planError}</span>
              </div>
            )}
          </form>

          {/* Generated 30-Day Calendar Output */}
          {!currentPlan ? (
            <div className="p-10 rounded-2xl bg-[#0e131d] border border-[#1e2638] text-center space-y-2">
              <Calendar className="w-8 h-8 text-violet-400 mx-auto" />
              <h3 className="text-sm font-bold text-slate-100">
                No 30-Day Social Plan Generated Yet
              </h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Select a business and target industry above, then click{' '}
                <strong>Generate 30-Day Content Plan</strong> to build a daily calendar with ready-to-post captions and CTAs.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Toolbar: Week Filter + Export + Save as Campaign Draft */}
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
                <div className="flex flex-wrap items-center gap-1.5">
                  {(['all', 1, 2, 3, 4] as const).map((wk) => (
                    <button
                      key={String(wk)}
                      type="button"
                      onClick={() => setSelectedWeek(wk)}
                      className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                        selectedWeek === wk
                          ? 'bg-blue-600 text-white'
                          : 'bg-[#141b2a] text-slate-400 hover:text-slate-200 border border-[#222d44]'
                      }`}
                    >
                      {wk === 'all' ? `All (${currentPlan.days.length} Days)` : `Week ${wk}`}
                    </button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportCsv}
                    className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#172033] hover:bg-[#1f2b44] border border-[#293754] rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5 text-cyan-400" />
                    Export .CSV
                  </button>
                  <button
                    type="button"
                    onClick={handleExportMarkdown}
                    className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#172033] hover:bg-[#1f2b44] border border-[#293754] rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5 text-cyan-400" />
                    Export .MD
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPrintModalOpen(true)}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg flex items-center gap-1.5 whitespace-nowrap transition-colors"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    Export PDF / Print
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveFullPlanAsDraft}
                    className="px-3.5 py-1.5 text-xs font-semibold text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Save 30-Day Plan to Campaigns
                  </button>
                </div>
              </div>

              {/* 30-Day Cards Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {visibleDays.map((item) => (
                  <div
                    key={item.day}
                    className="p-4 rounded-2xl bg-[#0f1422] border border-[#1e273a] hover:border-[#2e3c5a] transition-colors flex flex-col justify-between space-y-3"
                  >
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-mono font-bold text-cyan-400 tabular-nums">
                          DAY {item.day} · WK {item.week}
                        </span>
                        <span className="text-[11px] font-mono text-slate-300">
                          {item.platform} · {item.format}
                        </span>
                      </div>

                      <div className="text-[11px] font-medium text-violet-300">
                        {item.pillar}
                      </div>

                      <h4 className="text-sm font-bold text-slate-100 leading-snug">
                        {item.hook}
                      </h4>

                      <p className="text-xs text-slate-300 leading-relaxed">
                        {item.caption}
                      </p>

                      <div className="pt-1 space-y-1 text-[11px]">
                        <div className="text-emerald-400 font-medium">
                          CTA: {item.cta}
                        </div>
                        <div className="text-slate-500 font-mono">{item.hashtags}</div>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-3 border-t border-[#1a2335]">
                      <button
                        type="button"
                        onClick={() => handleCopyDay(item)}
                        className="px-2.5 py-1.5 text-[11px] font-medium text-slate-200 bg-[#172033] hover:bg-[#1f2b44] border border-[#283552] rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        {copiedDay === item.day ? (
                          <>
                            <Check className="w-3 h-3 text-emerald-400" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            Copy Post
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSaveDayAsDraft(item)}
                        className="px-2.5 py-1.5 text-[11px] font-semibold text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg transition-colors whitespace-nowrap"
                      >
                        + Draft Campaign
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Draft Campaign Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Draft Marketing Campaign"
        maxWidth="md"
      >
        <form onSubmit={handleCreateCampaign} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Campaign Name *
            </label>
            <input
              type="text"
              required
              placeholder="e.g. Q4 Edge Gateway Early Access Broadcast"
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as MarketingChannel)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="email">Email Broadcast</option>
                <option value="social_media">Social Media (X/LinkedIn)</option>
                <option value="seo">SEO & Backlinks</option>
                <option value="content">Content Marketing</option>
                <option value="ads">Targeted Ads</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Budget Allocation ($)
              </label>
              <input
                type="number"
                min="0"
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Target Audience
            </label>
            <input
              type="text"
              placeholder="e.g. Lead engineers, SaaS founders, newsletter subscribers"
              value={targetAudience}
              onChange={(e) => setTargetAudience(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Primary Conversion Goal
            </label>
            <input
              type="text"
              placeholder="e.g. Trial signups, license purchases, newsletter subscribers"
              value={conversionGoal}
              onChange={(e) => setConversionGoal(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Campaign Copy / Pitch
            </label>
            <textarea
              rows={3}
              placeholder="Subject line, opening hook, key call to action..."
              value={keyCopy}
              onChange={(e) => setKeyCopy(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
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
              Save Campaign Draft
            </button>
          </div>
        </form>
      </Modal>

      {/* Printable 30-Day Content Plan PDF / Print Preview Modal */}
      <DeliverableViewerModal
        product={printablePlanProduct}
        subtitle={
          currentPlan
            ? `${currentPlan.targetIndustry} · ${currentPlan.days.length}-Day Content Schedule · Print & PDF Ready`
            : undefined
        }
        onClose={() => setIsPrintModalOpen(false)}
      />
    </div>
  );
};
