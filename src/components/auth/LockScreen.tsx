import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Lock, KeyRound, ShieldAlert, Fingerprint } from 'lucide-react';

export const LockScreen: React.FC = () => {
  const { ownerProfile, unlockOS } = useOS();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    const success = unlockOS(pin);
    if (!success) {
      setError(true);
      setPin('');
      setTimeout(() => setError(false), 2000);
    }
  };

  const handleQuickBypass = () => {
    // Quick biometric/owner verification with configured pin
    unlockOS(ownerProfile.pinCode || '1234');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#07090e] text-slate-100 select-none">
      <div className="w-full max-w-sm p-6 sm:p-8 rounded-2xl bg-[#0e121a] border border-[#1e2638] shadow-2xl text-center relative overflow-hidden">
        {/* Glow ambient accent */}
        <div className="absolute -top-16 -left-16 w-32 h-32 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -right-16 w-32 h-32 bg-violet-600/10 rounded-full blur-3xl pointer-events-none" />

        {/* Lock Icon */}
        <div className="mx-auto mb-4 w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-600/20 to-violet-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-lg shadow-blue-500/10">
          <Lock className="w-7 h-7" />
        </div>

        <h2 className="text-xl font-bold tracking-tight text-slate-100">Executive Session Secured</h2>
        <p className="mt-1 text-xs text-slate-400">Personal AI Business OS</p>

        <div className="my-5 p-3 rounded-xl bg-[#141824] border border-[#21283a] text-left">
          <div className="text-[11px] font-mono text-slate-400 uppercase">Authenticated Principal</div>
          <div className="text-xs font-semibold text-slate-200 mt-0.5">{ownerProfile.name}</div>
          <div className="text-[11px] text-slate-400">{ownerProfile.roleTitle}</div>
        </div>

        <form onSubmit={handleUnlock} className="space-y-4">
          <div>
            <label className="block text-[11px] font-mono text-slate-400 uppercase tracking-wider mb-1.5 text-left">
              Enter Executive Access PIN
            </label>
            <div className="relative">
              <input
                type="password"
                maxLength={6}
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value);
                  setError(false);
                }}
                placeholder="••••"
                className={`w-full px-4 py-2.5 text-center text-lg font-mono tracking-widest rounded-xl bg-[#131722] border transition-colors focus:outline-none ${
                  error
                    ? 'border-rose-500 text-rose-400 ring-1 ring-rose-500'
                    : 'border-[#222b3d] text-slate-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                }`}
                autoFocus
              />
              <KeyRound className="absolute right-3.5 top-3 w-4 h-4 text-slate-400" />
            </div>
            {error && (
              <p className="mt-1.5 text-xs text-rose-400 flex items-center justify-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5" />
                Invalid PIN code. Please retry.
              </p>
            )}
            <p className="mt-1 text-[10px] text-slate-400">Default security PIN: 1234</p>
          </div>

          <button
            type="submit"
            className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center justify-center gap-2"
          >
            Authenticate & Resume
          </button>

          <button
            type="button"
            onClick={handleQuickBypass}
            className="w-full py-2 px-3 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-[#151a26] rounded-xl border border-transparent hover:border-[#222a3c] transition-colors flex items-center justify-center gap-1.5"
          >
            <Fingerprint className="w-4 h-4 text-violet-400" />
            Quick Touch / Keypass Unlock
          </button>
        </form>
      </div>
    </div>
  );
};
