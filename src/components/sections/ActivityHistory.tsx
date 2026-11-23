import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { ActivitySeverity } from '../../types';
import { Badge, Modal } from '../common/UIComponents';
import {
  History,
  Search,
  Filter,
  Trash2,
  Download,
  Shield,
  Activity,
} from 'lucide-react';

export const ActivityHistory: React.FC = () => {
  const { activityLogs, clearActivityLogs, selectedBusinessId, businesses } = useOS();

  const [searchTerm, setSearchTerm] = useState('');
  const [severityFilter, setSeverityFilter] = useState<ActivitySeverity | 'all'>('all');

  const filteredLogs = activityLogs.filter((log) => {
    const matchesBusiness = selectedBusinessId === 'all' || !log.businessId || log.businessId === selectedBusinessId;
    const matchesSeverity = severityFilter === 'all' || log.severity === severityFilter;
    const matchesSearch =
      searchTerm === '' ||
      log.action.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.details.toLowerCase().includes(searchTerm.toLowerCase()) ||
      log.actor.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesBusiness && matchesSeverity && matchesSearch;
  });

  const downloadAuditJSON = () => {
    const blob = new Blob([JSON.stringify(activityLogs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `paio-audit-log-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const severityBadge = (sev: ActivitySeverity) => {
    switch (sev) {
      case 'critical':
        return <Badge variant="rose">Critical</Badge>;
      case 'warning':
        return <Badge variant="amber">Warning</Badge>;
      case 'success':
        return <Badge variant="emerald">Success</Badge>;
      default:
        return <Badge variant="blue">Info</Badge>;
    }
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <History className="w-4 h-4 text-blue-400" />
            <span className="text-xs font-mono font-medium text-blue-400 uppercase tracking-wider">
              System Audit Trail & Telemetry
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">Activity History</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Immutable chronological record of owner authorizations, AI dispatches, and system events.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={downloadAuditJSON}
            className="px-3.5 py-2 text-xs font-medium text-slate-300 bg-[#161d2d] hover:bg-[#1d273c] border border-[#233048] rounded-xl transition-colors flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Export Audit Log
          </button>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-3 rounded-xl bg-[#0f1422] border border-[#1e273a]">
        <div className="relative w-full sm:w-72">
          <input
            type="text"
            placeholder="Search action or details..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto">
          {(['all', 'info', 'success', 'warning', 'critical'] as const).map((sev) => (
            <button
              key={sev}
              onClick={() => setSeverityFilter(sev)}
              className={`px-3 py-1 text-xs font-medium rounded-lg capitalize transition-colors ${
                severityFilter === sev
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200 bg-[#141b2a]'
              }`}
            >
              {sev}
            </button>
          ))}
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="rounded-2xl bg-[#0f1422] border border-[#1e273a] overflow-hidden">
        {filteredLogs.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-400">
            No activity matches the current search or filter criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#141b2a] border-b border-[#1f293d] text-slate-400 font-mono uppercase text-[10px]">
                <tr>
                  <th className="px-4 py-3">Timestamp (UTC)</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Action Event</th>
                  <th className="px-4 py-3">Actor / Dept</th>
                  <th className="px-4 py-3">Venture</th>
                  <th className="px-4 py-3">Execution Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#182131]">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-[#131926] transition-colors">
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{severityBadge(log.severity)}</td>
                    <td className="px-4 py-3 font-mono font-semibold text-slate-200 whitespace-nowrap">
                      {log.action}
                    </td>
                    <td className="px-4 py-3 text-slate-300 whitespace-nowrap">
                      <span className="font-mono text-[11px] text-blue-400">{log.actor}</span>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-[11px] whitespace-nowrap">
                      {log.businessName || 'Global OS'}
                    </td>
                    <td className="px-4 py-3 text-slate-300 max-w-md">
                      {log.details}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
