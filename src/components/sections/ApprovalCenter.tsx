import React, { useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { ApprovalRequest, ApprovalType, ApprovalStatus } from '../../types';
import { Badge, Modal, EmptyState } from '../common/UIComponents';
import {
  CheckCheck,
  XCircle,
  CheckCircle2,
  Plus,
  PackageCheck,
  Globe,
  Megaphone,
  Undo2,
  DollarSign,
  Shield,
  RefreshCw,
  Loader2,
  AlertCircle,
  Ban,
  ShieldCheck,
} from 'lucide-react';

export const ApprovalCenter: React.FC = () => {
  const {
    approvals,
    serverOwnerApprovals,
    isSyncingServerApprovals,
    serverApprovalsError,
    refreshAuthoritativeApprovals,
    revokeServerOwnerApproval,
    approveRequest,
    rejectRequest,
    createApprovalRequest,
    businesses,
    selectedBusinessId,
  } = useOS();

  const [filterStatus, setFilterStatus] = useState<ApprovalStatus | 'all'>('pending');
  const [rejectModalReq, setRejectModalReq] = useState<ApprovalRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const [approveModalReq, setApproveModalReq] = useState<ApprovalRequest | null>(null);
  const [approveNote, setApproveNote] = useState('');

  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bannerNotice, setBannerNotice] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [isTestTriggerModalOpen, setIsTestTriggerModalOpen] = useState(false);

  useEffect(() => {
    void refreshAuthoritativeApprovals();
  }, []);

  const filteredApprovals = approvals.filter((a) => {
    const matchesBusiness = selectedBusinessId === 'all' || a.businessId === selectedBusinessId;
    const matchesStatus = filterStatus === 'all' || a.status === filterStatus;
    return matchesBusiness && matchesStatus;
  });

  const filteredServerApprovals = serverOwnerApprovals.filter(
    (s) => selectedBusinessId === 'all' || s.business_id === selectedBusinessId
  );

  const pendingCount = approvals.filter((a) => a.status === 'pending').length;
  const approvedCount = approvals.filter((a) => a.status === 'approved').length;
  const rejectedCount = approvals.filter((a) => a.status === 'rejected').length;

  const handleConfirmReject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rejectModalReq || !rejectReason.trim() || isSubmittingAction) return;
    setIsSubmittingAction(true);
    setActionError(null);
    try {
      const result = await rejectRequest(rejectModalReq.id, rejectReason.trim());
      if (!result.ok) {
        setActionError(result.error || 'Could not reject or revoke request on server.');
        return;
      }
      setRejectModalReq(null);
      setRejectReason('');
      setBannerNotice({
        type: 'success',
        message: 'Rejection recorded cleanly.',
      });
    } finally {
      setIsSubmittingAction(false);
    }
  };

  const handleConfirmApprove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approveModalReq || isSubmittingAction) return;
    setIsSubmittingAction(true);
    setActionError(null);
    try {
      const result = await approveRequest(
        approveModalReq.id,
        approveNote.trim() || undefined
      );
      if (!result.ok) {
        setActionError(
          result.error ||
            'Server refused authoritative approval creation. Ticket remains pending.'
        );
        return;
      }
      setBannerNotice({
        type: 'success',
        message: result.approval
          ? `Server-authoritative owner approval created: ${result.approval.approval_id} (expires ${new Date(
              result.approval.expires_at
            ).toLocaleTimeString()}).`
          : `Request "${approveModalReq.title}" authorized.`,
      });
      setApproveModalReq(null);
      setApproveNote('');
    } finally {
      setIsSubmittingAction(false);
    }
  };

  const handleRevokeServerApproval = async (approvalId: string) => {
    setBannerNotice(null);
    const res = await revokeServerOwnerApproval(approvalId);
    if (!res.ok) {
      setBannerNotice({
        type: 'error',
        message: res.error || `Could not revoke approval ${approvalId}.`,
      });
      return;
    }
    setBannerNotice({
      type: 'success',
      message: `Authoritative approval ${approvalId} revoked on server.`,
    });
  };

  // Helper to trigger one of the 6 mandatory approval workflows for testing
  const triggerSimulation = (type: ApprovalType) => {
    const bizId =
      selectedBusinessId !== 'all' ? selectedBusinessId : businesses[0]?.id || 'biz-prime';

    switch (type) {
      case 'publish_product':
        createApprovalRequest({
          type: 'publish_product',
          title: 'Publish Product: High-Performance Next.js Boilerplate',
          description:
            'Product Creation department requesting authorization to release the product to public buyers at $129.00.',
          businessId: bizId,
          requestedByDepartment: 'product_creation',
          urgency: 'standard',
          payloadData: { price: 129.0, format: 'digital_download' },
        });
        break;

      case 'deploy_production_code':
        createApprovalRequest({
          type: 'deploy_production_code',
          title: 'Deploy Production Code: Edge Gateway v2.4 Release',
          description:
            'Development department completed automated regression testing. Ready to deploy build #448 to cloud edge.',
          businessId: bizId,
          requestedByDepartment: 'development',
          urgency: 'high',
          payloadData: { commit: '8f2a1b9', target: 'production' },
        });
        break;

      case 'send_marketing_campaign':
        createApprovalRequest({
          type: 'send_marketing_campaign',
          title: 'Broadcast Email Campaign: Early Black Friday VIP Offer',
          description:
            'Marketing department prepared broadcast to 4,200 verified newsletter subscribers. Budget: $250.00.',
          businessId: bizId,
          requestedByDepartment: 'marketing',
          urgency: 'standard',
          payloadData: { channel: 'email', recipientCount: 4200 },
        });
        break;

      case 'issue_refund':
        createApprovalRequest({
          type: 'issue_refund',
          title: 'Simulated Un-ingested Refund Ticket (Demo Only)',
          description:
            'Simulated ticket without server provenance ingestion. Real authoritative refund approvals require submitting a refund from Orders & Customers while signed in with Supabase Auth.',
          businessId: bizId,
          requestedByDepartment: 'customer_support',
          urgency: 'high',
          authoritativeSynced: false,
          payloadData: { amount: 99.0, reason: 'Duplicate purchase', authoritativeSynced: false },
        });
        break;

      case 'make_purchase':
        createApprovalRequest({
          type: 'make_purchase',
          title: 'Purchase Infrastructure: Enterprise Redis Cluster Upgrade',
          description:
            'Finance and Development department requesting capital expense of $180.00/mo for memory expansion.',
          businessId: bizId,
          requestedByDepartment: 'finance',
          urgency: 'standard',
          payloadData: { vendor: 'Upstash / AWS', cost: 180.0 },
        });
        break;

      case 'change_security_settings':
        createApprovalRequest({
          type: 'change_security_settings',
          title: 'Change Security Settings: Relax CORS for Development API',
          description:
            'Security department requesting review of incoming webhook whitelist to allow preview branch webhooks.',
          businessId: bizId,
          requestedByDepartment: 'security',
          urgency: 'critical',
          payloadData: { rule: 'cors_whitelist_append', origin: '*.internal' },
        });
        break;
    }
    setIsTestTriggerModalOpen(false);
  };

  const getTypeIcon = (type: ApprovalType) => {
    switch (type) {
      case 'publish_product':
        return <PackageCheck className="w-4 h-4 text-cyan-400" />;
      case 'deploy_production_code':
        return <Globe className="w-4 h-4 text-blue-400" />;
      case 'send_marketing_campaign':
        return <Megaphone className="w-4 h-4 text-violet-400" />;
      case 'issue_refund':
        return <Undo2 className="w-4 h-4 text-rose-400" />;
      case 'make_purchase':
        return <DollarSign className="w-4 h-4 text-emerald-400" />;
      case 'change_security_settings':
        return <Shield className="w-4 h-4 text-amber-400" />;
    }
  };

  return (
    <div className="space-y-6 pb-20 sm:pb-8 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-2xl bg-[#0e131d] border border-[#1e2638]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <CheckCheck className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-mono font-medium text-amber-400 uppercase tracking-wider">
              Executive Governance & Gatekeeping
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-100">
            Approval Center
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5">
            Server-authoritative owner sign-off for refunds plus human-in-the-loop gatekeeping across deploys, launches, marketing, and security.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void refreshAuthoritativeApprovals()}
            disabled={isSyncingServerApprovals}
            className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#161d2d] hover:bg-[#1d273c] border border-[#233048] rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-60"
          >
            {isSyncingServerApprovals ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
            )}
            Refresh Server Ledger
          </button>

          <button
            onClick={() => setIsTestTriggerModalOpen(true)}
            className="px-3.5 py-2 text-xs font-medium text-slate-300 bg-[#161d2d] hover:bg-[#1d273c] border border-[#233048] rounded-xl transition-colors flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5 text-amber-400" />
            Test AI Approval Trigger
          </button>
        </div>
      </div>

      {bannerNotice && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${
            bannerNotice.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          <span className="flex items-center gap-2">
            {bannerNotice.type === 'success' ? (
              <ShieldCheck className="w-4 h-4 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            {bannerNotice.message}
          </span>
          <button
            onClick={() => setBannerNotice(null)}
            className="text-[11px] underline opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Authoritative Server Owner Approvals Ledger */}
      <div className="p-4 rounded-2xl bg-[#0c111b] border border-[#1d2638] space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-xs font-mono font-semibold uppercase tracking-wider text-slate-200">
              Authoritative Server Refund Approvals ({filteredServerApprovals.length})
            </h2>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            GET /api/governance/approvals
          </span>
        </div>

        {serverApprovalsError ? (
          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/25 text-amber-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{serverApprovalsError}</span>
          </div>
        ) : filteredServerApprovals.length === 0 ? (
          <p className="text-xs text-slate-400">
            No authoritative server refund approvals recorded for this scope yet.
          </p>
        ) : (
          <div className="space-y-2">
            {filteredServerApprovals.map((srv) => (
              <div
                key={srv.approval_id}
                className="p-3 rounded-xl bg-[#111726] border border-[#1f2940] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
              >
                <div className="space-y-0.5 font-mono">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-100 font-semibold">{srv.approval_id}</span>
                    <Badge
                      variant={
                        srv.status === 'approved'
                          ? 'emerald'
                          : srv.status === 'consumed'
                          ? 'blue'
                          : 'rose'
                      }
                      size="sm"
                    >
                      {srv.status.toUpperCase()}
                    </Badge>
                    <span className="text-emerald-300 font-semibold">
                      ${(srv.amount_cents / 100).toFixed(2)}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    order: <span className="text-slate-200">{srv.order_id}</span>
                    {' • '}req: <span className="text-slate-300">{srv.request_id}</span>
                    {' • '}approver: <span className="text-slate-300">{srv.approved_by_user_id}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">
                    expires: {new Date(srv.expires_at).toLocaleString()}
                    {srv.consumed_at
                      ? ` • consumed: ${new Date(srv.consumed_at).toLocaleString()}`
                      : ''}
                  </div>
                </div>

                {(srv.status === 'approved' || srv.status === 'pending') && (
                  <button
                    onClick={() => void handleRevokeServerApproval(srv.approval_id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 flex items-center gap-1.5 shrink-0"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    Revoke Approval
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filter Tabs & Counters */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-2 rounded-xl bg-[#0f1422] border border-[#1e273a]">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setFilterStatus('pending')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
              filterStatus === 'pending'
                ? 'bg-amber-500 text-black shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Pending Review
            <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-black/20 text-black">
              {pendingCount}
            </span>
          </button>

          <button
            onClick={() => setFilterStatus('approved')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
              filterStatus === 'approved'
                ? 'bg-emerald-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Approved ({approvedCount})
          </button>

          <button
            onClick={() => setFilterStatus('rejected')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors flex items-center gap-1.5 ${
              filterStatus === 'rejected'
                ? 'bg-rose-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Rejected ({rejectedCount})
          </button>

          <button
            onClick={() => setFilterStatus('all')}
            className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
              filterStatus === 'all'
                ? 'bg-[#182133] text-slate-100'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            All Logs ({approvals.length})
          </button>
        </div>

        <div className="text-xs font-mono text-slate-400 px-2">
          Strict Server-Authoritative Refund Mode Active
        </div>
      </div>

      {/* Approval Requests Feed */}
      {filteredApprovals.length === 0 ? (
        <EmptyState
          icon={<CheckCheck className="w-8 h-8 text-amber-400" />}
          title={
            filterStatus === 'pending'
              ? 'Zero Pending Approval Requests'
              : 'No Approval Records in this View'
          }
          description="Autonomous departments are programmed to halt and request authorization before high-impact changes."
          actionText={filterStatus === 'pending' ? 'Simulate Sample Proposal' : undefined}
          onAction={() => setIsTestTriggerModalOpen(true)}
        />
      ) : (
        <div className="space-y-4">
          {filteredApprovals.map((req) => {
            const biz = businesses.find((b) => b.id === req.businessId);
            const isRefund = req.type === 'issue_refund';

            return (
              <div
                key={req.id}
                className={`p-5 rounded-2xl bg-[#0f1422] border transition-all ${
                  req.status === 'pending'
                    ? 'border-amber-500/40 shadow-sm shadow-amber-500/5'
                    : 'border-[#1e273a]'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="p-1.5 rounded-lg bg-[#161d2d] border border-[#233048]">
                        {getTypeIcon(req.type)}
                      </div>
                      <span className="text-xs font-mono uppercase px-2 py-0.5 rounded bg-[#161f30] text-slate-300 border border-[#222e44]">
                        {req.type.replace(/_/g, ' ')}
                      </span>
                      <span
                        className={`text-[10px] font-mono uppercase font-bold px-2 py-0.5 rounded ${
                          req.urgency === 'critical'
                            ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                            : req.urgency === 'high'
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                        }`}
                      >
                        {req.urgency} urgency
                      </span>
                      {isRefund && req.serverApprovalId && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          SERVER ID: {req.serverApprovalId}
                          {req.serverApprovalStatus ? ` (${req.serverApprovalStatus})` : ''}
                        </span>
                      )}
                      {isRefund && !req.payloadData?.requestId && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                          UN-INGESTED (CANNOT AUTHORIZE ON SERVER)
                        </span>
                      )}
                    </div>

                    <h3 className="text-base font-bold text-slate-100">{req.title}</h3>
                    <div className="text-xs font-mono text-slate-400">
                      Requested by:{' '}
                      <strong className="text-blue-400">
                        {req.requestedByDepartment.replace('_', ' ')}
                      </strong>
                      {' • '}
                      Venture: <strong className="text-slate-300">{biz?.name || 'Cross-Venture'}</strong>
                    </div>
                  </div>

                  <div className="shrink-0">
                    <Badge
                      variant={
                        req.status === 'approved'
                          ? 'emerald'
                          : req.status === 'rejected'
                          ? 'rose'
                          : 'amber'
                      }
                      size="md"
                    >
                      {req.status.toUpperCase()}
                    </Badge>
                  </div>
                </div>

                <p className="text-xs sm:text-sm text-slate-300 leading-relaxed bg-[#121724] p-3 rounded-xl border border-[#1b2334]">
                  {req.description}
                </p>

                {/* Payload data if available */}
                {req.payloadData && Object.keys(req.payloadData).length > 0 && (
                  <div className="mt-2 p-2.5 rounded-lg bg-[#0a0d14] border border-[#161d2c] text-[11px] font-mono text-slate-400">
                    <span className="text-slate-500 uppercase tracking-wider block mb-1">
                      Payload Specs:
                    </span>
                    <pre className="overflow-x-auto whitespace-pre-wrap text-slate-300">
                      {JSON.stringify(req.payloadData, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Decision note if decided */}
                {req.decisionNote && (
                  <div className="mt-2 text-xs text-slate-300 p-2.5 rounded-lg bg-[#161b28] border border-[#212a3d]">
                    <span className="font-semibold text-slate-200">Owner Decision Note:</span>{' '}
                    {req.decisionNote}
                    {req.decidedAt && (
                      <span className="block text-[10px] font-mono text-slate-400 mt-0.5">
                        Decided at: {new Date(req.decidedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}

                {/* Action buttons (only for pending) */}
                {req.status === 'pending' && (
                  <div className="flex items-center justify-end gap-3 pt-3 mt-3 border-t border-[#1b2335]">
                    <button
                      onClick={() => {
                        setActionError(null);
                        setRejectModalReq(req);
                        setRejectReason('');
                      }}
                      className="px-4 py-2 text-xs font-semibold rounded-xl text-rose-400 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 transition-colors flex items-center gap-1.5"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      Reject Proposal
                    </button>

                    <button
                      onClick={() => {
                        setActionError(null);
                        setApproveModalReq(req);
                        setApproveNote('');
                      }}
                      className="px-4 py-2 text-xs font-semibold rounded-xl text-black bg-emerald-400 hover:bg-emerald-300 shadow-md shadow-emerald-500/20 transition-all flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {isRefund ? 'Authorize on Server' : 'Authorize & Execute'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Reject Modal */}
      {rejectModalReq && (
        <Modal
          isOpen={true}
          onClose={() => {
            if (!isSubmittingAction) {
              setRejectModalReq(null);
              setActionError(null);
            }
          }}
          title="Reject AI Department Proposal"
          maxWidth="md"
        >
          <form onSubmit={handleConfirmReject} className="space-y-4">
            <p className="text-xs text-slate-300 leading-relaxed">
              State the reason for rejecting{' '}
              <strong className="text-slate-100">&ldquo;{rejectModalReq.title}&rdquo;</strong>.
              This directive will be recorded in the audit log and returned to the requesting department.
            </p>

            {actionError && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{actionError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Rejection Rationale *
              </label>
              <textarea
                required
                rows={3}
                placeholder="e.g. Budget limit exceeded, security review needed, scope change..."
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isSubmittingAction}
                onClick={() => {
                  setRejectModalReq(null);
                  setActionError(null);
                }}
                className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingAction}
                className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-lg shadow-sm disabled:opacity-60"
              >
                {isSubmittingAction ? 'Processing...' : 'Confirm Rejection'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Approve Modal */}
      {approveModalReq && (
        <Modal
          isOpen={true}
          onClose={() => {
            if (!isSubmittingAction) {
              setApproveModalReq(null);
              setActionError(null);
            }
          }}
          title="Executive Authorization Sign-off"
          maxWidth="md"
        >
          <form onSubmit={handleConfirmApprove} className="space-y-4">
            <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs">
              You are authorizing:{' '}
              <strong>{approveModalReq.title}</strong>
              {approveModalReq.type === 'issue_refund' && (
                <span className="block mt-1 text-[11px] text-emerald-200/80">
                  Creates an authoritative single-use approval record on the server via POST /api/governance/approvals.
                </span>
              )}
            </div>

            {actionError && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{actionError}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Optional Executive Note
              </label>
              <textarea
                rows={2}
                placeholder="e.g. Approved. Monitor conversion rate closely."
                value={approveNote}
                onChange={(e) => setApproveNote(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg bg-[#141b2a] border border-[#232f45] text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={isSubmittingAction}
                onClick={() => {
                  setApproveModalReq(null);
                  setActionError(null);
                }}
                className="px-3 py-2 text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmittingAction}
                className="px-4 py-2 text-xs font-semibold text-black bg-emerald-400 hover:bg-emerald-300 rounded-lg shadow-sm disabled:opacity-60 flex items-center gap-1.5"
              >
                {isSubmittingAction ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Authorizing...
                  </>
                ) : approveModalReq.type === 'issue_refund' ? (
                  'Sign & Record Server Approval'
                ) : (
                  'Sign & Execute'
                )}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Test simulation picker modal */}
      <Modal
        isOpen={isTestTriggerModalOpen}
        onClose={() => setIsTestTriggerModalOpen(false)}
        title="Simulate Autonomous Department Approval Request"
        maxWidth="md"
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            Select one of the 6 guarded operations to generate an incoming approval ticket:
          </p>

          <div className="space-y-2">
            <button
              onClick={() => triggerSimulation('publish_product')}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#222e44] text-left text-xs text-slate-200 flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <PackageCheck className="w-4 h-4 text-cyan-400" />
                1. Publishing Products
              </span>
              <Plus className="w-3.5 h-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => triggerSimulation('deploy_production_code')}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#222e44] text-left text-xs text-slate-200 flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <Globe className="w-4 h-4 text-blue-400" />
                2. Deploying Production Code
              </span>
              <Plus className="w-3.5 h-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => triggerSimulation('send_marketing_campaign')}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#222e44] text-left text-xs text-slate-200 flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <Megaphone className="w-4 h-4 text-violet-400" />
                3. Sending Marketing Campaigns
              </span>
              <Plus className="w-3.5 h-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => triggerSimulation('issue_refund')}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#222e44] text-left text-xs text-slate-200 flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <Undo2 className="w-4 h-4 text-rose-400" />
                4. Issuing Refunds (Demo Ticket Only)
              </span>
              <Plus className="w-3.5 h-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => triggerSimulation('make_purchase')}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#222e44] text-left text-xs text-slate-200 flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-emerald-400" />
                5. Making Purchases / Capital Outlay
              </span>
              <Plus className="w-3.5 h-3.5 text-slate-400" />
            </button>

            <button
              onClick={() => triggerSimulation('change_security_settings')}
              className="w-full p-2.5 rounded-xl bg-[#141b2a] hover:bg-[#1a2335] border border-[#222e44] text-left text-xs text-slate-200 flex items-center justify-between"
            >
              <span className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-amber-400" />
                6. Changing Security Settings
              </span>
              <Plus className="w-3.5 h-3.5 text-slate-400" />
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
