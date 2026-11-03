// Argus-native nodes — bind to mcp_agents, mcp_tools, mcp_skills,
// mcp_agent_memory, mcp_rag_indexes. Display the current selection's name
// (resolved against the palette) directly in the node card.

import { type NodeProps } from 'reactflow';
import { BaseNode } from './BaseNode';
import { registerNode } from './registry';
import { usePalette } from '@/api/palette';
import { useWorkflowAgentPreflight, type WorkflowAgentPreflight } from '@/api/workflows';
import { effectiveAgentModel, formatAgentTarget, resolvePaletteAgent } from '@/lib/agentBinding';
import { useBuilderStore } from '@/stores/builderStore';
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Wrench } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { describeToolNode } from './toolNodePresentation';

export interface AgentNodePreflightPresentation {
  tone: 'ready' | 'degraded' | 'blocked' | 'stale' | 'checking';
  label: string;
  detail: string;
}

export function describeAgentNodePreflight(
  preflight: WorkflowAgentPreflight | null | undefined,
  nodeId: string,
  options: { dirty?: boolean; loading?: boolean; error?: boolean } = {},
): AgentNodePreflightPresentation {
  if (options.dirty) return { tone: 'stale', label: 'Nicht geprüft', detail: 'Ungespeicherte Änderung' };
  if (options.loading) return { tone: 'checking', label: 'Prüft', detail: 'Runtime und Capabilities' };
  if (options.error) return { tone: 'blocked', label: 'Prüffehler', detail: 'Preflight nicht erreichbar' };
  if (!preflight) return { tone: 'stale', label: 'Nicht geprüft', detail: 'Preflight ausstehend' };
  const assignment = preflight.assignments.find((candidate) => candidate.stepIds.includes(nodeId));
  if (!assignment) {
    return {
      tone: 'blocked',
      label: 'Nicht aufgelöst',
      detail: preflight.blockers[0] ?? 'Keine Agent-Zuweisung im gespeicherten Contract',
    };
  }
  if (assignment.status === 'blocked') {
    return {
      tone: 'blocked',
      label: 'Blockiert',
      detail: assignment.blockers[0] ?? 'Agent ist nicht startbereit',
    };
  }
  if (assignment.status === 'degraded') {
    return {
      tone: 'degraded',
      label: 'Eingeschränkt',
      detail: assignment.warnings[0] ?? assignment.agentLabel ?? assignment.agentName ?? assignment.role,
    };
  }
  return {
    tone: 'ready',
    label: 'Verifiziert',
    detail: assignment.agentLabel ?? assignment.agentName ?? assignment.role,
  };
}

function AgentNode(props: NodeProps) {
  const { data: palette } = usePalette();
  const { id } = useParams<{ id?: string }>();
  const workflowId = id && Number.isSafeInteger(Number(id)) && Number(id) > 0 ? Number(id) : null;
  const dirty = useBuilderStore((state) => state.dirty);
  const preflight = useWorkflowAgentPreflight(workflowId, workflowId != null && !dirty);
  const nodeData = props.data as { agent_id?: number; agent_role?: string; output_contract?: string };
  const agent = resolvePaletteAgent(palette?.agents ?? [], nodeData);
  const readiness = workflowId == null
    ? null
    : describeAgentNodePreflight(preflight.data, props.id, {
        dirty,
        loading: preflight.isLoading,
        error: preflight.isError,
      });
  const ReadinessIcon = readiness?.tone === 'ready'
    ? CheckCircle2
    : readiness?.tone === 'checking'
      ? Loader2
      : AlertTriangle;
  return (
    <BaseNode icon="Bot" label="Agent" category="argus" selected={props.selected} nodeId={props.id}>
      <div className="font-medium text-foreground truncate">
        {formatAgentTarget(agent, nodeData)}
      </div>
      {agent && (
        <div className="text-xs">
          <span className="text-muted-foreground">model:</span> {effectiveAgentModel(agent)}
        </div>
      )}
      {readiness && (
        <div className={`builder-agent-node-preflight is-${readiness.tone}`} title={readiness.detail}>
          <ReadinessIcon className={`w-3 h-3 ${readiness.tone === 'checking' ? 'animate-spin' : ''}`} />
          <span>{readiness.label}</span>
          <small>{readiness.detail}</small>
        </div>
      )}
      {typeof nodeData.output_contract === 'string' && nodeData.output_contract && (
        <div className="text-xs text-muted-foreground truncate">
          Ausgabe: {nodeData.output_contract.replaceAll('_', ' ')}
        </div>
      )}
    </BaseNode>
  );
}
registerNode(
  {
    type: 'argus.agent',
    label: 'Agent',
    category: 'argus',
    icon: 'Bot',
    description: 'Ruft einen Argus-Agent (architect, coder, researcher …) auf.',
    defaultData: () => ({
      label: 'Agent',
      agent_id: null,
      agent_role: null,
      output_contract: '',
      output_contract_retries: 1,
      args: { prompt: '', rag_index_ids: [] },
    }),
    fields: [
      { name: 'agent_id', label: 'Agent', type: 'select-agents' },
      { name: 'prompt', label: 'Prompt', type: 'textarea', rows: 4, placeholder: 'Was soll der Agent tun?' },
      { name: 'rag_index_ids', label: 'RAG-Indizes', type: 'select-agent-rags' },
      {
        name: 'output_contract',
        label: 'Strukturierte Ausgabe',
        type: 'select-static',
        options: [
          { value: '', label: 'Keine strukturierte Ausgabe' },
          { value: 'planner_plan', label: 'Implementierungsplan' },
          { value: 'implementation_evidence', label: 'Implementierungsnachweis' },
          { value: 'review_verdict', label: 'Review-Entscheidung' },
        ],
        default: '',
      },
      { name: 'output_contract_retries', label: 'Format-Retries', type: 'number', min: 0, max: 2, default: 1 },
    ],
  },
  AgentNode
);

function ApprovalNode(props: NodeProps) {
  const message = (props.data as { message?: string; args?: { message?: string } }).message
    ?? (props.data as { args?: { message?: string } }).args?.message;
  return (
    <BaseNode icon="ShieldCheck" label="Human Approval" category="argus" selected={props.selected} nodeId={props.id}>
      <div className="font-medium text-foreground truncate flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5" /> Governed gate
      </div>
      <div className="text-xs text-muted-foreground truncate">{message || 'Human decision required'}</div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'argus.approval',
    label: 'Human Approval',
    category: 'argus',
    icon: 'ShieldCheck',
    description: 'Pausiert den Argus.Dev-Run und verlangt eine begründete menschliche Entscheidung.',
    defaultData: () => ({ label: 'Human Approval', message: 'Review the evidence and approve this workflow?', args: {} }),
    fields: [
      { name: 'message', label: 'Approval message', type: 'textarea', rows: 3, placeholder: 'What must the reviewer decide?' },
    ],
  },
  ApprovalNode,
);

function ToolNode(props: NodeProps) {
  const paletteQuery = usePalette();
  const presentation = describeToolNode(
    props.data as { tool?: string | null; integration_id?: string | null },
    paletteQuery.data,
    { loading: paletteQuery.isLoading, error: paletteQuery.isError },
  );
  const StateIcon = presentation.state === 'checking' ? Loader2
    : presentation.state === 'unconfigured' ? Wrench
      : AlertTriangle;
  return (
    <BaseNode
      icon="Wrench"
      brand={presentation.brand}
      brandLabel={presentation.providerLabel ?? undefined}
      label="Tool"
      category="argus"
      selected={props.selected}
      nodeId={props.id}
      configurationState={presentation.state === 'ready' ? 'ready'
        : presentation.state === 'checking' ? 'checking'
          : presentation.state === 'unconfigured' ? 'unconfigured'
            : 'blocked'}
    >
      {presentation.state === 'ready' ? (
        <>
          <div className="font-medium text-foreground truncate" title={presentation.actionLabel}>
            {presentation.actionLabel}
          </div>
          <div className="builder-tool-node-meta">
            <span title={[presentation.providerLabel, presentation.connectionLabel].filter(Boolean).join(' · ')}>
              {presentation.providerLabel ?? 'Connected tool'} · {presentation.connectionLabel}
            </span>
            <em data-risk={presentation.riskLevel}>
              {presentation.isWrite ? `${presentation.riskLevel} write` : 'read'}
            </em>
          </div>
        </>
      ) : (
        <div className={`builder-tool-node-state is-${presentation.state}`} role={presentation.state === 'missing' || presentation.state === 'error' ? 'alert' : undefined}>
          <StateIcon className={presentation.state === 'checking' ? 'animate-spin' : ''} />
          <div>
            <strong>{presentation.state === 'checking' ? 'Fabric wird geprüft'
              : presentation.state === 'unconfigured' ? 'Tool auswählen'
                : presentation.state === 'error' ? 'Fabric nicht erreichbar'
                  : 'Verbindung oder Berechtigung fehlt'}</strong>
            <span title={presentation.detail}>{presentation.detail}</span>
          </div>
        </div>
      )}
    </BaseNode>
  );
}
registerNode(
  {
    type: 'argus.tool',
    label: 'Tool',
    category: 'argus',
    icon: 'Wrench',
    description: 'Ruft ein MCP-Tool (K8s, Grafana, Jira, …) auf.',
    defaultData: () => ({ label: 'Tool', tool: null, args: {} }),
    fields: [
      { name: 'tool', label: 'Tool', type: 'select-tools' },
    ],
  },
  ToolNode
);

function SkillNode(props: NodeProps) {
  const { data: palette } = usePalette();
  const skillId = (props.data as { skill_id?: number })?.skill_id;
  const skill = palette?.skills.find((s) => s.id === skillId);
  return (
    <BaseNode icon="Sparkles" label="Skill" category="argus" selected={props.selected} nodeId={props.id}>
      <div className="font-medium text-foreground truncate">
        {skill ? skill.label : '(no skill)'}
      </div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'argus.skill',
    label: 'Skill',
    category: 'argus',
    icon: 'Sparkles',
    description: 'Wendet eine Argus-Skill an (z.B. architecture-diagram, NIS2-audit).',
    defaultData: () => ({ label: 'Skill', skill_id: null, args: {} }),
    fields: [
      { name: 'skill_id', label: 'Skill', type: 'select-skills' },
    ],
  },
  SkillNode
);

function MemoryNode(props: NodeProps) {
  const op = (props.data as { operation?: string })?.operation ?? 'retrieve';
  return (
    <BaseNode icon="Brain" label="Memory" category="argus" selected={props.selected} nodeId={props.id}>
      <div>Operation: <code className="text-foreground">{op}</code></div>
    </BaseNode>
  );
}
registerNode(
  {
    type: 'argus.memory',
    label: 'Memory',
    category: 'argus',
    icon: 'Brain',
    description: 'Liest oder schreibt in Argus\' pgvector Agent-Memory.',
    defaultData: () => ({ label: 'Memory', operation: 'retrieve', args: { query: '' } }),
    fields: [
      {
        name: 'operation',
        label: 'Operation',
        type: 'select-static',
        options: [
          { value: 'retrieve', label: 'Retrieve' },
          { value: 'store', label: 'Store' },
          { value: 'consolidate', label: 'Consolidate' },
        ],
        default: 'retrieve',
      },
      { name: 'query', label: 'Query / Content', type: 'textarea', rows: 3 },
    ],
  },
  MemoryNode
);

function KnowledgeNode(props: NodeProps) {
  const { data: palette } = usePalette();
  const nodeData = props.data as { index_name?: string; args?: { index_name?: string } };
  const idx = nodeData.index_name ?? nodeData.args?.index_name;
  const source = palette?.rag_indexes?.find((candidate) => candidate.name === idx);
  return (
    <BaseNode icon="BookOpen" label="Knowledge" category="argus" selected={props.selected} nodeId={props.id}>
      <div className="font-medium text-foreground truncate">
        {source?.label ?? idx ?? '(keine Quelle)'}
      </div>
      {source && <div className="text-xs text-muted-foreground">{source.provider}</div>}
    </BaseNode>
  );
}
registerNode(
  {
    type: 'argus.knowledge',
    label: 'Knowledge',
    category: 'argus',
    icon: 'BookOpen',
    description: 'RAG-Query gegen einen Argus Knowledge-Index.',
    defaultData: () => ({ label: 'Knowledge', index_name: null, args: { query: '', top_k: 5 } }),
    fields: [
      { name: 'index_name', label: 'Knowledge Source', type: 'select-rags' },
      { name: 'query', label: 'Query', type: 'text', placeholder: 'frage…' },
      { name: 'top_k', label: 'Top K', type: 'number', min: 1, max: 20, default: 5 },
    ],
  },
  KnowledgeNode
);
