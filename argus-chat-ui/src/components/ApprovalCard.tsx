import { useEffect, useMemo, useState } from 'react';
import type { ApprovalRequest } from '../data-provider/sse.js';
import { apiSend } from '../data-provider/client.js';
import { ep } from '../data-provider/endpoints.js';
import { useMe } from '../data-provider/hooks.js';

interface Props { approval: ApprovalRequest }

function formatRemaining(createdAt: string, ttlSeconds: number): string {
  const remaining = Math.max(0, new Date(createdAt).getTime() + ttlSeconds * 1000 - Date.now());
  if (remaining <= 0) return 'Approval window expired';
  const minutes = Math.ceil(remaining / 60000);
  return `${minutes} min approval window`;
}

function riskDescription(level: ApprovalRequest['risk_level']): string {
  if (level === 'critical') return 'Critical action';
  if (level === 'high') return 'High-risk action';
  return 'Governed action';
}

export function ApprovalCard({ approval }: Props) {
  const { data: me } = useMe();
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [message, setMessage] = useState('');
  const [decisionError, setDecisionError] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const remaining = useMemo(() => formatRemaining(approval.created_at, approval.ttl_seconds), [approval.created_at, approval.ttl_seconds, now]);
  const expired = remaining === 'Approval window expired';
  // The API uses the Argus role hierarchy and grants this action to every role
  // at or above agent_operator. Keep the UI gate aligned with that contract so
  // authorized users do not get a misleading read-only card.
  const canDecide = ['agent_operator', 'developer', 'operations_admin', 'platform_admin', 'admin', 'editor']
    .includes(me?.user.role ?? '');

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function decide(decision: 'approve' | 'reject') {
    if (processing || status !== 'pending' || expired) return;
    if (decision === 'reject' && !comment.trim()) {
      setMessage('A reason is required when rejecting an action.');
      return;
    }
    setProcessing(true);
    setMessage('');
    setDecisionError(false);
    try {
      await apiSend(ep.runtimeApproval(approval.approval_id, decision), 'POST', { comment: comment.trim() || undefined });
      setStatus(decision === 'approve' ? 'approved' : 'rejected');
      setMessage(decision === 'approve'
        ? 'Approved. Retry the action intentionally to consume this single-use grant.'
        : 'Action rejected. Argus will keep the requested action blocked.');
    } catch (error) {
      // Keep the request pending so a transient API failure can be retried.
      // The backend remains the source of truth for the decision.
      setDecisionError(true);
      setMessage(error instanceof Error ? error.message : 'The approval decision could not be submitted.');
    } finally {
      setProcessing(false);
    }
  }

  return (
    <section className={`approval-card ${approval.risk_level} ${status}`} aria-label="Argus approval request">
      <div className="approval-card-header">
        <div>
          <span className="approval-kicker">Argus governance</span>
          <h3>{riskDescription(approval.risk_level)} requires review</h3>
        </div>
        <span className="approval-risk-badge">{approval.risk_level.toUpperCase()} · {approval.risk_score}/100</span>
      </div>

      <p className="approval-card-description">{approval.action_description}</p>

      <div className="approval-card-grid">
        <div><span>Tool</span><code>{approval.tool_name}</code></div>
        <div><span>Scope</span><code>{approval.target_scope}</code></div>
        <div><span>Request</span><code>#{approval.approval_id}</code></div>
        <div><span>Validity</span><strong>{remaining}</strong></div>
      </div>

      {approval.risk_factors.length > 0 && (
        <details className="approval-card-details">
          <summary>Why Argus flagged this action ({approval.risk_factors.length})</summary>
          <ul>
            {approval.risk_factors.map((factor) => <li key={factor.id}><strong>{factor.label}</strong><span>{factor.evidence}</span></li>)}
          </ul>
        </details>
      )}

      <details className="approval-card-details">
        <summary>Review parameters (sensitive values redacted)</summary>
        <pre>{JSON.stringify(approval.parameters, null, 2)}</pre>
      </details>

      {status === 'pending' && !expired && canDecide && (
        <textarea
          className="approval-comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Optional comment for the audit trail; required for rejection"
          rows={2}
          aria-label="Approval comment"
        />
      )}
      {status === 'pending' && !expired && !canDecide && (
        <p className="approval-message">Your role can review this request in the Approval Inbox but cannot decide it.</p>
      )}

      {message && <p className={`approval-message ${decisionError ? 'error' : ''}`}>{message}</p>}

      {status === 'pending' && !expired && canDecide && (
        <div className="approval-actions">
          <button type="button" className="approval-reject" disabled={processing} onClick={() => decide('reject')}>Reject</button>
          <button type="button" className="approval-approve" disabled={processing} onClick={() => decide('approve')}>Approve action</button>
        </div>
      )}
      {(status === 'approved' || status === 'rejected' || expired) && <a href="/governance" className="approval-inbox-link">Open approval inbox</a>}
    </section>
  );
}
