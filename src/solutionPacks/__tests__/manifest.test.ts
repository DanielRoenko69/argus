import { describe, expect, it } from '@jest/globals';
import {
  parseSolutionPackManifestDocument,
  SolutionPackManifestError,
  validateSolutionPackManifest,
} from '../manifest.js';

const validManifest = {
  apiVersion: 'argus.eu/v1alpha1',
  kind: 'SolutionPack',
  metadata: {
    id: 'argus.dev',
    version: '0.1.0',
    displayName: 'Argus Dev',
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
      capabilities: ['git.read', 'workspace.exec'],
      credentials: [{ id: 'source-control', accepts: ['github', 'gitlab'] }],
    },
    components: {
      agents: [{
        id: 'coding-orchestrator',
        runtime: 'a2a',
        skills: ['implementation-planning'],
        bundles: ['dev-workspace'],
        credentials: ['source-control'],
        a2aAgentCardPath: '/agents/coding-orchestrator/.well-known/agent-card.json',
      }],
      skills: ['implementation-planning'],
      bundles: ['dev-workspace'],
      workflows: ['ticket-to-pull-request'],
      knowledgeSources: ['engineering-standards'],
      dashboards: ['development-overview'],
      policies: ['governed-repository-write'],
    },
    readiness: { smokeTests: ['agent-card', 'workspace-boundary'] },
  },
};

describe('SolutionPackManifest', () => {
  it('parses a strict container-delivered YAML manifest and applies safe defaults', () => {
    const manifest = parseSolutionPackManifestDocument(`
apiVersion: argus.eu/v1alpha1
kind: SolutionPack
metadata:
  id: argus.aiops
  version: 0.1.0
  displayName: Argus AIOps
spec:
  delivery:
    type: container
    protocol: argus-pack-v1alpha1
  requires:
    core: ">=1.0.0"
  components: {}
  readiness:
    smokeTests: [pack-health]
`);

    expect(manifest.spec.delivery.healthPath).toBe('/healthz');
    expect(manifest.spec.delivery.readinessPath).toBe('/readyz');
    expect(manifest.spec.components.agents).toEqual([]);
    expect(manifest.spec.components.runtimeAdapters).toEqual([]);
  });

  it('accepts an A2A agent only with a relative Agent Card path and valid references', () => {
    expect(validateSolutionPackManifest(validManifest).spec.components.agents[0]?.runtime).toBe('a2a');
  });

  it('accepts a declared runtime adapter without treating it as an MCP bundle or an A2A agent', () => {
    const manifest = validateSolutionPackManifest({
      ...validManifest,
      spec: {
        ...validManifest.spec,
        components: {
          ...validManifest.spec.components,
          runtimeAdapters: [{
            id: 'hermes-http',
            runtime: 'hermes',
            protocol: 'argus-runtime-v1alpha1',
            endpoint: '/runtime/v1',
            modes: ['attached', 'managed'],
            capabilities: ['health', 'runs', 'events-sse', 'cancel', 'approval'],
          }],
        },
      },
    });

    expect(manifest.spec.components.runtimeAdapters).toEqual([{
      id: 'hermes-http',
      runtime: 'hermes',
      protocol: 'argus-runtime-v1alpha1',
      endpoint: '/runtime/v1',
      modes: ['attached', 'managed'],
      capabilities: ['health', 'runs', 'events-sse', 'cancel', 'approval'],
    }]);
  });

  it('rejects absolute or traversing service paths', () => {
    const absolute = structuredClone(validManifest);
    absolute.spec.components.agents[0]!.a2aAgentCardPath = 'https://evil.example/agent-card.json';
    expect(() => validateSolutionPackManifest(absolute)).toThrow(SolutionPackManifestError);

    const traversing = structuredClone(validManifest);
    traversing.spec.delivery.healthPath = '/../admin';
    expect(() => validateSolutionPackManifest(traversing)).toThrow('path traversal');

    const encodedTraversal = structuredClone(validManifest);
    encodedTraversal.spec.components.agents[0]!.a2aAgentCardPath = '/agents/%2e%2e/admin';
    expect(() => validateSolutionPackManifest(encodedTraversal)).toThrow('encoded traversal');

    const queryPath = structuredClone(validManifest);
    queryPath.spec.delivery.readinessPath = '/readyz?as=another-route';
    expect(() => validateSolutionPackManifest(queryPath)).toThrow('query');
  });

  it('rejects undeclared component references and duplicate identifiers', () => {
    const invalid = structuredClone(validManifest);
    invalid.spec.components.agents[0]!.skills.push('missing-skill');
    invalid.spec.components.bundles.push('dev-workspace');

    expect(() => validateSolutionPackManifest(invalid)).toThrow('undeclared skill');
    expect(() => validateSolutionPackManifest(invalid)).toThrow('duplicate identifier');
  });

  it('rejects duplicate runtime adapters and duplicate adapter capabilities', () => {
    const duplicateAdapter = {
      ...validManifest,
      spec: {
        ...validManifest.spec,
        components: {
          ...validManifest.spec.components,
          runtimeAdapters: [{
            id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime/v1',
            modes: ['attached'], capabilities: ['health'],
          }, {
            id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime/v1',
            modes: ['attached'], capabilities: ['health'],
          }],
        },
      },
    };
    expect(() => validateSolutionPackManifest(duplicateAdapter)).toThrow("duplicate identifier 'hermes-http'");

    const duplicateCapability = {
      ...validManifest,
      spec: {
        ...validManifest.spec,
        components: {
          ...validManifest.spec.components,
          runtimeAdapters: [{
            id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime/v1',
            modes: ['attached'], capabilities: ['health', 'health'],
          }],
        },
      },
    };
    expect(() => validateSolutionPackManifest(duplicateCapability)).toThrow("duplicate capability 'health'");
  });

  it('rejects unknown fields instead of silently accepting contract drift', () => {
    const invalid = {
      ...validManifest,
      metadata: { ...validManifest.metadata, privileged: true },
    };
    expect(() => validateSolutionPackManifest(invalid)).toThrow('Unrecognized key');
  });
});
