import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { BusinessMemory, MemoryCategory, MemoryImportance, AIDepartmentType } from '../../types';
import { Badge, Modal } from '../common/UIComponents';
import {
  Brain,
  Plus,
  Search,
  Pin,
  Trash2,
  Edit3,
  Filter,
  Building2,
  Sparkles,
  Layers,
  Shield,
  Tag,
  Check,
  AlertCircle,
} from 'lucide-react';

export const MemoryManagement: React.FC = () => {
  const {
    memories,
    addMemory,
    updateMemory,
    deleteMemory,
    togglePinMemory,
    businesses,
    projects,
    departments,
    supabaseConfig,
  } = useOS();

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedBizFilter, setSelectedBizFilter] = useState<string>('all');
  const [selectedCatFilter, setSelectedCatFilter] = useState<string>('all');
  const [selectedDeptFilter, setSelectedDeptFilter] = useState<string>('all');

  // Modal state
  const [isAddEditOpen, setIsAddEditOpen] = useState(false);
  const [editingMemory, setEditingMemory] = useState<BusinessMemory | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Form state for Add/Edit
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formCategory, setFormCategory] = useState<MemoryCategory>('goal');
  const [formImportance, setFormImportance] = useState<MemoryImportance>('medium');
  const [formDepartment, setFormDepartment] = useState<AIDepartmentType | 'global'>('global');
  const [formBusinessId, setFormBusinessId] = useState<string>('');
  const [formProjectId, setFormProjectId] = useState<string>('');
  const [formTags, setFormTags] = useState<string>('');
  const [formIsPinned, setFormIsPinned] = useState(false);

  const openAddModal = () => {
    setEditingMemory(null);
    setFormTitle('');
    setFormContent('');
    setFormCategory('goal');
    setFormImportance('high');
    setFormDepartment('global');
    setFormBusinessId(businesses[0]?.id || '');
    setFormProjectId('');
    setFormTags('');
    setFormIsPinned(false);
    setIsAddEditOpen(true);
  };

  const openEditModal = (mem: BusinessMemory) => {
    setEditingMemory(mem);
    setFormTitle(mem.title);
    setFormContent(mem.content);
    setFormCategory(mem.category);
    setFormImportance(mem.importance);
    setFormDepartment(mem.department || 'global');
    setFormBusinessId(mem.businessId || '');
    setFormProjectId(mem.projectId || '');
    setFormTags(mem.tags ? mem.tags.join(', ') : '');
    setFormIsPinned(!!mem.isPinned);
    setIsAddEditOpen(true);
  };

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim() || !formContent.trim()) return;

    const tagsArray = formTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (editingMemory) {
      updateMemory(editingMemory.id, {
        title: formTitle.trim(),
        content: formContent.trim(),
        category: formCategory,
        importance: formImportance,
        department: formDepartment,
        businessId: formBusinessId || undefined,
        projectId: formProjectId || undefined,
        tags: tagsArray,
        isPinned: formIsPinned,
      });
    } else {
      addMemory({
        title: formTitle.trim(),
        content: formContent.trim(),
        category: formCategory,
        importance: formImportance,
        department: formDepartment,
        businessId: formBusinessId || undefined,
        projectId: formProjectId || undefined,
        tags: tagsArray,
        isPinned: formIsPinned,
        source: 'user_defined',
      });
    }

    setIsAddEditOpen(false);
  };

  const confirmDelete = () => {
    if (deletingId) {
      deleteMemory(deletingId);
      setDeletingId(null);
    }
  };

  // Filtered memories
  const filteredMemories = memories.filter((mem) => {
    // Text search
    const textMatch =
      searchQuery === '' ||
      mem.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      mem.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (mem.tags && mem.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase())));

    // Business filter
    const bizMatch =
      selectedBizFilter === 'all' ||
      (!mem.businessId && selectedBizFilter === 'global') ||
      mem.businessId === selectedBizFilter;

    // Category filter
    const catMatch = selectedCatFilter === 'all' || mem.category === selectedCatFilter;

    // Department filter
    const deptMatch = selectedDeptFilter === 'all' || (mem.department || 'global') === selectedDeptFilter;

    return textMatch && bizMatch && catMatch && deptMatch;
  });

  const getCategoryBadgeVariant = (cat: MemoryCategory) => {
    switch (cat) {
      case 'goal':
        return 'emerald';
      case 'strategy':
        return 'violet';
      case 'decision':
        return 'blue';
      case 'preference':
        return 'amber';
      case 'approval_policy':
        return 'rose';
      case 'product_info':
        return 'blue';
      default:
        return 'neutral';
    }
  };

  const getImportanceBadge = (imp: MemoryImportance) => {
    switch (imp) {
      case 'high':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">HIGH</span>;
      case 'medium':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">MED</span>;
      case 'low':
        return <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-500/20 text-slate-300 border border-slate-500/30">LOW</span>;
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Brain className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono font-medium text-violet-400 uppercase tracking-wider">
              Long-Term Context Engine
            </span>
          </div>
          <h2 className="text-xl font-bold tracking-tight text-slate-100">
            Persistent Business Memory Bank
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Cross-conversation memory storage powering Gemini AI decisions across your entire business portfolio.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant={supabaseConfig.isConnected ? 'emerald' : 'blue'}>
            {supabaseConfig.isConnected ? 'Synced to Supabase DB' : 'Local Encrypted Memory'}
          </Badge>
          <button
            onClick={openAddModal}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-md transition-all flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Add Memory</span>
          </button>
        </div>
      </div>

      {/* Filter Controls Bar */}
      <div className="p-4 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Search Bar */}
          <div className="relative">
            <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
            <input
              type="text"
              placeholder="Search memories, goals, decisions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Business Filter */}
          <div>
            <select
              value={selectedBizFilter}
              onChange={(e) => setSelectedBizFilter(e.target.value)}
              className="w-full px-3 py-1.5 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="all">All Ventures ({memories.length})</option>
              <option value="global">Global Portfolio Directives</option>
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          {/* Category Filter */}
          <div>
            <select
              value={selectedCatFilter}
              onChange={(e) => setSelectedCatFilter(e.target.value)}
              className="w-full px-3 py-1.5 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="all">All Categories</option>
              <option value="goal">Goals & Targets</option>
              <option value="strategy">Strategy & Stack</option>
              <option value="decision">Key Decisions</option>
              <option value="preference">Owner Preferences</option>
              <option value="approval_policy">Approval Policies</option>
              <option value="product_info">Product & Pricing</option>
              <option value="instruction">Direct Instructions</option>
            </select>
          </div>

          {/* Department Scope Filter */}
          <div>
            <select
              value={selectedDeptFilter}
              onChange={(e) => setSelectedDeptFilter(e.target.value)}
              className="w-full px-3 py-1.5 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="all">All Department Scopes</option>
              <option value="global">Global Scope</option>
              <option value="development">Development & Eng</option>
              <option value="product_creation">Product Strategy</option>
              <option value="marketing">Marketing & Growth</option>
              <option value="customer_support">Customer Support</option>
              <option value="finance">Financial Intelligence</option>
              <option value="security">Security & Governance</option>
            </select>
          </div>
        </div>
      </div>

      {/* Memory Cards Grid */}
      {filteredMemories.length === 0 ? (
        <div className="p-8 text-center rounded-2xl bg-[#0f1422] border border-[#1e273a] text-slate-400">
          <Brain className="w-8 h-8 text-slate-600 mx-auto mb-2 opacity-50" />
          <p className="text-sm font-semibold text-slate-300">No matching business memories found</p>
          <p className="text-xs text-slate-500 mt-1">
            Add a new memory manually or instruct Gemini in chat ("Remember that...") to extract key goals automatically.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredMemories.map((mem) => {
            const biz = businesses.find((b) => b.id === mem.businessId);
            const proj = projects.find((p) => p.id === mem.projectId);

            return (
              <div
                key={mem.id}
                className={`p-4 rounded-2xl bg-[#0f1422] border transition-all hover:border-[#2a3752] flex flex-col justify-between gap-3 ${
                  mem.isPinned ? 'border-violet-500/40 shadow-md shadow-violet-500/5' : 'border-[#1e273a]'
                }`}
              >
                <div>
                  {/* Top Bar badges */}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant={getCategoryBadgeVariant(mem.category)}>
                        {mem.category.replace('_', ' ').toUpperCase()}
                      </Badge>
                      {getImportanceBadge(mem.importance)}
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-[#161f30] text-slate-300 border border-[#212f47]">
                        Dept: {mem.department || 'global'}
                      </span>
                    </div>

                    <button
                      onClick={() => togglePinMemory(mem.id)}
                      className={`p-1 rounded-lg transition-colors ${
                        mem.isPinned ? 'text-amber-400 bg-amber-400/10' : 'text-slate-500 hover:text-slate-300'
                      }`}
                      title={mem.isPinned ? 'Unpin Memory' : 'Pin Memory'}
                    >
                      <Pin className="w-3.5 h-3.5 fill-current" />
                    </button>
                  </div>

                  {/* Title & Content */}
                  <h3 className="text-sm font-bold text-slate-100 mb-1 leading-snug">{mem.title}</h3>
                  <p className="text-xs text-slate-300/90 whitespace-pre-wrap leading-relaxed">{mem.content}</p>

                  {/* Entity Scope Tags */}
                  <div className="mt-3 pt-2.5 border-t border-[#1b2436] flex items-center justify-between text-[11px] text-slate-400 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-slate-300 font-mono">
                        <Building2 className="w-3 h-3 text-blue-400" />
                        {biz ? biz.name : 'Global Venture Directive'}
                      </span>
                      {proj && (
                        <span className="inline-flex items-center gap-1 text-slate-400 font-mono">
                          / {proj.name}
                        </span>
                      )}
                    </div>

                    <span className="text-[10px] font-mono text-slate-500">
                      {mem.source === 'conversation_extracted'
                        ? '🤖 Extracted from Chat'
                        : mem.source === 'user_defined'
                        ? '👤 Owner Defined'
                        : '⚡ System Kernel'}
                    </span>
                  </div>
                </div>

                {/* Bottom Actions */}
                <div className="flex items-center justify-between pt-2 border-t border-[#182030] text-xs">
                  <div className="flex items-center gap-1 text-[10px] font-mono text-slate-500">
                    <span>Saved: {new Date(mem.createdAt).toLocaleDateString()}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openEditModal(mem)}
                      className="px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:text-white bg-[#151c2c] hover:bg-[#1d273d] rounded-lg transition-colors flex items-center gap-1"
                    >
                      <Edit3 className="w-3 h-3 text-blue-400" />
                      <span>Edit / Correct</span>
                    </button>
                    <button
                      onClick={() => setDeletingId(mem.id)}
                      className="p-1 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors"
                      title="Delete Memory"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Memory Modal */}
      <Modal
        isOpen={isAddEditOpen}
        onClose={() => setIsAddEditOpen(false)}
        title={editingMemory ? 'Edit / Correct Business Memory' : 'Add Persistent Business Memory'}
      >
        <form onSubmit={handleSaveSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block text-slate-300 font-medium mb-1">Memory Title</label>
            <input
              type="text"
              required
              placeholder="e.g. Nexus Cloud Tech Revenue Goal or Tech Stack Policy"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Memory Detailed Content</label>
            <textarea
              rows={4}
              required
              placeholder="Enter exact business details, strategic goals, decisions, or owner guidelines..."
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              className="w-full p-3 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500 leading-relaxed"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">Category</label>
              <select
                value={formCategory}
                onChange={(e) => setFormCategory(e.target.value as MemoryCategory)}
                className="w-full px-3 py-2 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="goal">Goal & Target</option>
                <option value="strategy">Strategy & Tech Stack</option>
                <option value="decision">Key Decision</option>
                <option value="preference">Owner Preference</option>
                <option value="approval_policy">Approval Policy</option>
                <option value="product_info">Product & Pricing</option>
                <option value="instruction">Direct Instruction</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">Importance</label>
              <select
                value={formImportance}
                onChange={(e) => setFormImportance(e.target.value as MemoryImportance)}
                className="w-full px-3 py-2 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="high">High Priority Context</option>
                <option value="medium">Medium Priority</option>
                <option value="low">Low Priority</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-medium mb-1">Target Business Scope</label>
              <select
                value={formBusinessId}
                onChange={(e) => setFormBusinessId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="">Global (All Portfolio Ventures)</option>
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">Department Access Scope</label>
              <select
                value={formDepartment}
                onChange={(e) => setFormDepartment(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="global">All 6 AI Departments</option>
                <option value="development">Development & Engineering</option>
                <option value="product_creation">Product Creation</option>
                <option value="marketing">Marketing & Growth</option>
                <option value="customer_support">Customer Support</option>
                <option value="finance">Financial Intelligence</option>
                <option value="security">Security & Governance</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-medium mb-1">Tags (Comma-separated)</label>
            <input
              type="text"
              placeholder="mrr, tech-stack, pricing, rls"
              value={formTags}
              onChange={(e) => setFormTags(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="isPinnedCheck"
              checked={formIsPinned}
              onChange={(e) => setFormIsPinned(e.target.checked)}
              className="w-4 h-4 rounded bg-[#141b2a] border-[#232f45] text-blue-600 focus:ring-0"
            />
            <label htmlFor="isPinnedCheck" className="text-slate-300 font-medium cursor-pointer">
              Pin memory for high priority Gemini context injection
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-3 border-t border-[#1e273a]">
            <button
              type="button"
              onClick={() => setIsAddEditOpen(false)}
              className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-slate-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors"
            >
              {editingMemory ? 'Save Corrections' : 'Save Memory'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!deletingId}
        onClose={() => setDeletingId(null)}
        title="Delete Business Memory"
      >
        <div className="space-y-4 text-xs">
          <p className="text-slate-300">
            Are you sure you want to delete this persistent memory from the OS Memory Bank?
          </p>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              onClick={() => setDeletingId(null)}
              className="px-3.5 py-1.5 font-semibold text-slate-400 hover:text-slate-200 rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              className="px-3.5 py-1.5 font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg shadow-sm"
            >
              Delete Memory
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
