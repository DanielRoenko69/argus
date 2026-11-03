import { workflowCatalog } from './workflowCatalog.js';

export const ARGUS_DEV_PACK_MANIFEST = {
  apiVersion: 'argus.eu/v1alpha1',
  kind: 'SolutionPack',
  metadata: {
    id: 'argus.dev',
    version: '0.4.0',
    displayName: 'Argus Dev',
    description: 'Governed LangGraph coding workflows for planning, implementation, testing and review.',
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
      capabilities: ['agent.invoke', 'repository.read', 'repository.write', 'workspace.exec'],
      credentials: [],
    },
    components: {
      agents: [{
        id: 'coding-orchestrator',
        runtime: 'a2a',
        skills: ['ticket-planning', 'implementation', 'code-review'],
        bundles: ['dev-workspace'],
        credentials: [],
        coreAgents: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'],
        a2aAgentCardPath: '/.well-known/agent-card.json',
      }],
      skills: ['ticket-planning', 'implementation', 'code-review'],
      bundles: ['dev-workspace'],
      workflows: workflowCatalog().map(workflow => workflow.id),
      knowledgeSources: ['engineering-standards'],
      dashboards: ['development-overview'],
      policies: ['governed-repository-write'],
    },
    readiness: {
      smokeTests: ['runtime-database', 'coding-orchestrator-a2a'],
    },
  },
} as const;
