import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot, BrainCircuit, Check, CheckCircle2, CircleDot, ExternalLink, Link2, LoaderCircle,
  Play, RefreshCw, RotateCcw, ShieldCheck, Square, TerminalSquare, X,
} from 'lucide-react';
import {
  cancelHermesManagedRun,
  decideHermesManagedMemoryProposal,
  getHermesDevConnections,
  getHermesManagedMemoryProposals,
  getHermesManagedRun,
  getHermesManagedRunEvents,
  getHermesManagedRuns,
  getHermesManagedRuntime,
  preflightHermesManagedRuntime,
  startHermesManagedRun,
} from '../api';
import type { HermesManagedRunResponse } from '../types';
import { timeAgo } from './Ui';
import { HermesDevConnectionsPanel } from './HermesDevConnectionsPanel';

const TERMINAL = new Set(['cancelled', 'completed', 'failed']);

function stateLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

function evidenceLabel(evidence: Record<string, string | number | boolean | null> | undefined): string {
  if (!evidence) return '';
  return Object.entries(evidence).map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
}

export function HermesRuntimePanel() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'managed' | 'existing'>('managed');
  const runtime = useQuery({ queryKey: ['hermes-managed-runtime'], queryFn: getHermesManagedRuntime, staleTime: 10_000, refetchInterval: 15_000 });
  const connections = useQuery({ queryKey: ['hermes-dev-connections'], queryFn: getHermesDevConnections, staleTime: 15_000 });
  const runs = useQuery({ queryKey: ['hermes-managed-runs'], queryFn: getHermesManagedRuns, enabled: runtime.data?.pack.connected === true, refetchInterval: 5_000 });
  const memoryProposals = useQuery({
    queryKey: ['hermes-managed-memory-proposals'],
    queryFn: getHermesManagedMemoryProposals,
    enabled: runtime.data?.pack.connected === true,
    refetchInterval: 10_000,
  });
  const [agentName, setAgentName] = useState('');
  const [bundleIds, setBundleIds] = useState<number[]>([]);
  const [task, setTask] = useState('Inspect the selected project evidence with the governed Argus tools and return a concise implementation plan. Do not perform writes.');
  const [instructions, setInstructions] = useState('Use only the Argus MCP tools provided for this run. Cite concrete tool evidence and do not perform writes.');
  const [deadlineSeconds, setDeadlineSeconds] = useState(600);
  const [maxToolCalls, setMaxToolCalls] = useState(64);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [preflightSignature, setPreflightSignature] = useState('');

  const approvedBundles = useMemo(() => {
    const approved = new Set(runtime.data?.managed.approvedBundleIds ?? []);
    return (connections.data?.bundles ?? []).filter(bundle => approved.has(bundle.id));
  }, [connections.data?.bundles, runtime.data?.managed.approvedBundleIds]);

  useEffect(() => {
    if (!agentName && runtime.data?.managed.agents[0]) setAgentName(runtime.data.managed.agents[0].name);
  }, [agentName, runtime.data?.managed.agents]);
  useEffect(() => {
    if (bundleIds.length === 0 && approvedBundles.length > 0) setBundleIds(approvedBundles.map(bundle => bundle.id));
  }, [approvedBundles, bundleIds.length]);
  useEffect(() => {
    if (!selectedRunId && runs.data?.runs[0]) setSelectedRunId(runs.data.runs[0].run.id);
  }, [runs.data?.runs, selectedRunId]);

  const signature = JSON.stringify({ agentName, bundleIds: [...bundleIds].sort((a, b) => a - b) });
  const preflight = useMutation({
    mutationFn: () => preflightHermesManagedRuntime({ coreAgentName: agentName, bundleIds }),
    onSuccess: () => setPreflightSignature(signature),
  });
  const launch = useMutation({
    mutationFn: () => startHermesManagedRun({
      requestId: crypto.randomUUID(),
      coreAgentName: agentName,
      bundleIds,
      input: { text: task.trim() },
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      limits: { deadlineSeconds, maxToolCalls, maxOutputBytes: 256 * 1024 },
    }),
    onSuccess: async result => {
      setSelectedRunId(result.run.id);
      queryClient.setQueryData<{ runs: HermesManagedRunResponse[] }>(['hermes-managed-runs'], previous => ({
        runs: [result, ...(previous?.runs ?? []).filter(item => item.run.id !== result.run.id)],
      }));
      await queryClient.invalidateQueries({ queryKey: ['hermes-managed-run', result.run.id] });
    },
  });
  const selectedFromList = runs.data?.runs.find(item => item.run.id === selectedRunId);
  const status = useQuery({
    queryKey: ['hermes-managed-run', selectedRunId],
    queryFn: () => getHermesManagedRun(selectedRunId!),
    enabled: Boolean(selectedRunId),
    initialData: selectedFromList,
    refetchInterval: query => TERMINAL.has(query.state.data?.run.state ?? '') ? false : 1_000,
  });
  const events = useQuery({
    queryKey: ['hermes-managed-run-events', selectedRunId],
    queryFn: () => getHermesManagedRunEvents(selectedRunId!),
    enabled: Boolean(selectedRunId),
    refetchInterval: () => TERMINAL.has(status.data?.run.state ?? '') ? false : 1_000,
  });
  const cancel = useMutation({
    mutationFn: () => cancelHermesManagedRun(selectedRunId!),
    onSuccess: async result => {
      queryClient.setQueryData(['hermes-managed-run', result.run.id], result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['hermes-managed-runs'] }),
        queryClient.invalidateQueries({ queryKey: ['hermes-managed-run-events', result.run.id] }),
      ]);
    },
  });
  const decideMemory = useMutation({
    mutationFn: ({ proposalId, decision }: { proposalId: string; decision: 'accepted' | 'rejected' }) =>
      decideHermesManagedMemoryProposal(proposalId, decision),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['hermes-managed-memory-proposals'] });
    },
  });

  const toggleBundle = (id: number) => {
    setBundleIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
    setPreflightSignature('');
  };
  const preflightReady = preflight.data?.ready === true && preflightSignature === signature;
  const active = status.data && !TERMINAL.has(status.data.run.state);

  return (
    <section className="hermes-runtime-workbench" aria-label="Hermes runtime workbench">
      <header className="hermes-runtime-workbench-header">
        <div><span className="eyebrow">HERMES RUNTIME</span><h2>Choose how Hermes works with Argus Dev</h2><p>Bring an existing Hermes or start an isolated Managed Hermes with your current SSO identity, approved Bundles and Argus traces.</p></div>
        <div className="hermes-runtime-mode-tabs" role="tablist" aria-label="Hermes runtime mode">
          <button role="tab" aria-selected={mode === 'managed'} className={mode === 'managed' ? 'is-active' : ''} type="button" onClick={() => setMode('managed')}><Bot size={14} />Managed Hermes</button>
          <button role="tab" aria-selected={mode === 'existing'} className={mode === 'existing' ? 'is-active' : ''} type="button" onClick={() => setMode('existing')}><Link2 size={14} />Existing Hermes</button>
        </div>
      </header>

      {mode === 'existing' ? <HermesDevConnectionsPanel /> : (
        <div className="panel hermes-managed-panel">
          {runtime.isLoading ? <div className="hermes-managed-loading"><LoaderCircle className="spin" size={16} />Checking Managed Hermes…</div> : runtime.error ? (
            <div className="editor-error" role="alert">Managed Hermes status is unavailable: {runtime.error.message}</div>
          ) : runtime.data && (
            <>
              <div className="hermes-managed-readiness">
                <span className={runtime.data.managed.ready ? 'is-ready' : 'is-blocked'}>{runtime.data.managed.ready ? <CheckCircle2 size={17} /> : <CircleDot size={17} />}</span>
                <div><b>{runtime.data.managed.ready ? 'Managed Hermes ready' : 'Managed Hermes unavailable'}</b><small>{runtime.data.managed.detail}</small></div>
                <em><ShieldCheck size={12} />{runtime.data.identity.authentication === 'sso' ? 'SSO' : 'Argus session'} · {runtime.data.identity.displayName}</em>
              </div>

              <div className="hermes-managed-grid">
                <form className="hermes-managed-launch" onSubmit={event => { event.preventDefault(); if (preflightReady) launch.mutate(); }}>
                  <div className="hermes-managed-section-title"><TerminalSquare size={15} /><div><b>New development task</b><small>Every attempt gets a fresh container, trace and time-bounded MCP lease.</small></div></div>
                  <label>Core Agent<select aria-label="Managed Hermes Core Agent" value={agentName} onChange={event => { setAgentName(event.target.value); setPreflightSignature(''); }}><option value="">Select Agent</option>{runtime.data.managed.agents.map(agent => <option key={agent.id} value={agent.name}>{agent.label} · {agent.name}</option>)}</select></label>
                  <fieldset><legend>Read-only MCP Bundles</legend><div className="hermes-managed-bundles">{approvedBundles.map(bundle => <label className={bundleIds.includes(bundle.id) ? 'is-selected' : ''} key={bundle.id}><input type="checkbox" checked={bundleIds.includes(bundle.id)} onChange={() => toggleBundle(bundle.id)} /><span><b>{bundle.label}</b><small>{bundle.toolCount} tools</small></span></label>)}{!approvedBundles.length && <small>No approved Bundle is available to this identity.</small>}</div></fieldset>
                  <label>Task<textarea aria-label="Managed Hermes task" rows={5} maxLength={64 * 1024} value={task} onChange={event => setTask(event.target.value)} /></label>
                  <label>Runtime instructions<textarea aria-label="Managed Hermes instructions" rows={3} maxLength={8 * 1024} value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
                  <div className="hermes-managed-limits"><label>Deadline (seconds)<input type="number" min={runtime.data.limits.deadlineSeconds.min} max={runtime.data.limits.deadlineSeconds.max} value={deadlineSeconds} onChange={event => setDeadlineSeconds(Number(event.target.value))} /></label><label>Maximum tool calls<input type="number" min={runtime.data.limits.maxToolCalls.min} max={runtime.data.limits.maxToolCalls.max} value={maxToolCalls} onChange={event => setMaxToolCalls(Number(event.target.value))} /></label></div>
                  {preflight.data && preflightSignature === signature && <div className={preflight.data.ready ? 'hermes-preflight-result is-ready' : 'hermes-preflight-result is-blocked'}>{preflight.data.ready ? <><CheckCircle2 size={14} />Preflight passed</> : <><CircleDot size={14} />{preflight.data.errors.join(' ')}</>}</div>}
                  {(preflight.error || launch.error) && <div className="editor-error" role="alert">{(preflight.error ?? launch.error)?.message}</div>}
                  <div className="hermes-managed-actions"><button className="button button-secondary" type="button" disabled={!runtime.data.managed.ready || !agentName || !bundleIds.length || preflight.isPending} onClick={() => preflight.mutate()}><RefreshCw className={preflight.isPending ? 'spin' : ''} size={14} />{preflight.isPending ? 'Checking…' : 'Run preflight'}</button><button className="button button-primary" type="submit" disabled={!preflightReady || !task.trim() || launch.isPending}><Play size={14} />{launch.isPending ? 'Starting…' : 'Start Managed Hermes'}</button></div>
                </form>

                <section className="hermes-managed-runs" aria-label="Managed Hermes runs">
                  <header><div><b>Runs</b><small>Only attempts owned by your current Argus identity are shown.</small></div><button type="button" aria-label="Refresh Managed Hermes runs" onClick={() => void runs.refetch()}><RefreshCw size={13} /></button></header>
                  <div className="hermes-managed-run-layout">
                    <nav>{(runs.data?.runs ?? []).map(item => <button className={selectedRunId === item.run.id ? 'is-active' : ''} type="button" key={item.run.id} onClick={() => setSelectedRunId(item.run.id)}><span className={`run-dot state-${item.run.state}`} /><span><b>{stateLabel(item.run.state)}</b><small>{timeAgo(item.run.acceptedAt)}</small></span><code>{item.run.id.slice(0, 8)}</code></button>)}{!runs.isLoading && !(runs.data?.runs.length) && <div className="hermes-managed-empty">No Managed Hermes runs yet.</div>}</nav>
                    <div className="hermes-managed-run-detail">
                      {status.data ? <>
                        <header><div><span className={`run-dot state-${status.data.run.state}`} /><span><b>{stateLabel(status.data.run.state)}</b><small>Run {status.data.run.id}</small></span></div><div>{active && <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}><Square size={13} />{cancel.isPending ? 'Stopping…' : 'Stop'}</button>}{TERMINAL.has(status.data.run.state) && <button type="button" disabled={!preflightReady || launch.isPending} onClick={() => launch.mutate()} title="Starts a clean attempt with the current task and selection"><RotateCcw size={13} />Retry clean</button>}</div></header>
                        <div className="hermes-managed-trace"><code>TRACE {status.data.run.rootTraceId}</code><a href={`/observe/logs?root_trace=${encodeURIComponent(status.data.run.rootTraceId)}`}>Open logs <ExternalLink size={12} /></a></div>
                        <ol className="hermes-managed-events">{(events.data?.events ?? []).map(event => <li key={event.eventId}><span className={`run-dot state-${event.run.state}`} /><div><b>{stateLabel(event.type)}</b><small>{new Date(event.occurredAt).toLocaleTimeString()} {evidenceLabel(event.evidence)}</small></div></li>)}</ol>
                        {(status.error || events.error || cancel.error) && <div className="editor-error" role="alert">{(status.error ?? events.error ?? cancel.error)?.message}</div>}
                      </> : <div className="hermes-managed-empty">Select a run to inspect its live lifecycle and trace.</div>}
                    </div>
                  </div>
                </section>
              </div>

              <section className="hermes-memory-review" aria-label="Managed Hermes memory proposals">
                <header>
                  <div><span><BrainCircuit size={16} /></span><div><b>Governed memory review</b><small>Hermes can propose workspace facts, but only your explicit decision makes them available to a later attempt.</small></div></div>
                  <button type="button" aria-label="Refresh memory proposals" onClick={() => void memoryProposals.refetch()}><RefreshCw size={13} /></button>
                </header>
                <div className="hermes-memory-list">
                  {(memoryProposals.data?.proposals ?? []).map(proposal => (
                    <article className={`status-${proposal.status}`} key={proposal.id}>
                      <div className="hermes-memory-content"><span>{proposal.kind}</span><p>{proposal.content}</p><small>{proposal.workspaceLabel} · {proposal.validDays} days · proposed {proposal.proposalCount}×</small></div>
                      <div className="hermes-memory-provenance"><code>TRACE {proposal.sourceTraceId.slice(0, 12)}</code><a href={`/observe/logs?root_trace=${encodeURIComponent(proposal.sourceTraceId)}`}>Logs <ExternalLink size={11} /></a></div>
                      {proposal.status === 'pending' ? <div className="hermes-memory-actions"><button type="button" aria-label={`Reject memory proposal ${proposal.id}`} disabled={decideMemory.isPending} onClick={() => decideMemory.mutate({ proposalId: proposal.id, decision: 'rejected' })}><X size={13} />Reject</button><button className="is-accept" type="button" aria-label={`Accept memory proposal ${proposal.id}`} disabled={decideMemory.isPending} onClick={() => decideMemory.mutate({ proposalId: proposal.id, decision: 'accepted' })}><Check size={13} />Accept</button></div> : <em>{proposal.status}</em>}
                    </article>
                  ))}
                  {!memoryProposals.isLoading && !(memoryProposals.data?.proposals.length) && <div className="hermes-managed-empty">No memory proposals yet. Managed Hermes runs remain stateless until a proposal is reviewed.</div>}
                </div>
                {(memoryProposals.error || decideMemory.error) && <div className="editor-error" role="alert">{(memoryProposals.error ?? decideMemory.error)?.message}</div>}
              </section>
            </>
          )}
        </div>
      )}
    </section>
  );
}
