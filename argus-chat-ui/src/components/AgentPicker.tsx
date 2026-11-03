import { useEffect, useRef, useState } from 'react';
import { useAgents } from '../data-provider/hooks.js';
import { useChatStore } from '../store/chat.js';
import { Icon } from './Icon.js';

export function AgentPicker() {
  const { data: agents, isLoading, isError } = useAgents();
  const activeAgentId = useChatStore((state) => state.activeAgentId);
  const setAgent = useChatStore((state) => state.setAgent);
  const activeAgent = agents?.find((agent) => agent.id === activeAgentId);
  const [open, setOpen] = useState(!activeAgentId);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(!activeAgentId);
  }, [activeAgentId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filteredAgents = agents?.filter((agent) => {
    const needle = query.trim().toLowerCase();
    return !needle || `${agent.label} ${agent.name} ${agent.description}`.toLowerCase().includes(needle);
  });

  function choose(id: number) {
    setAgent(id);
    setOpen(false);
    setQuery('');
  }

  return (
    <div className="agent-picker" ref={ref}>
      <span className="agent-picker-label">Agent</span>
      <button
        type="button"
        className={`agent-picker-trigger${activeAgent ? ' has-agent' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-picker-status-dot" />
        <span className="agent-picker-trigger-copy">
          <strong>{activeAgent?.label || 'Choose an agent'}</strong>
          <small>{activeAgent?.model || (isLoading ? 'Loading agents…' : 'Select an execution context')}</small>
        </span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open && (
        <div className="agent-picker-menu" role="listbox" aria-label="Available agents">
          <label className="agent-picker-search">
            <Icon name="search" size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents…" aria-label="Search agents" autoFocus={!activeAgent} />
          </label>
          {filteredAgents?.map((agent) => (
            <button
              type="button"
              role="option"
              aria-selected={activeAgentId === agent.id}
              className={`agent-picker-option${activeAgentId === agent.id ? ' active' : ''}`}
              key={agent.id}
              onClick={() => choose(agent.id)}
            >
              <span className="agent-picker-option-dot" />
              <span className="agent-picker-option-copy">
                <strong>{agent.label || agent.name}</strong>
                <small>{agent.description || agent.model}</small>
              </span>
              {activeAgentId === agent.id && <span className="agent-picker-selected">Active</span>}
            </button>
          ))}
          {!isLoading && isError && <div className="agent-picker-empty agent-picker-error" role="alert">Could not load agents. Check the Argus connection.</div>}
          {!isLoading && !isError && (agents?.length ?? 0) > 0 && filteredAgents?.length === 0 && <div className="agent-picker-empty">No matching agents.</div>}
          {!isLoading && !isError && agents?.length === 0 && <div className="agent-picker-empty">No agents available.</div>}
        </div>
      )}
    </div>
  );
}
