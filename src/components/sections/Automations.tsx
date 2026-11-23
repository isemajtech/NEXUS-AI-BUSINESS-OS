import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { AutomationRule, AIDepartmentType } from '../../types';
import { Badge, Modal } from '../common/UIComponents';
import {
  Workflow,
  Plus,
  Play,
  Pause,
  Shield,
  Trash2,
  CheckCircle2,
  Zap,
  Clock,
  ArrowRight,
} from 'lucide-react';

export const Automations: React.FC = () => {
  const {
    automations,
    toggleAutomation,
    addAutomation,
    deleteAutomation,
    departments,
  } = useOS();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Form states
  const [name, setName] = useState('');
  const [triggerEvent, setTriggerEvent] = useState('');
  const [actionSummary, setActionSummary] = useState('');
  const [targetDepartment, setTargetDepartment] = useState<AIDepartmentType>('development');
  const [requiresOwnerApproval, setRequiresOwnerApproval] = useState(true);

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !triggerEvent.trim() || !actionSummary.trim()) return;

    addAutomation({
      name: name.trim(),
      triggerEvent: triggerEvent.trim(),
      actionSummary: actionSummary.trim(),
      targetDepartment,
      requiresOwnerApproval,
      isActive: true,
    });

    setName('');
    setTriggerEvent('');
    setActionSummary('');
    setIsAddModalOpen(false);
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Workflow className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono font-medium text-violet-400 uppercase tracking-wider">
              Autonomous Event Pipeline
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">Automations & Workflows</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Event-driven triggers connecting webhooks, AI agent departments, and owner guardrails.
          </p>
        </div>

        <button
          onClick={() => setIsAddModalOpen(true)}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          Create Automation Rule
        </button>
      </div>

      {/* Rules List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {automations.map((rule) => (
          <div
            key={rule.id}
            className={`p-5 rounded-2xl bg-[#0f1422] border transition-all flex flex-col justify-between space-y-4 ${
              rule.isActive ? 'border-[#1e273a] hover:border-slate-600' : 'border-[#1b2232] opacity-75'
            }`}
          >
            <div>
              <div className="flex items-start justify-between gap-2 mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-[#161f30] text-violet-300 border border-[#261f3d]">
                  {rule.targetDepartment.replace('_', ' ')}
                </span>

                <div className="flex items-center gap-2">
                  {rule.requiresOwnerApproval && (
                    <Badge variant="amber" size="sm">
                      Requires Approval
                    </Badge>
                  )}
                  <Badge variant={rule.isActive ? 'emerald' : 'neutral'} size="sm">
                    {rule.isActive ? 'Active' : 'Paused'}
                  </Badge>
                </div>
              </div>

              <h3 className="text-base font-bold text-slate-100">{rule.name}</h3>

              <div className="mt-3 p-3 rounded-xl bg-[#141b2a] border border-[#1f293d] space-y-2 text-xs">
                <div className="flex items-start gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-[10px] font-mono text-slate-400 uppercase block">When (Trigger):</span>
                    <span className="text-slate-200 font-medium">{rule.triggerEvent}</span>
                  </div>
                </div>

                <div className="flex items-start gap-2 pt-1 border-t border-[#1a2335]">
                  <ArrowRight className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="text-[10px] font-mono text-slate-400 uppercase block">Then (Action):</span>
                    <span className="text-slate-300">{rule.actionSummary}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-[#1a2335] text-xs">
              <span className="text-[11px] font-mono text-slate-400">
                Executed: {rule.executionCount} times
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleAutomation(rule.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                    rule.isActive
                      ? 'bg-[#182133] text-amber-400 hover:bg-[#202c42]'
                      : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                  }`}
                >
                  {rule.isActive ? (
                    <>
                      <Pause className="w-3 h-3" />
                      Pause
                    </>
                  ) : (
                    <>
                      <Play className="w-3 h-3" />
                      Activate
                    </>
                  )}
                </button>

                <button
                  onClick={() => deleteAutomation(rule.id)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-[#182133] transition-colors"
                  title="Delete Automation"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Create Automation Modal */}
      <Modal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        title="Create Workflow Automation"
        maxWidth="md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Automation Rule Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. Instant Discord Alert on New Order"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Trigger Event (When) *</label>
            <input
              type="text"
              required
              placeholder="e.g. Order completed or Deployment health ping fails"
              value={triggerEvent}
              onChange={(e) => setTriggerEvent(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Target Department *</label>
            <select
              value={targetDepartment}
              onChange={(e) => setTargetDepartment(e.target.value as AIDepartmentType)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {departments.map((d) => (
                <option key={d.type} value={d.type}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Execution Action (Then) *</label>
            <textarea
              rows={3}
              required
              placeholder="What actions must the AI department execute?"
              value={actionSummary}
              onChange={(e) => setActionSummary(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="reqApprovalRule"
              checked={requiresOwnerApproval}
              onChange={(e) => setRequiresOwnerApproval(e.target.checked)}
              className="rounded border-[#20293d] bg-[#131926] text-blue-500 focus:ring-blue-500"
            />
            <label htmlFor="reqApprovalRule" className="text-xs text-slate-300">
              Mandate Owner Approval before executing action
            </label>
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
              Create Rule
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
