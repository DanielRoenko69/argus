export type WorkflowStageKind = 'workspace' | 'plan' | 'knowledge' | 'review' | 'approval' | 'delivery';

export interface WorkflowInputField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select';
  required: boolean;
  placeholder?: string;
  description?: string;
  defaultValue?: string | number;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface WorkflowDefinition {
  id: string;
  graphId: string;
  label: string;
  description: string;
  tags: string[];
  inputSchema: WorkflowInputField[];
  stages: Array<{ id: string; label: string; hint: string; kind: WorkflowStageKind }>;
  approvalGates: string[];
  requiredAgents: string[];
  titleField: string;
  descriptionField: string;
  requiredBundleCategories: string[];
  recommendedBundleCategories: string[];
  requiredExecutionTargetKinds: string[];
}

const INCIDENT_INVESTIGATION: WorkflowDefinition = {
  id: 'incident-investigation',
  graphId: 'incident_investigation',
  label: 'Incident investigation',
  description: 'Scope an operational incident and build a provider-neutral, evidence-first investigation plan.',
  tags: ['aiops', 'incident', 'read-only', 'evidence', 'root-cause-analysis'],
  inputSchema: [
    { name: 'title', label: 'Incident title', type: 'text', required: true, placeholder: 'Checkout latency increased after deployment' },
    { name: 'summary', label: 'Observed symptoms', type: 'textarea', required: true, placeholder: 'Describe the alert, user impact and any known context.' },
    {
      name: 'severity', label: 'Severity', type: 'select', required: true, defaultValue: 'warning',
      options: [
        { value: 'critical', label: 'Critical' },
        { value: 'warning', label: 'Warning' },
        { value: 'info', label: 'Info' },
      ],
    },
    { name: 'service', label: 'Affected service', type: 'text', required: true, placeholder: 'checkout' },
    { name: 'environment', label: 'Environment', type: 'text', required: true, defaultValue: 'production', placeholder: 'production' },
    { name: 'started_at', label: 'Started at', type: 'text', required: false, placeholder: '2026-08-10T10:30:00Z' },
    { name: 'alert_source', label: 'Alert source', type: 'text', required: false, placeholder: 'Alertmanager / Grafana / Datadog' },
    { name: 'alert_url', label: 'Alert URL', type: 'text', required: false, placeholder: 'https://monitoring.example/incidents/123' },
    {
      name: 'correlation_window_minutes', label: 'Correlation window', type: 'number', required: true,
      defaultValue: 30, min: 5, max: 360, description: 'Evidence window before and after the reported start time.',
    },
  ],
  stages: [
    { id: 'incident_intake', label: 'Intake', hint: 'Normalize signal', kind: 'workspace' },
    { id: 'resolve_scope', label: 'Scope', hint: 'Service & window', kind: 'plan' },
    { id: 'map_topology', label: 'Topology', hint: 'Dependencies', kind: 'knowledge' },
    { id: 'inspect_metrics', label: 'Metrics', hint: 'Golden signals', kind: 'knowledge' },
    { id: 'inspect_logs', label: 'Logs', hint: 'Patterns & errors', kind: 'knowledge' },
    { id: 'inspect_traces', label: 'Traces', hint: 'Critical path', kind: 'knowledge' },
    { id: 'inspect_changes', label: 'Changes', hint: 'Deployments & config', kind: 'knowledge' },
    { id: 'test_hypotheses', label: 'Correlate', hint: 'Rank hypotheses', kind: 'plan' },
    { id: 'search_runbooks', label: 'Runbooks', hint: 'RAG & history', kind: 'knowledge' },
    { id: 'review_evidence', label: 'Review', hint: 'Evidence quality', kind: 'review' },
    { id: 'publish_findings', label: 'Findings', hint: 'Read-only handoff', kind: 'delivery' },
  ],
  approvalGates: [],
  requiredAgents: ['researcher', 'knowledge', 'reviewer'],
  titleField: 'title',
  descriptionField: 'summary',
  requiredBundleCategories: ['metrics', 'runtime'],
  recommendedBundleCategories: ['logs', 'traces', 'topology', 'repository', 'rag', 'incident'],
  requiredExecutionTargetKinds: ['kubernetes'],
};

const catalog = [INCIDENT_INVESTIGATION];

export function workflowCatalog(): WorkflowDefinition[] {
  return catalog.map(workflow => ({
    ...workflow,
    tags: [...workflow.tags],
    inputSchema: workflow.inputSchema.map(field => ({
      ...field,
      options: field.options?.map(option => ({ ...option })),
    })),
    stages: workflow.stages.map(stage => ({ ...stage })),
    approvalGates: [...workflow.approvalGates],
    requiredAgents: [...workflow.requiredAgents],
    requiredBundleCategories: [...workflow.requiredBundleCategories],
    recommendedBundleCategories: [...workflow.recommendedBundleCategories],
    requiredExecutionTargetKinds: [...workflow.requiredExecutionTargetKinds],
  }));
}

export function getWorkflow(workflowId: string): WorkflowDefinition | undefined {
  return catalog.find(workflow => workflow.id === workflowId);
}

