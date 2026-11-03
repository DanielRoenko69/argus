import { renderPageShell } from '../shared/navHtml.js';
import type { SessionUser } from '../auth/userAuth.js';
import type { AgentWithRag } from './types.js';
import { chatCoreCss, chatCoreScript, chatCoreMarkup } from './chat/chatCore.js';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Dedicated agent chat surface.
 *
 * Administrative pages live in the Argus Console. Keeping this route focused
 * on chat makes it useful for operators and backwards-compatible embeds
 * without reintroducing the retired HTML administration UI.
 */
export function renderAgentsHtml(agents: AgentWithRag[], user?: SessionUser): string {
  const agentsJson = JSON.stringify(agents.map(a => ({
    id: a.id,
    name: a.name,
    label: a.label,
    description: a.description,
    model: a.model,
    temperature: a.temperature,
    max_tokens: a.max_tokens,
    max_iterations: a.max_iterations,
    composite_name: a.composite_name ?? null,
    system_prompt: a.system_prompt ?? null,
  })));

  const agentItemsHtml = agents.length === 0
    ? '<div class="agents-empty">Keine Agents konfiguriert.<br>In der Argus Console unter Agent Studio anlegen.</div>'
    : agents.map(a => `
              <div class="agent-item" data-id="${a.id}" onclick="selectAgent(${a.id})">
                <div class="agent-item-row">
                  <span class="agent-dot on"></span>
                  <span class="agent-item-name">${esc(a.label)}</span>
                </div>
                <div class="agent-item-model">${esc(a.model)}</div>
              </div>`).join('');

  const features = { sessions: true, attachments: true, modelOverride: true } as const;

  return renderPageShell({
    activePage: 'agents',
    title: 'Argus — Agent Chat',
    user,
    styles: chatCoreCss,
    content: `
    ${chatCoreMarkup({ features, showAgentList: true, agentItemsHtml })}

    <script>${chatCoreScript({ authMode: 'session', features, sessionsApiBase: '/api/agents', agentsJson })}</script>
    `,
  });
}
