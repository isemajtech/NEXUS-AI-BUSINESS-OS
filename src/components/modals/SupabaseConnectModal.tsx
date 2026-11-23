import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Modal, Badge } from '../common/UIComponents';
import {
  checkSupabaseHealth,
  SupabaseHealthCheckResult,
  SUPABASE_SQL_SCHEMA,
} from '../../lib/supabase';
import {
  Database,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  RefreshCw,
  ExternalLink,
  Shield,
  Eye,
  EyeOff,
  Terminal,
  Server,
  ArrowRight,
  LogOut,
} from 'lucide-react';

interface SupabaseConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SupabaseConnectModal: React.FC<SupabaseConnectModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { supabaseConfig, updateSupabaseConfig, logActivity } = useOS();

  const [url, setUrl] = useState(supabaseConfig.projectUrl);
  const [anonKey, setAnonKey] = useState(supabaseConfig.anonKey);
  const [showKey, setShowKey] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [healthResult, setHealthResult] = useState<SupabaseHealthCheckResult | null>(null);
  const [copiedSQL, setCopiedSQL] = useState(false);
  const [activeTab, setActiveTab] = useState<'credentials' | 'schema' | 'guide'>('credentials');

  const handleTestAndConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !anonKey.trim()) return;

    setIsVerifying(true);
    setHealthResult(null);

    const result = await checkSupabaseHealth(url.trim(), anonKey.trim());
    setIsVerifying(false);
    setHealthResult(result);

    if (result.success) {
      updateSupabaseConfig({
        projectUrl: url.trim(),
        anonKey: anonKey.trim(),
        isConnected: true,
        lastCheckedAt: new Date().toISOString(),
      });
      logActivity(
        'SUPABASE_CONNECTED',
        `Connected to Supabase project instance at ${url.trim()}`,
        'success'
      );
    } else {
      updateSupabaseConfig({
        projectUrl: url.trim(),
        anonKey: anonKey.trim(),
        isConnected: false,
        errorMessage: result.message,
        lastCheckedAt: new Date().toISOString(),
      });
    }
  };

  const handleDisconnect = () => {
    updateSupabaseConfig({
      projectUrl: '',
      anonKey: '',
      isConnected: false,
    });
    setUrl('');
    setAnonKey('');
    setHealthResult(null);
    logActivity('SUPABASE_DISCONNECTED', 'Reverted database storage to local encrypted SQLite/Store.', 'warning');
  };

  const handleCopySQL = () => {
    navigator.clipboard.writeText(SUPABASE_SQL_SCHEMA);
    setCopiedSQL(true);
    setTimeout(() => setCopiedSQL(false), 2500);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Connect to Supabase"
      maxWidth="2xl"
    >
      <div className="space-y-5">
        {/* Connection status header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-xl bg-[#090d16] border border-[#1b2438]">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-emerald-500/20 to-blue-500/20 text-emerald-400 border border-emerald-500/30">
              <Database className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-100">Supabase Cloud Database</span>
                <Badge variant={supabaseConfig.isConnected ? 'emerald' : 'neutral'}>
                  {supabaseConfig.isConnected ? 'Connected' : 'Offline / Local Store'}
                </Badge>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {supabaseConfig.isConnected
                  ? `Active instance: ${supabaseConfig.projectUrl}`
                  : 'Currently storing all data in isolated local storage with RLS parity.'}
              </p>
            </div>
          </div>

          {supabaseConfig.isConnected && (
            <button
              onClick={handleDisconnect}
              className="px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 border border-rose-500/30 rounded-lg transition-colors flex items-center gap-1 self-start sm:self-auto"
            >
              <LogOut className="w-3.5 h-3.5" />
              Disconnect
            </button>
          )}
        </div>

        {/* Tab Selection */}
        <div className="flex items-center p-1 rounded-xl bg-[#0c1018] border border-[#1e273a]">
          <button
            onClick={() => setActiveTab('credentials')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'credentials'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            1. Credentials & Auth
          </button>
          <button
            onClick={() => setActiveTab('schema')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'schema'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            2. SQL Schema & RLS
          </button>
          <button
            onClick={() => setActiveTab('guide')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              activeTab === 'guide'
                ? 'bg-blue-600 text-white shadow'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            3. Setup Guide
          </button>
        </div>

        {/* Tab 1: Credentials Form */}
        {activeTab === 'credentials' && (
          <form onSubmit={handleTestAndConnect} className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-300">
                  Supabase Project URL *
                </label>
                <a
                  href="https://supabase.com/dashboard"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-blue-400 hover:underline flex items-center gap-1"
                >
                  Supabase Dashboard
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <input
                type="url"
                required
                placeholder="https://your-project-ref.supabase.co"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="w-full px-3.5 py-2.5 text-xs font-mono rounded-xl bg-[#141b2a] border border-[#232f45] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Found in Supabase: <strong>Project Settings &rarr; API &rarr; Project URL</strong>
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Public Anon Key (<code className="font-mono text-emerald-400">anon public</code>) *
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  required
                  placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                  value={anonKey}
                  onChange={(e) => setAnonKey(e.target.value)}
                  className="w-full pl-3.5 pr-10 py-2.5 text-xs font-mono rounded-xl bg-[#141b2a] border border-[#232f45] text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-slate-200"
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-400">
                <Shield className="w-3.5 h-3.5 text-emerald-400" />
                <span>
                  Never enter service-role keys. Anon keys with Row Level Security protect your database.
                </span>
              </div>
            </div>

            {/* Health check results card */}
            {healthResult && (
              <div
                className={`p-3.5 rounded-xl border text-xs space-y-2 ${
                  healthResult.success
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                }`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  {healthResult.success ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                  )}
                  <span>{healthResult.message}</span>
                </div>

                {healthResult.success && (
                  <div className="pt-2 border-t border-emerald-500/20 text-[11px] font-mono space-y-1 text-slate-300">
                    <div>
                      &bull; Auth Service: <span className="text-emerald-400">Online & Reachable</span>
                    </div>
                    <div>
                      &bull; Verified Tables: {healthResult.existingTables.length > 0 ? (
                        <span className="text-emerald-400">{healthResult.existingTables.join(', ')}</span>
                      ) : (
                        <span className="text-amber-400">None detected yet. Run the SQL schema to create them.</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
              <span className="text-[11px] text-slate-400 font-mono">
                Environment: Isolated Founder Tenant
              </span>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 sm:flex-none px-4 py-2 text-xs text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isVerifying}
                  className="flex-1 sm:flex-none px-5 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl shadow-md shadow-blue-500/20 transition-all flex items-center justify-center gap-2"
                >
                  {isVerifying ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Verifying...</span>
                    </>
                  ) : (
                    <>
                      <span>Test & Connect</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Tab 2: SQL Schema & RLS Exporter */}
        {activeTab === 'schema' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-bold text-slate-200">
                  Supabase PostgreSQL Schema & Row Level Security
                </h4>
                <p className="text-[11px] text-slate-400">
                  Includes all 13 core tables, foreign keys, and zero-trust policies.
                </p>
              </div>

              <button
                onClick={handleCopySQL}
                className="px-3.5 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow transition-colors flex items-center gap-1.5"
              >
                {copiedSQL ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-300" />
                    <span>Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Migration SQL</span>
                  </>
                )}
              </button>
            </div>

            <div className="relative rounded-xl bg-[#090c13] border border-[#1b2334] overflow-hidden">
              <div className="p-2.5 bg-[#0d121c] border-b border-[#1b2334] flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>001_business_os_rls_schema.sql</span>
                <span>PostgreSQL 15+</span>
              </div>
              <pre className="p-3 text-[10px] font-mono text-slate-300 max-h-72 overflow-y-auto leading-relaxed select-all">
                {SUPABASE_SQL_SCHEMA}
              </pre>
            </div>

            <p className="text-[11px] text-slate-400">
              Paste this into your Supabase Dashboard &rarr; <strong>SQL Editor</strong> &rarr; Click <strong>Run</strong>.
            </p>
          </div>
        )}

        {/* Tab 3: Step-by-Step Setup Guide */}
        {activeTab === 'guide' && (
          <div className="space-y-3 text-xs text-slate-300">
            <div className="p-3.5 rounded-xl bg-[#0e131d] border border-[#1e2638] space-y-2.5">
              <h4 className="font-bold text-slate-100 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">1</span>
                Create or Open your Supabase Project
              </h4>
              <p className="text-slate-400 text-[11px] pl-7 leading-relaxed">
                Log into{' '}
                <a
                  href="https://supabase.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:underline"
                >
                  supabase.com
                </a>
                . If you don&apos;t have a project yet, click &ldquo;New Project&rdquo; and choose your preferred cloud region.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#0e131d] border border-[#1e2638] space-y-2.5">
              <h4 className="font-bold text-slate-100 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">2</span>
                Copy Project URL & Anon Public Key
              </h4>
              <p className="text-slate-400 text-[11px] pl-7 leading-relaxed">
                Inside your Supabase dashboard, navigate to <strong>Project Settings &rarr; API</strong>. Copy the <strong>Project URL</strong> and the <strong>anon / public key</strong> into Tab 1 of this modal.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#0e131d] border border-[#1e2638] space-y-2.5">
              <h4 className="font-bold text-slate-100 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold">3</span>
                Execute SQL Migration
              </h4>
              <p className="text-slate-400 text-[11px] pl-7 leading-relaxed">
                Click Tab 2 above (&ldquo;SQL Schema & RLS&rdquo;), click <strong>Copy Migration SQL</strong>, navigate to <strong>SQL Editor</strong> in Supabase, paste, and click <strong>Run</strong>. All 13 tables and Row Level Security policies will be instantiated in seconds.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#0e131d] border border-blue-500/20 space-y-2.5">
              <h4 className="font-bold text-slate-100 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-white flex items-center justify-center text-[10px] font-bold">4</span>
                Google Gemini Secret & Edge Function Deployment
              </h4>
              <div className="pl-7 space-y-1.5 text-[11px] text-slate-300">
                <p className="text-slate-400">
                  Set the Gemini API key in your Supabase project (never in client code):
                </p>
                <div className="p-2 rounded bg-[#090d14] border border-[#1a2335] font-mono text-[10px] text-emerald-400">
                  supabase secrets set GEMINI_API_KEY=&quot;AIzaSy...&quot;
                </div>
                <p className="text-slate-400">Deploy the included Edge Function:</p>
                <div className="p-2 rounded bg-[#090d14] border border-[#1a2335] font-mono text-[10px] text-blue-400">
                  supabase functions deploy ai-assistant
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
