import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Business, BusinessStatus } from '../../types';
import { Badge, Modal } from '../common/UIComponents';
import {
  Building2,
  Plus,
  Archive,
  Globe,
  DollarSign,
  PackageCheck,
  Receipt,
  Edit2,
  Trash2,
  ChevronRight,
  TrendingUp,
  Layers,
} from 'lucide-react';

export const Businesses: React.FC = () => {
  const {
    businesses,
    projects,
    products,
    orders,
    addBusiness,
    updateBusiness,
    archiveBusiness,
    deleteBusiness,
    selectedBusinessId,
    setSelectedBusinessId,
    setActiveSection,
  } = useOS();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingBiz, setEditingBiz] = useState<Business | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [industry, setIndustry] = useState('Software & Technology');
  const [currency, setCurrency] = useState('USD');
  const [targetMarket, setTargetMarket] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');

  const handleOpenAdd = () => {
    setName('');
    setSlug('');
    setDescription('');
    setIndustry('Software & Technology');
    setCurrency('USD');
    setTargetMarket('');
    setWebsiteUrl('');
    setIsAddModalOpen(true);
  };

  const handleOpenEdit = (biz: Business) => {
    setEditingBiz(biz);
    setName(biz.name);
    setSlug(biz.slug);
    setDescription(biz.description);
    setIndustry(biz.industry);
    setCurrency(biz.currency);
    setTargetMarket(biz.targetMarket || '');
    setWebsiteUrl(biz.websiteUrl || '');
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const finalSlug = slug.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    addBusiness({
      name: name.trim(),
      slug: finalSlug,
      description: description.trim(),
      industry: industry.trim(),
      currency,
      targetMarket: targetMarket.trim(),
      websiteUrl: websiteUrl.trim(),
      status: 'active',
    });
    setIsAddModalOpen(false);
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingBiz || !name.trim()) return;
    updateBusiness(editingBiz.id, {
      name: name.trim(),
      slug: slug.trim() || editingBiz.slug,
      description: description.trim(),
      industry: industry.trim(),
      currency,
      targetMarket: targetMarket.trim(),
      websiteUrl: websiteUrl.trim(),
    });
    setEditingBiz(null);
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Building2 className="w-4 h-4 text-blue-400" />
            <span className="text-xs font-mono font-medium text-blue-400 uppercase tracking-wider">
              Portfolio Governance
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">My Businesses</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Manage your sovereign companies, websites, applications, and revenue streams.
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          Add Business
        </button>
      </div>

      {/* Business Cards Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {businesses.map((biz) => {
          const bizProjects = projects.filter((p) => p.businessId === biz.id);
          const bizProducts = products.filter((p) => p.businessId === biz.id);
          const bizOrders = orders.filter((o) => o.businessId === biz.id && o.status === 'completed');
          const bizRevenue = bizOrders.reduce((sum, o) => sum + o.amount, 0);
          const isSelected = selectedBusinessId === biz.id;

          return (
            <div
              key={biz.id}
              className={`p-5 rounded-2xl bg-[#0f1422] border transition-all ${
                isSelected ? 'border-blue-500/50 ring-1 ring-blue-500/30' : 'border-[#1e273a] hover:border-slate-600'
              }`}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-slate-100">{biz.name}</h3>
                    <Badge variant={biz.status === 'active' ? 'emerald' : 'neutral'}>
                      {biz.status}
                    </Badge>
                  </div>
                  <span className="text-xs font-mono text-slate-400">{biz.industry} • {biz.currency}</span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleOpenEdit(biz)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#182133] transition-colors"
                    title="Edit Business"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => archiveBusiness(biz.id)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-[#182133] transition-colors"
                    title="Archive / Unarchive"
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                  {businesses.length > 1 && (
                    <button
                      onClick={() => deleteBusiness(biz.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-[#182133] transition-colors"
                      title="Delete Business"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed mb-4">
                {biz.description || 'No description specified for this venture.'}
              </p>

              {/* Stats Bar */}
              <div className="grid grid-cols-4 gap-2 p-3 rounded-xl bg-[#141b2b] border border-[#1e273c] text-center mb-4">
                <div>
                  <div className="text-[10px] text-slate-400 uppercase font-mono">Apps</div>
                  <div className="text-sm font-bold font-mono text-slate-200">{bizProjects.length}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase font-mono">Products</div>
                  <div className="text-sm font-bold font-mono text-slate-200">{bizProducts.length}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase font-mono">Orders</div>
                  <div className="text-sm font-bold font-mono text-slate-200">{bizOrders.length}</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-400 uppercase font-mono">Revenue</div>
                  <div className="text-sm font-bold font-mono text-emerald-400">
                    ${bizRevenue.toLocaleString('en-US', { minimumFractionDigits: 0 })}
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-2 border-t border-[#1a2335]">
                {biz.websiteUrl ? (
                  <a
                    href={biz.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline flex items-center gap-1 font-mono"
                  >
                    <Globe className="w-3.5 h-3.5" />
                    {biz.websiteUrl.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  <span className="text-xs text-slate-400 font-mono">No website URL</span>
                )}

                <button
                  onClick={() => {
                    setSelectedBusinessId(biz.id);
                    setActiveSection('command_center');
                  }}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 border border-blue-500/30 transition-colors flex items-center gap-1"
                >
                  <span>Focus Scope</span>
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Business Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Register New Sovereign Business"
        maxWidth="md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Company / Venture Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. HyperScale Media"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Identifier Slug (Unique)</label>
            <input
              type="text"
              placeholder="hyperscale-media"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Industry</label>
              <input
                type="text"
                placeholder="Software, E-commerce, Media"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Primary Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (€)</option>
                <option value="GBP">GBP (£)</option>
                <option value="CAD">CAD ($)</option>
                <option value="AUD">AUD ($)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Website URL</label>
            <input
              type="url"
              placeholder="https://example.com"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Executive Summary / Purpose</label>
            <textarea
              rows={3}
              placeholder="Core value proposition and digital products planned..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
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
              Create Business
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit Business Modal */}
      {editingBiz && (
        <Modal
          isOpen={true}
          onClose={() => setEditingBiz(null)}
          title={`Edit ${editingBiz.name}`}
          maxWidth="md"
        >
          <form onSubmit={handleUpdate} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Company Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Website URL</label>
              <input
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Description</label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingBiz(null)}
                className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
              >
                Save Changes
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};
