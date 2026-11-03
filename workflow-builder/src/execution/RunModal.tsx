// Modal that pops up when user clicks "Run" and the workflow has input_params.
// Renders a typed form, validates required fields, then triggers execute with inputs.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Play, X, Loader2, History as HistoryIcon, FlaskConical, DollarSign, AlertTriangle, CheckCircle2, Boxes, ExternalLink, ShieldCheck, RotateCw } from 'lucide-react';
import { Button } from '@/ui/button';
import { useFlow, useWorkflowAgentPreflight } from '@/api/workflows';
import { useWorkflowResourcePreflight } from '@/api/builder';
import { useExecuteWorkflow, usePackRunWorkflow, useRetryWorkflow } from '@/api/execution';
import { ApiError } from '@/api/client';
import { useCostPredict } from '@/api/stats';
import { navigateToWorkflowReplay } from '@/lib/studioBridge';
import { BrandMark } from '@/components/BrandMark';
import { useBuilderStore } from '@/stores/builderStore';

const SAVED_INPUTS_KEY = (wfId: number) => `argus.savedInputs.${wfId}`;
const SAVED_INPUTS_MAX = 5;

const PACK_SUPPORTED_NODE_TYPES = new Set([
  'trigger.manual', 'trigger.schedule', 'trigger.webhook',
  'argus.agent', 'argus.approval',
  'logic.condition', 'logic.parallel', 'logic.router',
  'logic.response', 'logic.note',
]);

function formatRunError(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const body = error.body as { error?: unknown; issues?: unknown };
    const summary = typeof body.error === 'string' ? body.error : error.message;
    const issues = Array.isArray(body.issues)
      ? body.issues.filter((issue): issue is string => typeof issue === 'string')
      : [];
    return issues.length > 0 ? `${summary}: ${issues.join(' · ')}` : summary;
  }
  return error instanceof Error ? error.message : String(error);
}

function loadSavedInputs(wfId: number): Array<{ ts: number; values: Record<string, unknown> }> {
  try {
    const raw = localStorage.getItem(SAVED_INPUTS_KEY(wfId));
    return raw ? (JSON.parse(raw) as Array<{ ts: number; values: Record<string, unknown> }>) : [];
  } catch { return []; }
}
function appendSavedInputs(wfId: number, values: Record<string, unknown>): void {
  try {
    const list = loadSavedInputs(wfId);
    list.unshift({ ts: Date.now(), values });
    localStorage.setItem(SAVED_INPUTS_KEY(wfId), JSON.stringify(list.slice(0, SAVED_INPUTS_MAX)));
  } catch { /* quota */ }
}

interface InputParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string | number | boolean;
}

interface Props {
  open: boolean;
  workflowId: number | null;
  /** Optional: pre-fill values (e.g. from replay-mode in RunsDrawer). */
  prefill?: Record<string, unknown> | null;
  /** Failed Core execution used as immutable checkpoint source. */
  retryRunId?: number | null;
  retryStepIds?: string[];
  onClose: () => void;
}

export function RunModal({ open, workflowId, prefill, retryRunId = null, retryStepIds = [], onClose }: Props) {
  const { data: flow } = useFlow(workflowId);
  const execute = useExecuteWorkflow();
  const retry = useRetryWorkflow();
  const packRun = usePackRunWorkflow();
  const params = (flow?.input_params as InputParam[] | undefined) ?? [];
  const hasAgentSteps = flow?.steps.some((step) => (step.type ?? '') === 'argus.agent') ?? false;
  const unsupportedPackTypes = [...new Set((flow?.steps ?? [])
    .map(step => String(step.type ?? ''))
    .filter(type => !PACK_SUPPORTED_NODE_TYPES.has(type)))];
  const hasPackResponse = flow?.steps.some(step => (step.type ?? '') === 'logic.response') ?? false;
  const packCompatible = hasAgentSteps && hasPackResponse && unsupportedPackTypes.length === 0;
  const agentPreflight = useWorkflowAgentPreflight(workflowId, open && hasAgentSteps);
  const resourcePreflight = useWorkflowResourcePreflight(workflowId, open);
  const selectNodes = useBuilderStore((state) => state.selectNodes);
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const [savedInputs, setSavedInputs] = useState<Array<{ ts: number; values: Record<string, unknown> }>>([]);
  const [mockMode, setMockMode] = useState(false);
  const [runtime, setRuntime] = useState<'core' | 'argus.dev'>('core');
  const costPredict = useCostPredict();
  const [costUsd, setCostUsd] = useState<number | null>(null);

  // Seed defaults (or prefill from replay) when modal opens
  useEffect(() => {
    if (!open) return;
    const seed: Record<string, string | number | boolean> = {};
    for (const p of params) {
      const pre = prefill?.[p.name];
      if (pre !== undefined && (typeof pre === 'string' || typeof pre === 'number' || typeof pre === 'boolean')) {
        seed[p.name] = pre;
      } else if (p.default !== undefined) seed[p.name] = p.default;
      else if (p.type === 'boolean') seed[p.name] = false;
      else if (p.type === 'number') seed[p.name] = 0;
      else seed[p.name] = '';
    }
    setValues(seed);
    // Core owns MCP Fabric tool execution and persistent approval checkpoints.
    // Argus.Dev stays an explicit option for graphs covered by its portable
    // Agent/logic contract.
    setRuntime('core');
    if (workflowId) setSavedInputs(loadSavedInputs(workflowId));
    // Predict cost when modal opens
    if (flow?.steps) {
      costPredict.mutate(flow.steps, {
        onSuccess: (r) => setCostUsd(r.total_usd),
        onError: () => setCostUsd(null),
      });
    }
  }, [open, flow?.id, prefill]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !workflowId) return null;

  const missing = params.filter((p) => p.required && (values[p.name] === '' || values[p.name] === undefined));
  const agentReady = !hasAgentSteps
    || (!agentPreflight.isLoading && !agentPreflight.isError && agentPreflight.data?.ready === true);
  const resourcesReady = !resourcePreflight.isLoading
    && !resourcePreflight.isError
    && resourcePreflight.data?.ready === true;
  const canRun = missing.length === 0 && !execute.isPending && !retry.isPending && !packRun.isPending && agentReady && resourcesReady;

  async function onRun() {
    if (!workflowId) return;
    try {
      const resourcesChecked = await resourcePreflight.refetch();
      if (resourcesChecked.isError || !resourcesChecked.data?.ready) return;
      if (hasAgentSteps) {
        const checked = await agentPreflight.refetch();
        if (checked.isError || !checked.data?.ready) return;
      }
      if (retryRunId != null) {
        await retry.mutateAsync({ workflowId, runId: retryRunId, input: values });
        appendSavedInputs(workflowId, values);
        onClose();
        return;
      }
      if (runtime === 'argus.dev') {
        const result = await packRun.mutateAsync({ workflowId, input: values });
        appendSavedInputs(workflowId, values);
        onClose();
        navigateToWorkflowReplay(workflowId, result.workflowThreadId || result.rootTraceId);
        return;
      }
      await execute.mutateAsync({ workflowId, input: values, mock: mockMode });
      appendSavedInputs(workflowId, values);
      onClose();
    } catch {/* error in execute.error */}
  }

  function applySaved(idx: number) {
    const set = savedInputs[idx];
    if (!set) return;
    const next: Record<string, string | number | boolean> = {};
    for (const p of params) {
      const v = set.values[p.name];
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') next[p.name] = v;
      else if (p.default !== undefined) next[p.name] = p.default;
      else next[p.name] = p.type === 'number' ? 0 : p.type === 'boolean' ? false : '';
    }
    setValues(next);
  }

  function inspectStep(stepId: string) {
    if (stepId === '*') return;
    selectNodes([stepId]);
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 px-4 py-6 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[560px] max-h-[calc(100vh-6rem)] bg-card border border-border rounded-lg shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            {retryRunId != null ? <RotateCw className="w-4 h-4 text-accent" /> : <Play className="w-4 h-4 text-accent" />}
            <div>
              <h2 className="text-small font-medium">{retryRunId != null ? `Run #${retryRunId} ab Fehler fortsetzen` : 'Workflow ausführen'}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{flow?.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary">
            <X className="w-4 h-4" />
          </button>
        </header>

        {savedInputs.length > 0 && (
          <div className="px-4 pt-3 pb-2 border-b border-border">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
              <HistoryIcon className="w-3 h-3" />
              <span>Vorherige Inputs:</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {savedInputs.map((s, i) => {
                const preview = Object.entries(s.values).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join(' · ');
                return (
                  <button
                    key={i}
                    onClick={() => applySaved(i)}
                    className="px-2 py-0.5 rounded text-[11px] bg-secondary hover:bg-secondary/70 text-foreground/80 hover:text-foreground border border-border truncate max-w-[260px]"
                    title={JSON.stringify(s.values, null, 2)}
                  >
                    {new Date(s.ts).toLocaleTimeString()} · {preview}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {retryRunId != null && (
            <section className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs" aria-label="Checkpoint retry summary">
              <div className="flex items-start gap-2">
                <RotateCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div>
                  <strong className="text-foreground">Checkpoint-Retry aus Run #{retryRunId}</strong>
                  <p className="mt-1 text-muted-foreground">
                    Erfolgreiche, nicht betroffene Schritte werden wiederverwendet. Neu ausgeführt: {retryStepIds.length > 0 ? retryStepIds.join(', ') : 'fehlgeschlagener Schritt und Nachfolger'}.
                  </p>
                </div>
              </div>
            </section>
          )}
          <section className={`builder-start-preflight ${resourcesReady && agentReady ? 'is-ready' : 'is-blocked'}`} aria-label="Workflow start preflight">
            <header>
              {resourcePreflight.isLoading || resourcePreflight.isFetching || (hasAgentSteps && (agentPreflight.isLoading || agentPreflight.isFetching))
                ? <Loader2 className="animate-spin" />
                : resourcesReady && agentReady
                  ? <ShieldCheck />
                  : <AlertTriangle />}
              <div>
                <strong>{resourcePreflight.isLoading || resourcePreflight.isFetching
                  ? 'Start-Preflight läuft'
                  : resourcesReady && agentReady
                    ? 'Workflow ist startbereit'
                    : 'Start-Preflight blockiert'}</strong>
                <span>{resourcePreflight.data
                  ? `${resourcePreflight.data.tools.filter(tool => tool.status === 'ready').length} Fabric-Aktionen verifiziert · ${resourcePreflight.data.blockers.length + (agentPreflight.data?.blockers.length ?? 0)} Blocker`
                  : 'Gespeicherten Graph und berechtigten MCP-Fabric-Katalog prüfen.'}</span>
              </div>
            </header>

            {resourcePreflight.isError && (
              <div className="builder-start-preflight-error">Der Core konnte den aktuellen Fabric-Preflight nicht laden. Der Start bleibt aus Sicherheitsgründen gesperrt.</div>
            )}

            {resourcePreflight.data && (resourcePreflight.data.errors.length > 0 || resourcePreflight.data.tools.length > 0) && (
              <div className="builder-start-preflight-findings">
                {resourcePreflight.data.errors.map((finding, index) => (
                  <button key={`${finding.stepId}-${index}`} type="button" className="builder-start-finding is-blocked" onClick={() => inspectStep(finding.stepId)} disabled={finding.stepId === '*'}>
                    <AlertTriangle />
                    <div><strong>{finding.stepId === '*' ? 'Workflow-Struktur' : finding.stepId}</strong><span>{finding.issue}</span></div>
                    {finding.stepId !== '*' && <small>Node öffnen</small>}
                  </button>
                ))}
                {resourcePreflight.data.tools.map(tool => (
                  <article key={tool.stepId} className={`builder-start-finding is-${tool.status}`}>
                    <BrandMark brand={tool.integrationBrand} label={tool.integrationLabel} fallbackIcon="Plug" />
                    <button type="button" onClick={() => inspectStep(tool.stepId)}>
                      <strong>{tool.stepLabel}</strong>
                      <span>{tool.issue ?? `${tool.integrationLabel} · ${tool.connectionName ?? tool.toolName}`}</span>
                    </button>
                    <div>
                      <em data-risk={tool.riskLevel}>{tool.access === 'write' ? `${tool.riskLevel} write` : 'read'}</em>
                      {tool.status === 'blocked' && (
                        <a href={tool.configureHref} target="_top" title={`${tool.integrationLabel} in MCP Fabric konfigurieren`}>
                          Fabric <ExternalLink />
                        </a>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          {hasAgentSteps && retryRunId == null && (
            <div className="builder-runtime-picker" role="group" aria-label="Execution runtime">
              <button type="button" className={runtime === 'core' ? 'is-selected' : ''} onClick={() => setRuntime('core')}>
                <Play className="w-4 h-4" /><span><b>Argus Core</b><small>Fabric tools + persistente Approvals</small></span>
              </button>
              <button
                type="button"
                disabled={!packCompatible}
                title={!packCompatible
                  ? `Nicht Pack-kompatibel${unsupportedPackTypes.length > 0 ? `: ${unsupportedPackTypes.join(', ')}` : ': terminaler Response-Node fehlt'}`
                  : 'Gespeicherten Graph nach Argus.Dev publizieren'}
                className={runtime === 'argus.dev' ? 'is-selected' : ''}
                onClick={() => { setRuntime('argus.dev'); setMockMode(false); }}
              >
                <Boxes className="w-4 h-4" /><span><b>Argus.Dev</b><small>{packCompatible ? 'Publizieren + LangGraph' : 'Für portable Agent-/Logik-Graphen'}</small></span>
              </button>
            </div>
          )}
          {hasAgentSteps && (
            <div className={`builder-run-preflight ${agentPreflight.data?.ready ? 'is-ready' : 'is-blocked'}`}>
              {agentPreflight.isLoading || agentPreflight.isFetching
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : agentPreflight.data?.ready
                  ? <CheckCircle2 className="w-4 h-4" />
                  : <AlertTriangle className="w-4 h-4" />}
              <div>
                <strong>{agentPreflight.isLoading || agentPreflight.isFetching
                  ? 'Agent Preflight läuft'
                  : agentPreflight.data?.ready
                    ? 'Agent Contract bereit'
                    : 'Agent Contract blockiert'}</strong>
                <span>{agentPreflight.data?.ready
                  ? `${agentPreflight.data.assignments.length} Rollen mit Runtime und Capabilities verifiziert.`
                  : agentPreflight.data?.blockers[0] ?? 'Runtime und Agent-Capabilities konnten nicht bestätigt werden.'}</span>
                {!agentPreflight.data?.ready && agentPreflight.data && agentPreflight.data.blockers.length > 1 && (
                  <ul>{agentPreflight.data.blockers.slice(1).map(blocker => <li key={blocker}>{blocker}</li>)}</ul>
                )}
              </div>
            </div>
          )}
          {params.length === 0 ? (
            <p className="text-small text-muted-foreground text-center py-4">
              Dieser Workflow benötigt keine Inputs.
            </p>
          ) : (
            params.map((p) => (
              <div key={p.name} className="space-y-1">
                <label htmlFor={`workflow-input-${p.name}`} className="flex items-center gap-1 text-xs font-medium text-foreground">
                  {p.name}
                  {p.required && <span className="text-red-400">*</span>}
                  <span className="text-muted-foreground font-normal ml-1">({p.type})</span>
                </label>
                {p.description && (
                  <p className="text-[11px] text-muted-foreground">{p.description}</p>
                )}
                <InputField inputId={`workflow-input-${p.name}`} param={p} value={values[p.name]} onChange={(v) => setValues((s) => ({ ...s, [p.name]: v }))} />
              </div>
            ))
          )}
          {(execute.isError || retry.isError || packRun.isError) && (
            <div className="text-xs text-destructive p-2 rounded bg-red-500/10 border border-red-500/30">
              {formatRunError(execute.error ?? retry.error ?? packRun.error)}
            </div>
          )}
        </div>

        {runtime === 'core' && retryRunId == null && <div className="px-4 py-2 border-t border-border flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer text-muted-foreground hover:text-foreground">
            <input type="checkbox" checked={mockMode} onChange={(e) => setMockMode(e.target.checked)} className="w-3 h-3 accent-primary" />
            <FlaskConical className="w-3 h-3" />
            Mock-Mode (kein Tool-/LLM-Call)
          </label>
          {costUsd != null && !mockMode && (
            <span className="ml-auto flex items-center gap-1 text-amber-400" title="Geschätzte Kosten">
              <DollarSign className="w-3 h-3" />
              ~${costUsd.toFixed(4)}
            </span>
          )}
        </div>}
        <footer className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border">
          <div className="text-xs text-muted-foreground">
            {missing.length > 0 && `${missing.length} Pflichtfeld${missing.length === 1 ? '' : 'er'} fehlen`}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Abbrechen</Button>
            <Button variant="default" size="sm" disabled={!canRun} onClick={onRun}>
              {(execute.isPending || retry.isPending || packRun.isPending) && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {retryRunId != null ? <RotateCw className="w-3.5 h-3.5" /> : runtime === 'argus.dev' ? <Boxes className="w-3.5 h-3.5" /> : mockMode ? <FlaskConical className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {retryRunId != null ? 'Retry starten' : runtime === 'argus.dev' ? 'In Argus.Dev starten' : mockMode ? 'Mock-Run' : 'Starten'}
            </Button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function InputField({
  inputId, param, value, onChange,
}: { inputId: string; param: InputParam; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void }) {
  const cls = 'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';

  if (param.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-small">
        <input id={inputId} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-primary" />
        <span className="text-muted-foreground">aktiviert</span>
      </label>
    );
  }
  if (param.type === 'number') {
    return (
      <input id={inputId} type="number" value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} className={cls} />
    );
  }
  // string — textarea for long descriptions, otherwise input
  const isLong = (param.description ?? '').toLowerCase().includes('beschreibung') || param.name === 'task';
  if (isLong) {
    return (
      <textarea
        id={inputId}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        className={`${cls} resize-y font-mono text-xs`}
        placeholder={param.required ? 'erforderlich' : 'optional'}
      />
    );
  }
  return (
    <input id={inputId} type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={cls}
      placeholder={param.required ? 'erforderlich' : 'optional'} />
  );
}
