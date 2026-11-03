import { lazy, memo, Suspense, useState } from 'react';
import type { UiMessage } from './types.js';
import { formatTok, formatEur } from './format.js';
import { Citations } from './Citations.js';
import { ApprovalCard } from './ApprovalCard.js';
import { Icon } from './Icon.js';

// Markdown brings the math, syntax highlighting and artifact renderers with
// it. A new chat normally starts empty, so defer that substantial render path
// until an assistant has something to display.
const Markdown = lazy(async () => {
  const module = await import('../render/Markdown.js');
  return { default: module.Markdown };
});

interface Props {
  msg: UiMessage;
  streaming?: boolean;
  isLastAssistant?: boolean;
  onRegenerate?: () => void;
  onRetry?: () => void;
  onSwitchVariant?: (leafId: string) => void;
  onEditMessage?: (msgId: string, text: string) => void;
}

/**
 * During token streaming only the final assistant message changes. Memoizing
 * individual rows prevents React/Markdown from re-rendering the complete chat
 * history for every delta.
 */
export const Message = memo(function Message({ msg, streaming, isLastAssistant, onRegenerate, onRetry, onSwitchVariant, onEditMessage }: Props) {
  const isUser = msg.role === 'user';
  const isStreaming = !isUser && streaming && msg.content !== undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  async function copyMessage() {
    try {
      await navigator.clipboard?.writeText(msg.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard access is optional */ }
  }

  return (
    <div className={`message-row ${msg.role}`}>
      <div className="message-row-heading">
        <div className="message-role-label">
          <span className={`message-avatar ${isUser ? 'user' : 'assistant'}`}>{isUser ? 'U' : <Icon name="eye" size={14} />}</span>
          <span>{isUser ? 'You' : 'Argus'}</span>
        </div>
        {!isUser && msg.usage && (
          <div className="msg-usage">
            {formatTok(msg.usage.total)} tok
            {msg.usage.cost > 0 ? ` · ${formatEur(msg.usage.cost)}` : ''}
          </div>
        )}
      </div>

      <div className={`message-bubble ${msg.role}${isStreaming ? ' streaming' : ''}`}>
        {isUser ? (
          editing ? (
            <div className="msg-edit">
              <textarea
                className="msg-edit-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Edit message"
                rows={3}
                autoFocus
              />
              <div className="msg-edit-actions">
                <button className="msg-edit-save" disabled={!draft.trim()} onClick={() => { setEditing(false); if (msg.id) onEditMessage?.(msg.id, draft.trim()); }}>Save</button>
                <button className="msg-edit-cancel" onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              {msg.images && msg.images.length > 0 && (
                <div className="msg-images">
                  {msg.images.map((img, i) => <img key={i} src={img.dataUrl} alt={img.name} title={img.name} className="msg-image-thumb" />)}
                </div>
              )}
              {msg.content}
            </>
          )
        ) : (
          <Suspense fallback={<span className="message-markdown-fallback" aria-busy="true">{msg.content}</span>}>
            <Markdown content={msg.content} />
          </Suspense>
        )}
      </div>

      {!isUser && msg.citations && msg.citations.length > 0 && <Citations items={msg.citations} />}
      {!isUser && msg.approvalRequest && <ApprovalCard approval={msg.approvalRequest} />}

      {msg.error && (
        <div className="message-error" role="alert">
          <div className="message-error-copy">
            <strong>Response failed</strong>
            <span>{msg.error}</span>
          </div>
          <button type="button" className="message-error-retry" onClick={onRetry} disabled={!onRetry}>
            <Icon name="refresh" size={14} /> Retry
          </button>
        </div>
      )}

      {msg.variant && msg.variant.count > 1 && (
        <div className="msg-variant">
          <button className="msg-variant-nav" disabled={msg.variant.index === 0} onClick={() => onSwitchVariant?.(msg.variant!.siblingIds[msg.variant!.index - 1])} aria-label="Previous variant"><Icon name="chevron-left" size={14} /></button>
          <span className="msg-variant-label">{msg.variant.index + 1}/{msg.variant.count}</span>
          <button className="msg-variant-nav" disabled={msg.variant.index === msg.variant.count - 1} onClick={() => onSwitchVariant?.(msg.variant!.siblingIds[msg.variant!.index + 1])} aria-label="Next variant"><Icon name="chevron-right" size={14} /></button>
        </div>
      )}

      {!isStreaming && !editing && (
        <div className="message-actions" aria-label={`${isUser ? 'User' : 'Assistant'} message actions`}>
          <button type="button" className="message-action" onClick={copyMessage} aria-label="Copy message" title="Copy message">
            <Icon name="copy" size={14} /> {copied ? 'Copied' : 'Copy'}
          </button>
          {isUser && msg.id && <button type="button" className="message-action" onClick={() => { setDraft(msg.content); setEditing(true); }} aria-label="Edit message" title="Edit"><Icon name="edit" size={14} /> Edit</button>}
          {!isUser && isLastAssistant && <button type="button" className="message-action" onClick={onRegenerate} aria-label="Regenerate" title="Regenerate"><Icon name="refresh" size={14} /> Regenerate</button>}
        </div>
      )}

      {msg.steps && msg.steps.length > 0 && (
        <div className="tool-steps">
          <div className="tool-steps-header">
            <span>Tool activity</span>
            <span>{msg.steps.filter((step) => step.kind === 'call').length} calls</span>
          </div>
          {msg.steps.map((step, i) => (
            <details key={i} className="tool-step">
              <summary>
                <span className={`tool-step-icon ${step.status ?? ''}`}>{step.status === 'running' ? '…' : step.status === 'error' ? '!' : step.kind === 'call' ? '✓' : '↳'}</span>
                <span className="tool-step-name">{step.name}</span>
                <span className={`tool-step-kind ${step.kind}`}>{step.status === 'running' ? 'running' : step.status === 'error' ? 'error' : step.kind === 'call' ? 'completed' : 'result'}</span>
                {step.durationMs !== undefined && <span className="tool-step-duration">{step.durationMs < 1000 ? `${Math.round(step.durationMs)}ms` : `${(step.durationMs / 1000).toFixed(1)}s`}</span>}
              </summary>
              <div className="tool-step-body">
                <pre className="tool-step-pre">{typeof step.payload === 'string' ? step.payload : JSON.stringify(step.payload, null, 2)}</pre>
                {(step.traceId || step.spanId) && <div className="tool-step-trace">{step.traceId && <span>Trace <code>{step.traceId}</code></span>}{step.spanId && <span>Span <code>{step.spanId}</code></span>}</div>}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
});
