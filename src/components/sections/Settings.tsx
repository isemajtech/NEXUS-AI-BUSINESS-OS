import React, { useState, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { Badge, Modal } from '../common/UIComponents';
import {
  SUPABASE_SQL_SCHEMA,
  PHASE1_FACTORY_MIGRATION_SQL,
  PHASE1_FACTORY_ROLLBACK_SQL,
  verifyPhase1Infrastructure,
  Phase1VerificationResult,
  testSupabaseConnection,
  getCurrentSupabaseUser,
  signInSupabaseOwner,
  signUpSupabaseOwner,
  signOutSupabaseOwner,
  resetSupabaseClient,
} from '../../lib/supabase';
import { MemoryManagement } from './MemoryManagement';
import {
  Settings as SettingsIcon,
  Database,
  Key,
  Shield,
  Copy,
  Check,
  Download,
  Upload,
  RefreshCw,
  Terminal,
  Lock,
  Cpu,
  Trash2,
  Sparkles,
  Server,
  AlertTriangle,
  Brain,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

export const Settings: React.FC = () => {
  const {
    supabaseConfig,
    updateSupabaseConfig,
    aiConfig,
    updateAIConfig,
    ownerProfile,
    updateOwnerProfile,
    exportDatabaseJSON,
    importDatabaseJSON,
    seedRealisticStarterData,
    resetToCleanSlate,
    logActivity,
  } = useOS();

  // Supabase form & auth state
  const [supabaseUrl, setSupabaseUrl] = useState(supabaseConfig.projectUrl);
  const [supabaseKey, setSupabaseKey] = useState(supabaseConfig.anonKey);
  const [testingSupabase, setTestingSupabase] = useState(false);
  const [supabaseStatusMsg, setSupabaseStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [supaAuthUser, setSupaAuthUser] = useState<{ id: string; email?: string } | null>(null);
  const [supaAuthEmail, setSupaAuthEmail] = useState(ownerProfile.email || '');
  const [supaAuthPassword, setSupaAuthPassword] = useState('');
  const [supaAuthBusy, setSupaAuthBusy] = useState(false);
  const [supaAuthMsg, setSupaAuthMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    getCurrentSupabaseUser().then(setSupaAuthUser).catch(() => setSupaAuthUser(null));
  }, [supabaseConfig.isConnected, supabaseConfig.projectUrl]);

  // Copied SQL state
  const [copiedSQL, setCopiedSQL] = useState(false);
  const [sqlView, setSqlView] = useState<'phase1' | 'rollback' | 'baseline'>('phase1');
  const [isVerifyingPhase1, setIsVerifyingPhase1] = useState(false);
  const [phase1Result, setPhase1Result] = useState<Phase1VerificationResult | null>(null);

  // Owner profile state
  const [ownerName, setOwnerName] = useState(ownerProfile.name);
  const [ownerEmail, setOwnerEmail] = useState(ownerProfile.email);
  const [ownerRole, setOwnerRole] = useState(ownerProfile.roleTitle);
  const [ownerPin, setOwnerPin] = useState(ownerProfile.pinCode || '1234');
  const [profileSaved, setProfileSaved] = useState(false);

  // Import file ref
  const [importJsonText, setImportJsonText] = useState('');
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [backupStatusMsg, setBackupStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

  const handleTestAndSaveSupabase = async (e: React.FormEvent) => {
    e.preventDefault();
    setTestingSupabase(true);
    setSupabaseStatusMsg(null);
    setSupaAuthMsg(null);

    const result = await testSupabaseConnection(supabaseUrl.trim(), supabaseKey.trim());
    setTestingSupabase(false);

    if (result.success) {
      updateSupabaseConfig({
        projectUrl: supabaseUrl.trim(),
        anonKey: supabaseKey.trim(),
        isConnected: true,
        lastCheckedAt: new Date().toISOString(),
      });
      resetSupabaseClient();
      const user = await getCurrentSupabaseUser();
      setSupaAuthUser(user);
      setSupabaseStatusMsg({ type: 'success', text: result.message });
    } else {
      updateSupabaseConfig({
        projectUrl: supabaseUrl.trim(),
        anonKey: supabaseKey.trim(),
        isConnected: false,
        errorMessage: result.message,
        lastCheckedAt: new Date().toISOString(),
      });
      resetSupabaseClient();
      setSupaAuthUser(null);
      setSupabaseStatusMsg({ type: 'error', text: result.message });
    }
  };

  const handleSupabaseAuth = async (mode: 'signin' | 'signup') => {
    if (!supaAuthEmail.trim() || !supaAuthPassword) {
      setSupaAuthMsg({ type: 'error', text: 'Enter email and password for Supabase Auth.' });
      return;
    }
    setSupaAuthBusy(true);
    setSupaAuthMsg(null);
    const res =
      mode === 'signin'
        ? await signInSupabaseOwner(supaAuthEmail, supaAuthPassword)
        : await signUpSupabaseOwner(supaAuthEmail, supaAuthPassword);
    setSupaAuthBusy(false);

    if (res.success) {
      if (res.user) setSupaAuthUser(res.user);
      setSupaAuthPassword('');
      setSupaAuthMsg({ type: 'success', text: res.message });
    } else {
      setSupaAuthMsg({ type: 'error', text: res.message });
    }
  };

  const handleSupabaseSignOut = async () => {
    await signOutSupabaseOwner();
    setSupaAuthUser(null);
    setSupaAuthMsg({ type: 'success', text: 'Signed out of Supabase Auth session.' });
  };

  const activeSqlText =
    sqlView === 'phase1'
      ? PHASE1_FACTORY_MIGRATION_SQL
      : sqlView === 'rollback'
      ? PHASE1_FACTORY_ROLLBACK_SQL
      : SUPABASE_SQL_SCHEMA;

  const activeSqlFilename =
    sqlView === 'phase1'
      ? 'supabase/migrations/20261116000001_digital_product_factory_phase1.sql'
      : sqlView === 'rollback'
      ? 'supabase/migrations/20261116000001_digital_product_factory_phase1_rollback.sql'
      : 'migrations/001_business_os_rls_schema.sql';

  const handleCopySQL = () => {
    navigator.clipboard.writeText(activeSqlText);
    setCopiedSQL(true);
    setTimeout(() => setCopiedSQL(false), 2500);
  };

  const handleVerifyPhase1 = async () => {
    setIsVerifyingPhase1(true);
    const res = await verifyPhase1Infrastructure();
    setPhase1Result(res);
    setIsVerifyingPhase1(false);
    logActivity(
      'PHASE1_SCHEMA_CHECK',
      `Phase 1 Factory infrastructure check: ${res.checks.filter((c) => c.passed).length}/${res.checks.length} checks passed.`,
      res.allPassed ? 'success' : 'warning'
    );
  };

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    updateOwnerProfile({
      name: ownerName.trim(),
      email: ownerEmail.trim(),
      roleTitle: ownerRole.trim(),
      pinCode: ownerPin.trim(),
    });
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  };

  const handleDownloadBackup = () => {
    const jsonStr = exportDatabaseJSON();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `paio-database-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const success = importDatabaseJSON(importJsonText);
    if (success) {
      setIsImportModalOpen(false);
      setImportJsonText('');
      setBackupStatusMsg({ type: 'success', text: 'Database restored cleanly (server-authoritative approval flags cleared for re-verification).' });
    } else {
      setBackupStatusMsg({ type: 'error', text: 'Invalid backup JSON format. Please verify the content.' });
    }
  };

  const handleConfirmReset = () => {
    resetToCleanSlate();
    setIsResetConfirmOpen(false);
  };

  const [settingsTab, setSettingsTab] = useState<'memory' | 'system'>('memory');

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <SettingsIcon className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-mono font-medium text-violet-400 uppercase tracking-wider">
              System Configuration & Business Memory
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">OS Settings & Memory Bank</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Manage persistent business memory, Supabase connection parameters, RLS schema, and owner security.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[#131a29] border border-[#202b3f] self-start sm:self-auto">
          <button
            onClick={() => setSettingsTab('memory')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              settingsTab === 'memory'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a2335]'
            }`}
          >
            <Brain className="w-3.5 h-3.5" />
            <span>Business Memory Bank</span>
          </button>
          <button
            onClick={() => setSettingsTab('system')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              settingsTab === 'system'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a2335]'
            }`}
          >
            <SettingsIcon className="w-3.5 h-3.5" />
            <span>Database & System</span>
          </button>
        </div>
      </div>

      {/* Render Memory Bank tab or System Settings tab */}
      {settingsTab === 'memory' ? (
        <MemoryManagement />
      ) : (
        <div className="space-y-6">
          {/* Grid: 2 Columns on desktop */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column 1: Supabase Configuration & Health */}
        <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <h3 className="text-sm font-bold text-slate-100">Supabase Database Integration</h3>
            </div>
            <Badge variant={supabaseConfig.isConnected ? 'emerald' : 'blue'}>
              {supabaseConfig.isConnected ? 'Cloud Connected' : 'Local Encrypted Store'}
            </Badge>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Personal AI Business OS operates seamlessly with an isolated local database, and can connect directly to your Supabase project instance with Row Level Security.
          </p>

          <form onSubmit={handleTestAndSaveSupabase} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Supabase Project URL</label>
              <input
                type="text"
                placeholder="https://xyzprojectid.supabase.co"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Supabase Anon / Public API Key
              </label>
              <input
                type="password"
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                value={supabaseKey}
                onChange={(e) => setSupabaseKey(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <p className="mt-1 text-[10px] text-slate-400">
                Never supply service-role keys. Anon keys with Row Level Security are strictly enforced.
              </p>
            </div>

            {supabaseStatusMsg && (
              <div
                className={`p-2.5 rounded-lg text-xs font-mono ${
                  supabaseStatusMsg.type === 'success'
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                }`}
              >
                {supabaseStatusMsg.text}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={testingSupabase}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors flex items-center gap-1.5"
              >
                {testingSupabase && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                <span>{testingSupabase ? 'Verifying...' : 'Test & Save Connection'}</span>
              </button>
            </div>
          </form>

          {/* Supabase Owner Auth Session (required for owner-scoped RLS & Storage verification) */}
          <div className="pt-3 border-t border-[#1e273a] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <Key className="w-3.5 h-3.5 text-cyan-400" />
                Supabase Owner Auth Session
              </span>
              <Badge variant={supaAuthUser ? 'emerald' : 'neutral'}>
                {supaAuthUser ? 'Signed In' : 'Anonymous'}
              </Badge>
            </div>

            {supaAuthUser ? (
              <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium text-emerald-300 truncate">
                    {supaAuthUser.email || 'Authenticated Owner'}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400 truncate">
                    UID: {supaAuthUser.id}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleSupabaseSignOut}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-md bg-[#141b2a] border border-[#243047] text-slate-300 hover:text-white shrink-0"
                >
                  Sign Out
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="email"
                    placeholder="Owner email"
                    value={supaAuthEmail}
                    onChange={(e) => setSupaAuthEmail(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="password"
                    placeholder="Supabase password"
                    value={supaAuthPassword}
                    onChange={(e) => setSupaAuthPassword(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={supaAuthBusy}
                    onClick={() => handleSupabaseAuth('signin')}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors"
                  >
                    {supaAuthBusy ? 'Working...' : 'Sign In'}
                  </button>
                  <button
                    type="button"
                    disabled={supaAuthBusy}
                    onClick={() => handleSupabaseAuth('signup')}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-200 bg-[#141b2a] hover:bg-[#1a2335] border border-[#232f45] rounded-lg transition-colors"
                  >
                    Create Owner Account
                  </button>
                </div>
              </div>
            )}

            {supaAuthMsg && (
              <div
                className={`p-2 rounded-lg text-[11px] font-mono ${
                  supaAuthMsg.type === 'success'
                    ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/25'
                    : 'bg-rose-500/10 text-rose-300 border border-rose-500/25'
                }`}
              >
                {supaAuthMsg.text}
              </div>
            )}
          </div>
        </div>

        {/* Right Column 1: AI Provider & Coordinator Routing */}
        <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-violet-400" />
              <h3 className="text-sm font-bold text-slate-100">AI Coordinator Engine Routing</h3>
            </div>
            <Badge variant="violet">Active Proxy</Badge>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            The central AI executive routes instructions to your 6 specialized departments. All write mutations require Owner Approval.
          </p>

          <div className="space-y-3 text-xs">
            <div>
              <label className="block text-slate-300 font-medium mb-1">Active AI Model & Runtime</label>
              <select
                value={aiConfig.model === 'gemini-2.5-flash-lite' ? 'gemini-3.1-flash-lite' : aiConfig.model}
                onChange={(e) => updateAIConfig({ model: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 focus:outline-none focus:border-blue-500"
              >
                <option value="gemini-2.5-flash">Google Gemini 2.5 Flash (Supabase Edge Function: ai-assistant)</option>
                <option value="gemini-2.5-pro">Google Gemini 2.5 Pro (Deep Strategy & Architecture)</option>
                <option value="gemini-3.1-flash-lite">Google Gemini 3.1 Flash-Lite (High Speed Dispatch)</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">Execution Architecture</label>
              <div className="p-3 rounded-xl bg-[#141b2a] border border-[#232f45] space-y-1.5">
                <div className="flex items-center gap-2 text-slate-200 font-semibold">
                  <Database className="w-3.5 h-3.5 text-emerald-400" />
                  Supabase Edge Function: ai-assistant
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Calls Google Gemini API server-side using the <code className="text-emerald-400 font-mono">GEMINI_API_KEY</code> Supabase secret. API keys are never exposed in frontend code.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">Global System Prompt Directive</label>
              <textarea
                rows={3}
                value={aiConfig.customSystemPrompt}
                onChange={(e) => updateAIConfig({ customSystemPrompt: e.target.value })}
                className="w-full p-2.5 rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-300 font-mono text-xs focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Left Column 2: Owner Security Profile & Session PIN */}
        <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-blue-400" />
              <h3 className="text-sm font-bold text-slate-100">Owner Security & Access PIN</h3>
            </div>
            <Lock className="w-4 h-4 text-slate-500" />
          </div>

          <form onSubmit={handleSaveProfile} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Owner Name</label>
                <input
                  type="text"
                  required
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">Security PIN (4 Digits)</label>
                <input
                  type="password"
                  maxLength={6}
                  required
                  value={ownerPin}
                  onChange={(e) => setOwnerPin(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono text-center tracking-widest rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Email</label>
              <input
                type="email"
                required
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Executive Title</label>
              <input
                type="text"
                value={ownerRole}
                onChange={(e) => setOwnerRole(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm transition-colors"
              >
                Update Profile & PIN
              </button>
              {profileSaved && (
                <span className="text-xs text-emerald-400 flex items-center gap-1 font-medium">
                  <Check className="w-3.5 h-3.5" />
                  Saved securely
                </span>
              )}
            </div>
          </form>
        </div>

        {/* Right Column 2: Data Backup & Recovery */}
        <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-bold text-slate-100">Data Backup & Recovery</h3>
            </div>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Export a full encrypted snapshot of your business entities, products, tasks, and audit logs.
          </p>

          <div className="space-y-2.5">
            <button
              onClick={handleDownloadBackup}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#232f45] text-left text-xs font-medium text-slate-200 flex items-center justify-between transition-colors"
            >
              <span className="flex items-center gap-2">
                <Download className="w-4 h-4 text-blue-400" />
                Export Full System Backup (JSON)
              </span>
              <span className="text-[10px] font-mono text-slate-400">Download</span>
            </button>

            <button
              onClick={() => setIsImportModalOpen(true)}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#232f45] text-left text-xs font-medium text-slate-200 flex items-center justify-between transition-colors"
            >
              <span className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-cyan-400" />
                Restore System from Backup JSON
              </span>
              <span className="text-[10px] font-mono text-slate-400">Restore</span>
            </button>

            <button
              onClick={seedRealisticStarterData}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#232f45] text-left text-xs font-medium text-slate-200 flex items-center justify-between transition-colors"
            >
              <span className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-violet-400" />
                Seed Realistic Baseline Records
              </span>
              <span className="text-[10px] font-mono text-slate-400">Test Helper</span>
            </button>

            <button
              onClick={() => setIsResetConfirmOpen(true)}
              className="w-full p-2.5 rounded-xl bg-rose-500/5 hover:bg-rose-500/10 border border-rose-500/20 text-left text-xs font-medium text-rose-300 flex items-center justify-between transition-colors"
            >
              <span className="flex items-center gap-2">
                <Trash2 className="w-4 h-4 text-rose-400" />
                Reset System to Clean Slate
              </span>
              <span className="text-[10px] font-mono text-rose-400">Wipe Data</span>
            </button>
          </div>
          {backupStatusMsg && (
            <div
              className={`p-2.5 rounded-lg text-xs font-mono ${
                backupStatusMsg.type === 'success'
                  ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                  : 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
              }`}
            >
              {backupStatusMsg.text}
            </div>
          )}
        </div>
      </div>

      {/* Full-width Section: Phase 1 Digital Product Factory Migration & Schema Verifier */}
      <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-blue-400" />
              <h3 className="text-sm font-bold text-slate-100">
                Supabase Schema, Phase 1 Factory Migration & RLS Security Verifier
              </h3>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Additive Phase 1 upgrade: extends products, adds factory_jobs + owner RLS, adds gumroad integration check, and creates private product-assets & digital-deliverables buckets.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={isVerifyingPhase1}
              onClick={handleVerifyPhase1}
              className="px-3.5 py-2 text-xs font-semibold text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-xl transition-colors flex items-center gap-1.5"
            >
              {isVerifyingPhase1 ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Shield className="w-3.5 h-3.5" />
              )}
              <span>Verify Phase 1 Schema & Buckets</span>
            </button>

            <button
              onClick={handleCopySQL}
              className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 shrink-0"
            >
              {copiedSQL ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-300" />
                  <span>Copied SQL!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Active SQL</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Live Phase 1 Verification Checklist */}
        {phase1Result && (
          <div className="p-4 rounded-xl bg-[#0a0e17] border border-[#1d273b] space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-200">Live Supabase Phase 1 Verification</span>
              <span className={phase1Result.allPassed ? 'text-emerald-400 font-mono' : 'text-amber-400 font-mono'}>
                {phase1Result.checks.filter((c) => c.passed).length}/{phase1Result.checks.length} Passed
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {phase1Result.checks.map((chk) => (
                <div
                  key={chk.name}
                  className="p-2.5 rounded-lg bg-[#111725] border border-[#1d273c] flex items-start gap-2 text-xs"
                >
                  {chk.passed ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-200">{chk.name}</div>
                    <div className="text-[11px] text-slate-400 break-words">{chk.details}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SQL Script Switcher */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSqlView('phase1')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              sqlView === 'phase1'
                ? 'bg-blue-600 text-white'
                : 'bg-[#141b2a] text-slate-400 hover:text-slate-200 border border-[#222d44]'
            }`}
          >
            Phase 1 Migration SQL (Additive)
          </button>
          <button
            type="button"
            onClick={() => setSqlView('rollback')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              sqlView === 'rollback'
                ? 'bg-rose-600 text-white'
                : 'bg-[#141b2a] text-slate-400 hover:text-slate-200 border border-[#222d44]'
            }`}
          >
            Phase 1 Rollback SQL
          </button>
          <button
            type="button"
            onClick={() => setSqlView('baseline')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              sqlView === 'baseline'
                ? 'bg-[#1d283f] text-slate-100 border border-[#2d3e5e]'
                : 'bg-[#141b2a] text-slate-400 hover:text-slate-200 border border-[#222d44]'
            }`}
          >
            Full Baseline Schema (15 Tables)
          </button>
        </div>

        <div className="relative rounded-xl bg-[#090c13] border border-[#1b2334] overflow-hidden">
          <div className="p-3 bg-[#0d121c] border-b border-[#1b2334] flex items-center justify-between text-[11px] font-mono text-slate-400">
            <span>{activeSqlFilename}</span>
            <span>PostgreSQL 15+ / Supabase</span>
          </div>
          <pre className="p-4 text-[11px] font-mono text-slate-300 max-h-96 overflow-y-auto leading-relaxed select-all">
            {activeSqlText}
          </pre>
        </div>
      </div>
    </div>
  )}

      {/* Import Backup Modal */}
      <Modal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        title="Restore Database from JSON Backup"
        maxWidth="md"
      >
        <form onSubmit={handleImportSubmit} className="space-y-4">
          <p className="text-xs text-slate-300">
            Paste the raw JSON backup string exported from Personal AI Business OS:
          </p>
          <textarea
            required
            rows={8}
            placeholder="{ &quot;version&quot;: &quot;1.0.0&quot;, &quot;businesses&quot;: [...] }"
            value={importJsonText}
            onChange={(e) => setImportJsonText(e.target.value)}
            className="w-full p-3 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
          />
          {backupStatusMsg?.type === 'error' && (
            <div className="p-2.5 rounded-lg text-xs font-mono bg-rose-500/10 text-rose-400 border border-rose-500/30">
              {backupStatusMsg.text}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsImportModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Restore Data
            </button>
          </div>
        </form>
      </Modal>

      {/* Wipe Confirmation Modal */}
      <Modal
        isOpen={isResetConfirmOpen}
        onClose={() => setIsResetConfirmOpen(false)}
        title="Reset System to Clean Slate"
        maxWidth="sm"
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs">
            <AlertTriangle className="w-5 h-5 shrink-0 text-rose-400" />
            <span>This will wipe products, orders, customers, and approval requests back to 0.</span>
          </div>

          <p className="text-xs text-slate-400">
            Your business entities and configured AI department instructions will remain preserved.
          </p>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsResetConfirmOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmReset}
              className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg shadow-sm"
            >
              Confirm Clean Slate
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
