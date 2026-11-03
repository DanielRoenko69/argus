import { useAgents } from '../data-provider/hooks.js';
import { useChatStore } from '../store/chat.js';

function modeLabel(mode?: string): string {
  if (mode === 'worker') return 'Worker';
  if (mode === 'reviewer') return 'Reviewer';
  return 'Chat';
}

function riskLabel(level?: string): string {
  if (level === 'high') return 'High risk';
  if (level === 'medium') return 'Medium risk';
  return 'Low risk';
}

export function AgentContextBar() {
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const { data: agents } = useAgents();
  const agent = agents?.find((item) => item.id === activeAgentId);

  if (!agent) {
    return (
      <div className="agent-context-bar empty" role="status">
        <span className="agent-context-dot" aria-hidden="true" />
        <span>Select an agent to start an Argus session.</span>
      </div>
    );
  }

  const context = [
    agent.ticket_id ? `Ticket ${agent.ticket_id}` : null,
    agent.pr_branch ? `Branch ${agent.pr_branch}` : null,
    agent.repository ? `Repo ${agent.repository}` : null,
  ].filter(Boolean);

  return (
    <div className="agent-context-bar" role="status" aria-label="Active Argus execution context">
      <div className="agent-context-main">
        <span className="agent-context-dot active" aria-hidden="true" />
        <strong>{agent.label || agent.name}</strong>
        <span className="context-pill">{modeLabel(agent.agent_mode)}</span>
        <span className={`context-pill risk-${agent.risk_level ?? 'low'}`}>{riskLabel(agent.risk_level)}</span>
        {agent.human_oversight_required && <span className="context-pill oversight">Approval required for sensitive actions</span>}
      </div>
      <div className="agent-context-meta">
        {context.map((item) => <span key={item}>{item}</span>)}
        <span>{activeSessionId ? `Session ${activeSessionId.slice(0, 8)}` : 'New session'}</span>
        {agent.supports_vision && <span>Vision enabled</span>}
      </div>
    </div>
  );
}
