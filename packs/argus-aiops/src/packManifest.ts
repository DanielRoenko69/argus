import { workflowCatalog } from './workflowCatalog.js';

export const ARGUS_AIOPS_PACK_MANIFEST = {
  apiVersion: 'argus.eu/v1alpha1',
  kind: 'SolutionPack',
  metadata: {
    id: 'argus.aiops',
    version: '0.2.0',
    displayName: 'Argus AIOps',
    description: 'Governed, evidence-first incident investigation across existing observability and runtime systems.',
  },
  spec: {
    delivery: {
      type: 'container',
      protocol: 'argus-pack-v1alpha1',
      healthPath: '/healthz',
      readinessPath: '/readyz',
    },
    requires: {
      core: '>=1.0.0',
      capabilities: [
        'agent.invoke',
        'metrics.query',
        'runtime.read',
        'logs.query',
        'traces.query',
        'topology.read',
        'changes.read',
        'knowledge.search',
      ],
      credentials: [
        { id: 'telemetry', accepts: ['prometheus', 'grafana', 'datadog', 'new-relic', 'opensearch', 'elastic', 'splunk'] },
        { id: 'runtime', accepts: ['kubernetes', 'openshift', 'aws', 'azure', 'gcp'] },
        { id: 'incident-management', accepts: ['pagerduty', 'servicenow', 'jira'], optional: true },
      ],
    },
    components: {
      agents: [{
        id: 'incident-orchestrator',
        runtime: 'a2a',
        skills: ['incident-triage', 'signal-correlation', 'runbook-selection'],
        bundles: ['aiops-observe'],
        credentials: ['telemetry', 'runtime', 'incident-management'],
        coreAgents: ['aiops-researcher', 'aiops-knowledge', 'aiops-reviewer'],
        a2aAgentCardPath: '/.well-known/agent-card.json',
      }],
      skills: ['incident-triage', 'signal-correlation', 'runbook-selection'],
      bundles: ['aiops-observe'],
      workflows: workflowCatalog().map(workflow => workflow.id),
      knowledgeSources: ['operations-runbooks'],
      dashboards: ['operations-overview', 'incident-review'],
      policies: ['read-only-observation'],
    },
    readiness: {
      smokeTests: ['manifest-contract', 'a2a-contract', 'task-persistence'],
    },
  },
} as const;
