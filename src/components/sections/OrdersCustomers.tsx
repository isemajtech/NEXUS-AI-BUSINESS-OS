import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { Customer, Order } from '../../types';
import { Badge, Modal, EmptyState } from '../common/UIComponents';
import { authorizedApiFetch } from '../../lib/supabase';
import {
  Receipt,
  Users,
  Plus,
  DollarSign,
  Undo2,
  CheckCircle2,
  Mail,
  RefreshCw,
  Loader2,
  AlertCircle,
} from 'lucide-react';

export const OrdersCustomers: React.FC = () => {
  const {
    orders,
    customers,
    products,
    businesses,
    selectedBusinessId,
    addCustomer,
    addOrder,
    syncGumroadSales,
    requestRefund,
  } = useOS();

  const [isSyncingGumroad, setIsSyncingGumroad] = useState(false);
  const [syncNotice, setSyncNotice] = useState<{
    type: 'success' | 'info' | 'error';
    message: string;
  } | null>(null);

  const [activeTab, setActiveTab] = useState<'orders' | 'customers'>('orders');
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [refundOrderId, setRefundOrderId] = useState<string | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  // Form states
  const [custName, setCustName] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [custBizId, setCustBizId] = useState(
    selectedBusinessId !== 'all' ? selectedBusinessId : (businesses[0]?.id || '')
  );
  const [custNotes, setCustNotes] = useState('');

  const [orderCustId, setOrderCustId] = useState('');
  const [orderProdId, setOrderProdId] = useState('');
  const [orderPaymentMethod, setOrderPaymentMethod] = useState('Stripe Gateway');

  const filteredOrders = selectedBusinessId === 'all'
    ? orders
    : orders.filter((o) => o.businessId === selectedBusinessId);

  const filteredCustomers = selectedBusinessId === 'all'
    ? customers
    : customers.filter((c) => c.businessId === selectedBusinessId);

  const handleCreateCustomer = (e: React.FormEvent) => {
    e.preventDefault();
    if (!custName.trim() || !custEmail.trim() || !custBizId) return;

    addCustomer({
      name: custName.trim(),
      email: custEmail.trim(),
      businessId: custBizId,
      status: 'active',
      notes: custNotes.trim(),
    });

    setCustName('');
    setCustEmail('');
    setCustNotes('');
    setIsCustomerModalOpen(false);
  };

  const handleCreateOrder = (e: React.FormEvent) => {
    e.preventDefault();
    const cust = customers.find((c) => c.id === orderCustId);
    const prod = products.find((p) => p.id === orderProdId);
    if (!cust || !prod) return;

    addOrder({
      businessId: prod.businessId,
      customerId: cust.id,
      productId: prod.id,
      productName: prod.name,
      customerName: cust.name,
      customerEmail: cust.email,
      amount: prod.price,
      currency: 'USD',
      status: 'completed',
      paymentMethod: orderPaymentMethod,
    });

    setIsOrderModalOpen(false);
  };

  const handleConfirmRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refundOrderId || !refundReason.trim() || refundSubmitting) return;
    setRefundSubmitting(true);
    setRefundError(null);
    try {
      const result = await requestRefund(refundOrderId, refundReason.trim());
      if (!result.ok) {
        setRefundError(result.error || 'Could not submit refund request to server.');
        return;
      }
      setRefundOrderId(null);
      setRefundReason('');
      setRefundError(null);
    } finally {
      setRefundSubmitting(false);
    }
  };

  const handleSyncGumroadSales = async () => {
    setIsSyncingGumroad(true);
    setSyncNotice(null);
    try {
      const resp = await authorizedApiFetch('/api/gumroad/sales');
      const data = await resp.json().catch(() => ({}));
      const fetchedSales = Array.isArray(data?.sales) ? data.sales : [];

      if (fetchedSales.length > 0) {
        const res = syncGumroadSales(fetchedSales);
        setSyncNotice({
          type: 'success',
          message: `Gumroad sync complete: ${res.imported} imported, ${res.updated} updated, ${res.skipped} already in ledger.`,
        });
      } else if (data?.missingSecret) {
        setSyncNotice({
          type: 'info',
          message:
            'GUMROAD_ACCESS_TOKEN is not set in server secrets yet (and 0 Ping webhooks received). Configure GUMROAD_ACCESS_TOKEN on the server to pull historical Gumroad sales.',
        });
      } else if (!data?.success) {
        setSyncNotice({
          type: 'error',
          message: data?.error || 'Could not fetch Gumroad sales.',
        });
      } else {
        setSyncNotice({
          type: 'info',
          message: 'Gumroad ledger checked: 0 sales found yet.',
        });
      }
    } catch (err: any) {
      setSyncNotice({
        type: 'error',
        message: err?.message || 'Network error connecting to Gumroad sales sync endpoint.',
      });
    } finally {
      setIsSyncingGumroad(false);
    }
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Receipt className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-mono font-medium text-emerald-400 uppercase tracking-wider">
              Commerce & CRM Ledger
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">Orders & Customers</h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Verified customer relationships, transaction receipts, and guarded refund authorizations.
          </p>
        </div>

        {/* Tab switcher & quick actions */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex p-1 rounded-xl bg-[#141b2a] border border-[#20293d]">
            <button
              onClick={() => setActiveTab('orders')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                activeTab === 'orders' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Orders ({filteredOrders.length})
            </button>
            <button
              onClick={() => setActiveTab('customers')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                activeTab === 'customers' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Customers ({filteredCustomers.length})
            </button>
          </div>

          <button
            type="button"
            disabled={isSyncingGumroad}
            onClick={handleSyncGumroadSales}
            className="px-3 py-2 text-xs font-semibold text-pink-200 bg-pink-500/15 hover:bg-pink-500/25 disabled:opacity-60 border border-pink-500/30 rounded-xl transition-colors flex items-center gap-1.5 whitespace-nowrap"
          >
            {isSyncingGumroad ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {isSyncingGumroad ? 'Syncing Gumroad...' : 'Sync Gumroad Sales'}
          </button>

          <button
            type="button"
            onClick={() => {
              if (activeTab === 'orders') {
                if (customers.length === 0 || products.length === 0) {
                  setIsCustomerModalOpen(true);
                } else {
                  setOrderCustId(customers[0]?.id || '');
                  setOrderProdId(products[0]?.id || '');
                  setIsOrderModalOpen(true);
                }
              } else {
                setIsCustomerModalOpen(true);
              }
            }}
            className="px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl shadow-sm transition-colors flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            {activeTab === 'orders' ? 'Log Order' : 'Add Customer'}
          </button>
        </div>
      </div>

      {syncNotice && (
        <div
          className={`px-4 py-3 rounded-xl border text-xs flex items-center justify-between gap-3 ${
            syncNotice.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : syncNotice.type === 'error'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
              : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-200'
          }`}
        >
          <div className="flex items-center gap-2">
            {syncNotice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{syncNotice.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setSyncNotice(null)}
            className="text-xs font-semibold opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Orders Tab View */}
      {activeTab === 'orders' && (
        <div className="space-y-4">
          {filteredOrders.length === 0 ? (
            <EmptyState
              icon={<Receipt className="w-8 h-8 text-emerald-400" />}
              title="No Transaction Orders Logged"
              description="Orders from your Stripe, PayPal, or Gumroad gateways will appear here. No fabricated metrics are simulated."
              actionText="Record First Verified Order"
              onAction={() => {
                if (customers.length === 0) {
                  setIsCustomerModalOpen(true);
                } else if (products.length === 0) {
                  setSyncNotice({
                    type: 'info',
                    message: 'Please create a product in the Products tab first before logging an order.',
                  });
                } else {
                  setOrderCustId(customers[0]?.id || '');
                  setOrderProdId(products[0]?.id || '');
                  setIsOrderModalOpen(true);
                }
              }}
            />
          ) : (
            <div className="overflow-x-auto rounded-2xl bg-[#0f1422] border border-[#1e273a]">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#141b2a] border-b border-[#1f293d] text-slate-400 font-mono uppercase text-[10px]">
                  <tr>
                    <th className="px-4 py-3">Order ID</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#182131]">
                  {filteredOrders.map((ord) => (
                    <tr key={ord.id} className="hover:bg-[#131926] transition-colors">
                      <td className="px-4 py-3 font-mono font-medium text-slate-200">{ord.orderNumber}</td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-200">{ord.customerName}</div>
                        <div className="text-[11px] text-slate-400 font-mono">{ord.customerEmail}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{ord.productName}</td>
                      <td className="px-4 py-3 font-mono font-bold text-emerald-400">${ord.amount.toFixed(2)}</td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={
                            ord.status === 'completed'
                              ? 'emerald'
                              : ord.status === 'refunded'
                              ? 'rose'
                              : 'amber'
                          }
                        >
                          {ord.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-400">
                        {new Date(ord.createdAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {ord.status === 'completed' && (
                          <button
                            onClick={() => setRefundOrderId(ord.id)}
                            className="px-2 py-1 text-[11px] font-medium text-rose-400 hover:bg-rose-500/10 rounded transition-colors flex items-center gap-1 ml-auto"
                            title="Request Refund Authorization"
                          >
                            <Undo2 className="w-3 h-3" />
                            Request Refund
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Customers Tab View */}
      {activeTab === 'customers' && (
        <div className="space-y-4">
          {filteredCustomers.length === 0 ? (
            <EmptyState
              icon={<Users className="w-8 h-8 text-blue-400" />}
              title="No Customers Enrolled Yet"
              description="Maintain isolated customer directories per business with spend tracking and notes."
              actionText="Add Customer"
              onAction={() => setIsCustomerModalOpen(true)}
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCustomers.map((cust) => {
                const biz = businesses.find((b) => b.id === cust.businessId);

                return (
                  <div
                    key={cust.id}
                    className="p-5 rounded-2xl bg-[#0f1422] border border-[#1e273a] hover:border-slate-600 transition-all space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold text-slate-100">{cust.name}</h3>
                        <div className="text-xs font-mono text-slate-400 flex items-center gap-1 mt-0.5">
                          <Mail className="w-3 h-3" />
                          {cust.email}
                        </div>
                      </div>
                      <Badge variant="blue">{cust.status}</Badge>
                    </div>

                    <div className="p-3 rounded-xl bg-[#141b2b] border border-[#1f293d] flex items-center justify-between text-xs">
                      <div>
                        <div className="text-[10px] font-mono text-slate-400 uppercase">Total Spend</div>
                        <div className="text-sm font-bold font-mono text-emerald-400">
                          ${cust.totalSpend.toFixed(2)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[10px] font-mono text-slate-400 uppercase">Orders</div>
                        <div className="text-sm font-bold font-mono text-slate-200">
                          {cust.ordersCount}
                        </div>
                      </div>
                    </div>

                    <div className="text-[11px] font-mono text-slate-400 pt-1">
                      Venture: <strong className="text-slate-300">{biz?.name || 'Unassigned'}</strong>
                    </div>

                    {cust.notes && (
                      <p className="text-xs text-slate-400 italic bg-[#111724] p-2 rounded-lg border border-[#1b2334]">
                        &ldquo;{cust.notes}&rdquo;
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Add Customer Modal */}
      <Modal
        isOpen={isCustomerModalOpen}
        onClose={() => setIsCustomerModalOpen(false)}
        title="Enroll Customer into CRM"
        maxWidth="md"
      >
        <form onSubmit={handleCreateCustomer} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Customer Full Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. Jordan Vance"
              value={custName}
              onChange={(e) => setCustName(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Email Address *</label>
            <input
              type="email"
              required
              placeholder="jordan@company.com"
              value={custEmail}
              onChange={(e) => setCustEmail(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Business Venture *</label>
            <select
              required
              value={custBizId}
              onChange={(e) => setCustBizId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {businesses.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">CRM Notes</label>
            <textarea
              rows={2}
              placeholder="Source, contract terms, or account preferences..."
              value={custNotes}
              onChange={(e) => setCustNotes(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsCustomerModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Enroll Customer
            </button>
          </div>
        </form>
      </Modal>

      {/* Log Manual Order Modal */}
      <Modal
        isOpen={isOrderModalOpen}
        onClose={() => setIsOrderModalOpen(false)}
        title="Log Verified Order"
        maxWidth="md"
      >
        <form onSubmit={handleCreateOrder} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Select Customer *</label>
            <select
              required
              value={orderCustId}
              onChange={(e) => setOrderCustId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.email})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Select Product *</label>
            <select
              required
              value={orderProdId}
              onChange={(e) => setOrderProdId(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — ${p.price.toFixed(2)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">Payment Method / Gateway</label>
            <input
              type="text"
              value={orderPaymentMethod}
              onChange={(e) => setOrderPaymentMethod(e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsOrderModalOpen(false)}
              className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-lg shadow-sm"
            >
              Record Order
            </button>
          </div>
        </form>
      </Modal>

      {/* Request Refund Modal */}
      {refundOrderId && (
        <Modal
          isOpen={true}
          onClose={() => {
            if (!refundSubmitting) {
              setRefundOrderId(null);
              setRefundError(null);
            }
          }}
          title="Submit Refund for Owner Approval"
          maxWidth="md"
        >
          <form onSubmit={handleConfirmRefund} className="space-y-4">
            <p className="text-xs text-slate-300 leading-relaxed">
              Submitting a refund ingests a server-signed provenance request and queues it for authoritative Executive Owner sign-off in Approval Center.
            </p>

            {refundError && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{refundError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Reason for Refund *</label>
              <textarea
                required
                rows={3}
                placeholder="Customer dissatisfaction, duplicated charge, subscription cancellation..."
                value={refundReason}
                onChange={(e) => setRefundReason(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={refundSubmitting}
                onClick={() => {
                  setRefundOrderId(null);
                  setRefundError(null);
                }}
                className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={refundSubmitting}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg shadow-sm disabled:opacity-60 flex items-center gap-1.5"
              >
                {refundSubmitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Ingesting Provenance...
                  </>
                ) : (
                  'Send to Approval Center'
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};
