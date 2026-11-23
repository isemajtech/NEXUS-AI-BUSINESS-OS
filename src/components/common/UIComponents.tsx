import React from 'react';

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  change?: string;
  isPositive?: boolean;
  icon?: React.ReactNode;
  accentColor?: 'blue' | 'violet' | 'cyan' | 'emerald' | 'amber' | 'rose';
  onClick?: () => void;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  subtitle,
  change,
  isPositive,
  icon,
  accentColor = 'blue',
  onClick,
}) => {
  const accentGlow = {
    blue: 'border-blue-500/20 hover:border-blue-500/40 text-blue-400',
    violet: 'border-violet-500/20 hover:border-violet-500/40 text-violet-400',
    cyan: 'border-cyan-500/20 hover:border-cyan-500/40 text-cyan-400',
    emerald: 'border-emerald-500/20 hover:border-emerald-500/40 text-emerald-400',
    amber: 'border-amber-500/20 hover:border-amber-500/40 text-amber-400',
    rose: 'border-rose-500/20 hover:border-rose-500/40 text-rose-400',
  }[accentColor];

  return (
    <div
      onClick={onClick}
      className={`relative p-5 rounded-xl bg-[#0f1420]/80 border transition-all duration-200 ${accentGlow} ${
        onClick ? 'cursor-pointer hover:bg-[#141b2a]' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">{title}</span>
        {icon && <div className="p-2 rounded-lg bg-[#182030] text-slate-300">{icon}</div>}
      </div>
      <div className="flex items-baseline gap-2">
        <div className="text-2xl sm:text-3xl font-bold font-mono text-slate-100">{value}</div>
        {change && (
          <span
            className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
              isPositive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
            }`}
          >
            {change}
          </span>
        )}
      </div>
      {subtitle && <p className="mt-1.5 text-xs text-slate-400">{subtitle}</p>}
    </div>
  );
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'blue' | 'violet' | 'emerald' | 'amber' | 'rose' | 'neutral';
  size?: 'sm' | 'md';
}

export const Badge: React.FC<BadgeProps> = ({ children, variant = 'neutral', size = 'sm' }) => {
  const styles = {
    blue: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
    violet: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    emerald: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    amber: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    rose: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    neutral: 'bg-slate-800 text-slate-300 border-slate-700',
  }[variant];

  const sizeClass = size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1';

  return (
    <span className={`inline-flex items-center font-medium rounded-full border ${styles} ${sizeClass}`}>
      {children}
    </span>
  );
};

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'md',
}) => {
  if (!isOpen) return null;

  const maxWidthClass = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-xl',
    '2xl': 'max-w-2xl',
  }[maxWidth];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div
        className={`w-full ${maxWidthClass} bg-[#111622] border border-[#212b3e] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1d2537]">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#1a2130] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
  actionText?: string;
  onAction?: () => void;
  secondaryActionText?: string;
  onSecondaryAction?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  actionText,
  onAction,
  secondaryActionText,
  onSecondaryAction,
}) => {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-4 text-center rounded-2xl border border-dashed border-[#1f293d] bg-[#0c1018]/50">
      {icon && <div className="p-3.5 mb-3 rounded-2xl bg-[#141b28] text-blue-400 border border-[#202b3f]">{icon}</div>}
      <h4 className="text-base font-semibold text-slate-200 mb-1">{title}</h4>
      <p className="text-sm text-slate-400 max-w-md mb-6">{description}</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {actionText && onAction && (
          <button
            onClick={onAction}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm shadow-blue-500/20 transition-colors flex items-center gap-2"
          >
            {actionText}
          </button>
        )}
        {secondaryActionText && onSecondaryAction && (
          <button
            onClick={onSecondaryAction}
            className="px-4 py-2 text-sm font-medium text-slate-300 bg-[#161e2e] hover:bg-[#1c273c] border border-[#26344c] rounded-lg transition-colors"
          >
            {secondaryActionText}
          </button>
        )}
      </div>
    </div>
  );
};
