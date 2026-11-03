/**
 * chatCore — shared chat frontend module
 *
 * Markup contract (element IDs the chat JS requires):
 *   #agentList          — container for agent-item elements (data-id attr)
 *   .agent-item         — per-agent clickable rows (data-id={agentId})
 *   #sessionArea        — session-history section (toggled .visible)
 *   #sessionList        — container for rendered session-item elements
 *   #chatPlaceholder    — shown before an agent is selected
 *   #chatMain           — main chat shell (toggled .visible)
 *   #chatAgentName      — header label for the current agent
 *   #chatAgentModel     — header model badge for the current agent
 *   #chatHeaderDot      — status dot in the chat header
 *   #chatMessages       — message list container
 *   #chatInput          — textarea for user input
 *   #chatInputBox       — outer wrapper for the input area (drag-over class)
 *   #sendBtn            — send button (disabled during streaming)
 *   #attachBtn          — attachment trigger button  [features.attachments]
 *   #fileInput          — hidden file input          [features.attachments]
 *   #attachBar          — chip row above textarea    [features.attachments]
 *   #modelDisplay       — model-override <select>    [features.modelOverride]
 *   #modelOverrideHint  — "!" badge shown on override[features.modelOverride]
 *   #settingsPanel      — settings slide-panel
 *   #settingsToggleBtn  — header button that opens settings panel
 *   #settingsPanelBody  — body of the settings panel
 *
 * The markup that references these IDs lives in renderAgentsHtml (agentPage.ts)
 * and will also be reproduced verbatim by the upcoming /chat and /embed surfaces.
 */

// ── Inline minimal markdown renderer (no CDN needed) ─────────────────────────
const MARKDOWN_JS = `
function renderMarkdown(text) {
  if (!text) return '';
  var s = String(text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Fenced code blocks
  s = s.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(_,c){ return '<pre><code>'+c.trim()+'</code></pre>'; });
  // Inline code
  s = s.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  // Headers
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Bold + italic
  s = s.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
  // Blockquote
  s = s.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  // Unordered list items
  s = s.replace(/^[*\\-] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\\/li>\\n?)+/g, function(m){ return '<ul>'+m+'</ul>'; });
  // Ordered list items
  s = s.replace(/^\\d+\\. (.+)$/gm, '<li>$1</li>');
  // Paragraphs (double newline)
  s = s.replace(/\\n\\n+/g, '</p><p>');
  // Single line breaks
  s = s.replace(/\\n/g, '<br>');
  s = '<p>' + s + '</p>';
  // Clean up empty paragraphs around block elements
  s = s.replace(/<p>(<(?:h[123]|ul|ol|pre|blockquote)[^>]*>)/g, '$1');
  s = s.replace(/(<\\/(?:h[123]|ul|ol|pre|blockquote)>)<\\/p>/g, '$1');
  s = s.replace(/<p><\\/p>/g, '');
  return s;
}
`;

// ── CSS ───────────────────────────────────────────────────────────────────────

/**
 * Chat-specific CSS for the full-height agent chat layout.
 * Consumed by renderAgentsHtml (and future /chat + /embed surfaces).
 * Selectors are NOT yet prefixed with .argus-chat — a later task handles
 * iframe-scoping; this task only moves them without behaviour change.
 */
export const chatCoreCss: string = `
    /* ── Full-height chat layout ── */
    .main-content:has(.agents-root) { overflow: hidden; padding: 0; }
    .agents-root { display: flex; height: 100vh; overflow: hidden; }
    /* Iframe-fill safeguard: when html/body are sized to 100% (embed surface),
       .agents-root inherits height correctly. Overrides 100vh with 100% of the
       iframe element. Does not regress full-page /chat or /agents layouts because
       those set html/body height:100% explicitly in their own <style> blocks too. */
    html.argus-embed .agents-root,
    body > .agents-root { height: 100%; }

    /* ── Left sidebar: agent list + sessions ── */
    .agents-sidebar { width: 220px; min-width: 220px; background: var(--bg-card); border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
    .agents-sidebar-header { padding: 10px 10px 8px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .agents-sidebar-title { font-size: 10px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; }
    .new-chat-btn { width: 20px; height: 20px; border-radius: 4px; background: none; border: 1px solid var(--border-mid); color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.1s; flex-shrink: 0; font-size: 13px; line-height: 1; }
    .new-chat-btn:hover { background: var(--accent-glow); border-color: var(--accent); color: var(--accent-light); }

    .agent-list { flex: 1; overflow-y: auto; padding: 4px; display: flex; flex-direction: column; gap: 1px; min-height: 0; scrollbar-width: none; }
    .agent-list::-webkit-scrollbar { display: none; }
    .agent-item { padding: 8px 9px; border-radius: 6px; cursor: pointer; transition: all 0.1s; }
    .agent-item:hover { background: rgba(255,255,255,0.03); }
    .agent-item.active { background: rgba(124,58,237,.1); }
    .agent-item-row { display: flex; align-items: center; gap: 7px; }
    .agent-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--green); }
    .agent-dot.off { background: var(--text-dim); }
    .agent-item-name { font-size: 12.5px; font-weight: 500; color: var(--text); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent-item.active .agent-item-name { color: var(--accent-light); font-weight: 600; }
    .agent-item-model { font-size: 11px; color: var(--text-dim); font-family: monospace; margin-top: 3px; padding-left: 13px; }
    .agents-empty { padding: 20px 12px; text-align: center; color: var(--text-muted); font-size: 12px; line-height: 1.6; }

    /* ── Session history ── */
    .session-section { border-top: 1px solid var(--border); flex-shrink: 0; max-height: 240px; display: none; flex-direction: column; }
    .session-section.visible { display: flex; }
    .session-section-header { padding: 8px 10px 4px; display: flex; align-items: center; }
    .session-section-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
    .session-list { overflow-y: auto; padding: 2px 4px 6px; display: flex; flex-direction: column; gap: 1px; scrollbar-width: none; }
    .session-list::-webkit-scrollbar { display: none; }
    .session-item { padding: 5px 8px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.1s; }
    .session-item:hover { background: rgba(255,255,255,0.03); }
    .session-item.active { background: rgba(124,58,237,.1); }
    .session-item-label { flex: 1; min-width: 0; font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .session-item.active .session-item-label { color: var(--accent-light); }
    .session-item-time { font-size: 10px; color: var(--text-dim); white-space: nowrap; flex-shrink: 0; }
    .session-del { opacity: 0; font-size: 10px; cursor: pointer; flex-shrink: 0; color: var(--text-dim); line-height: 1; }
    .session-item:hover .session-del { opacity: 0.5; }
    .session-item:hover .session-del:hover { opacity: 1; color: var(--red); }

    /* ── Main chat area ── */
    .chat-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; min-width: 0; background: var(--bg); }
    .chat-placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: var(--text-muted); z-index: 1; }
    .chat-placeholder-logo { width: 44px; height: 44px; border-radius: 10px; background: linear-gradient(135deg,#7c3aed,#4f46e5); display: flex; align-items: center; justify-content: center; font-size: 20px; color:#fff; font-weight:700; }
    .chat-placeholder-text { font-size: 13px; color: var(--text-muted); }
    .chat-placeholder-hint { font-size: 11.5px; color: var(--text-dim); }
    #chatMain { display: none; flex-direction: column; flex: 1; overflow: hidden; height: 100%; }
    #chatMain.visible { display: flex; }

    /* ── Chat header ── */
    .chat-header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; background: var(--bg-card); gap: 10px; }
    .chat-header-info { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
    .chat-header-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
    .chat-header-name { font-size: 13px; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chat-header-model { font-size: 11px; font-family: monospace; background: rgba(124,58,237,.12); color: var(--accent-light); padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
    .chat-header-actions { display: flex; gap: 4px; }
    .chat-hdr-btn { width: 26px; height: 26px; border-radius: 5px; background: none; border: 1px solid transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.1s; }
    .chat-hdr-btn:hover { background: rgba(255,255,255,.05); border-color: var(--border-mid); color: var(--text); }
    .chat-hdr-btn.active { background: var(--accent-glow); border-color: rgba(124,58,237,.3); color: var(--accent-light); }

    /* ── Messages ── */
    .chat-messages { flex: 1; overflow-y: auto; padding: 20px 24px 8px; display: flex; flex-direction: column; gap: 16px; min-height: 0; }
    .msg { display: flex; gap: 10px; max-width: 680px; width: 100%; }
    .msg.user { margin-left: auto; flex-direction: row-reverse; }
    .msg-avatar { width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; margin-top: 2px; }
    .msg.user .msg-avatar { background: var(--accent); color: #fff; }
    .msg.assistant .msg-avatar { background: linear-gradient(135deg,#1a1a2e,#2a1a4e); color: var(--accent-light); border: 1px solid var(--border-mid); }
    .msg-content { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex: 1; }
    .msg-bubble { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; border-top-left-radius: 3px; padding: 10px 13px; font-size: 13px; line-height: 1.6; color: var(--text); word-break: break-word; }
    .msg.user .msg-bubble { background: rgba(124,58,237,.12); border-color: rgba(124,58,237,.2); border-top-left-radius: 10px; border-top-right-radius: 3px; white-space: pre-wrap; }
    .msg-bubble p { margin: 0 0 0.55em; } .msg-bubble p:last-child { margin-bottom: 0; }
    .msg-bubble pre { background: rgba(0,0,0,.3); border: 1px solid var(--border); border-radius: 5px; padding: 10px 13px; overflow-x: auto; margin: 0.5em 0; font-size: 11.5px; }
    .msg-bubble code { background: rgba(124,58,237,.15); color: var(--accent-light); border-radius: 3px; padding: 1px 5px; font-size: 11.5px; font-family: monospace; }
    .msg-bubble pre code { background: none; padding: 0; color: var(--text); }
    .msg-bubble h1,.msg-bubble h2,.msg-bubble h3 { color: var(--text); margin: 0.75em 0 0.35em; font-weight: 600; }
    .msg-bubble ul,.msg-bubble ol { margin: 0.4em 0; padding-left: 1.5em; }
    .msg-bubble li { margin-bottom: 0.2em; }
    .msg-bubble blockquote { border-left: 3px solid var(--accent); margin: 0.5em 0; padding-left: 10px; color: var(--text-muted); }
    .msg-bubble table { border-collapse: collapse; width: 100%; margin: 0.5em 0; font-size: 12px; }
    .msg-bubble th,.msg-bubble td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
    .msg-bubble th { background: rgba(0,0,0,.2); }
    .cursor { display: inline-block; width: 6px; height: 0.9em; background: var(--accent-light); border-radius: 1px; margin-left: 2px; vertical-align: text-bottom; animation: blink 0.9s step-end infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

    /* ── Tool call blocks ── */
    .tool-call { background: rgba(0,0,0,.25); border: 1px solid var(--border); border-left: 2px solid rgba(124,58,237,.4); border-radius: 6px; font-size: 12px; overflow: hidden; margin-top: 3px; }
    .tool-call.running { border-left-color: rgba(251,191,36,.6); }
    .tool-call.error { border-left-color: rgba(248,81,73,.5); }
    .tool-call.done { border-left-color: rgba(63,185,80,.5); }
    .tool-call summary { cursor: pointer; padding: 6px 10px; display: flex; align-items: center; gap: 6px; color: var(--text-muted); user-select: none; list-style: none; }
    .tool-call summary::-webkit-details-marker { display: none; }
    .tool-call summary:hover { color: var(--text); background: rgba(255,255,255,.02); }
    .tool-call-chevron { font-size: 9px; color: var(--text-dim); transition: transform 0.15s; flex-shrink: 0; }
    details[open] .tool-call-chevron { transform: rotate(90deg); }
    .tool-call-icon { font-size: 12px; flex-shrink: 0; }
    .tool-call-name { font-family: monospace; color: var(--accent-light); font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tool-call-status { font-size: 10px; padding: 1px 6px; border-radius: 3px; white-space: nowrap; flex-shrink: 0; }
    .tool-call-status.running { background: rgba(251,191,36,.12); color: #fbbf24; }
    .tool-call-status.done    { background: rgba(63,185,80,.1);   color: #3fb950; }
    .tool-call-status.error   { background: rgba(248,81,73,.1);   color: #f87171; }
    .tool-call-dur { font-size: 10px; color: var(--text-dim); flex-shrink: 0; }
    .tool-call-body { padding: 6px 10px 8px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
    .tool-section-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.07em; }
    .tool-call-args { font-family: monospace; font-size: 11px; color: var(--text-muted); white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; background: rgba(0,0,0,.2); border-radius: 4px; padding: 5px 8px; }
    .tool-call-result { font-family: monospace; font-size: 11px; color: var(--text); white-space: pre-wrap; word-break: break-all; max-height: 280px; overflow-y: auto; }

    /* ── Checkpoint divider ── */
    .checkpoint { display: flex; align-items: center; gap: 8px; color: var(--text-dim); font-size: 10.5px; margin: 2px 0; }
    .checkpoint-line { flex: 1; height: 1px; background: var(--border); }

    /* ── Input area ── */
    .ai-transparency-notice { display: flex; align-items: center; justify-content: center; gap: 7px; padding: 0 4px 7px; color: var(--text-dim); font-size: 10.5px; line-height: 1.4; text-align: center; }
    .ai-transparency-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 18px; padding: 0 5px; border: 1px solid var(--border-mid); border-radius: 999px; color: var(--accent-light); background: rgba(124,58,237,.1); font-size: 9px; font-weight: 700; letter-spacing: .04em; }
    .chat-input-wrap { padding: 10px 16px 14px; flex-shrink: 0; }
    .chat-input-box { background: var(--bg-card); border: 1px solid var(--border-mid); border-radius: 10px; overflow: hidden; transition: border-color 0.12s, box-shadow 0.12s; }
    .chat-input-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,58,237,.08); }
    .chat-input-box.drag-over { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,58,237,.15); background: rgba(124,58,237,.04); }
    .chat-textarea { display: block; width: 100%; background: none; border: none; color: var(--text); padding: 10px 14px 6px; font-size: 13px; font-family: inherit; resize: none; min-height: 44px; max-height: 160px; line-height: 1.5; outline: none; }
    .chat-textarea::placeholder { color: var(--text-dim); }
    /* Attachment chips */
    .attachment-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 6px 10px 0; }
    .attachment-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 3px 8px; border-radius: 12px; border: 1px solid var(--border-mid); background: var(--surface); color: var(--text-muted); max-width: 200px; }
    .attachment-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .attachment-chip .chip-remove { cursor: pointer; opacity: .6; font-size: 13px; line-height: 1; flex-shrink: 0; }
    .attachment-chip .chip-remove:hover { opacity: 1; }
    .attachment-chip.image-chip { border-color: rgba(37,99,235,.4); color: #60a5fa; }
    .attachment-chip.text-chip { border-color: rgba(22,163,74,.4); color: #4ade80; }
    .attachment-chip.code-chip { border-color: rgba(124,58,237,.4); color: #a78bfa; }
    /* Toolbar buttons */
    .chat-input-footer { display: flex; align-items: center; gap: 6px; padding: 4px 8px 6px; border-top: 1px solid var(--border); }
    .chat-tool-btn { background: none; border: none; cursor: pointer; color: var(--text-dim); padding: 3px 5px; border-radius: 4px; font-size: 14px; line-height: 1; transition: all .12s; }
    .chat-tool-btn:hover { background: rgba(255,255,255,.06); color: var(--text-muted); }
    .model-select { background: none; border: none; color: var(--text-dim); font-size: 11px; font-family: monospace; cursor: pointer; padding: 2px 4px; border-radius: 3px; outline: none; }
    .model-select:hover { background: rgba(255,255,255,.04); color: var(--text-muted); }
    .model-select option { background: #141414; }
    .chat-footer-sep { width: 1px; height: 13px; background: var(--border-mid); flex-shrink: 0; }
    .chat-footer-spacer { flex: 1; }
    .chat-send-btn { padding: 4px 12px; background: var(--accent); color: #fff; border: none; border-radius: 5px; font-size: 12px; cursor: pointer; transition: background 0.12s; font-family: inherit; font-weight: 500; display: flex; align-items: center; gap: 5px; }
    .chat-send-btn:hover { background: #6d28d9; }
    .chat-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .chat-send-icon { width: 12px; height: 12px; }

    /* ── Settings slide-panel ── */
    .settings-panel { position: absolute; top: 0; right: 0; bottom: 0; width: 300px; background: var(--bg-card); border-left: 1px solid var(--border); display: flex; flex-direction: column; transform: translateX(100%); transition: transform 0.2s ease; z-index: 50; }
    .settings-panel.open { transform: translateX(0); }
    .settings-panel-header { padding: 11px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .settings-panel-title { font-size: 12px; font-weight: 600; color: var(--text); }
    .settings-close { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 2px; display: flex; align-items: center; }
    .settings-close:hover { color: var(--text); }
    .settings-panel-body { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .settings-field { display: flex; flex-direction: column; gap: 4px; }
    .settings-label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; }
    .settings-value { font-size: 12px; color: var(--text); background: rgba(0,0,0,.2); border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; }
    .settings-value.mono { font-family: monospace; }
    .settings-divider { height: 1px; background: var(--border); margin: 2px 0; }
    .settings-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .settings-row-label { font-size: 12px; color: var(--text-muted); }
    .settings-row-val { font-size: 12px; color: var(--text); font-weight: 500; }
    .settings-prompt { font-size: 11px; font-family: monospace; color: var(--text-muted); line-height: 1.55; background: rgba(0,0,0,.2); border: 1px solid var(--border); border-radius: 5px; padding: 8px; max-height: 160px; overflow-y: auto; white-space: pre-wrap; }
    .settings-tag { font-size: 10.5px; padding: 2px 7px; border-radius: 4px; background: rgba(124,58,237,.1); color: var(--accent-light); border: 1px solid rgba(124,58,237,.2); }
    .settings-tag-list { display: flex; flex-wrap: wrap; gap: 4px; }
    `;

// ── Markup ────────────────────────────────────────────────────────────────────

/** Options for chatCoreMarkup — a subset of ChatCoreOpts focused on markup gating. */
export interface ChatCoreMarkupOpts {
  features: {
    sessions: boolean;
    attachments: boolean;
    modelOverride: boolean;
  };
  /**
   * When true (default), renders the #agentList sidebar so the user can switch agents.
   * Set to false for single-agent embed surfaces where no picker is needed.
   */
  showAgentList?: boolean;
  /**
   * Optional pre-rendered HTML for agent list items, injected inside #agentList.
   * When omitted the list is empty (useful for embed/slim-shell where agentsJson JS populates it).
   */
  agentItemsHtml?: string;
  /**
   * Visible disclosure for interactive AI surfaces. Enabled with a safe default
   * when omitted; deployments can provide reviewed text or explicitly disable it.
   */
  aiTransparency?: { enabled: boolean; notice: string };
  /** Remove operator-only controls from customer-facing chat surfaces. */
  visitorMode?: boolean;
  /** Optional first assistant message shown before the visitor writes. */
  welcomeMessage?: string | null;
  /** Optional customer-facing composer placeholder. */
  inputPlaceholder?: string;
}

function escMarkup(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Returns the chat-pane HTML markup containing all element IDs required by chatCoreScript.
 * The caller must wrap this in a container (body, .chat-area, etc.) and supply
 * chatCoreCss + chatCoreScript separately.
 *
 * Feature flags gate optional regions so unused surfaces pay no markup cost:
 *   features.sessions===false  → #sessionArea / #sessionList omitted
 *   features.attachments===false → #attachBtn / #fileInput / #attachBar omitted
 *   features.modelOverride===false → #modelDisplay / #modelOverrideHint omitted
 *   showAgentList===false → #agentList sidebar omitted (single-agent embed)
 */
export function chatCoreMarkup(opts: ChatCoreMarkupOpts): string {
  const { features, showAgentList = true, agentItemsHtml = '', visitorMode = false } = opts;
  const aiTransparency = opts.aiTransparency ?? {
    enabled: true,
    notice: 'You are interacting with an AI agent. Responses may be inaccurate; verify important information and review tool actions before approval.',
  };

  const agentListBlock = showAgentList ? `
      <!-- Left sidebar -->
      <div class="agents-sidebar">
        <div class="agents-sidebar-header">
          <span class="agents-sidebar-title">Agents</span>
          <button class="new-chat-btn" onclick="newSession()" title="Neue Session">+</button>
        </div>
        <div class="agent-list" id="agentList">
          ${agentItemsHtml}
        </div>
        ${features.sessions ? `
        <div class="session-section" id="sessionArea">
          <div class="session-section-header">
            <span class="session-section-label">Verlauf</span>
          </div>
          <div class="session-list" id="sessionList"></div>
        </div>` : ''}
      </div>` : '';

  const modelOverrideBlock = features.modelOverride ? `
                <select class="model-select" id="modelDisplay" title="Modell überschreiben">
                  <option id="modelOption">--</option>
                </select>
                <span id="modelOverrideHint" style="display:none;font-size:10px;color:#f59e0b;margin-left:2px;" title="Override">!</span>
                <div class="chat-footer-sep"></div>` : '';

  const attachBtnBlock = features.attachments ? `
                <button class="chat-tool-btn" id="attachBtn" title="Datei anhängen">+</button>
                <input type="file" id="fileInput" multiple style="display:none"
                  accept=".log,.txt,.yaml,.yml,.json,.xml,.toml,.env,.sh,.py,.js,.ts,.go,.java,.md,.csv,.sql,.conf,.cfg,.ini,.tf,.hcl,.png,.jpg,.jpeg,.gif,.webp,.svg">` : '';

  const attachBarBlock = features.attachments ? `
              <div id="attachBar" style="display:none;flex-wrap:wrap;gap:4px;padding:6px 10px 0;"></div>` : '';

  const welcomeBlock = opts.welcomeMessage ? `
            <div class="msg assistant visitor-welcome" role="status">
              <div class="msg-avatar" aria-hidden="true">AI</div>
              <div class="msg-content"><div class="msg-bubble">${escMarkup(opts.welcomeMessage)}</div></div>
            </div>` : '';
  const inputPlaceholder = escMarkup(opts.inputPlaceholder || 'Nachricht eingeben... (Enter senden, Shift+Enter Umbruch)');

  return `
    <div class="agents-root">
      ${agentListBlock}

      <!-- Main chat area -->
      <div class="chat-area">
        <div class="chat-placeholder" id="chatPlaceholder">
          <div class="chat-placeholder-logo">🤖</div>
          <div class="chat-placeholder-text">Agent auswählen</div>
          <div class="chat-placeholder-hint">Wähle einen Agent aus der linken Liste</div>
        </div>
        <div id="chatMain">
          <div class="chat-header">
            <div class="chat-header-info">
              <span class="chat-header-dot" id="chatHeaderDot"></span>
              <span class="chat-header-name" id="chatAgentName">—</span>
              <span class="chat-header-model" id="chatAgentModel"></span>
            </div>
            ${visitorMode ? '' : `<div class="chat-header-actions">
              <button class="chat-hdr-btn" onclick="newSession()" title="Neue Session">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
              </button>
              <button class="chat-hdr-btn" id="settingsToggleBtn" onclick="toggleSettings()" title="Agent-Einstellungen">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
              </button>
            </div>`}
          </div>
          <div class="chat-messages" id="chatMessages">${welcomeBlock}</div>
          <div class="chat-input-wrap">
            ${aiTransparency.enabled ? `<div class="ai-transparency-notice" role="note" aria-label="AI interaction notice"><span class="ai-transparency-badge" aria-hidden="true">AI</span><span>${escMarkup(aiTransparency.notice)}</span></div>` : ''}
            <div class="chat-input-box" id="chatInputBox">
              ${attachBarBlock}
              <textarea class="chat-textarea" id="chatInput"
                placeholder="${inputPlaceholder}" rows="1"
                onkeydown="if(event.key==='Enter'&amp;&amp;!event.shiftKey){event.preventDefault();sendMessage();}"
                oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,160)+'px'"></textarea>
              <div class="chat-input-footer">
                ${modelOverrideBlock}
                ${attachBtnBlock}
                <div class="chat-footer-spacer"></div>
                <button class="chat-send-btn" id="sendBtn" onclick="sendMessage()">
                  <svg class="chat-send-icon" viewBox="0 0 16 16" fill="none"><path d="M14 8L2 2l3 6-3 6 12-6Z" fill="currentColor"/></svg>
                  Senden
                </button>
              </div>
            </div>
            ${features.attachments ? `<div style="font-size:10px;color:var(--text-dim);margin-top:4px;padding:0 4px;">
              Tipp: Drag &amp; Drop oder + für Dateien (Logs, YAML, Code, Bilder) &bull; Ctrl+V für Screenshots
            </div>` : ''}
          </div>
        </div>

        <!-- Settings slide-panel -->
        ${visitorMode ? '' : `<div class="settings-panel" id="settingsPanel">
          <div class="settings-panel-header">
            <span class="settings-panel-title">Agent-Einstellungen</span>
            <button class="settings-close" onclick="toggleSettings()">✕</button>
          </div>
          <div class="settings-panel-body" id="settingsPanelBody"></div>
        </div>`}
      </div>
    </div>`;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface ChatCoreOpts {
  /** 'session' = cookie auth (today's behaviour). 'public-token' = widget iframe mode. */
  authMode: 'session' | 'public-token';
  features: {
    /** When false, session sidebar/history wiring is skipped. */
    sessions: boolean;
    /** When false, file-attachment wiring is skipped. */
    attachments: boolean;
    /** When false, model-override dropdown wiring is skipped. */
    modelOverride: boolean;
  };
  /** Base path for agent API calls, e.g. '/api/agents'. Replaces hardcoded paths. */
  sessionsApiBase: string;
  /**
   * JSON-serialised agents array to embed as the AGENTS JS variable.
   * Pass the result of JSON.stringify(agents.map(...)) from the caller.
   */
  agentsJson: string;
  /** Omit operator-only settings code from customer-facing bundles. */
  visitorMode?: boolean;
  /**
   * Widget slug for public-token mode. Required when authMode='public-token'.
   * Used to construct the /public/widget/:slug/session and /chat API paths.
   */
  publicSlug?: string;
}

// ── Script builder ────────────────────────────────────────────────────────────

/**
 * Returns the chat frontend JS as a plain string (NO surrounding <script> tags).
 * The caller is responsible for wrapping in <script>…</script>.
 *
 * Feature flags gate their respective JS blocks so unused surfaces pay no cost.
 * authMode='session' reproduces today's cookie-auth behaviour exactly.
 * authMode='public-token' is a clearly-marked stub — NOT implemented here.
 */
export function chatCoreScript(opts: ChatCoreOpts): string {
  const { authMode, features, sessionsApiBase, agentsJson } = opts;

  // authMode stub comment — future phases will branch on this
  const authModeNote =
    authMode === 'public-token'
      ? `// TODO(chat-core): authMode='public-token' — inject Bearer token into fetch headers here`
      : `// authMode='session': cookie auth via credentials:'same-origin' (default behaviour)`;

  // ── Current-session lifecycle JS (ALWAYS present — required by sendMessage) ──
  // newSession() creates a session via POST and sets currentSessionId.
  // It is the minimal lifecycle needed on every surface (including embed where
  // features.sessions:false and the history sidebar is absent).
  // Sidebar re-render after newSession is handled by the caller (loadSessions
  // calls renderSessionList before/after; on embed there is no list to render).
  const sessionLifecycleJs = `
      async function newSession() {
        if (!currentAgentId) return;
        try {
          var res = await fetch('${sessionsApiBase}/'+currentAgentId+'/sessions', {
            method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/json'}, body:'{}',
          });
          if (!res.ok) return;
          var session = await res.json();
          sessions.unshift(session);
          currentSessionId = session.id;
          if (typeof renderSessionList === 'function') renderSessionList();
          document.getElementById('chatMessages').innerHTML = '';
        } catch(e) { console.error(e); }
      }`;

  // ── Session sidebar JS (gated by features.sessions — history list only) ──────
  // loadSessions, renderSessionList, loadSession, deleteSession, and their
  // helpers are sidebar-only concerns. Not needed on the embed surface.
  const sessionSidebarJs = `
      async function loadSessions() {
        if (!currentAgentId) return;
        try {
          var res = await fetch('${sessionsApiBase}/' + currentAgentId + '/sessions', { credentials:'same-origin' });
          sessions = res.ok ? await res.json() : [];
          renderSessionList();
          if (sessions.length > 0) loadSession(sessions[0].id);
          else await newSession();
        } catch(e) { console.error(e); }
      }

      function renderSessionList() {
        var list = document.getElementById('sessionList');
        if (!sessions.length) { list.innerHTML = ''; return; }
        list.innerHTML = sessions.map(function(s) {
          var active = s.id === currentSessionId ? ' active' : '';
          var msgs = s.messages || [];
          var first = msgs.find(function(m){ return m.role === 'user'; });
          var label = first ? String(first.content||'').slice(0,36)+(first.content&&first.content.length>36?'…':'') : 'Neue Session';
          var time = relativeTime(s.last_active || s.created_at);
          return '<div class="session-item'+active+'" data-sid="'+escHtml(s.id)+'" onclick="handleSessionClick(this)">'
            +'<span class="session-item-label">'+escHtml(label)+'</span>'
            +'<span class="session-item-time">'+escHtml(time)+'</span>'
            +'<span class="session-del" data-del-sid="'+escHtml(s.id)+'" onclick="event.stopPropagation();handleSessionDelete(this)">✕</span>'
            +'</div>';
        }).join('');
      }

      function handleSessionClick(el) { loadSession(el.dataset.sid); }
      function handleSessionDelete(el) { deleteSession(el.dataset.delSid); }

      async function loadSession(sid) {
        currentSessionId = sid;
        renderSessionList();
        try {
          var res = await fetch('${sessionsApiBase}/'+currentAgentId+'/sessions/'+sid, { credentials:'same-origin' });
          if (!res.ok) return;
          var session = await res.json();
          var container = document.getElementById('chatMessages');
          container.innerHTML = '';
          var msgs = session.messages || [];
          msgs.forEach(function(m, idx) {
            if (m.role==='user') {
              if (idx > 0) appendCheckpoint(container);
              appendBubble('user', m.content||'');
            } else if (m.role==='assistant') {
              var div = appendBubble('assistant', m.content||'');
              if (m.tool_calls) m.tool_calls.forEach(function(tc){
                appendToolCall(div, tc.function.name, tc.function.arguments, null, 'done', null);
              });
            }
          });
          container.scrollTop = container.scrollHeight;
        } catch(e) { console.error(e); }
      }

      async function deleteSession(sid) {
        try {
          await fetch('${sessionsApiBase}/'+currentAgentId+'/sessions/'+sid, { method:'DELETE', credentials:'same-origin' });
          sessions = sessions.filter(function(s){ return s.id !== sid; });
          if (currentSessionId === sid) {
            currentSessionId = null;
            document.getElementById('chatMessages').innerHTML = '';
            if (sessions.length > 0) loadSession(sessions[0].id); else newSession();
          }
          renderSessionList();
        } catch(e) { console.error(e); }
      }`;

  // ── Attachment wiring JS (gated by features.attachments) ─────────────────
  const attachmentJs = `
      var attachBtn = document.getElementById('attachBtn');
      var fileInput = document.getElementById('fileInput');
      if (attachBtn && fileInput) {
        attachBtn.addEventListener('click', function() { fileInput.click(); });
        fileInput.addEventListener('change', function(e) {
          var files = e.target.files || [];
          for (var i = 0; i < files.length; i++) appendFileToChat(files[i]);
          e.target.value = '';
        });
      }

      var chatBox = document.getElementById('chatInputBox');
      if (chatBox) {
        chatBox.addEventListener('dragover', function(e) { e.preventDefault(); chatBox.classList.add('drag-over'); });
        chatBox.addEventListener('dragleave', function() { chatBox.classList.remove('drag-over'); });
        chatBox.addEventListener('drop', function(e) {
          e.preventDefault(); chatBox.classList.remove('drag-over');
          var files = e.dataTransfer ? e.dataTransfer.files : [];
          for (var i = 0; i < files.length; i++) appendFileToChat(files[i]);
        });
      }

      var chatInput = document.getElementById('chatInput');
      if (chatInput) {
        chatInput.addEventListener('paste', function(e) {
          var items = e.clipboardData ? e.clipboardData.items : [];
          for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf('image/') === 0) {
              var f = items[i].getAsFile();
              if (f) appendFileToChat(new File([f], 'paste.png', {type: f.type}));
            }
          }
        });
      }`;

  // ── Model-override wiring JS (gated by features.modelOverride) ───────────
  const modelOverrideJs = `
      fetch('/api/models', { credentials: 'same-origin' })
        .then(function(r) { return r.ok ? r.json() : {data:[]}; })
        .then(function(d) {
          var models = (d.data || []).filter(function(m) { return m.enabled; });
          var sel = document.getElementById('modelDisplay');
          if (!sel || models.length === 0) return;
          var opts = '<option value="">-- Agent-Standard --<'+'/option>';
          for (var i = 0; i < models.length; i++) {
            var m = models[i];
            opts += '<option value="' + escHtml(m.model_name) + '">[' + escHtml(m.provider.substring(0,2).toUpperCase()) + '] ' + escHtml(m.model_name) + '<'+'/option>';
          }
          sel.innerHTML = opts;
          sel.disabled = false;
          sel.style.cursor = 'pointer';
          sel.onchange = function() {
            selectedModelOverride = sel.value || null;
            var hint = document.getElementById('modelOverrideHint');
            if (hint) hint.style.display = selectedModelOverride ? 'inline' : 'none';
          };
        }).catch(function() {});`;

  // ── Per-agent allowed-models fetch (gated by features.modelOverride) ──────
  const allowedModelsJs = `
        // Load allowed models for this agent's key and update dropdown
        fetch('${sessionsApiBase}/' + id + '/allowed-models', { credentials: 'same-origin' })
          .then(function(r) { return r.ok ? r.json() : {models:[], restricted:false}; })
          .then(function(d) {
            var sel = document.getElementById('modelDisplay');
            if (!sel) return;
            var opts = '<option value="">-- Agent-Standard --<' + '/option>';
            for (var i = 0; i < d.models.length; i++) {
              var m = d.models[i];
              var prov = '[' + escHtml(m.provider.substring(0,2).toUpperCase()) + ']';
              opts += '<option value="' + escHtml(m.model_name) + '">' + prov + ' ' + escHtml(m.model_name) + '<' + '/option>';
            }
            sel.innerHTML = opts;
            sel.value = '';
            sel.disabled = d.models.length === 0;
          }).catch(function() {});`;

  // ── selectAgent: model-override reset (gated by features.modelOverride) ──
  const selectAgentModelOverrideReset = `
        // Reset model override when switching agents
        selectedModelOverride = null;
        var hint = document.getElementById('modelOverrideHint');
        if (hint) hint.style.display = 'none';`;

  // ── selectAgent: session loading (gated by features.sessions) ─────────────
  // When sessions:true — show the sidebar and load the session list (today's behaviour).
  // When sessions:false — call newSession() directly to create an ephemeral session
  //   so currentSessionId is set and sendMessage() is unblocked.
  const selectAgentSessionLoad = `
        document.getElementById('sessionArea').classList.add('visible');
        if (settingsOpen) renderSettingsPanel();
        loadSessions();`;

  const selectAgentSessionLoadEmbed = `
        await newSession();`;

  // ── Public-token mode JS ──────────────────────────────────────────────────
  //
  // The iframe (origin = Argus origin) makes same-origin calls to the public
  // widget API. A module-local widgetToken + publicSessionId are maintained
  // across turns. The host page never sees the token (it lives inside the iframe
  // sandbox). Token is refreshed on every turn via X-Widget-Token response header.
  // Slug is inlined at code-gen time so all URL paths are literal strings —
  // this makes both the test assertions and runtime behaviour unambiguous.
  const _slug = opts.publicSlug ?? '';
  const _sessionUrl = `/public/widget/${_slug}/session`;
  const _chatUrl    = `/public/widget/${_slug}/chat`;

  const publicTokenJs = authMode === 'public-token' ? `
      // ── Public-token state (module-local, never exposed to host page) ──
      var widgetToken = null;
      var publicSessionId = null;

      // ensureSession: lazily creates an anonymous session and stores the token.
      // Called before every /chat request. Safe to call multiple times — noop if
      // token is already set.
      async function ensureSession() {
        if (widgetToken) return;
        var res = await fetch('${_sessionUrl}', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) throw new Error('session init failed: ' + res.status);
        var data = await res.json();
        widgetToken = data.token;
        publicSessionId = data.sessionId;
      }

      // readSseStream: shared SSE body reader used by sendMessage in public-token mode.
      // Accepts the fetch Response and drives the same UI update logic as session mode.
      async function readSseStream(res, bubble, cursor, assistantDiv, container, fullText, toolEls, toolStarts, toolIdx) {
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
        outer: while(true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, {stream:true});
          var lines = buf.split('\\n');
          buf = lines.pop()||'';
          for (var i=0;i<lines.length;i++) {
            var line = lines[i];
            if (!line.startsWith('data: ')) continue;
            var raw = line.slice(6).trim();
            if (raw==='[DONE]') break outer;
            var evt; try{ evt=JSON.parse(raw); }catch(e){ continue; }
            if (evt.delta) {
              fullText[0] += evt.delta;
              bubble.innerHTML = renderMarkdown(fullText[0]);
              bubble.appendChild(cursor);
              container.scrollTop = container.scrollHeight;
            } else if (evt.tool_call) {
              var key = evt.tool_call.name+'_'+(toolIdx[0]++);
              toolEls[key] = appendToolCall(assistantDiv, evt.tool_call.name, JSON.stringify(evt.tool_call.args), null, 'running', null);
              toolStarts[key] = Date.now();
            } else if (evt.tool_result) {
              var ks = Object.keys(toolEls);
              for (var k=ks.length-1;k>=0;k--) {
                if (ks[k].startsWith(evt.tool_result.name+'_') && toolEls[ks[k]]) {
                  var st2 = toolEls[ks[k]].querySelector('[data-status]');
                  if (st2 && st2.textContent.indexOf('läuft')>=0) {
                    var dur2 = toolStarts[ks[k]] ? (Date.now()-toolStarts[ks[k]]) : null;
                    updateToolCall(toolEls[ks[k]], evt.tool_result.preview||'', (evt.tool_result.preview||'').startsWith('Error:'), dur2);
                    break;
                  }
                }
              }
            }
          }
        }
        return fullText[0];
      }
  ` : '';

  // ── The full script body ──────────────────────────────────────────────────
  return `
      ${MARKDOWN_JS}

      ${authModeNote}

      ${publicTokenJs}

      function relativeTime(iso) {
        var now = Date.now(), t = new Date(iso).getTime();
        var diff = Math.floor((now - t) / 1000);
        if (diff < 60) return 'gerade eben';
        if (diff < 3600) return Math.floor(diff/60) + 'm';
        if (diff < 86400) return Math.floor(diff/3600) + 'h';
        if (diff < 172800) return 'gestern';
        return new Date(iso).toLocaleDateString('de-DE', { day:'2-digit', month:'2-digit' });
      }
      function escHtml(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      }

      var AGENTS = ${agentsJson};
      var currentAgentId = null, currentAgent = null, currentSessionId = null, sessions = [];
      var settingsOpen = false;
      var selectedModelOverride = null;
      var pendingAttachments = [];

      function appendFileToChat(file) {
        if (file.size > 524288) { alert('Max 512 KB pro Datei'); return; }
        var inp = document.getElementById('chatInput');
        var mime = file.type || '';
        if (mime.indexOf('image/') === 0) {
          var r = new FileReader();
          r.onload = function(ev) {
            pendingAttachments.push({name: file.name, type: mime, dataUrl: ev.target.result});
            updateAttachBar();
          };
          r.readAsDataURL(file);
        } else {
          var r2 = new FileReader();
          r2.onload = function(ev) {
            var ext = file.name.split('.').pop() || 'text';
            var block = '\\n\\n--- ' + file.name + ' ---\\n' + ev.target.result + '\\n---\\n';
            if (inp) { inp.value += block; inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 160) + 'px'; }
          };
          r2.readAsText(file);
        }
      }

      function updateAttachBar() {
        var bar = document.getElementById('attachBar');
        if (!bar) return;
        if (pendingAttachments.length === 0) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
        bar.style.display = 'flex';
        bar.innerHTML = pendingAttachments.map(function(a, i) {
          return '<span style="font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--text-muted);">'
            + escHtml(a.name)
            + ' <span onclick="removePending('+i+')" style="cursor:pointer;opacity:.7">x<'+'/span><'+'/span>';
        }).join('');
      }

      function removePending(i) {
        pendingAttachments.splice(i, 1);
        updateAttachBar();
      }

      ${features.attachments ? attachmentJs : '// TODO(chat-core): finer-grained gate — attachments feature disabled'}

      ${features.modelOverride ? modelOverrideJs : '// TODO(chat-core): finer-grained gate — modelOverride feature disabled'}

      async function selectAgent(id) {
        currentAgentId = id;
        currentAgent = AGENTS.find(function(a){ return a.id === id; });
        if (!currentAgent) return;
        // The slim /chat shell also offers a native picker in its top bar.
        // Keep it aligned when a user selects an agent from the list, or when
        // the server-provided default agent is bootstrapped on page load.
        var shellAgentPicker = document.getElementById('chatShellAgentPicker');
        if (shellAgentPicker) shellAgentPicker.value = String(id);
        document.querySelectorAll('.agent-item').forEach(function(el){
          el.classList.toggle('active', Number(el.dataset.id) === id);
        });
        document.getElementById('chatAgentName').textContent = currentAgent.label;
        var modelEl = document.getElementById('chatAgentModel');
        if (modelEl) modelEl.textContent = currentAgent.model;
        ${features.modelOverride ? selectAgentModelOverrideReset : ''}
        ${features.modelOverride ? allowedModelsJs : ''}
        document.getElementById('chatPlaceholder').style.display = 'none';
        document.getElementById('chatMain').classList.add('visible');
        ${features.sessions ? selectAgentSessionLoad : authMode === 'public-token' ? `
        // public-token mode: session is created lazily on first send via ensureSession()
        // No pre-flight newSession() call needed.` : selectAgentSessionLoadEmbed}
      }

      ${opts.visitorMode ? '// visitor mode: operator settings code omitted' : `function toggleSettings() {
        settingsOpen = !settingsOpen;
        var panel = document.getElementById('settingsPanel');
        var btn = document.getElementById('settingsToggleBtn');
        panel.classList.toggle('open', settingsOpen);
        btn.classList.toggle('active', settingsOpen);
        if (settingsOpen) renderSettingsPanel();
      }

      function renderSettingsPanel() {
        if (!currentAgent) return;
        var a = currentAgent;
        var body = document.getElementById('settingsPanelBody');
        body.innerHTML =
          '<div class="settings-field"><div class="settings-label">Name</div><div class="settings-value">' + escHtml(a.label) + '</div></div>'
          + '<div class="settings-field"><div class="settings-label">Slug</div><div class="settings-value mono">' + escHtml(a.name||'') + '</div></div>'
          + (a.description ? '<div class="settings-field"><div class="settings-label">Beschreibung</div><div class="settings-value">' + escHtml(a.description) + '</div></div>' : '')
          + '<div class="settings-divider"></div>'
          + '<div class="settings-field"><div class="settings-label">Modell</div><div class="settings-value mono">' + escHtml(a.model) + '</div></div>'
          + '<div class="settings-row"><span class="settings-row-label">Temperatur</span><span class="settings-row-val">' + (a.temperature||'0.7') + '</span></div>'
          + '<div class="settings-row"><span class="settings-row-label">Max Tokens</span><span class="settings-row-val">' + (a.max_tokens||4096) + '</span></div>'
          + '<div class="settings-row"><span class="settings-row-label">Max Iterationen</span><span class="settings-row-val">' + (a.max_iterations||10) + '</span></div>'
          + '<div class="settings-divider"></div>'
          + (a.system_prompt ? '<div class="settings-field"><div class="settings-label">System Prompt</div><div class="settings-prompt">' + escHtml(a.system_prompt) + '</div></div>' : '<div class="settings-field"><div class="settings-label">System Prompt</div><div style="font-size:0.75rem;color:var(--text-dim)">Kein System Prompt konfiguriert</div></div>')
          + (a.composite_name ? '<div class="settings-divider"></div><div class="settings-field"><div class="settings-label">Tools (Composite)</div><div class="settings-tag-list"><span class="settings-tag">' + escHtml(a.composite_name) + '</span></div></div>' : '');
        if (['admin','platform_admin','operations_admin'].includes(a.role)) {
          body.innerHTML += '<div style="margin-top:0.5rem"><a href="/build/agents" class="btn btn-sm btn-ghost" style="width:100%;justify-content:center">Im Agent Studio bearbeiten →</a></div>';
        }
      }`}

      ${authMode !== 'public-token' ? sessionLifecycleJs : '// public-token mode: newSession lifecycle replaced by ensureSession()'}

      ${features.sessions ? sessionSidebarJs : '// sessions sidebar omitted (embed surface)'}

      function appendCheckpoint(container) {
        var d = document.createElement('div');
        d.className = 'checkpoint';
        d.innerHTML = '<div class="checkpoint-line"></div><span>' + new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}) + '</span><div class="checkpoint-line"></div>';
        container.appendChild(d);
      }

      function appendBubble(role, text) {
        var container = document.getElementById('chatMessages');
        var div = document.createElement('div');
        div.className = 'msg ' + role;
        var avatar = document.createElement('div');
        avatar.className = 'msg-avatar';
        avatar.textContent = role === 'user' ? 'Du' : 'AI';
        var content = document.createElement('div');
        content.className = 'msg-content';
        var bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        if (role === 'assistant') bubble.innerHTML = renderMarkdown(text);
        else bubble.textContent = text;
        content.appendChild(bubble);
        div.appendChild(avatar);
        div.appendChild(content);
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return div;
      }

      function tryFormatJson(text) {
        if (!text) return '';
        var s = String(text).trim();
        try { return JSON.stringify(JSON.parse(s), null, 2); } catch(e) { return s; }
      }

      function appendToolCall(msgDiv, name, argsStr, result, status, durationMs) {
        var contentDiv = msgDiv.querySelector('.msg-content');
        if (!contentDiv) return null;
        var details = document.createElement('details');
        var sc = status||'running';
        details.className = 'tool-call ' + sc;
        var sl = sc==='running' ? '<span class="tool-call-status running">● läuft</span>'
                : sc==='error'   ? '<span class="tool-call-status error">✕ Fehler</span>'
                :                  '<span class="tool-call-status done">✓ fertig</span>';
        var dur = durationMs ? '<span class="tool-call-dur">'+durationMs+'ms</span>' : '<span class="tool-call-dur" data-dur></span>';
        var af = tryFormatJson(argsStr || '{}');
        var rf = result ? tryFormatJson(result) : '';
        details.innerHTML = '<summary>'
          +'<span class="tool-call-chevron">▶</span>'
          +'<span class="tool-call-icon">⚙</span>'
          +'<span class="tool-call-name">'+escHtml(name)+'</span>'
          +'<span data-status>'+sl+'</span>'
          +dur
          +'</summary>'
          +'<div class="tool-call-body">'
          +'<div class="tool-section-label">Parameter</div>'
          +'<div class="tool-call-args" data-args>'+escHtml(af)+'</div>'
          +(rf?'<div class="tool-section-label" style="margin-top:0.35rem">Ergebnis</div><div class="tool-call-result" data-result>'+escHtml(rf)+'</div>':'<div class="tool-call-result" data-result style="display:none"></div>')
          +'</div>';
        contentDiv.appendChild(details);
        var msgs = document.getElementById('chatMessages');
        msgs.scrollTop = msgs.scrollHeight;
        return details;
      }

      function updateToolCall(det, result, isError, durationMs) {
        if (!det) return;
        det.className = 'tool-call ' + (isError ? 'error' : 'done');
        var st = det.querySelector('[data-status]');
        var re = det.querySelector('[data-result]');
        var dur = det.querySelector('[data-dur]');
        if (st) st.innerHTML = isError
          ? '<span class="tool-call-status error">✕ Fehler</span>'
          : '<span class="tool-call-status done">✓ fertig</span>';
        if (re) { re.style.display=''; re.textContent=tryFormatJson(result||''); }
        if (dur && durationMs) dur.textContent = durationMs + 'ms';
        det.open = !!isError;
      }

      ${authMode === 'public-token' ? `
      // ── sendMessage — public-token mode ──────────────────────────────────────
      // Uses Bearer token auth. Token is refreshed from X-Widget-Token header each
      // turn. On 401, clears token + session and retries ensureSession once.
      async function sendMessage() {
        var input = document.getElementById('chatInput');
        var text = input.value.trim();
        if (!text) return;
        var sendBtn = document.getElementById('sendBtn');
        input.value = ''; input.style.height = 'auto';
        sendBtn.disabled = true;

        var container = document.getElementById('chatMessages');
        if (container.children.length > 0) appendCheckpoint(container);
        appendBubble('user', text);

        var assistantDiv = document.createElement('div');
        assistantDiv.className = 'msg assistant';
        var avatar = document.createElement('div'); avatar.className = 'msg-avatar'; avatar.textContent = 'AI';
        var content = document.createElement('div'); content.className = 'msg-content';
        var bubble = document.createElement('div'); bubble.className = 'msg-bubble';
        var cursor = document.createElement('span'); cursor.className = 'cursor';
        bubble.appendChild(cursor);
        content.appendChild(bubble);
        assistantDiv.appendChild(avatar);
        assistantDiv.appendChild(content);
        container.appendChild(assistantDiv);
        container.scrollTop = container.scrollHeight;

        var fullText = ['']; var toolEls = {}; var toolStarts = {}; var toolIdx = [0];

        try {
          await ensureSession();

          var res = await fetch('${_chatUrl}', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + widgetToken,
            },
            body: JSON.stringify({ sessionId: publicSessionId, message: text }),
          });

          // On 401: token expired — clear and retry once with a fresh session
          if (res.status === 401) {
            widgetToken = null;
            publicSessionId = null;
            await ensureSession();
            res = await fetch('${_chatUrl}', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + widgetToken,
              },
              body: JSON.stringify({ sessionId: publicSessionId, message: text }),
            });
          }

          if (!res.ok) {
            bubble.innerHTML = '<span style="color:var(--red)">Fehler: '+escHtml(String(res.status))+'</span>';
            sendBtn.disabled = false;
            return;
          }

          // Refresh the widget token from the response header for the next turn
          var freshToken = res.headers.get('X-Widget-Token');
          if (freshToken) widgetToken = freshToken;

          await readSseStream(res, bubble, cursor, assistantDiv, container, fullText, toolEls, toolStarts, toolIdx);
        } catch(e) {
          bubble.innerHTML = '<span style="color:var(--red)">Verbindungsfehler: '+escHtml(String(e.message||e))+'</span>';
        } finally {
          if (cursor.parentNode) cursor.parentNode.removeChild(cursor);
          if (fullText[0]) bubble.innerHTML = renderMarkdown(fullText[0]);
          sendBtn.disabled = false;
          document.getElementById('chatInput').focus();
          container.scrollTop = container.scrollHeight;
        }
      }
      ` : `
      // ── sendMessage — session mode (cookie auth, same-origin) ────────────────
      async function sendMessage() {
        var input = document.getElementById('chatInput');
        var text = input.value.trim();
        if (!text || !currentSessionId) return;
        var sendBtn = document.getElementById('sendBtn');
        input.value = ''; input.style.height = 'auto';
        sendBtn.disabled = true;

        var displayText = text;
        var attachmentsToSend = pendingAttachments.slice();
        pendingAttachments = [];
        updateAttachBar();

        var container = document.getElementById('chatMessages');
        if (container.children.length > 0) appendCheckpoint(container);
        appendBubble('user', displayText);

        var assistantDiv = document.createElement('div');
        assistantDiv.className = 'msg assistant';
        var avatar = document.createElement('div'); avatar.className = 'msg-avatar'; avatar.textContent = 'AI';
        var content = document.createElement('div'); content.className = 'msg-content';
        var bubble = document.createElement('div'); bubble.className = 'msg-bubble';
        var cursor = document.createElement('span'); cursor.className = 'cursor';
        bubble.appendChild(cursor);
        content.appendChild(bubble);
        assistantDiv.appendChild(avatar);
        assistantDiv.appendChild(content);
        container.appendChild(assistantDiv);
        container.scrollTop = container.scrollHeight;

        var fullText = '', toolEls = {}, toolStarts = {}, toolIdx = 0;

        try {
          var res = await fetch('${sessionsApiBase}/'+currentAgentId+'/sessions/'+currentSessionId+'/chat', {
            method:'POST', credentials:'same-origin',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(Object.assign(
              {message: text || ''},
              ${features.modelOverride ? "selectedModelOverride ? {model_override:selectedModelOverride} : {}," : '{},'}
              attachmentsToSend.length > 0 ? {attachments: attachmentsToSend.map(function(a){
                return { name:a.name, type:a.type, content:a.content||null, dataUrl:a.dataUrl||null, chipType:a.chipType };
              })} : {}
            )),
          });
          if (!res.ok) {
            bubble.innerHTML = '<span style="color:var(--red)">Fehler: '+escHtml(String(res.status))+'</span>';
            return;
          }
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
          outer: while(true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buf += dec.decode(chunk.value, {stream:true});
            var lines = buf.split('\\n');
            buf = lines.pop()||'';
            for (var i=0;i<lines.length;i++) {
              var line = lines[i];
              if (!line.startsWith('data: ')) continue;
              var raw = line.slice(6).trim();
              if (raw==='[DONE]') break outer;
              var evt; try{ evt=JSON.parse(raw); }catch(e){ continue; }
              if (evt.delta) {
                fullText += evt.delta;
                bubble.innerHTML = renderMarkdown(fullText);
                bubble.appendChild(cursor);
                container.scrollTop = container.scrollHeight;
              } else if (evt.tool_call) {
                var key = evt.tool_call.name+'_'+(toolIdx++);
                toolEls[key] = appendToolCall(assistantDiv, evt.tool_call.name, JSON.stringify(evt.tool_call.args), null, 'running', null);
                toolStarts[key] = Date.now();
              } else if (evt.tool_result) {
                var ks = Object.keys(toolEls);
                for (var k=ks.length-1;k>=0;k--) {
                  if (ks[k].startsWith(evt.tool_result.name+'_') && toolEls[ks[k]]) {
                    var st2 = toolEls[ks[k]].querySelector('[data-status]');
                    if (st2 && st2.textContent.indexOf('läuft')>=0) {
                      var dur2 = toolStarts[ks[k]] ? (Date.now()-toolStarts[ks[k]]) : null;
                      updateToolCall(toolEls[ks[k]], evt.tool_result.preview||'', (evt.tool_result.preview||'').startsWith('Error:'), dur2);
                      break;
                    }
                  }
                }
              }
            }
          }
        } catch(e) {
          bubble.innerHTML = '<span style="color:var(--red)">Verbindungsfehler: '+escHtml(String(e.message))+'</span>';
        } finally {
          if (cursor.parentNode) cursor.parentNode.removeChild(cursor);
          if (fullText) bubble.innerHTML = renderMarkdown(fullText);
          sendBtn.disabled = false;
          document.getElementById('chatInput').focus();
          container.scrollTop = container.scrollHeight;
        }
      }
      `}
    `;
}
