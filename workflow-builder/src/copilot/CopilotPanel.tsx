import { useState } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  GitBranch,
  Loader2,
  PlugZap,
  Save,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { useCopilot, type CopilotSuggestion } from '@/api/copilot';
import { useValidate } from '@/api/builder';
import { buildSavePayload, mergeWorkflowInputParams, useFlow, useSaveFlow } from '@/api/workflows';
import type { WorkflowStep } from '@/api/workflows';
import { useBuilderStore } from '@/stores/builderStore';
import { buildCopilotGraphPatch } from './graphPatch';

interface Props {
  open: boolean;
  workflowId: number | null;
  onClose: () => void;
}

type ProposalStatus = 'proposed' | 'applying' | 'applied' | 'rejected' | 'blocked';

const AGENT_BINDING_WARNING = /^([^:]+): argus\.agent step needs `agent_role` or `agent_id`$/;

function unresolvedCopilotWarnings(warnings: string[] | undefined, steps: WorkflowStep[]): string[] {
  return (warnings ?? []).filter(issue => {
    const match = AGENT_BINDING_WARNING.exec(issue);
    if (!match) return true;
    const step = steps.find(candidate => candidate.id === match[1]);
    const role = typeof step?.agent_role === 'string' ? step.agent_role.trim() : '';
    return !role && !(Number.isSafeInteger(step?.agent_id) && Number(step?.agent_id) > 0);
  });
}

interface HistoryItem {
  role: 'user' | 'assistant';
  text: string;
  suggestion?: CopilotSuggestion;
  status?: ProposalStatus;
  issues?: string[];
}

export function CopilotPanel({ open, workflowId, onClose }: Props) {
  const copilot = useCopilot();
  const validate = useValidate();
  const save = useSaveFlow();
  const { data: flow } = useFlow(workflowId);
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);

  if (!open) return null;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!workflowId || !prompt.trim()) return;
    const state = useBuilderStore.getState();
    const userText = prompt.trim();
    setPrompt('');
    setHistory(current => [...current, { role: 'user', text: userText }]);
    try {
      const suggestion = await copilot.mutateAsync({
        workflowId,
        prompt: userText,
        current_nodes: state.nodes.map(node => ({
          id: node.id,
          type: node.type ?? '',
          position: node.position,
          data: node.data as Record<string, unknown>,
        })),
        current_edges: state.edges.map(edge => ({ source: edge.source, target: edge.target })),
      });
      const preview = buildCopilotGraphPatch(state.nodes, state.edges, suggestion);
      const previewSteps = buildSavePayload(
        preview.nodes,
        preview.edges,
        state.viewport,
        flow?.agent_requirements ?? [],
      ).steps;
      const warnings = unresolvedCopilotWarnings(suggestion.warnings, previewSteps);
      const normalizedSuggestion = { ...suggestion, warnings };
      setHistory(current => [...current, {
        role: 'assistant',
        text: normalizedSuggestion.rationale,
        suggestion: normalizedSuggestion,
        status: warnings.length ? 'blocked' : 'proposed',
        issues: warnings,
      }]);
    } catch (error) {
      setHistory(current => [...current, {
        role: 'assistant',
        text: `Fehler: ${error instanceof Error ? error.message : String(error)}`,
        status: 'blocked',
      }]);
    }
  }

  async function applyAt(index: number) {
    const item = history[index];
    if (!workflowId || !item?.suggestion || item.suggestion.warnings?.length) return;
    setHistory(current => current.map((entry, itemIndex) => (
      itemIndex === index ? { ...entry, status: 'applying', issues: undefined } : entry
    )));

    try {
      const source = useBuilderStore.getState();
      if (source.readOnly) throw new Error('Der Workflow ist schreibgeschützt.');
      const patch = buildCopilotGraphPatch(source.nodes, source.edges, item.suggestion);
      const payload = {
        ...buildSavePayload(
        patch.nodes,
        patch.edges,
        source.viewport,
        flow?.agent_requirements ?? [],
        ),
        input_params: mergeWorkflowInputParams(flow?.input_params, item.suggestion.input_params),
      };
      const validation = await validate.mutateAsync({ workflowId, steps: payload.steps });
      if (!validation.valid) {
        setHistory(current => current.map((entry, itemIndex) => itemIndex === index ? {
          ...entry,
          status: 'blocked',
          issues: validation.errors.map(error => `${error.stepId}: ${error.issue}`),
        } : entry));
        return;
      }

      const latest = useBuilderStore.getState();
      if (latest.nodes !== source.nodes || latest.edges !== source.edges) {
        throw new Error('Der Canvas wurde während der Prüfung geändert. Bitte den Vorschlag erneut anwenden.');
      }
      await save.mutateAsync({ id: workflowId, payload });
      useBuilderStore.getState().applyGraphPatch(patch.nodes, patch.edges, { markClean: true });
      setHistory(current => current.map((entry, itemIndex) => itemIndex === index ? {
        ...entry,
        status: 'applied',
        issues: validation.warnings.map(warning => `${warning.stepId}: ${warning.issue}`),
      } : entry));
    } catch (error) {
      setHistory(current => current.map((entry, itemIndex) => itemIndex === index ? {
        ...entry,
        status: 'blocked',
        issues: [error instanceof Error ? error.message : String(error)],
      } : entry));
    }
  }

  function rejectAt(index: number) {
    setHistory(current => current.map((entry, itemIndex) => (
      itemIndex === index ? { ...entry, status: 'rejected' } : entry
    )));
  }

  return (
    <aside className="absolute right-0 top-0 bottom-0 w-[26rem] border-l border-border bg-card/95 backdrop-blur flex flex-col animate-slide-in-right z-20">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <div>
            <h3 className="text-small font-medium">Workflow Copilot</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Idee in einen geprüften Entwurf übersetzen</p>
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-secondary" aria-label="Copilot schließen">
          <X className="w-3.5 h-3.5" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {history.length === 0 && (
          <div className="text-xs text-muted-foreground space-y-2">
            <div className="rounded-md border border-violet-500/20 bg-violet-500/5 p-3">
              <div className="flex items-center gap-1.5 text-violet-300 font-medium mb-1">
                <ShieldCheck className="w-3.5 h-3.5" /> Governed by Argus
              </div>
              <p>Der Copilot verwendet nur Agents, Knowledge Sources und MCP-Tools, auf die du Zugriff hast.</p>
            </div>
            <p>Beispiele:</p>
            <ul className="space-y-1">
              {EXAMPLES.map(example => (
                <li key={example}>
                  <button
                    onClick={() => setPrompt(example)}
                    className="text-left w-full px-2 py-1.5 rounded hover:bg-secondary text-foreground/70 hover:text-foreground"
                  >
                    „{example}“
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {history.map((item, index) => (
          <HistoryRow
            key={index}
            item={item}
            onAccept={() => void applyAt(index)}
            onReject={() => rejectAt(index)}
          />
        ))}
        {copilot.isPending && (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Copilot plant und prüft den Workflow…
          </div>
        )}
      </div>

      <form onSubmit={onSubmit} className="p-3 border-t border-border">
        <div className="relative">
          <textarea
            value={prompt}
            onChange={event => setPrompt(event.target.value)}
            placeholder="z. B. Lies neue GitHub Issues, priorisiere sie mit einem Agent und poste das Ergebnis in Slack…"
            rows={4}
            className="w-full pr-9 px-2.5 py-2 rounded-md bg-input border border-border text-small placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void onSubmit(event as unknown as React.FormEvent);
              }
            }}
          />
          <button
            type="submit"
            disabled={!workflowId || !prompt.trim() || copilot.isPending}
            className="absolute bottom-2 right-2 p-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            title="Senden (Strg+Enter)"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </aside>
  );
}

function HistoryRow({ item, onAccept, onReject }: {
  item: HistoryItem;
  onAccept: () => void;
  onReject: () => void;
}) {
  if (item.role === 'user') {
    return <div className="rounded-md bg-primary/10 border border-primary/20 px-3 py-2 text-xs">{item.text}</div>;
  }
  if (!item.suggestion) {
    return (
      <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
        <div className="flex items-center gap-1 mb-1"><AlertCircle className="w-3 h-3" /> Copilot-Fehler</div>
        {item.text}
      </div>
    );
  }

  const summary = summarizeSuggestion(item.suggestion);
  const rejected = item.status === 'rejected';
  return (
    <div className={`rounded-md border px-3 py-2 text-xs space-y-2 ${
      item.status === 'applied'
        ? 'border-emerald-500/30 bg-emerald-500/5'
        : item.status === 'blocked'
          ? 'border-amber-500/30 bg-amber-500/5'
          : 'border-border bg-secondary/30'
    } ${rejected ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2">
        <Bot className="w-3.5 h-3.5 text-violet-300 mt-0.5 shrink-0" />
        <div className={rejected ? 'line-through text-muted-foreground' : 'text-foreground'}>{item.text}</div>
      </div>

      {!rejected && (
        <>
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            <SummaryCell icon={<GitBranch className="w-3 h-3" />} value={`${item.suggestion.add_nodes.length} neu · ${item.suggestion.update_nodes?.length ?? 0} geändert · ${item.suggestion.add_edges.length} Kanten`} />
            <SummaryCell icon={<PlugZap className="w-3 h-3" />} value={summary.integrations.length ? summary.integrations.join(', ') : 'Keine Integration'} />
            <SummaryCell icon={<Bot className="w-3 h-3" />} value={`${summary.agentCount} Agents · ${summary.knowledgeCount} Knowledge`} />
            <SummaryCell
              icon={summary.writeCount ? <ShieldAlert className="w-3 h-3 text-amber-300" /> : <ShieldCheck className="w-3 h-3 text-emerald-300" />}
              value={summary.writeCount ? `${summary.writeCount} Write-Schritte` : 'Read-only / lokal'}
            />
          </div>

          <ul className="font-mono text-[11px] text-muted-foreground space-y-0.5">
            {item.suggestion.add_nodes.slice(0, 8).map(node => (
              <li key={node.id}>+ <span className="text-accent">{node.type}</span> {(node.data?.['label'] as string) ?? node.id}</li>
            ))}
            {item.suggestion.add_nodes.length > 8 && <li>… +{item.suggestion.add_nodes.length - 8} weitere</li>}
            {(item.suggestion.update_nodes ?? []).slice(0, 8).map(node => (
              <li key={`update-${node.id}`}>~ <span className="text-violet-300">{node.id}</span> bestehender Knoten</li>
            ))}
          </ul>

          {summary.writeCount > 0 && (
            <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-200">
              Write-Schritte bleiben an den eingestellten Argus Write-Mode und dessen Approval-Regeln gebunden.
            </div>
          )}
          {item.issues && item.issues.length > 0 && (
            <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
              <div className="font-medium text-amber-200 mb-1">Noch nicht ausführbar</div>
              <ul className="space-y-0.5 text-amber-100/80">
                {item.issues.map((issue, index) => <li key={index}>· {issue}</li>)}
              </ul>
            </div>
          )}

          {item.status === 'applied' ? (
            <div className="flex items-center gap-1 text-emerald-400"><Check className="w-3 h-3" /> Geprüft und als Entwurf gespeichert</div>
          ) : item.status === 'applying' ? (
            <div className="flex items-center gap-1 text-violet-300"><Loader2 className="w-3 h-3 animate-spin" /> Graph prüfen und speichern…</div>
          ) : (
            <div className="flex gap-2 pt-1">
              <button
                onClick={onAccept}
                disabled={item.status === 'blocked'}
                className="flex items-center gap-1 px-2 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Save className="w-3 h-3" /> Prüfen & als Entwurf speichern
              </button>
              <button onClick={onReject} className="flex items-center gap-1 px-2 py-1.5 rounded bg-secondary hover:bg-secondary/70 text-xs">
                <X className="w-3 h-3" /> Verwerfen
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCell({ icon, value }: { icon: React.ReactNode; value: string }) {
  return <div className="flex items-center gap-1 rounded border border-border/70 bg-background/30 px-2 py-1.5 min-w-0">{icon}<span className="truncate" title={value}>{value}</span></div>;
}

function summarizeSuggestion(suggestion: CopilotSuggestion) {
  const integrations = new Set<string>();
  let writeCount = 0;
  let agentCount = 0;
  let knowledgeCount = 0;
  for (const node of suggestion.add_nodes) {
    const data = node.data ?? {};
    if (node.type === 'argus.agent') agentCount += 1;
    if (node.type === 'argus.knowledge') knowledgeCount += 1;
    const binding = data['tool_binding'];
    if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
      const contract = binding as Record<string, unknown>;
      if (typeof contract['integration_id'] === 'string') integrations.add(contract['integration_id']);
      if (contract['access'] === 'write') writeCount += 1;
    } else if (typeof data['integration_id'] === 'string') {
      integrations.add(data['integration_id']);
    }
  }
  for (const update of suggestion.update_nodes ?? []) {
    const data = update.data ?? {};
    const binding = data['tool_binding'];
    if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
      const contract = binding as Record<string, unknown>;
      if (typeof contract['integration_id'] === 'string') integrations.add(contract['integration_id']);
      if (contract['access'] === 'write') writeCount += 1;
    } else if (typeof data['integration_id'] === 'string') {
      integrations.add(data['integration_id']);
    }
  }
  return { integrations: [...integrations], writeCount, agentCount, knowledgeCount };
}

const EXAMPLES = [
  'Lies neue GitHub Issues, priorisiere sie mit dem Planner und poste das Ergebnis in Slack.',
  'Prüfe jeden Morgen um 09:00 Uhr offene Incidents und sende eine Zusammenfassung.',
  'Verarbeite alle Elemente einer Eingabeliste parallel und gib eine gemeinsame Antwort zurück.',
];
