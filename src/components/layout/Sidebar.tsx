import React from 'react';
import { useOS, NavSection } from '../../context/OSContext';
import {
  LayoutDashboard,
  Bot,
  Building2,
  Globe,
  Users2,
  PackageCheck,
  Receipt,
  Megaphone,
  CircleDollarSign,
  Workflow,
  CheckCheck,
  History,
  Settings as SettingsIcon,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';

interface NavItem {
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number | string;
  badgeVariant?: 'amber' | 'blue' | 'emerald';
}

interface NavGroup {
  groupName: string;
  items: NavItem[];
}

export const Sidebar: React.FC = () => {
  const { activeSection, setActiveSection, approvals, tasks } = useOS();

  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;
  const activeTasksCount = tasks.filter((t) => t.status === 'in_progress' || t.status === 'pending').length;

  const navGroups: NavGroup[] = [
    {
      groupName: 'Executive',
      items: [
        { id: 'command_center', label: 'Command Center', icon: LayoutDashboard },
        { id: 'ai_assistant', label: 'AI Assistant', icon: Bot },
      ],
    },
    {
      groupName: 'Ventures & Fleet',
      items: [
        { id: 'businesses', label: 'My Businesses', icon: Building2 },
        { id: 'websites_apps', label: 'Websites & Apps', icon: Globe },
        {
          id: 'ai_workforce',
          label: 'AI Workforce',
          icon: Users2,
          badge: activeTasksCount > 0 ? activeTasksCount : undefined,
          badgeVariant: 'blue',
        },
      ],
    },
    {
      groupName: 'Revenue & Operations',
      items: [
        { id: 'products', label: 'Products', icon: PackageCheck },
        { id: 'orders_customers', label: 'Orders & Customers', icon: Receipt },
        { id: 'marketing', label: 'Marketing', icon: Megaphone },
        { id: 'financial_center', label: 'Financial Center', icon: CircleDollarSign },
      ],
    },
    {
      groupName: 'Governance & Rules',
      items: [
        { id: 'automations', label: 'Automations', icon: Workflow },
        {
          id: 'approval_center',
          label: 'Approval Center',
          icon: CheckCheck,
          badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined,
          badgeVariant: 'amber',
        },
        { id: 'activity_history', label: 'Activity History', icon: History },
        { id: 'settings', label: 'Settings', icon: SettingsIcon },
      ],
    },
  ];

  return (
    <aside className="hidden lg:flex flex-col w-64 shrink-0 bg-[#0c0f17] border-r border-[#19202f] h-[calc(100vh-4rem)] sticky top-16 select-none">
      <div className="flex-1 overflow-y-auto py-4 px-3 space-y-6">
        {navGroups.map((group) => (
          <div key={group.groupName} className="space-y-1">
            <h4 className="px-3 text-[11px] font-mono font-semibold uppercase tracking-wider text-slate-400">
              {group.groupName}
            </h4>
            <div className="mt-1 space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-all ${
                      isActive
                        ? 'bg-blue-600/15 text-blue-400 border border-blue-500/30 font-semibold'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-[#131925]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-blue-400' : 'text-slate-400'}`} />
                      <span>{item.label}</span>
                    </div>

                    {item.badge !== undefined && (
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                          item.badgeVariant === 'amber'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Security & OS status bottom card */}
      <div className="p-3 border-t border-[#182030] bg-[#090c13]">
        <div className="p-2.5 rounded-lg bg-[#111723] border border-[#1e273a] flex items-center gap-2.5">
          <div className="p-1.5 rounded-md bg-emerald-500/10 text-emerald-400">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-medium text-slate-200 truncate">RLS Guardrail Active</div>
            <div className="text-[10px] text-slate-400 truncate">Zero-Trust Owner Access</div>
          </div>
        </div>
      </div>
    </aside>
  );
};
