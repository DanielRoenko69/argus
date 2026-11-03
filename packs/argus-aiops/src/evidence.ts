import type { AgentToolCall, CoreAgentResponse } from './coreClient.js';
import type { InvestigationPlan } from './domain.js';
import { z } from 'zod';

export type InvestigationAgentRole = 'researcher' | 'knowledge' | 'reviewer';

export interface AgentEvidence {
  role: InvestigationAgentRole;
  status: 'completed' | 'failed';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  agentId: number | null;
  model: string | null;
  sessionId: string | null;
  outputSummary: string;
  error: string | null;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  ragCitations?: Array<{ source: string; index: string; score: number }>;
}

export interface InvestigationEvidence {
  kind: 'aiops-investigation-evidence';
  schemaVersion: 2;
  implementationStage: 'agent-evidence';
  generatedAt: string;
  incident: InvestigationPlan['incident'];
  scope: InvestigationPlan['scope'];
  quality: 'reviewed' | 'partial' | 'failed';
  agentEvidence: AgentEvidence[];
  signalCoverage: SignalCoverage[];
  timeline: EvidenceTimelineEvent[];
  kubernetesEvidence?: KubernetesEvidence;
  synthesis: string;
  diagnosis: ReviewerDiagnosis;
  safety: {
    mode: 'read-only';
    writesAllowed: false;
    rawTelemetryPersisted: false;
    redactionApplied: true;
  };
}

const reviewerDiagnosisSchema = z.object({
  conclusion: z.enum(['confirmed', 'suspected', 'inconclusive', 'refuted']),
  executiveAssessment: z.string().trim().min(1).max(2_000),
  rootCause: z.object({
    candidateRef: z.string().trim().max(128).nullable(),
    targetKind: z.string().trim().max(120).nullable(),
    targetName: z.string().trim().max(200).nullable(),
    statement: z.string().trim().min(1).max(800),
    confidence: z.number().min(0).max(100),
    rationale: z.string().trim().min(1).max(1_200),
  }).strict().nullable(),
  hypotheses: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    statement: z.string().trim().min(1).max(800),
    verdict: z.enum(['supported', 'weakened', 'unresolved', 'refuted']),
    confidence: z.number().min(0).max(100),
    evidenceFor: z.array(z.string().trim().min(1).max(300)).max(3),
    evidenceAgainst: z.array(z.string().trim().min(1).max(300)).max(3),
  }).strict()).max(6),
  evidence: z.array(z.object({
    lane: z.enum(['metrics', 'logs', 'traces', 'runtime', 'topology', 'changes', 'knowledge']),
    claim: z.string().trim().min(1).max(800),
    sourceRefs: z.array(z.string().trim().min(1).max(128)).max(4),
  }).strict()).max(10),
  recommendedActions: z.array(z.object({
    priority: z.enum(['now', 'next', 'later']),
    action: z.string().trim().min(1).max(800),
    rationale: z.string().trim().min(1).max(800),
    requiresApproval: z.boolean(),
  }).strict()).max(6),
}).strict();

export type ReviewerDiagnosis = z.infer<typeof reviewerDiagnosisSchema>;

function reviewerJson(value: string): unknown {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

export function fallbackReviewerDiagnosis(plan: InvestigationPlan, assessment: string): ReviewerDiagnosis {
  return {
    conclusion: 'inconclusive',
    executiveAssessment: assessment.replace(/\s+/g, ' ').trim().slice(0, 2_000) || 'The investigation did not produce a valid structured reviewer verdict.',
    rootCause: null,
    hypotheses: plan.hypotheses.slice(0, 6).map(hypothesis => ({
      id: hypothesis.id,
      statement: hypothesis.statement,
      verdict: 'unresolved',
      confidence: 0,
      evidenceFor: [],
      evidenceAgainst: [],
    })),
    evidence: [],
    recommendedActions: [],
  };
}

export function parseReviewerDiagnosis(output: string, plan: InvestigationPlan): { diagnosis: ReviewerDiagnosis; valid: boolean } {
  const parsed = reviewerDiagnosisSchema.safeParse(reviewerJson(output));
  if (!parsed.success) return { diagnosis: fallbackReviewerDiagnosis(plan, output), valid: false };
  const allowedCandidateRefs = new Set(Object.keys(plan.incident.labels ?? {})
    .filter(key => /^argus\.core\.impact\.candidate\.[1-5]$/.test(key)));
  const candidateRef = parsed.data.rootCause?.candidateRef ?? null;
  return {
    diagnosis: parsed.data.rootCause && candidateRef && !allowedCandidateRefs.has(candidateRef)
      ? { ...parsed.data, rootCause: { ...parsed.data.rootCause, candidateRef: null } }
      : parsed.data,
    valid: true,
  };
}

export interface KubernetesEvidence {
  namespace: string;
  resources: Array<{
    kind: 'Service' | 'Deployment' | 'Pod';
    name: string;
    status: string;
    owner?: string;
    labels: Record<string, string>;
    provenance: EvidenceProvenance;
  }>;
  edges: Array<{
    from: string;
    to: string;
    relation: 'selects' | 'owns' | 'depends-on';
  }>;
  events: Array<{
    timestamp: string;
    type: string;
    reason: string;
    object: string;
    message: string;
    provenance: EvidenceProvenance;
  }>;
}

export interface EvidenceProvenance {
  toolName: string;
  toolCallId?: string;
  traceId?: string;
  spanId?: string;
}

export type SignalLane = 'metrics' | 'logs' | 'traces' | 'runtime' | 'topology' | 'changes' | 'knowledge';

export interface SignalCoverage {
  lane: SignalLane;
  status: 'collected' | 'missing' | 'failed';
  queryCount: number;
  sources: string[];
  toolNames: string[];
}

export interface EvidenceTimelineEvent {
  id: string;
  timestamp: string;
  lane: SignalLane;
  source: string;
  title: string;
  summary: string;
  correlationKey: string | null;
}

const SENSITIVE_KEY = /(?:authorization|auth|token|secret|password|api.?key|credential|cookie)/i;

function boundedValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => boundedValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100)
      .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : boundedValue(item, depth + 1)]));
  }
  return String(value ?? '');
}

export function safeToolCalls(toolCalls: AgentToolCall[]): AgentEvidence['toolCalls'] {
  return toolCalls.slice(0, 256).map(call => ({
    name: call.name.slice(0, 256),
    args: boundedValue(call.args) as Record<string, unknown>,
  }));
}

type KubernetesResource = KubernetesEvidence['resources'][number];
type KubernetesEdge = KubernetesEvidence['edges'][number];

interface KubernetesCandidate extends KubernetesResource {
  uid: string;
  selector: Record<string, string>;
  annotations: Record<string, string>;
  ownerReference?: string;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, max = 256): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function stringMap(value: unknown, limit = 16): Record<string, string> {
  const source = object(value);
  if (!source) return {};
  return Object.fromEntries(Object.entries(source)
    .filter(([key, item]) => !SENSITIVE_KEY.test(key) && typeof item === 'string')
    .slice(0, limit)
    .map(([key, item]) => [key.slice(0, 128), String(item).slice(0, 256)]));
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function kubernetesStatus(kind: KubernetesResource['kind'], item: Record<string, unknown>): string {
  const status = object(item['status']) ?? {};
  const spec = object(item['spec']) ?? {};
  if (kind === 'Service') return 'Active';
  if (kind === 'Deployment') {
    const desired = number(status['replicas']) || number(spec['replicas']);
    const ready = number(status['readyReplicas']);
    if (desired === 0) return 'Scaled to zero';
    return ready >= desired ? `Healthy (${ready}/${desired})` : `Degraded (${ready}/${desired})`;
  }
  const containerStatuses = Array.isArray(status['containerStatuses']) ? status['containerStatuses'] : [];
  for (const containerValue of containerStatuses) {
    const container = object(containerValue);
    const state = object(container?.['state']);
    const reason = text(object(state?.['waiting'])?.['reason']) || text(object(state?.['terminated'])?.['reason']);
    if (reason) return reason;
  }
  const ready = (Array.isArray(status['conditions']) ? status['conditions'] : []).some(conditionValue => {
    const condition = object(conditionValue);
    return condition?.['type'] === 'Ready' && condition['status'] === 'True';
  });
  const phase = text(status['phase']) || 'Unknown';
  return phase === 'Running' && ready ? 'Running' : phase;
}

function labelsMatch(labels: Record<string, string>, selector: Record<string, string>): boolean {
  const entries = Object.entries(selector);
  return entries.length > 0 && entries.every(([key, value]) => labels[key] === value);
}

function parseProviderJson(call: AgentToolCall): Record<string, unknown> | null {
  if (!call.result || call.result.length > 256 * 1024) return null;
  try {
    return object(JSON.parse(call.result));
  } catch {
    return null;
  }
}

function provenance(call: AgentToolCall): EvidenceProvenance {
  return {
    toolName: call.name.slice(0, 256),
    ...(call.toolCallId ? { toolCallId: call.toolCallId.slice(0, 256) } : {}),
    ...(call.traceId ? { traceId: call.traceId } : {}),
    ...(call.spanId ? { spanId: call.spanId } : {}),
  };
}

function normalizeCandidate(
  value: unknown,
  namespace: string,
  source: EvidenceProvenance,
): KubernetesCandidate | null {
  const item = object(value);
  const metadata = object(item?.['metadata']);
  const kind = text(item?.['kind']) as KubernetesResource['kind'];
  const name = text(metadata?.['name']);
  if (!item || !metadata || !name || !['Service', 'Deployment', 'Pod'].includes(kind)) return null;
  if (text(metadata['namespace']) !== namespace) return null;
  const spec = object(item['spec']) ?? {};
  const owner = (Array.isArray(metadata['ownerReferences']) ? metadata['ownerReferences'] : [])
    .map(object).find(reference => reference?.['controller'] === true) ?? null;
  const selector = kind === 'Service'
    ? stringMap(spec['selector'])
    : kind === 'Deployment'
      ? stringMap(object(spec['selector'])?.['matchLabels'])
      : {};
  return {
    kind,
    name,
    status: kubernetesStatus(kind, item),
    labels: stringMap(metadata['labels']),
    provenance: source,
    uid: text(metadata['uid']),
    selector,
    annotations: stringMap(metadata['annotations']),
    ownerReference: owner ? `${text(owner['kind'])}/${text(owner['name'])}` : undefined,
  };
}

function resourceKey(resource: Pick<KubernetesResource, 'kind' | 'name'>): string {
  return `${resource.kind}/${resource.name}`;
}

export function buildKubernetesEvidence(
  toolCalls: AgentToolCall[],
  scope: { namespace: string; service: string; windowStart?: string; windowEnd?: string },
): KubernetesEvidence | undefined {
  const namespace = scope.namespace.slice(0, 253);
  const service = scope.service.slice(0, 253);
  if (!namespace || !service) return undefined;

  const candidates: KubernetesCandidate[] = [];
  const eventPayloads: Array<{ event: Record<string, unknown>; provenance: EvidenceProvenance }> = [];
  for (const call of toolCalls.slice(0, 64)) {
    if (!call.name.startsWith('aiops_kubernetes_')) continue;
    if (String(call.args['all_namespaces'] ?? '').toLowerCase() === 'true') continue;
    if (call.args['namespace'] !== namespace) continue;
    const payload = parseProviderJson(call);
    if (!payload) continue;
    const items = Array.isArray(payload['items']) ? payload['items'].slice(0, 100) : [];
    if (call.name.endsWith('_k8s_get_resources')) {
      for (const item of items) {
        const candidate = normalizeCandidate(item, namespace, provenance(call));
        if (candidate) candidates.push(candidate);
      }
    } else if (call.name.endsWith('_k8s_get_events')) {
      eventPayloads.push(...items.flatMap(item => {
        const event = object(item);
        return event ? [{ event, provenance: provenance(call) }] : [];
      }));
    }
  }

  const uniqueCandidates = [...new Map(candidates.map(candidate => [resourceKey(candidate), candidate])).values()];
  const primary = uniqueCandidates.filter(candidate =>
    candidate.name === service || candidate.labels['app.kubernetes.io/name'] === service);
  const dependencyNames = new Set(primary.flatMap(candidate =>
    (candidate.annotations['argus.aiops/dependencies'] ?? '').split(',').map(value => value.trim()).filter(Boolean)));
  const relevantApps = new Set([service, ...dependencyNames]);
  const selected = uniqueCandidates.filter(candidate =>
    relevantApps.has(candidate.name) || relevantApps.has(candidate.labels['app.kubernetes.io/name'] ?? ''))
    .slice(0, 48);
  const selectedKeys = new Set(selected.map(resourceKey));

  const edges: KubernetesEdge[] = [];
  const services = selected.filter(candidate => candidate.kind === 'Service');
  const deployments = selected.filter(candidate => candidate.kind === 'Deployment');
  const pods = selected.filter(candidate => candidate.kind === 'Pod');
  for (const serviceResource of services) {
    for (const deployment of deployments) {
      if (labelsMatch(deployment.labels, serviceResource.selector)) {
        edges.push({ from: resourceKey(serviceResource), to: resourceKey(deployment), relation: 'selects' });
      }
    }
  }
  for (const deployment of deployments) {
    for (const pod of pods) {
      if (labelsMatch(pod.labels, deployment.selector)) {
        edges.push({ from: resourceKey(deployment), to: resourceKey(pod), relation: 'owns' });
        pod.owner = resourceKey(deployment);
      }
    }
    for (const dependency of (deployment.annotations['argus.aiops/dependencies'] ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
      const target = services.find(candidate => candidate.name === dependency)
        ?? deployments.find(candidate => candidate.name === dependency);
      if (target) edges.push({ from: resourceKey(deployment), to: resourceKey(target), relation: 'depends-on' });
    }
  }
  for (const candidate of selected) {
    if (!candidate.owner && candidate.ownerReference) candidate.owner = candidate.ownerReference;
  }

  const selectedNames = new Set(selected.map(candidate => candidate.name));
  const selectedPodNames = selected.filter(candidate => candidate.kind === 'Pod').map(candidate => candidate.name);
  const selectedUids = new Set(selected.map(candidate => candidate.uid).filter(Boolean));
  const windowStart = scope.windowStart ? Date.parse(scope.windowStart) : Number.NEGATIVE_INFINITY;
  const windowEnd = scope.windowEnd ? Date.parse(scope.windowEnd) : Number.POSITIVE_INFINITY;
  const events = eventPayloads.flatMap(({ event, provenance: source }) => {
    const involved = object(event['involvedObject']) ?? {};
    const objectName = text(involved['name']);
    const involvedUid = text(involved['uid']);
    const message = text(event['message'], 1_000);
    const timestamp = text(event['eventTime']) || text(event['lastTimestamp']) || text(event['firstTimestamp']);
    const timestampMs = Date.parse(timestamp);
    if (!Number.isNaN(timestampMs) && (timestampMs < windowStart || timestampMs > windowEnd)) return [];
    const matchesCurrentObject = involvedUid
      ? selectedUids.has(involvedUid)
      : selectedNames.has(objectName);
    const matchesCurrentChild = selectedPodNames.some(name => message.includes(name));
    const matchesCurrentResource = matchesCurrentObject || matchesCurrentChild;
    if (!matchesCurrentResource) return [];
    const kind = text(involved['kind']) || 'Object';
    return [{
      timestamp,
      type: text(event['type']) || 'Normal',
      reason: text(event['reason']) || 'Unknown',
      object: `${kind}/${objectName}`.slice(0, 512),
      message,
      provenance: source,
    }];
  }).filter(event => event.timestamp && event.object !== 'Object/')
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 12);

  if (selected.length === 0 && events.length === 0) return undefined;
  return {
    namespace,
    resources: selected.map(({ uid: _uid, selector: _selector, annotations: _annotations, ownerReference: _owner, ...resource }) => resource),
    edges: [...new Map(edges.map(edge => [`${edge.from}|${edge.relation}|${edge.to}`, edge])).values()]
      .filter(edge => selectedKeys.has(edge.from) && selectedKeys.has(edge.to)).slice(0, 64),
    events,
  };
}

function planJson(plan: InvestigationPlan): string {
  return JSON.stringify({ incident: plan.incident, scope: plan.scope, hypotheses: plan.hypotheses }, null, 2);
}

const SIGNAL_LANES: SignalLane[] = ['metrics', 'logs', 'traces', 'runtime', 'topology', 'changes', 'knowledge'];
const SIGNAL_TOOL_PATTERNS: Record<SignalLane, RegExp> = {
  metrics: /(?:prometheus|promql|metrics?)/i,
  logs: /(?:loki|search_logs|logql|logs?)/i,
  traces: /(?:jaeger|search_traces|get_trace|traceql|traces?)/i,
  runtime: /(?:targets?|runtime|container)/i,
  topology: /(?:topology|dependencies|service_graph|service_map)/i,
  changes: /(?:changes?|deploy|release|repository|git|config)/i,
  knowledge: /(?:rag_|knowledge|runbook|incident_history)/i,
};

function signalLane(toolName: string): SignalLane | null {
  if (/(?:kubernetes|k8s).*pod_logs/i.test(toolName)) return 'logs';
  if (/(?:kubernetes|k8s).*(?:get_resources|describe_resource|get_resource_yaml)/i.test(toolName)) return 'topology';
  if (/(?:kubernetes|k8s).*(?:get_events|cluster_configuration|available_api_resources)/i.test(toolName)) return 'runtime';
  if (/(?:prometheus_targets|runtime|container)/i.test(toolName)) return 'runtime';
  if (/(?:loki|search_logs|logql)/i.test(toolName)) return 'logs';
  if (/(?:jaeger|search_traces|get_trace|traceql)/i.test(toolName)) return 'traces';
  return SIGNAL_LANES.find(lane => SIGNAL_TOOL_PATTERNS[lane].test(toolName)) ?? null;
}

function signalSource(toolName: string): string {
  if (toolName.includes('prometheus')) return 'Prometheus';
  if (toolName.includes('loki')) return 'Loki';
  if (toolName.includes('jaeger')) return 'Jaeger';
  if (toolName.startsWith('argus_observe_')) return 'Argus Observe';
  if (/(?:kubernetes|k8s)/i.test(toolName)) return 'Kubernetes';
  if (/(?:rag_|knowledge|runbook|incident_history)/i.test(toolName)) return 'Knowledge';
  return 'MCP provider';
}

function timestampFromArgs(args: Record<string, unknown>, fallback: string): string {
  for (const key of ['time', 'end', 'start', 'end_micros', 'start_micros']) {
    const value = args[key];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const raw = String(value);
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    if (!/^\d{10,19}$/.test(raw)) continue;
    const numeric = BigInt(raw);
    const milliseconds = raw.length >= 18 ? numeric / 1_000_000n
      : raw.length >= 15 ? numeric / 1_000n
        : numeric * 1_000n;
    const date = new Date(Number(milliseconds));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function querySummary(args: Record<string, unknown>): string {
  const entries = ['query', 'service', 'state', 'label_name', 'trace_id', 'namespace', 'resource_type', 'resource_name', 'pod_name', 'container']
    .flatMap(key => args[key] === undefined ? [] : [`${key}=${String(args[key]).slice(0, 160)}`]);
  return entries.join(' · ') || 'Bounded read-only provider query';
}

export function buildSignalEvidence(agentEvidence: AgentEvidence[]): {
  signalCoverage: SignalCoverage[];
  timeline: EvidenceTimelineEvent[];
} {
  const calls = agentEvidence.flatMap(agent => agent.toolCalls.map((call, index) => ({ agent, call, index })));
  const knowledgeCitations = agentEvidence.flatMap(agent => (agent.ragCitations ?? []).map((citation, index) => ({ agent, citation, index })));
  const signalCoverage = SIGNAL_LANES.map(lane => {
    const matches = calls.filter(item => signalLane(item.call.name) === lane);
    const citationCount = lane === 'knowledge' ? knowledgeCitations.length : 0;
    const relevantAgents = agentEvidence.filter(agent => agent.role !== 'reviewer');
    return {
      lane,
      status: matches.length + citationCount > 0
        ? 'collected' as const
        : relevantAgents.some(agent => agent.status === 'failed')
          ? 'failed' as const
          : 'missing' as const,
      queryCount: matches.length + citationCount,
      sources: [...new Set([...matches.map(item => signalSource(item.call.name)), ...(citationCount ? ['Knowledge'] : [])])],
      toolNames: [...new Set([...matches.map(item => item.call.name), ...(citationCount ? ['rag:auto'] : [])])],
    };
  });
  const timeline = [...calls.flatMap(({ agent, call, index }) => {
    const lane = signalLane(call.name);
    if (!lane) return [];
    const source = signalSource(call.name);
    return [{
      id: `${agent.role}-${index}-${call.name}`.slice(0, 256),
      timestamp: timestampFromArgs(call.args, agent.endedAt),
      lane,
      source,
      title: `${source} ${lane} evidence`,
      summary: querySummary(call.args),
      correlationKey: typeof call.args['trace_id'] === 'string'
        ? call.args['trace_id'].slice(0, 128)
        : typeof call.args['service'] === 'string'
          ? call.args['service'].slice(0, 128)
          : null,
    }];
  }), ...knowledgeCitations.map(({ agent, citation, index }) => ({
    id: `${agent.role}-citation-${index}`,
    timestamp: agent.endedAt,
    lane: 'knowledge' as const,
    source: 'Knowledge',
    title: 'Knowledge retrieval evidence',
    summary: `index=${citation.index} · source=${citation.source}`.slice(0, 500),
    correlationKey: citation.index.slice(0, 128),
  }))].sort((left, right) => left.timestamp.localeCompare(right.timestamp)).slice(0, 64);
  return { signalCoverage, timeline };
}

export function researcherPrompt(plan: InvestigationPlan): string {
  const laneContract = plan.evidenceLanes
    .filter(lane => lane.id !== 'knowledge')
    .map(lane => `- ${lane.id} (${lane.requirement}): tools=${lane.allowedToolNames.join(', ') || 'none'}; query recipes=${lane.queryTemplates.map(query => `${query.id}:${query.toolName}`).join(', ') || 'none'}`)
    .join('\n');
  return `You are the read-only operations researcher in a governed AIOps investigation.

Hard rules:
- Use only read/query/list/get/search/inspect tools available through your scoped MCP bundles.
- You MUST execute at least one available provider or Argus-observability tool before drawing a conclusion. Start with target/health discovery and a bounded metrics query where available.
- Investigate only the configured evidence lanes below. A query recipe is an approved bounded argument template; render its placeholders from the incident contract and call only its named tool.
- Execute every configured query recipe at least once. Multiple recipes in one lane intentionally prove multiple providers and are not alternatives.
- Do not substitute a different provider, index, label selector, namespace or tool when a recipe is present.
- Never create, update, delete, restart, scale, patch, apply, deploy, acknowledge or resolve anything.
- Work only inside the incident window and service/environment scope below.
- Prefer aggregates and representative examples. Do not copy raw log corpora or full metric series into the answer.
- Separate observed facts, inferences and unavailable evidence. Never invent a provider result.

Configured evidence contract:
${laneContract}

Return concise Markdown with: Observations; Queries performed; Evidence gaps; Ranked hypotheses; Recommended next read-only checks.

Incident contract:
${planJson(plan)}`;
}

export function researcherGapPrompt(
  plan: InvestigationPlan,
  missingLanes: Array<'metrics' | 'logs' | 'traces' | 'kubernetes'>,
  missingRecipeTools: string[] = [],
): string {
  const configuredTools = (lane: 'metrics' | 'logs' | 'traces' | 'kubernetes'): string => {
    const id = lane === 'kubernetes' ? 'runtime' : lane;
    const contract = plan.evidenceLanes.find(item => item.id === id);
    return contract
      ? contract.queryTemplates.map(query => `${query.id}:${query.toolName}`).join(', ') || contract.allowedToolNames.join(', ') || 'no approved tool'
      : 'lane not configured';
  };
  return `You are completing a mandatory evidence-gap pass for a governed read-only AIOps investigation.

The first pass did not execute a provider query for: ${missingLanes.join(', ') || 'no entire lane'}.
For EACH missing lane, execute at least one bounded read-only provider tool now. Prefer:
${missingLanes.map(lane => `- ${lane}: ${configuredTools(lane)}`).join('\n')}

The following configured recipe tools were not executed and MUST each be called once now:
${missingRecipeTools.map(tool => `- ${tool}`).join('\n') || '- none'}

An empty provider result is valid evidence and must be reported as unavailable; skipping the query is not valid. When Kubernetes is missing, query Services, Deployments and Pods in the exact contracted namespace with output=json, then recent Events. Do not repeat Kubernetes topology discovery unless Kubernetes is explicitly listed as missing. Never invoke write or workspace tools. Return a concise evidence-gap summary after the tool calls.

Incident contract:
${planJson(plan)}`;
}

export function knowledgePrompt(plan: InvestigationPlan): string {
  return `You are the read-only knowledge specialist in a governed AIOps investigation.

You MUST call an advertised rag_, knowledge, runbook or incident-history tool. Search only those scoped tools for runbooks, architecture notes, service ownership and comparable historical incidents. Do not invoke write tools or propose an action as if it already happened. Cite document names or result identifiers when available. Clearly state when no relevant knowledge evidence exists.

Return concise Markdown with: Relevant runbooks; Historical matches; Ownership/escalation context; Knowledge gaps.

Incident contract:
${planJson(plan)}`;
}

export function reviewerPrompt(plan: InvestigationPlan, evidence: AgentEvidence[]): string {
  const compact = evidence.map(item => ({
    role: item.role,
    status: item.status,
    outputSummary: item.outputSummary.slice(0, 20_000),
    error: item.error,
    tools: item.toolCalls.map(call => call.name),
  }));
  return `You are the read-only evidence reviewer for a governed AIOps investigation.

Validate every causal claim against the supplied evidence. Distinguish correlation from causation. Do not claim that missing logs, traces or metrics were checked. Do not perform remediation or invoke write tools.

Return ONLY one JSON object. Do not use Markdown or a code fence. It must use exactly this contract:
{
  "conclusion": "confirmed | suspected | inconclusive | refuted",
  "executiveAssessment": "concise evidence-backed assessment",
  "rootCause": null | {
    "candidateRef": "exact argus.core.impact.candidate.N label key, or null",
    "targetKind": "component kind, or null",
    "targetName": "component name, or null",
    "statement": "causal statement",
    "confidence": 0,
    "rationale": "evidence for and against"
  },
  "hypotheses": [{
    "id": "stable id",
    "statement": "hypothesis",
    "verdict": "supported | weakened | unresolved | refuted",
    "confidence": 0,
    "evidenceFor": ["bounded claim"],
    "evidenceAgainst": ["bounded claim"]
  }],
  "evidence": [{
    "lane": "metrics | logs | traces | runtime | topology | changes | knowledge",
    "claim": "validated aggregate claim",
    "sourceRefs": ["tool, trace, metric, runbook or result identifier"]
  }],
  "recommendedActions": [{
    "priority": "now | next | later",
    "action": "safe next action",
    "rationale": "why",
    "requiresApproval": true
  }]
}

Use "confirmed" only when multiple independent signals support causality. Use "refuted" only when evidence contradicts the proposed candidate. Otherwise use "suspected" or "inconclusive". A candidateRef may only copy an exact Core candidate label key present in the incident contract. Recommendations are proposals only; never imply they were executed.

Incident contract:
${planJson(plan)}

Collected agent evidence:
${JSON.stringify(compact, null, 2)}`;
}

export function completedAgentEvidence(
  role: InvestigationAgentRole,
  startedAt: Date,
  endedAt: Date,
  response: CoreAgentResponse,
): AgentEvidence {
  return {
    role,
    status: 'completed',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    agentId: response.agent.id,
    model: response.agent.model,
    sessionId: response.sessionId || null,
    outputSummary: response.response.slice(0, 100_000),
    error: null,
    toolCalls: safeToolCalls(response.toolCalls),
    ragCitations: (response.ragCitations ?? []).slice(0, 100).map(citation => ({
      source: citation.source.slice(0, 1_000),
      index: citation.index.slice(0, 256),
      score: Number.isFinite(citation.score) ? citation.score : 0,
    })),
  };
}

export function failedAgentEvidence(
  role: InvestigationAgentRole,
  startedAt: Date,
  endedAt: Date,
  cause: unknown,
): AgentEvidence {
  return {
    role,
    status: 'failed',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
    agentId: null,
    model: null,
    sessionId: null,
    outputSummary: '',
    error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000),
    toolCalls: [],
    ragCitations: [],
  };
}
