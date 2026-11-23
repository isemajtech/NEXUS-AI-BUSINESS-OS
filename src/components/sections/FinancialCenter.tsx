import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { ExpenseRecord } from '../../types';
import { MetricCard, Badge, Modal, EmptyState } from '../common/UIComponents';
import {
  CircleDollarSign,
  Plus,
  CreditCard,
  TrendingUp,
  Receipt,
  Building,
  AlertCircle,
  FileText,
  Trash2,
  Lock,
} from 'lucide-react';

export const FinancialCenter: React.FC = () => {
  const {
    orders,
    expenses,
    businesses,
    selectedBusinessId,
    addExpense,
    deleteExpense,
    createApprovalRequest,
  } = useOS();

  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);

  // Form state
  const [vendor, setVendor] = useState('');
  const [amount, setAmount] = useState<number | ''>('');
  const [category, setCategory] = useState<ExpenseRecord['category']>('hosting_infra');
  const [businessId, setBusinessId] = useState(
    selectedBusinessId !== 'all' ? selectedBusinessId : (businesses[0]?.id || '')
  );
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  const filteredOrders = selectedBusinessId === 'all'
    ? orders
    : orders.filter((o) => o.businessId === selectedBusinessId);

  const filteredExpenses = selectedBusinessId === 'all'
    ? expenses
    : expenses.filter((e) => e.businessId === selectedBusinessId);

  const grossRevenue = filteredOrders
    .filter((o) => o.status === 'completed')
    .reduce((sum, o) => sum + o.amount, 0);

  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0);
  const netProfit = grossRevenue - totalExpenses;
  const estimatedTaxReserve = netProfit > 0 ? netProfit * 0.25 : 0;

  const handleCreateExpense = (e: React.FormEvent) => {
    e.preventDefault();
    if (!vendor.trim() || !amount || Number(amount) <= 0 || !businessId) return;

    addExpense({
      businessId,
      vendor: vendor.trim(),
      amount: Number(amount),
      category,
      currency: 'USD',
      date,
      notes: notes.trim(),
      receiptStatus: 'verified',
    });

    setVendor('');
    setAmount('');
    setNotes('');
    setIsExpenseModalOpen(false);
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <CircleDollarSign className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-mono font-medium text-emerald-400 uppercase tracking-wider">
              Treasury & P&L Architecture
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">Financial Center</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Strict verified cashflow tracking, operational expenditures, and tax reserve planning. Zero fabricated metrics.
          </p>
        </div>

        <button
          onClick={() => setIsExpenseModalOpen(true)}
          className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          Log Business Expense
        </button>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <MetricCard
          title="Gross Revenue"
          value={`$${grossRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subtitle="From verified completed orders"
          accentColor="emerald"
        />

        <MetricCard
          title="Operating Expenses"
          value={`$${totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subtitle={`${filteredExpenses.length} expense entries recorded`}
          accentColor="rose"
        />

        <MetricCard
          title="Net Cash Flow"
          value={`$${netProfit.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subtitle={netProfit >= 0 ? 'Positive balance' : 'Operating deficit'}
          accentColor={netProfit >= 0 ? 'emerald' : 'amber'}
        />

        <MetricCard
          title="Est. Tax Reserve (25%)"
          value={`$${estimatedTaxReserve.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          subtitle="Recommended quarterly hold"
          accentColor="blue"
        />
      </div>

      {/* Payment Gateways & Banking Status (Real unverified status - no false claims) */}
      <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-3">
        <h3 className="text-xs font-mono uppercase tracking-wider text-slate-400">
          Payment Processors & Gateway Integrations
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="p-3.5 rounded-xl bg-[#141b2a] border border-[#1f293d] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10 text-blue-400">
                <CreditCard className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-200">Stripe Gateway</div>
                <div className="text-[10px] text-slate-400">Webhooks & Subscriptions</div>
              </div>
            </div>
            <Badge variant="blue">Ready / Configurable</Badge>
          </div>

          <div className="p-3.5 rounded-xl bg-[#141b2a] border border-[#1f293d] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
                <Building className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-200">Corporate Banking</div>
                <div className="text-[10px] text-slate-400">Mercury / Brex / Wise</div>
              </div>
            </div>
            <Badge variant="neutral">Manual Reconciliation</Badge>
          </div>

          <div className="p-3.5 rounded-xl bg-[#141b2a] border border-[#1f293d] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10 text-violet-400">
                <Receipt className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-200">Crypto / USDC Treasury</div>
                <div className="text-[10px] text-slate-400">Self-Custodial Cold Wallet</div>
              </div>
            </div>
            <Badge variant="neutral">Not Initialized</Badge>
          </div>
        </div>
      </div>

      {/* Expense Ledger */}
      <div className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">Expense Ledger ({filteredExpenses.length})</h3>
          <button
            onClick={() => setIsExpenseModalOpen(true)}
            className="text-xs text-blue-400 hover:text-blue-300 font-medium"
          >
            + Add Expense
          </button>
        </div>

        {filteredExpenses.length === 0 ? (
          <div className="py-12 text-center text-xs text-slate-400">
            No expenses logged yet. Keep your business overhead recorded accurately for tax compliance.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#141b2a] border-b border-[#1f293d] text-slate-400 font-mono uppercase text-[10px]">
                <tr>
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Vendor</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5">Amount</th>
                  <th className="px-3 py-2.5">Notes</th>
                  <th className="px-3 py-2.5 text-right">Delete</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#182131]">
                {filteredExpenses.map((exp) => (
                  <tr key={exp.id} className="hover:bg-[#131926] transition-colors">
                    <td className="px-3 py-2.5 font-mono text-[11px] text-slate-400">{exp.date}</td>
                    <td className="px-3 py-2.5 font-semibold text-slate-200">{exp.vendor}</td>
                    <td className="px-3 py-2.5 text-slate-300">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-[#161f30] text-slate-300 border border-[#222e44]">
                        {exp.category.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 font-mono font-bold text-rose-400">${exp.amount.toFixed(2)}</td>
                    <td className="px-3 py-2.5 text-slate-400 text-[11px] max-w-xs truncate">{exp.notes || '-'}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        onClick={() => deleteExpense(exp.id)}
                        className="p-1 rounded text-slate-500 hover:text-rose-400"
                        title="Delete record"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Expense Modal */}
      <Modal
        isOpen={isExpenseModalOpen}
        onClose={() => setIsExpenseModalOpen(false)}
        title="Record Business Expenditure"
        maxWidth="md"
      >
        <form onSubmit={handleCreateExpense} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Vendor / Payee *</label>
            <input
              type="text"
              required
              placeholder="e.g. Supabase, Vercel, GitHub, OpenAI"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Amount ($ USD) *</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                placeholder="29.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Date</label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as any)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                <option value="hosting_infra">Hosting & Infrastructure</option>
                <option value="software_subscription">Software & SaaS</option>
                <option value="marketing">Marketing & Ads</option>
                <option value="contractor">Contractor & Freelance</option>
                <option value="legal">Legal & Admin</option>
                <option value="hardware">Hardware & Devices</option>
                <option value="other">Other Expense</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Business Venture *</label>
              <select
                required
                value={businessId}
                onChange={(e) => setBusinessId(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              >
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Notes / Description</label>
            <textarea
              rows={2}
              placeholder="Receipt details or expense rationale..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsExpenseModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Record Expense
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
