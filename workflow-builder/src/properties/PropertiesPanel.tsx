// Right-side properties panel. Renders a form from the active node's
// FieldSchema. Edits flow back into Zustand via updateNodeData().
//
// Layout pattern derived from sim/apps/sim/app/w/.../properties-panel
// (Apache 2.0). Re-implemented against Argus data shape.

import { useState } from 'react';
import { useBuilderStore } from '@/stores/builderStore';
import { getNodeDefinition, type FieldSchema } from '@/nodes/registry';
import { usePalette } from '@/api/palette';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '@/api/client';
import { useTestWebhookWorkflow } from '@/api/execution';
import { buildSavePayload, useFlow, useSaveFlow } from '@/api/workflows';
import { Button } from '@/ui/button';
import { AlertTriangle, CheckCircle2, ExternalLink, FlaskConical, Loader2, LockKeyhole, Settings2, Tag, Trash2, Wrench, X } from 'lucide-react';
import { WandButton } from './WandButton';
import { VarAutocomplete } from './VarAutocomplete';
import { MonacoField } from './MonacoField';
import { ToolConfigForm } from './ToolConfigForm';
import { CredRefSelect } from './CredRefSelect';
import { RagMultiSelect } from './RagMultiSelect';
import { BrandMark } from '@/components/BrandMark';
import { portableToolSelection, type PortableToolSelection } from '@/lib/portableToolBinding';
import {
  agentBindingMode,
  availableAgentRoles,
  effectiveAgentModel,
  normalizedAgentRole,
  resolvePaletteAgent,
  resolvePaletteAgentForRole,
} from '@/lib/agentBinding';

export function PropertiesPanel({ workflowId = null }: { workflowId?: number | null } = {}): React.ReactNode {
  const selectedId = useBuilderStore((s) => s.selectedNodeId);
  const node = useBuilderStore((s) => s.nodes.find((n) => n.id === selectedId));
  const updateNodeData = useBuilderStore((s) => s.updateNodeData);
  const removeNode = useBuilderStore((s) => s.removeNode);
  const selectNode = useBuilderStore((s) => s.selectNode);

  if (!node) return null;
  const def = getNodeDefinition(node.type ?? '');
  if (!def) return null;

  const data = (node.data ?? {}) as Record<string, unknown>;
  const category = def.category === 'argus' ? 'ARGUS' : def.category === 'logic' ? 'LOGIK' : 'AUSLÖSER';
  const configurableFields = node.type === 'argus.agent'
    ? def.fields.filter((field) => field.name !== 'agent_id')
    : def.fields;

  return (
    <>
      <button
        type="button"
        className="builder-properties-backdrop"
        aria-label="Block-Eigenschaften schließen"
        onClick={() => selectNode(null)}
      />
      <aside
        aria-label="Block-Eigenschaften"
        className="builder-properties-panel w-80 shrink-0 border-l border-border flex flex-col animate-slide-in-right"
      >
        <header className="builder-properties-header">
          <div className="builder-properties-icon" data-category={def.category}><Settings2 className="w-4 h-4" /></div>
          <div className="min-w-0">
            <span>{category} · {node.type}</span>
            <h3>{(data['label'] as string) || def.label}</h3>
            <p>{def.description}</p>
          </div>
          <button
            onClick={() => selectNode(null)}
            className="builder-panel-close"
            aria-label="Block-Eigenschaften schließen"
            title="Schließen"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

      <div className="builder-properties-content flex-1 overflow-y-auto">
        <InspectorSection
          icon={<Tag className="w-3.5 h-3.5" />}
          eyebrow="BLOCK"
          title="Allgemein"
          description="Name und Darstellung auf dem Canvas."
        >
          <Field
            schema={{ name: 'label', label: 'Anzeigename', type: 'text', placeholder: def.label }}
            value={(data['label'] as string) ?? def.label}
            onChange={(v) => updateNodeData(node.id, { label: v })}
            nodeType={node.type ?? ''}
            nodeLabel={(data['label'] as string) ?? def.label}
          />
        </InspectorSection>

        {(configurableFields.length > 0 || node.type === 'argus.agent') && (
          <InspectorSection
            icon={<Settings2 className="w-3.5 h-3.5" />}
            eyebrow="VERHALTEN"
            title="Konfiguration"
            description="Eingaben und Laufzeitverhalten dieses Blocks."
          >
            {node.type === 'argus.agent' && <AgentAssignmentField nodeId={node.id} />}
            {configurableFields.map((field) => {
              const args = data['args'] !== null && typeof data['args'] === 'object'
                ? data['args'] as Record<string, unknown>
                : {};
              const value = data[field.name] ?? args[field.name];
              const storedInArgs = !(field.name in data) && field.name in args;
              return (
                <Field
                  key={field.name}
                  schema={field}
                  value={value}
                  onChange={(v) => {
                    if (node.type === 'argus.tool' && field.name === 'tool') {
                      const selection = isPortableToolSelection(v)
                        ? v
                        : { tool: typeof v === 'string' ? v : null, integration_id: null, tool_binding: null };
                      updateNodeData(node.id, { ...selection, args: {} });
                      return;
                    }
                    updateNodeData(node.id, storedInArgs
                      ? { args: { ...args, [field.name]: v } }
                      : { [field.name]: v });
                  }}
                  nodeType={node.type ?? ''}
                  nodeLabel={(data['label'] as string) ?? def.label}
                />
              );
            })}
          </InspectorSection>
        )}

        {node.type === 'argus.tool' && (
          <InspectorSection
            icon={<Wrench className="w-3.5 h-3.5" />}
            eyebrow="AUSFÜHRUNG"
            title="Tool-Zugriff"
            description="Parameter und Credential-Kontext für diesen Aufruf."
          >
            <ToolArgsSection
              toolName={data['tool'] as string | undefined}
              args={(data['args'] as Record<string, unknown>) ?? {}}
              credRef={data['cred_ref'] as { bundle_id: number } | undefined}
              onArgsChange={(next) => updateNodeData(node.id, { args: next })}
              onCredChange={(cr) => updateNodeData(node.id, { cred_ref: cr })}
            />
          </InspectorSection>
        )}

        {node.type === 'trigger.webhook' && (
          <WebhookLocalTestSection workflowId={workflowId} nodeId={node.id} data={data} />
        )}
      </div>

      <footer className="builder-properties-footer">
        <span>GEFAHRENBEREICH</span>
        <Button
          variant="destructive"
          size="sm"
          className="w-full"
          onClick={() => removeNode(node.id)}
        >
          <Trash2 className="w-3.5 h-3.5" />
          Block löschen
        </Button>
      </footer>
      </aside>
    </>
  );
}

function InspectorSection({
  icon,
  eyebrow,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="builder-inspector-section">
      <header>
        <div className="builder-inspector-section-icon">{icon}</div>
        <div>
          <span>{eyebrow}</span>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </header>
      <div className="builder-inspector-fields">{children}</div>
    </section>
  );
}

interface FieldProps {
  schema: FieldSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  nodeType?: string;
  nodeLabel?: string;
}

function Field({ schema, value, onChange, nodeType, nodeLabel }: FieldProps) {
  const wandEligible = schema.type === 'text' || schema.type === 'textarea';
  return (
    <div className="builder-field">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">{schema.label}</label>
        {wandEligible && nodeType && (
          <WandButton
            fieldName={schema.name}
            currentValue={typeof value === 'string' ? value : ''}
            nodeType={nodeType}
            nodeLabel={nodeLabel ?? ''}
            onAccept={(v) => onChange(v)}
          />
        )}
      </div>
      <FieldInput schema={schema} value={value} onChange={onChange} />
    </div>
  );
}

function FieldInput({ schema, value, onChange }: FieldProps) {
  const baseInputClasses =
    'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';

  switch (schema.type) {
    case 'text':
      return (
        <VarAutocomplete
          type="input"
          value={(value as string) ?? ''}
          placeholder={schema.placeholder ?? ''}
          onChange={(v) => onChange(v)}
        />
      );

    case 'textarea':
      // JavaScript/condition fields → Monaco; ordinary text → autocomplete textarea
      if (schema.name === 'function_code') {
        return <MonacoField value={(value as string) ?? ''} onChange={onChange} language="javascript" height={(schema.rows ?? 8) * 20} />;
      }
      if (schema.name === 'condition') {
        return <MonacoField value={(value as string) ?? ''} onChange={onChange} language="javascript" height={(schema.rows ?? 3) * 20} />;
      }
      return (
        <VarAutocomplete
          type="textarea"
          value={(value as string) ?? ''}
          placeholder={schema.placeholder ?? ''}
          rows={schema.rows ?? 4}
          onChange={(v) => onChange(v)}
        />
      );

    case 'number':
      return (
        <input
          type="number"
          value={(value as number) ?? schema.default ?? 0}
          min={schema.min}
          max={schema.max}
          onChange={(e) => onChange(Number(e.target.value))}
          className={baseInputClasses}
        />
      );

    case 'boolean':
      return (
        <input
          type="checkbox"
          checked={Boolean(value ?? schema.default)}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 accent-primary"
        />
      );

    case 'select-static':
      return (
        <select
          value={(value as string) ?? schema.default ?? ''}
          onChange={(e) => onChange(e.target.value)}
          className={baseInputClasses}
        >
          {schema.options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      );

    case 'select-agents':     return <AgentSelect     value={value as number | undefined} onChange={onChange} />;
    case 'select-agent-rags': return <RagMultiSelectField />;
    case 'select-rags':       return <RagSelect       value={value as string | undefined} onChange={onChange} />;
    case 'select-tools':      return <ToolSelect      value={value as string | undefined} onChange={onChange} />;
    case 'select-skills':     return <SkillSelect     value={value as number | undefined} onChange={onChange} />;
    case 'select-workflows':  return <WorkflowSelect  value={value as number | undefined} onChange={onChange} />;

    default:
      // Exhaustiveness fallback. FieldSchema also declares 'select-k8s-namespace'
      // and 'select-k8s-pod' (and may gain more types) for which there is no
      // dedicated input component yet. Without this branch the switch returned
      // undefined → the field rendered NOTHING and its value was silently
      // un-editable. Fall back to a free-text field so every declared field type
      // stays editable (the user can type the namespace/pod name directly).
      return (
        <VarAutocomplete
          type="input"
          value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
          placeholder=""
          onChange={(v) => onChange(v)}
        />
      );
  }
}

// Thin adapter: RagMultiSelect reads the selected node + its own args from the
// store directly (it writes through step.args.rag_index_ids, not the flat
// node-data key the generic Field onChange targets), so it only needs the id.
function RagMultiSelectField() {
  const selectedId = useBuilderStore((s) => s.selectedNodeId);
  if (!selectedId) return null;
  return <RagMultiSelect nodeId={selectedId} />;
}

interface WorkflowRow { id: number; name: string; description: string; enabled: boolean; source?: string }
function WorkflowSelect({ value, onChange }: { value: number | undefined; onChange: (v: unknown) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-workflows'],
    queryFn: () => api.get<WorkflowRow[]>('/api/admin/workflows'),
    staleTime: 60_000,
  });
  const cls = 'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';
  return (
    <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{isLoading ? 'lädt…' : '— wählen —'}</option>
      {(data ?? []).filter((w) => w.enabled && w.source !== 'template').map((w) => (
        <option key={w.id} value={w.id}>#{w.id} · {w.name}</option>
      ))}
    </select>
  );
}

function AgentSelect({ value, onChange }: { value: number | undefined; onChange: (v: unknown) => void }) {
  const { data, isLoading } = usePalette();
  const cls = 'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';
  return (
    <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{isLoading ? 'lädt…' : '— wählen —'}</option>
      {(data?.agents ?? []).map((a) => (
        <option key={a.id} value={a.id}>{a.label} ({a.agent_mode})</option>
      ))}
    </select>
  );
}

function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object' && !Array.isArray(error.body)) {
    const message = (error.body as Record<string, unknown>)['error'];
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function WebhookLocalTestSection({
  workflowId,
  nodeId,
  data,
}: {
  workflowId: number | null;
  nodeId: string;
  data: Record<string, unknown>;
}) {
  const updateNodeData = useBuilderStore((state) => state.updateNodeData);
  const selectNode = useBuilderStore((state) => state.selectNode);
  const dirty = useBuilderStore((state) => state.dirty);
  const nodes = useBuilderStore((state) => state.nodes);
  const edges = useBuilderStore((state) => state.edges);
  const viewport = useBuilderStore((state) => state.viewport);
  const markClean = useBuilderStore((state) => state.markClean);
  const flow = useFlow(workflowId);
  const saveFlow = useSaveFlow();
  const testWebhook = useTestWebhookWorkflow();
  const provider = typeof data['webhook_provider'] === 'string' ? data['webhook_provider'] : 'auto';
  const allowedEvents = typeof data['webhook_allowed_events'] === 'string'
    ? data['webhook_allowed_events'].split(',').map(value => value.trim()).filter(Boolean)
    : [];
  const fixtureText = typeof data['webhook_test_payload'] === 'string' ? data['webhook_test_payload'] : '';
  const [fixtureError, setFixtureError] = useState<string | null>(null);

  const startLocalTest = async () => {
    let payload: Record<string, unknown> | undefined;
    if (fixtureText.trim()) {
      try {
        const parsed = JSON.parse(fixtureText) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setFixtureError('Der Test-Payload muss ein JSON-Objekt sein.');
          return;
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        setFixtureError('Der lokale Test-Payload enthält kein gültiges JSON.');
        return;
      }
    }
    setFixtureError(null);
    if (!workflowId) return;
    try {
      if (dirty) {
        const serverFlow = flow.data ?? (await flow.refetch()).data;
        if (!serverFlow) {
          setFixtureError('Der Workflow wird noch geladen. Bitte versuche es gleich erneut.');
          return;
        }
        await saveFlow.mutateAsync({
          id: workflowId,
          payload: buildSavePayload(nodes, edges, viewport, serverFlow.agent_requirements ?? []),
        });
        markClean();
      }
      await testWebhook.mutateAsync({
        workflowId,
        provider,
        event: allowedEvents[0],
        payload,
      });
      selectNode(null);
    } catch {
      // Mutation errors are rendered below with their server-provided message.
    }
  };

  const operationPending = saveFlow.isPending || testWebhook.isPending;

  return (
    <InspectorSection
      icon={<FlaskConical className="w-3.5 h-3.5" />}
      eyebrow="LOCAL TEST"
      title="Webhook simulieren"
      description="Erzeugt eine lokale Provider-Delivery und öffnet den Run im Execution Log."
    >
      <div className="builder-webhook-test">
        <label htmlFor={`${nodeId}-webhook-test-payload`}>Provider-Payload (optional)</label>
        <textarea
          id={`${nodeId}-webhook-test-payload`}
          rows={7}
          value={fixtureText}
          onChange={event => {
            setFixtureError(null);
            updateNodeData(nodeId, { webhook_test_payload: event.target.value });
          }}
          placeholder={provider === 'github' || provider === 'auto'
            ? '{\n  "action": "opened",\n  "issue": { "number": 1 },\n  "repository": { "name": "repo", "owner": { "login": "owner" } }\n}'
            : '{ "message": "local test" }'}
        />
        <p>Leer lassen, um eine sichere {provider === 'auto' ? 'GitHub' : provider}-Beispieldelivery zu verwenden.</p>
        <p className="is-warning">Kein Mock: Nach dem lokalen Trigger laufen konfigurierte Agents und MCP-Tools regulär.</p>
        {dirty && <p className="is-warning">Ungespeicherte Änderungen werden vor dem Test automatisch gespeichert.</p>}
        {fixtureError && <p className="is-error">{fixtureError}</p>}
        {saveFlow.isError && <p className="is-error">Speichern fehlgeschlagen: {apiErrorMessage(saveFlow.error)}</p>}
        {testWebhook.isError && <p className="is-error">{apiErrorMessage(testWebhook.error)}</p>}
        <Button
          type="button"
          size="sm"
          disabled={!workflowId || operationPending}
          onClick={() => { void startLocalTest(); }}
          className="w-full"
        >
          {operationPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FlaskConical className="w-3.5 h-3.5" />}
          {dirty ? 'Speichern & lokalen Test starten' : 'Lokalen Testlauf starten'}
        </Button>
      </div>
    </InspectorSection>
  );
}

export function AgentAssignmentField({ nodeId }: { nodeId: string }) {
  const node = useBuilderStore((state) => state.nodes.find((candidate) => candidate.id === nodeId));
  const updateNodeData = useBuilderStore((state) => state.updateNodeData);
  const { data: palette, isLoading } = usePalette();
  const agents = palette?.agents ?? [];
  const data = (node?.data ?? {}) as { agent_id?: number | null; agent_role?: string | null };
  const mode = agentBindingMode(data);
  const role = normalizedAgentRole(data.agent_role);
  const resolved = resolvePaletteAgent(agents, data);
  const roles = availableAgentRoles(agents);
  const unresolved = mode === 'role' ? Boolean(role) && !resolved : data.agent_id != null && !resolved;
  const missing = mode === 'role' ? !role : data.agent_id == null;
  const runtimeDisabled = resolved?.runtime_enabled === false;
  const status = missing
    ? { label: 'Zuweisung fehlt', tone: 'is-blocked' }
    : unresolved
      ? { label: 'Nicht auflösbar', tone: 'is-blocked' }
      : runtimeDisabled
        ? { label: 'Runtime deaktiviert', tone: 'is-blocked' }
        : { label: 'Auflösungskandidat', tone: 'is-ready' };
  const StatusIcon = status.tone === 'is-ready' ? CheckCircle2 : AlertTriangle;
  const inputClass = 'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';

  const changeMode = (nextMode: 'role' | 'agent') => {
    if (nextMode === mode) return;
    if (nextMode === 'role') {
      const inferredRole = normalizedAgentRole(resolved?.agent_role) ?? resolved?.name ?? null;
      updateNodeData(nodeId, { agent_id: null, agent_role: inferredRole });
      return;
    }
    const candidate = role ? resolvePaletteAgentForRole(agents, role) : resolved;
    updateNodeData(nodeId, { agent_role: null, agent_id: candidate?.id ?? null });
  };

  return (
    <div className="builder-agent-assignment">
      <div className="builder-field">
        <span>Zuweisung</span>
        <div className="builder-agent-mode" role="group" aria-label="Agent-Zuweisungsmodus">
          <button type="button" aria-pressed={mode === 'role'} onClick={() => changeMode('role')}>Rolle</button>
          <button type="button" aria-pressed={mode === 'agent'} onClick={() => changeMode('agent')}>Konkreter Agent</button>
        </div>
      </div>

      {mode === 'role' ? (
        <div className="builder-field">
          <label htmlFor={`${nodeId}-agent-role`}>Agent-Rolle</label>
          <select
            id={`${nodeId}-agent-role`}
            className={inputClass}
            value={role ?? ''}
            onChange={(event) => updateNodeData(nodeId, { agent_role: event.target.value || null, agent_id: null })}
          >
            <option value="">{isLoading ? 'lädt…' : roles.length ? '— Rolle wählen —' : '— keine Rollen verfügbar —'}</option>
            {roles.map((candidateRole) => <option key={candidateRole} value={candidateRole}>{candidateRole}</option>)}
          </select>
          <p className="builder-agent-assignment-help">Portabel: Argus Core löst die Rolle beim Start zum bereiten Agent auf.</p>
        </div>
      ) : (
        <div className="builder-field">
          <label htmlFor={`${nodeId}-agent-id`}>Konkreter Agent</label>
          <select
            id={`${nodeId}-agent-id`}
            className={inputClass}
            value={data.agent_id ?? ''}
            onChange={(event) => updateNodeData(nodeId, {
              agent_id: event.target.value ? Number(event.target.value) : null,
              agent_role: null,
            })}
          >
            <option value="">{isLoading ? 'lädt…' : '— Agent wählen —'}</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.label} ({agent.agent_mode})</option>)}
          </select>
          <p className="builder-agent-assignment-help">Gepinnt: Dieser Workflow bleibt an genau diese Core-Agent-ID gebunden.</p>
        </div>
      )}

      <div className={`builder-agent-resolution ${status.tone}`}>
        <StatusIcon className="w-4 h-4" />
        <div>
          <small>{status.label}</small>
          <strong>{resolved?.label ?? (role ? `Role: ${role}` : 'Kein Agent ausgewählt')}</strong>
          {resolved && (
            <span>{effectiveAgentModel(resolved)} · {resolved.runtime_profile_label ?? resolved.runtime_type ?? 'Argus Runtime'}</span>
          )}
          {!resolved && !missing && <span>Kein aktivierter Core-Agent entspricht dieser Zuweisung.</span>}
        </div>
      </div>
      <p className="builder-agent-assignment-help">Der Agent-Contract-Preflight prüft Runtime, MCP-Bundles, Skills und Tools vor der Ausführung.</p>
    </div>
  );
}

function RagSelect({ value, onChange }: { value: string | undefined; onChange: (v: unknown) => void }) {
  const { data, isLoading } = usePalette();
  const sources = data?.rag_indexes ?? [];
  const cls = 'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';
  return (
    <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{isLoading ? 'lädt…' : sources.length === 0 ? '— keine Quelle verfügbar —' : '— wählen —'}</option>
      {sources.map((source) => (
        <option key={source.id} value={source.name}>{source.label} ({source.provider})</option>
      ))}
    </select>
  );
}

function isPortableToolSelection(value: unknown): value is PortableToolSelection {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'tool' in value);
}

function ToolSelect({ value, onChange }: { value: string | undefined; onChange: (v: unknown) => void }) {
  const { data, isLoading } = usePalette();
  const cls = 'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';
  const groups = new Map<string, NonNullable<typeof data>['tools']>();
  for (const tool of data?.tools ?? []) {
    const label = tool.integration_label ?? tool.connection_name ?? tool.backend ?? 'Other';
    const entries = groups.get(label) ?? [];
    entries.push(tool);
    groups.set(label, entries);
  }
  return (
    <select
      className={cls}
      value={value ?? ''}
      onChange={(e) => {
        const selected = data?.tools.find(tool => tool.name === e.target.value);
        onChange(selected
          ? portableToolSelection(selected)
          : { tool: null, integration_id: null, tool_binding: null });
      }}
    >
      <option value="">{isLoading ? 'lädt…' : '— wählen —'}</option>
      {[...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([label, tools]) => (
        <optgroup key={label} label={label}>
          {tools.sort((left, right) => (left.action_label ?? left.name).localeCompare(right.action_label ?? right.name)).map((tool) => (
            <option key={tool.id} value={tool.name}>
              {tool.action_label ?? tool.name} — {tool.connection_name ?? tool.backend}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function SkillSelect({ value, onChange }: { value: number | undefined; onChange: (v: unknown) => void }) {
  const { data, isLoading } = usePalette();
  const cls = 'w-full px-2.5 py-1.5 rounded-md bg-input border border-border text-small focus:outline-none focus:ring-1 focus:ring-ring';
  return (
    <select className={cls} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{isLoading ? 'lädt…' : '— wählen —'}</option>
      {(data?.skills ?? []).map((s) => (
        <option key={s.id} value={s.id}>{s.label}</option>
      ))}
    </select>
  );
}

function ToolArgsSection({
  toolName,
  args,
  credRef,
  onArgsChange,
  onCredChange,
}: {
  toolName: string | undefined;
  args: Record<string, unknown>;
  credRef: { bundle_id: number } | undefined;
  onArgsChange: (next: Record<string, unknown>) => void;
  onCredChange: (cr: { bundle_id: number } | undefined) => void;
}) {
  const { data: palette } = usePalette();
  const tool = palette?.tools.find((t) => t.name === toolName);

  if (!toolName) {
    return <p className="text-[11px] text-muted-foreground">Erst ein Tool wählen, dann erscheinen die Parameter.</p>;
  }

  if (palette && !tool) {
    return (
      <div className="builder-tool-missing" role="alert">
        <AlertTriangle className="w-4 h-4" />
        <div><strong>Tool nicht verfügbar</strong><span>{toolName} ist nicht mehr im berechtigten MCP-Katalog.</span></div>
      </div>
    );
  }

  const parameters = tool?.parameters ?? [];
  const freeform = tool?.freeform ?? parameters.length === 0;

  return (
    <div className="builder-tool-access">
      {tool && (
        <div className="builder-tool-binding">
          <BrandMark
            brand={tool.integration_brand}
            label={tool.integration_label ?? tool.connection_name ?? tool.backend}
            fallbackIcon="Plug"
          />
          <div>
            <strong>{tool.action_label ?? tool.name}</strong>
            <span>{tool.integration_label ?? 'Connected tool'} · {tool.connection_name ?? tool.backend}</span>
          </div>
          <em data-risk={tool.risk_level ?? 'low'}>{tool.is_write ? `${tool.risk_level ?? 'medium'} write` : 'read'}</em>
        </div>
      )}
      <div className="builder-field">
        <span className="text-xs font-medium text-muted-foreground">Parameter</span>
        <ToolConfigForm
          parameters={parameters}
          args={args}
          onChange={onArgsChange}
          freeform={freeform}
        />
      </div>
      <div className="builder-field">
        <label className="text-xs font-medium text-muted-foreground">MCP Fabric identity</label>
        <CredRefSelect value={credRef} onChange={onCredChange} />
      </div>
      <div className="builder-fabric-identity">
        <LockKeyhole className="w-4 h-4" />
        <div>
          <strong>Authentication stays in MCP Fabric</strong>
          <span>Endpoints, OAuth sessions and API tokens are encrypted connection settings. This workflow stores only the tool and an optional bundle reference.</span>
        </div>
        <a href="/mcp-fabric" target="_top">
          Manage <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}
