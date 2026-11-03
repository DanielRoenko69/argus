/**
 * This declaration is consumed by Argus Core during Pack discovery. It declares
 * an execution bridge, not an MCP Bundle: Core remains the authority for MCP
 * bundles, credentials, approvals, audits and short-lived tool access.
 */
import { HERMES_RUNTIME_CAPABILITY_CEILING } from './runtimeTypes.js';

export const ARGUS_HERMES_PACK_MANIFEST = {
  apiVersion: 'argus.eu/v1alpha1',
  kind: 'SolutionPack',
  metadata: {
    id: 'argus.hermes',
    version: '0.1.0',
    displayName: 'Argus Hermes',
    description: 'Hermes runtime bridge for attached external services and later Argus-managed isolated runners.',
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
      capabilities: ['agent.invoke', 'mcp.fabric', 'observability.trace', 'runtime.execute'],
      credentials: [{ id: 'hermes-service', accepts: ['hermes-http'], optional: true }],
    },
    components: {
      agents: [],
      runtimeAdapters: [{
        id: 'hermes-http',
        runtime: 'hermes',
        protocol: 'argus-runtime-v1alpha1',
        endpoint: '/runtime/v1',
        modes: ['attached', 'managed'],
        // This is the maximum versioned adapter contract. The live capability
        // endpoint still reports only `health` until an isolated per-run
        // provisioner is actually installed, so Core stays fail-closed.
        capabilities: HERMES_RUNTIME_CAPABILITY_CEILING,
      }],
      skills: [],
      bundles: [],
      workflows: [],
      knowledgeSources: [],
      dashboards: [],
      policies: ['attached-runtime-attestation', 'managed-runtime-isolation'],
    },
    readiness: {
      smokeTests: ['manifest-contract', 'runtime-capability-handshake'],
    },
  },
} as const;
