import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import {
  Shield,
  Lock,
  ChevronDown,
  Plus,
  CheckCircle2,
  Database,
  Search,
  Bell,
  Cpu,
} from 'lucide-react';

interface HeaderProps {
  onOpenMobileMenu: () => void;
  onOpenNewBusinessModal: () => void;
  onOpenSupabaseModal: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenMobileMenu,
  onOpenNewBusinessModal,
  onOpenSupabaseModal,
}) => {
  const {
    activeSection,
    businesses,
    selectedBusinessId,
    setSelectedBusinessId,
    selectedBusiness,
    approvals,
    setActiveSection,
    lockOS,
    supabaseConfig,
  } = useOS();

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const pendingApprovalsCount = approvals.filter((a) => a.status === 'pending').length;

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between h-16 px-4 sm:px-6 bg-[#0a0d14]/90 backdrop-blur-md border-b border-[#1b2232]">
      {/* Left side: Brand + Mobile Toggle + Business Selector */}
      <div className="flex items-center gap-3 sm:gap-4">
        {/* Mobile menu button */}
        <button
          onClick={onOpenMobileMenu}
          className="lg:hidden p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#141b28] transition-colors"
          aria-label="Open Navigation Menu"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Brand Icon & Name */}
        <div
          onClick={() => setActiveSection('command_center')}
          className="flex items-center gap-2.5 cursor-pointer group"
        >
          <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 text-white font-bold text-sm shadow-md shadow-blue-500/20 group-hover:shadow-blue-500/40 transition-shadow">
            <Cpu className="w-4 h-4 text-white" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#0a0d14]" />
          </div>
          <div className="hidden sm:block">
            <span className="text-sm font-bold tracking-tight text-slate-100 flex items-center gap-1.5">
              Personal AI <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-violet-400 font-extrabold">Business OS</span>
            </span>
            <span className="block text-[10px] font-mono text-slate-400 -mt-0.5">Autonomous Executive Architecture</span>
          </div>
        </div>

        {/* Business Selector Dropdown (Hidden on AI Assistant screen) */}
        {activeSection !== 'ai_assistant' && (
          <div className="relative">
            <button
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#121723] hover:bg-[#182030] text-slate-200 border border-[#20293d] transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
              <span className="max-w-[130px] sm:max-w-[180px] truncate">
                {selectedBusiness ? selectedBusiness.name : 'All Ventures (Portfolio)'}
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            </button>

            {isDropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setIsDropdownOpen(false)}
                />
                <div className="absolute left-0 mt-1.5 w-64 rounded-xl bg-[#101521] border border-[#232d43] shadow-xl z-50 py-1.5 animate-in fade-in zoom-in-95">
                  <div className="px-3 py-1.5 text-[10px] font-mono font-semibold text-slate-400 uppercase tracking-wider">
                    Select Venture Scope
                  </div>
                  <button
                    onClick={() => {
                      setSelectedBusinessId('all');
                      setIsDropdownOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-[#171f30] ${
                      selectedBusinessId === 'all' ? 'text-blue-400 font-semibold bg-[#141b2a]' : 'text-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-violet-400" />
                      All Businesses (Portfolio)
                    </span>
                    {selectedBusinessId === 'all' && <CheckCircle2 className="w-3.5 h-3.5 text-blue-400" />}
                  </button>
                  <div className="my-1 border-t border-[#1d2639]" />
                  <div className="max-h-48 overflow-y-auto">
                    {businesses.map((biz) => (
                      <button
                        key={biz.id}
                        onClick={() => {
                          setSelectedBusinessId(biz.id);
                          setIsDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-[#171f30] ${
                          selectedBusinessId === biz.id ? 'text-blue-400 font-semibold bg-[#141b2a]' : 'text-slate-300'
                        }`}
                      >
                        <span className="truncate">{biz.name}</span>
                        {selectedBusinessId === biz.id && <CheckCircle2 className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                      </button>
                    ))}
                  </div>
                  <div className="my-1 border-t border-[#1d2639]" />
                  <button
                    onClick={() => {
                      setIsDropdownOpen(false);
                      onOpenNewBusinessModal();
                    }}
                    className="w-full text-left px-3 py-2 text-xs text-blue-400 hover:bg-[#171f30] flex items-center gap-2 font-medium"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Register New Business
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Right side: Supabase state + Pending Approvals + Lock OS */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Supabase status badge (Hidden on AI Assistant screen) */}
        {activeSection !== 'ai_assistant' && (
          <button
            onClick={onOpenSupabaseModal}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-all ${
              supabaseConfig.isConnected
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                : 'bg-[#121722] text-slate-300 border-[#20293d] hover:border-blue-500/50 hover:text-white'
            }`}
            title="Connect to Supabase / Database Management"
          >
            <Database className={`w-3.5 h-3.5 ${supabaseConfig.isConnected ? 'text-emerald-400' : 'text-blue-400'}`} />
            <span className="text-[11px] font-mono">
              {supabaseConfig.isConnected ? 'Supabase Connected' : 'Connect to Supabase'}
            </span>
          </button>
        )}

        {/* Pending Approvals quick badge */}
        <button
          onClick={() => setActiveSection('approval_center')}
          className={`relative p-2 rounded-lg border transition-all ${
            pendingApprovalsCount > 0
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20'
              : 'bg-[#121723] text-slate-400 border-[#20293d] hover:text-slate-200'
          }`}
          title={`${pendingApprovalsCount} Pending Approval Requests`}
        >
          <Bell className="w-4 h-4" />
          {pendingApprovalsCount > 0 && (
            <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-amber-500 text-black text-[10px] font-bold">
              {pendingApprovalsCount}
            </span>
          )}
        </button>

        {/* Lock OS Button */}
        <button
          onClick={lockOS}
          className="p-2 rounded-lg bg-[#121723] hover:bg-[#182030] text-slate-400 hover:text-slate-200 border border-[#20293d] transition-colors"
          title="Lock Private OS Session"
        >
          <Lock className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
