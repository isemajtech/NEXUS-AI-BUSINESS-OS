import React from 'react';
import { useOS, NavSection } from '../../context/OSContext';
import {
  LayoutDashboard,
  Bot,
  Building2,
  CheckCheck,
  Menu,
  X,
  Globe,
  Users2,
  PackageCheck,
  Receipt,
  Megaphone,
  CircleDollarSign,
  Workflow,
  History,
  Settings as SettingsIcon,
  Lock,
} from 'lucide-react';

interface MobileNavProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
  forceShowBottomBar?: boolean;
}

export const MobileNav: React.FC<MobileNavProps> = ({
  isOpen,
  onClose,
  onOpen,
  forceShowBottomBar = false,
}) => {
  const { activeSection, setActiveSection, approvals, tasks, lockOS } = useOS();

  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;
  const activeTasksCount = tasks.filter((t) => t.status === 'in_progress' || t.status === 'pending').length;

  const allSections: { id: NavSection; label: string; icon: React.ComponentType<{ className?: string }>; badge?: number }[] = [
    { id: 'command_center', label: 'Command Center', icon: LayoutDashboard },
    { id: 'ai_assistant', label: 'AI Assistant', icon: Bot },
    { id: 'businesses', label: 'My Businesses', icon: Building2 },
    { id: 'websites_apps', label: 'Websites & Apps', icon: Globe },
    { id: 'ai_workforce', label: 'AI Workforce', icon: Users2, badge: activeTasksCount > 0 ? activeTasksCount : undefined },
    { id: 'products', label: 'Products', icon: PackageCheck },
    { id: 'orders_customers', label: 'Orders & Customers', icon: Receipt },
    { id: 'marketing', label: 'Marketing', icon: Megaphone },
    { id: 'financial_center', label: 'Financial Center', icon: CircleDollarSign },
    { id: 'automations', label: 'Automations', icon: Workflow },
    { id: 'approval_center', label: 'Approval Center', icon: CheckCheck, badge: pendingApprovalsCount > 0 ? pendingApprovalsCount : undefined },
    { id: 'activity_history', label: 'Activity History', icon: History },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  const handleSelect = (id: NavSection) => {
    setActiveSection(id);
    onClose();
  };

  return (
    <>
      {/* Bottom Navigation Bar (Persistent on phones, and centered on desktop during full-screen assistant mode) */}
      <nav
        className={`${
          forceShowBottomBar ? 'flex' : 'lg:hidden flex'
        } fixed bottom-0 left-0 right-0 z-40 bg-[#090c13]/95 backdrop-blur-md border-t border-[#1b2334] px-2 py-1 safe-area-pb`}
      >
        <div className="grid grid-cols-5 gap-1 items-center max-w-lg mx-auto w-full">
          <button
            onClick={() => setActiveSection('command_center')}
            className={`flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[48px] ${
              activeSection === 'command_center' ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <LayoutDashboard className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-medium leading-none">Command</span>
          </button>

          <button
            onClick={() => setActiveSection('ai_assistant')}
            className={`flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[48px] ${
              activeSection === 'ai_assistant' ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Bot className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-medium leading-none">Assistant</span>
          </button>

          <button
            onClick={() => setActiveSection('businesses')}
            className={`flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[48px] ${
              activeSection === 'businesses' ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Building2 className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-medium leading-none">Ventures</span>
          </button>

          <button
            onClick={() => setActiveSection('approval_center')}
            className={`relative flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[48px] ${
              activeSection === 'approval_center' ? 'text-amber-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <div className="relative">
              <CheckCheck className="w-5 h-5 mb-0.5" />
              {pendingApprovalsCount > 0 && (
                <span className="absolute -top-1 -right-2 flex items-center justify-center min-w-3.5 h-3.5 px-0.5 rounded-full bg-amber-500 text-black text-[9px] font-bold">
                  {pendingApprovalsCount}
                </span>
              )}
            </div>
            <span className="text-[10px] font-medium leading-none">Approvals</span>
          </button>

          <button
            onClick={isOpen ? onClose : (onOpen || onClose)}
            className={`flex flex-col items-center justify-center py-1 rounded-lg transition-colors min-h-[48px] ${
              isOpen ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Menu className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-medium leading-none">All Hubs</span>
          </button>
        </div>
      </nav>

      {/* Slide-over Full Drawer for Hubs */}
      {isOpen && (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
            onClick={onClose}
          />

          {/* Drawer Sheet */}
          <div className="relative flex flex-col w-4/5 max-w-xs bg-[#0c1018] border-r border-[#1e273a] h-full shadow-2xl z-10 animate-in slide-in-from-left duration-200">
            {/* Drawer Header */}
            <div className="flex items-center justify-between p-4 border-b border-[#1b2334] bg-[#0a0d14]">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center text-white font-bold text-xs">
                  OS
                </div>
                <div>
                  <span className="text-sm font-bold text-slate-100">Personal AI</span>
                  <span className="block text-[10px] font-mono text-slate-400">Navigation Matrix</span>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#151c2a]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Navigation List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {allSections.map((sec) => {
                const Icon = sec.icon;
                const isActive = activeSection === sec.id;
                return (
                  <button
                    key={sec.id}
                    onClick={() => handleSelect(sec.id)}
                    className={`w-full flex items-center justify-between px-3.5 py-3 rounded-xl text-sm font-medium transition-colors min-h-[48px] ${
                      isActive
                        ? 'bg-blue-600/20 text-blue-400 border border-blue-500/40 font-semibold'
                        : 'text-slate-300 hover:bg-[#141b27] hover:text-slate-100'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Icon className={`w-5 h-5 ${isActive ? 'text-blue-400' : 'text-slate-400'}`} />
                      <span>{sec.label}</span>
                    </div>

                    {sec.badge !== undefined && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                        {sec.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Drawer Footer with Lock */}
            <div className="p-3 border-t border-[#1a2232] bg-[#090c12]">
              <button
                onClick={() => {
                  lockOS();
                  onClose();
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-[#141b28] hover:bg-[#1a2334] text-slate-300 text-xs font-medium border border-[#212c3f] transition-colors min-h-[44px]"
              >
                <Lock className="w-4 h-4 text-slate-400" />
                Lock System Session
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
