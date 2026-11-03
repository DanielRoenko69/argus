/**
 * chatShell — standalone HTML documents for slim chat shell + embed surfaces.
 *
 * Unlike renderAgentsHtml (which uses renderPageShell and injects the full admin sidebar),
 * these renderers produce lean documents:
 *   renderChatShell → full page with slim top-bar only (no admin sidebar)
 *   renderEmbedChat → bare body only, 100% × 100%, for use in an iframe
 */

import type { SessionUser } from '../../auth/userAuth.js';
import { CSS_VARS } from '../../shared/navHtml.js';
import { chatCoreCss, chatCoreMarkup, chatCoreScript } from './chatCore.js';

function escHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── renderChatShell ───────────────────────────────────────────────────────────

export interface ChatShellOpts {
  user?: SessionUser;
  agents: { id: number; label: string; model?: string; visibility?: string }[];
  activeAgentId?: number;
}

/**
 * Returns a full HTML document (DOCTYPE…html) for the slim chat shell.
 * Renders a compact top-bar (Argus logo, agent picker, user label + logout) instead of
 * the full admin sidebar nav. No `.sidebar` / `.sidebar-nav` chrome.
 */
export function renderChatShell(opts: ChatShellOpts): string {
  const { user, agents, activeAgentId } = opts;

  const agentsJson = JSON.stringify(agents.map(a => ({ id: a.id, label: a.label, model: a.model })));

  const features = { sessions: true, attachments: true, modelOverride: false } as const;

  const agentPickerOptions = agents
    .map(a => `<option value="${a.id}"${a.id === activeAgentId ? ' selected' : ''}>${escHtml(a.label)}</option>`)
    .join('');
  const activeAgentBootstrap = activeAgentId !== undefined && agents.some(a => a.id === activeAgentId)
    ? `<script>
    document.addEventListener('DOMContentLoaded', function() {
      selectAgent(${activeAgentId});
    });
  </script>`
    : '';

  const userHtml = user
    ? `<span class="chat-shell-user">${escHtml(user.display_name || user.username)}</span>
       <form method="POST" action="/auth/logout" style="display:inline">
         <button type="submit" class="chat-shell-logout-btn" title="Abmelden">Abmelden</button>
       </form>`
    : '';

  // Server-render the agent rows into #agentList (the chat JS wires onclick=selectAgent).
  // Mirrors renderAgentsHtml so the slim shell shows the same agent list.
  const agentItemsHtml = agents.length === 0
    ? '<div class="agents-empty">Keine Agents verfügbar.</div>'
    : agents.map(a => `
              <div class="agent-item" data-id="${a.id}" onclick="selectAgent(${a.id})">
                <div class="agent-item-row">
                  <span class="agent-dot on"></span>
                  <span class="agent-item-name">${escHtml(a.label)}</span>
                </div>
                <div class="agent-item-model">${escHtml(a.model ?? '')}</div>
              </div>`).join('');

  const markup = chatCoreMarkup({ features, showAgentList: true, agentItemsHtml });
  const script = chatCoreScript({
    authMode: 'session',
    features,
    sessionsApiBase: '/api/agents',
    agentsJson,
  });

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus — Chat</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    ${CSS_VARS}
    html, body { height: 100%; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; font-size: 13px; display: flex; flex-direction: column; }

    /* ── Slim top bar ── */
    .chat-shell-topbar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--bg-card); border-bottom: 1px solid var(--border); flex-shrink: 0; height: 44px; }
    .chat-shell-logo { font-size: 14px; font-weight: 700; color: var(--accent-light); letter-spacing: -0.02em; text-decoration: none; }
    .chat-shell-sep { width: 1px; height: 18px; background: var(--border-mid); flex-shrink: 0; }
    .chat-shell-agent-picker { background: var(--bg-card-2); border: 1px solid var(--border-mid); color: var(--text); font-size: 12px; border-radius: 5px; padding: 3px 8px; cursor: pointer; outline: none; }
    .chat-shell-agent-picker:hover { border-color: var(--accent); }
    .chat-shell-spacer { flex: 1; }
    .chat-shell-user { font-size: 11.5px; color: var(--text-muted); }
    .chat-shell-logout-btn { background: none; border: 1px solid var(--border-mid); color: var(--text-dim); font-size: 11px; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-family: inherit; }
    .chat-shell-logout-btn:hover { border-color: var(--border); color: var(--text-muted); }

    /* ── Chat body fills remaining height ── */
    .chat-shell-body { flex: 1; overflow: hidden; display: flex; min-height: 0; }
    .chat-shell-body .agents-root { flex: 1; height: 100%; }

    ${chatCoreCss}
  </style>
</head>
<body>
  <div class="chat-shell-topbar">
    <a href="/chat" class="chat-shell-logo">Argus</a>
    <div class="chat-shell-sep"></div>
    <select class="chat-shell-agent-picker" id="chatShellAgentPicker" onchange="selectAgent(Number(this.value))">
      <option value="">-- Agent wählen --</option>
      ${agentPickerOptions}
    </select>
    <div class="chat-shell-spacer"></div>
    ${userHtml}
  </div>
  <div class="chat-shell-body">
    ${markup}
  </div>
  <script>${script}</script>
  ${activeAgentBootstrap}
</body>
</html>`;
}

// ── renderEmbedChat ───────────────────────────────────────────────────────────

export interface EmbedChatOpts {
  agentId: number;
  agent?: { id: number; label: string };
}

/**
 * Returns a bare HTML document (no top bar, no sidebar) sized 100% × 100%
 * for embedding in an iframe. Sessions are disabled; attachments enabled;
 * model override disabled.
 */
export function renderEmbedChat(opts: EmbedChatOpts): string {
  const { agentId, agent } = opts;
  const resolvedAgent = agent ?? { id: agentId, label: 'Agent' };
  const agentsJson = JSON.stringify([resolvedAgent]);

  const features = { sessions: false, attachments: true, modelOverride: false } as const;

  const markup = chatCoreMarkup({ features, showAgentList: false });
  const script = chatCoreScript({
    authMode: 'session',
    features,
    sessionsApiBase: '/api/agents',
    agentsJson,
  });

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Argus — Embed Chat</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    ${CSS_VARS}
    html, body { height: 100%; width: 100%; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; font-size: 13px; }

    /* ── Embed: fill full iframe ── */
    .agents-root { height: 100%; width: 100%; }

    ${chatCoreCss}
  </style>
</head>
<body>
  ${markup}
  <script>
    // Auto-select the single agent on load
    document.addEventListener('DOMContentLoaded', function() {
      selectAgent(${agentId});
    });
    ${script}
  </script>
</body>
</html>`;
}
