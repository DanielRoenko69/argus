import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bot, CheckCircle2, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { usePalette } from '@/api/palette';
import {
  buildSavePayload,
  type WorkflowAgentPreflight,
  type WorkflowAgentRequirement,
  useFlow,
  useSaveFlow,
} from '@/api/workflows';
import { useBuilderStore } from '@/stores/builderStore';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  workflowId: number;
  open: boolean;
  onClose: () => void;
}

const MODES = ['chat', 'worker', 'reviewer'] as const;
const ROLE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{1,127}$/;

function slugRole(value: string, fallback: string): string {
  const role = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '');
  return ROLE_PATTERN.test(role) ? role : fallback;
}

function splitList(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
}

function cloneRequirements(value: WorkflowAgentRequirement[]): WorkflowAgentRequirement[] {
  return value.map(requirement => ({
    ...requirement,
    stepIds: [...requirement.stepIds],
    allowedModes: [...requirement.allowedModes],
    requiredSkillNames: [...requirement.requiredSkillNames],
    requiredToolPatterns: [...requirement.requiredToolPatterns],
  }));
}

export function AgentContractEditor({ workflowId, open, onClose }: Props) {
  const { data: flow } = useFlow(workflowId);
  const { data: palette } = usePalette();
  const nodes = useBuilderStore(state => state.nodes);
  const edges = useBuilderStore(state => state.edges);
  const viewport = useBuilderStore(state => state.viewport);
  const setNodes = useBuilderStore(state => state.setNodes);
  const markClean = useBuilderStore(state => state.markClean);
  const save = useSaveFlow();
  const [draft, setDraft] = useState<WorkflowAgentRequirement[]>([]);
  const [preflight, setPreflight] = useState<WorkflowAgentPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedWorkflowRef = useRef<number | null>(null);

  const agentNodes = useMemo(() => nodes
    .filter(node => node.type === 'argus.agent')
    .map((node, index) => {
      const data = (node.data ?? {}) as Record<string, unknown>;
      const agentId = typeof data['agent_id'] === 'number' ? data['agent_id'] : null;
      const agent = palette?.agents.find(candidate => candidate.id === agentId);
      return {
        id: node.id,
        label: String(data['label'] ?? `Agent ${index + 1}`),
        agentId,
        agent,
        agentRole: typeof data['agent_role'] === 'string' ? data['agent_role'] : null,
      };
    }), [nodes, palette]);

  useEffect(() => {
    if (!open) {
      initializedWorkflowRef.current = null;
      return;
    }
    if (!flow || initializedWorkflowRef.current === workflowId) return;
    const existing = flow?.agent_requirements ?? [];
    if (existing.length > 0) {
      setDraft(cloneRequirements(existing));
    } else {
      // Flow data and canvas restoration arrive independently. Waiting here avoids
      // freezing an empty inferred contract when the drawer is opened immediately.
      if ((flow.steps.length > 0 || flow.block_definitions.length > 0) && nodes.length === 0) return;
      const inferred = new Map<string, WorkflowAgentRequirement>();
      for (const [index, node] of agentNodes.entries()) {
        const fallback = `agent-${index + 1}`;
        const role = slugRole(node.agentRole ?? node.agent?.name ?? node.label, fallback);
        const current = inferred.get(role);
        if (current) {
          current.stepIds.push(node.id);
          continue;
        }
        const mode = MODES.includes(node.agent?.agent_mode as typeof MODES[number])
          ? node.agent!.agent_mode as typeof MODES[number]
          : 'worker';
        inferred.set(role, {
          role,
          label: node.agent?.label ?? node.label,
          stepIds: [node.id],
          ...(node.agent ? { agentName: node.agent.name } : node.agentId ? { agentId: node.agentId } : {}),
          allowedModes: [mode],
          requiredSkillNames: [],
          requiredToolPatterns: [],
          minimumBundleCount: 0,
        });
      }
      setDraft([...inferred.values()]);
    }
    initializedWorkflowRef.current = workflowId;
    setPreflight(null);
    setError(null);
  }, [agentNodes, flow, nodes.length, open, workflowId]);

  if (!open) return null;

  const validationErrors = validateDraft(draft, agentNodes.map(node => node.id));
  const canEdit = flow?.can_edit !== false;
  const draftRoles = new Set(draft.map(requirement => requirement.role));
  const savedOnlyAssignments = preflight?.assignments.filter(assignment => !draftRoles.has(assignment.role)) ?? [];
  const preflightFindings = preflight ? [...preflight.blockers, ...preflight.warnings] : [];

  const update = (index: number, patch: Partial<WorkflowAgentRequirement>) => {
    setDraft(current => current.map((requirement, position) => position === index
      ? { ...requirement, ...patch }
      : requirement));
    setPreflight(null);
  };

  const toggleStep = (requirementIndex: number, stepId: string) => {
    setDraft(current => current.map((requirement, index) => {
      if (index === requirementIndex) {
        return requirement.stepIds.includes(stepId)
          ? { ...requirement, stepIds: requirement.stepIds.filter(id => id !== stepId) }
          : { ...requirement, stepIds: [...requirement.stepIds, stepId] };
      }
      return { ...requirement, stepIds: requirement.stepIds.filter(id => id !== stepId) };
    }));
    setPreflight(null);
  };

  const runPreflight = async () => {
    setChecking(true);
    setError(null);
    try {
      setPreflight(await api.get<WorkflowAgentPreflight>(`/api/admin/workflows/${workflowId}/agent-preflight`));
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setChecking(false);
    }
  };

  const saveContract = async () => {
    if (!canEdit || validationErrors.length > 0) return;
    setError(null);
    const roleByStep = new Map(draft.flatMap(requirement => requirement.stepIds.map(stepId => [stepId, requirement.role] as const)));
    const nextNodes = nodes.map(node => {
      if (node.type !== 'argus.agent') return node;
      const { agent_role: _oldRole, ...data } = (node.data ?? {}) as Record<string, unknown>;
      const role = roleByStep.get(node.id);
      return { ...node, data: role ? { ...data, agent_id: null, agent_role: role } : data };
    });
    setNodes(nextNodes);
    try {
      await save.mutateAsync({
        id: workflowId,
        payload: { ...buildSavePayload(nextNodes, edges, viewport), agent_requirements: draft },
      });
      markClean();
      await runPreflight();
    } catch (caught) {
      setError(apiErrorMessage(caught));
    }
  };

  return createPortal(
    <div className="agent-contract-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="agent-contract-drawer" role="dialog" aria-modal="true" aria-label="Workflow Agent contract">
        <header className="agent-contract-titlebar">
          <div className="agent-contract-title-icon"><Bot className="w-5 h-5" /></div>
          <div>
            <span>EXECUTION CONTRACT</span>
            <h2>Workflow Agents</h2>
            <p>Resolve portable roles to governed Agents before this workflow can run.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close Agent contract"><X className="w-4 h-4" /></button>
        </header>

        <div className="agent-contract-summary">
          <div><small>Agent steps</small><strong>{agentNodes.length}</strong></div>
          <div><small>Declared roles</small><strong>{draft.length}</strong></div>
          <div><small>Assigned steps</small><strong>{new Set(draft.flatMap(item => item.stepIds)).size}/{agentNodes.length}</strong></div>
          <div className={cn(preflight?.ready ? 'is-ready' : preflight ? 'is-blocked' : '')}>
            <small>Preflight</small><strong>{preflight ? preflight.ready ? 'Ready' : 'Blocked' : 'Not checked'}</strong>
          </div>
        </div>

        <div className="agent-contract-content">
          {agentNodes.length === 0 && draft.length === 0 ? (
            <div className="agent-contract-empty">
              <Bot className="w-6 h-6" />
              <strong>No Agent steps on this canvas</strong>
              <p>Add an Agent block first, or create a supporting role that is not bound to a step.</p>
            </div>
          ) : draft.map((requirement, index) => (
            <article className="agent-contract-role" key={`${requirement.role}-${index}`}>
              <div className="agent-contract-role-head">
                <span className="agent-contract-role-number">{index + 1}</span>
                <div><small>PORTABLE ROLE</small><strong>{requirement.label || requirement.role}</strong></div>
                <button type="button" disabled={!canEdit} onClick={() => setDraft(current => current.filter((_, position) => position !== index))} aria-label={`Remove ${requirement.role}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="agent-contract-form-grid">
                <label><span>Role key</span><input value={requirement.role} disabled={!canEdit} onChange={event => update(index, { role: event.target.value.toLowerCase() })} placeholder="coder" /></label>
                <label><span>Display label</span><input value={requirement.label ?? ''} disabled={!canEdit} onChange={event => update(index, { label: event.target.value })} placeholder="Coder" /></label>
                <label>
                  <span>Preferred Agent</span>
                  <select value={requirement.agentName ?? ''} disabled={!canEdit} onChange={event => update(index, {
                    agentName: event.target.value || undefined,
                    agentId: undefined,
                  })}>
                    <option value="">Resolve by role</option>
                    {(palette?.agents ?? []).map(agent => <option key={agent.id} value={agent.name}>{agent.label} · {agent.agent_mode}</option>)}
                  </select>
                </label>
                <label><span>Preset name</span><input value={requirement.presetName ?? ''} disabled={!canEdit} onChange={event => update(index, { presetName: event.target.value || undefined })} placeholder="argus-dev-coder" /></label>
                <label><span>Minimum preset version</span><input type="number" min="1" value={requirement.minimumPresetVersion ?? 1} disabled={!canEdit || !requirement.presetName} onChange={event => update(index, { minimumPresetVersion: Number(event.target.value) || 1 })} /></label>
                <label><span>Minimum MCP bundles</span><input type="number" min="0" max="16" value={requirement.minimumBundleCount} disabled={!canEdit} onChange={event => update(index, { minimumBundleCount: Number(event.target.value) || 0 })} /></label>
              </div>

              <fieldset className="agent-contract-fieldset">
                <legend>Allowed Agent modes</legend>
                <div className="agent-contract-checks">
                  {MODES.map(mode => <label key={mode}><input type="checkbox" checked={requirement.allowedModes.includes(mode)} disabled={!canEdit} onChange={() => update(index, {
                    allowedModes: requirement.allowedModes.includes(mode)
                      ? requirement.allowedModes.filter(item => item !== mode)
                      : [...requirement.allowedModes, mode],
                  })} /><span>{mode}</span></label>)}
                </div>
              </fieldset>

              <fieldset className="agent-contract-fieldset">
                <legend>Assigned Agent steps</legend>
                <div className="agent-contract-checks is-steps">
                  {agentNodes.map(node => <label key={node.id}><input type="checkbox" checked={requirement.stepIds.includes(node.id)} disabled={!canEdit} onChange={() => toggleStep(index, node.id)} /><span>{node.label}<code>{node.id}</code></span></label>)}
                  {agentNodes.length === 0 && <span className="agent-contract-muted">Supporting role without an execution step</span>}
                </div>
              </fieldset>

              <div className="agent-contract-form-grid is-wide">
                <label><span>Required skill names</span><input value={requirement.requiredSkillNames.join(', ')} disabled={!canEdit} onChange={event => update(index, { requiredSkillNames: splitList(event.target.value) })} placeholder="typescript, secure-review" /></label>
                <label><span>Required tool patterns</span><input value={requirement.requiredToolPatterns.join(', ')} disabled={!canEdit} onChange={event => update(index, { requiredToolPatterns: splitList(event.target.value) })} placeholder="github_*, workspace_write" /></label>
              </div>

              {preflight?.assignments.find(item => item.role === requirement.role) && <AssignmentEvidence assignment={preflight.assignments.find(item => item.role === requirement.role)!} />}
            </article>
          ))}

          {savedOnlyAssignments.length > 0 && (
            <section className="agent-contract-saved-evidence">
              <div><small>SAVED CONTRACT EVIDENCE</small><strong>Current persisted workflow</strong><span>Save this draft to migrate the workflow to its portable role contract.</span></div>
              {savedOnlyAssignments.map(assignment => <AssignmentEvidence key={assignment.role} assignment={assignment} />)}
            </section>
          )}

          {preflightFindings.length > 0 && (
            <div className={cn('agent-contract-preflight-findings', preflight?.blockers.length ? 'is-blocked' : '')}>
              <AlertTriangle className="w-4 h-4" />
              <ul>{preflightFindings.map(message => <li key={message}>{message}</li>)}</ul>
            </div>
          )}

          {validationErrors.length > 0 && (
            <div className="agent-contract-validation"><AlertTriangle className="w-4 h-4" /><ul>{validationErrors.map(message => <li key={message}>{message}</li>)}</ul></div>
          )}
          {error && <div className="agent-contract-validation"><AlertTriangle className="w-4 h-4" /><span>{error}</span></div>}
          {preflight && preflight.assignments.length === 0 && preflight.ready && (
            <div className="agent-contract-preflight-empty"><CheckCircle2 className="w-4 h-4" />No Agent dependency; preflight is ready.</div>
          )}
        </div>

        <footer className="agent-contract-actions">
          <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => setDraft(current => [...current, emptyRequirement(current.length)])}>
            <Plus className="w-3.5 h-3.5" /> Add role
          </Button>
          <span />
          <Button variant="outline" size="sm" disabled={checking || save.isPending} onClick={() => void runPreflight()}>
            <RefreshCw className={cn('w-3.5 h-3.5', checking && 'animate-spin')} /> {checking ? 'Checking…' : 'Check saved'}
          </Button>
          <Button variant="default" size="sm" disabled={!canEdit || save.isPending || validationErrors.length > 0} onClick={() => void saveContract()}>
            <Save className="w-3.5 h-3.5" /> {save.isPending ? 'Saving…' : 'Save & check'}
          </Button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function AssignmentEvidence({ assignment }: { assignment: WorkflowAgentPreflight['assignments'][number] }) {
  return (
    <div className={cn('agent-contract-evidence', `is-${assignment.status}`)}>
      {assignment.status === 'blocked' ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
      <div><small>RESOLVED AGENT</small><strong>{assignment.agentLabel ?? assignment.agentName ?? 'Not resolved'}</strong><span>{assignment.model ?? 'No model'} · {assignment.runtime?.profileLabel ?? assignment.runtime?.type ?? 'No runtime'}</span></div>
      <div><small>CAPABILITIES</small><strong>{assignment.toolNames.length} tools · {assignment.bundleIds.length} bundles</strong><span>{assignment.skillNames.length} skills · {assignment.stepIds.length} steps</span></div>
      {(assignment.blockers.length > 0 || assignment.warnings.length > 0) && <ul>{[...assignment.blockers, ...assignment.warnings].map(item => <li key={item}>{item}</li>)}</ul>}
    </div>
  );
}

function emptyRequirement(index: number): WorkflowAgentRequirement {
  return {
    role: `agent-${index + 1}`,
    label: `Agent role ${index + 1}`,
    stepIds: [],
    allowedModes: ['worker'],
    requiredSkillNames: [],
    requiredToolPatterns: [],
    minimumBundleCount: 0,
  };
}

function validateDraft(requirements: WorkflowAgentRequirement[], agentStepIds: string[]): string[] {
  const errors: string[] = [];
  const roles = new Set<string>();
  const assigned = new Set<string>();
  for (const requirement of requirements) {
    if (!ROLE_PATTERN.test(requirement.role)) errors.push(`Role '${requirement.role || '?'}' must use lowercase letters, numbers, dots, colons, underscores or dashes.`);
    if (roles.has(requirement.role)) errors.push(`Role '${requirement.role}' is declared more than once.`);
    roles.add(requirement.role);
    if (requirement.allowedModes.length === 0) errors.push(`Role '${requirement.role}' needs at least one allowed Agent mode.`);
    for (const stepId of requirement.stepIds) {
      if (assigned.has(stepId)) errors.push(`Agent step '${stepId}' is assigned more than once.`);
      assigned.add(stepId);
    }
  }
  for (const stepId of agentStepIds) if (!assigned.has(stepId)) errors.push(`Agent step '${stepId}' has no portable role assignment.`);
  return [...new Set(errors)];
}

function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const message = (error.body as { error?: unknown }).error;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : 'Agent contract request failed';
}
