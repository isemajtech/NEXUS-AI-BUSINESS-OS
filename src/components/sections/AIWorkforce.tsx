import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { AIAgentDepartment, AIDepartmentType, AgentAutonomyLevel, TaskPriority } from '../../types';
import { Badge, Modal } from '../common/UIComponents';
import {
  Users2,
  Code2,
  Sparkles,
  Megaphone,
  HeadphonesIcon,
  CircleDollarSign,
  ShieldCheck,
  Plus,
  CheckCircle2,
  Settings,
  Lock,
  ArrowRight,
  ListTodo,
} from 'lucide-react';

export const AIWorkforce: React.FC = () => {
  const {
    departments,
    updateDepartment,
    tasks,
    addTask,
    updateTaskStatus,
    selectedBusiness,
  } = useOS();

  const [activeDeptType, setActiveDeptType] = useState<AIDepartmentType>('development');
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);

  // Task form state
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskPriority, setTaskPriority] = useState<TaskPriority>('medium');

  const activeDept = departments.find((d) => d.type === activeDeptType) || departments[0];
  const deptTasks = tasks.filter((t) => t.departmentId === activeDept.type);

  // Department icon helper
  const getDeptIcon = (type: AIDepartmentType) => {
    switch (type) {
      case 'development':
        return <Code2 className="w-5 h-5 text-blue-400" />;
      case 'product_creation':
        return <Sparkles className="w-5 h-5 text-violet-400" />;
      case 'marketing':
        return <Megaphone className="w-5 h-5 text-cyan-400" />;
      case 'customer_support':
        return <HeadphonesIcon className="w-5 h-5 text-emerald-400" />;
      case 'finance':
        return <CircleDollarSign className="w-5 h-5 text-amber-400" />;
      case 'security':
        return <ShieldCheck className="w-5 h-5 text-rose-400" />;
    }
  };

  const handleUpdateInstructions = (newInstructions: string) => {
    updateDepartment(activeDept.type, { systemInstructions: newInstructions });
  };

  const handleUpdateAutonomy = (level: AgentAutonomyLevel) => {
    updateDepartment(activeDept.type, { autonomyLevel: level });
  };

  const handleTogglePermission = (key: keyof AIAgentDepartment['permissions']) => {
    const current = activeDept.permissions[key];
    updateDepartment(activeDept.type, {
      permissions: {
        ...activeDept.permissions,
        [key]: !current,
      },
    });
  };

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return;

    addTask({
      departmentId: activeDept.type,
      businessId: selectedBusiness?.id,
      title: taskTitle.trim(),
      description: taskDesc.trim(),
      priority: taskPriority,
      status: 'pending',
      assignedAgent: `${activeDept.name} Autonomous Unit`,
    });

    setTaskTitle('');
    setTaskDesc('');
    setIsTaskModalOpen(false);
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Users2 className="w-4 h-4 text-blue-400" />
            <span className="text-xs font-mono font-medium text-blue-400 uppercase tracking-wider">
              Autonomous Division Matrix
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">AI Workforce</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Six specialized AI departments operating under strict owner-defined autonomy boundaries.
          </p>
        </div>

        <button
          onClick={() => setIsTaskModalOpen(true)}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          Queue Department Task
        </button>
      </div>

      {/* 6 Department Cards Navigation */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {departments.map((dept) => {
          const isSelected = dept.type === activeDeptType;
          const deptCount = tasks.filter((t) => t.departmentId === dept.type).length;

          return (
            <button
              key={dept.id}
              onClick={() => setActiveDeptType(dept.type)}
              className={`p-3.5 rounded-xl text-left border transition-all flex flex-col justify-between ${
                isSelected
                  ? 'bg-[#151c2c] border-blue-500/50 ring-1 ring-blue-500/30'
                  : 'bg-[#0f1422] border-[#1e273a] hover:border-slate-600'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                {getDeptIcon(dept.type)}
                <span className="text-[10px] font-mono font-bold text-slate-400">{deptCount} tasks</span>
              </div>
              <div>
                <div className={`text-xs font-bold leading-tight ${isSelected ? 'text-blue-300' : 'text-slate-200'}`}>
                  {dept.name.split(' ')[0]}
                </div>
                <div className="text-[10px] text-slate-400 capitalize mt-0.5">{dept.status}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Active Department Details & Configuration */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Instructions & Permissions Matrix */}
        <div className="lg:col-span-1 space-y-4">
          <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getDeptIcon(activeDept.type)}
                <h3 className="text-sm font-bold text-slate-100">{activeDept.name}</h3>
              </div>
              <Badge variant={activeDept.status === 'active' ? 'emerald' : 'neutral'}>
                {activeDept.status}
              </Badge>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              {activeDept.description}
            </p>

            {/* Status & Autonomy Level Selector */}
            <div className="pt-2 border-t border-[#1b2335] space-y-3">
              <div>
                <label className="block text-[11px] font-mono text-slate-400 uppercase mb-1">
                  Autonomy Governance
                </label>
                <select
                  value={activeDept.autonomyLevel}
                  onChange={(e) => handleUpdateAutonomy(e.target.value as AgentAutonomyLevel)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2b] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
                >
                  <option value="strict_approval">Strict Owner Approval (Mandatory)</option>
                  <option value="semi_autonomous">Semi-Autonomous (Routine Only)</option>
                  <option value="read_only">Read-Only / Analytical Only</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-mono text-slate-400 uppercase mb-1">
                  Department Operational State
                </label>
                <select
                  value={activeDept.status}
                  onChange={(e) => updateDepartment(activeDept.type, { status: e.target.value as any })}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2b] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
                >
                  <option value="active">Active & Available</option>
                  <option value="idle">Idle / Standby</option>
                  <option value="paused">Paused</option>
                </select>
              </div>
            </div>

            {/* Permissions Matrix */}
            <div className="pt-2 border-t border-[#1b2335]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-mono text-slate-400 uppercase">Executive Permissions</span>
                <Lock className="w-3.5 h-3.5 text-slate-500" />
              </div>

              <div className="space-y-1.5 text-xs">
                {Object.entries(activeDept.permissions).map(([key, val]) => (
                  <label
                    key={key}
                    className="flex items-center justify-between p-2 rounded-lg bg-[#141b2a] border border-[#1f293d] cursor-pointer hover:border-slate-500 transition-colors"
                  >
                    <span className="text-slate-300 text-[11px] font-mono">
                      {key.replace(/([A-Z])/g, ' $1').toLowerCase()}
                    </span>
                    <input
                      type="checkbox"
                      checked={val}
                      onChange={() => handleTogglePermission(key as any)}
                      className="rounded bg-[#1a2335] border-[#29364f] text-blue-500 focus:ring-blue-500"
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* System Instructions Editor */}
          <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">System Directives & Rules</span>
              <Settings className="w-3.5 h-3.5 text-slate-400" />
            </div>
            <textarea
              rows={4}
              value={activeDept.systemInstructions}
              onChange={(e) => handleUpdateInstructions(e.target.value)}
              className="w-full p-3 text-xs font-mono rounded-xl bg-[#141b2b] border border-[#222e44] text-slate-300 focus:outline-none focus:border-blue-500"
            />
            <p className="text-[10px] text-slate-400">
              Changes persist instantly across all coordinated workflows.
            </p>
          </div>
        </div>

        {/* Right 2 Columns: Task List for this Department */}
        <div className="lg:col-span-2 p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ListTodo className="w-4 h-4 text-blue-400" />
              <h3 className="text-sm font-semibold text-slate-200">
                {activeDept.name} &mdash; Task Queue ({deptTasks.length})
              </h3>
            </div>

            <button
              onClick={() => setIsTaskModalOpen(true)}
              className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 font-medium"
            >
              <Plus className="w-3.5 h-3.5" />
              New Directive
            </button>
          </div>

          {deptTasks.length === 0 ? (
            <div className="py-16 text-center text-xs text-slate-400">
              No tasks currently queued for this department. Use the button above to assign an objective.
            </div>
          ) : (
            <div className="space-y-3">
              {deptTasks.map((task) => (
                <div
                  key={task.id}
                  className="p-4 rounded-xl bg-[#141b2b] border border-[#1f293d] space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-100">{task.title}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 uppercase">
                          {task.priority}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">{task.description}</p>
                    </div>

                    <Badge
                      variant={
                        task.status === 'completed'
                          ? 'emerald'
                          : task.status === 'awaiting_approval'
                          ? 'amber'
                          : 'blue'
                      }
                    >
                      {task.status.replace('_', ' ')}
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-[#1b2436] text-[11px] font-mono text-slate-400">
                    <span>Assigned: {task.assignedAgent}</span>

                    {task.status !== 'completed' && (
                      <button
                        onClick={() => updateTaskStatus(task.id, 'completed', 'Completed by department unit')}
                        className="px-2.5 py-1 text-[11px] text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        Mark Completed
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Task Creation Modal */}
      <Modal
        isOpen={isTaskModalOpen}
        onClose={() => setIsTaskModalOpen(false)}
        title={`Queue Task for ${activeDept.name}`}
        maxWidth="md"
      >
        <form onSubmit={handleCreateTask} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Task Title *</label>
            <input
              type="text"
              required
              placeholder="e.g. Audit API Rate Limits"
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Priority</label>
            <select
              value={taskPriority}
              onChange={(e) => setTaskPriority(e.target.value as TaskPriority)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Detailed Instructions</label>
            <textarea
              rows={3}
              placeholder="Specify requirements, constraints, and success criteria..."
              value={taskDesc}
              onChange={(e) => setTaskDesc(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsTaskModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Queue Task
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
