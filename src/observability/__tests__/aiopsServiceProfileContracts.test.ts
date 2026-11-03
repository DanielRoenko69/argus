import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  aiOpsCapabilityRequirementSchema,
  aiOpsGlobalReadinessSchema,
  aiOpsLegacyProjectionSchema,
  aiOpsServiceProfileConfigSchema,
  aiOpsServiceProfileErrorSchema,
  aiOpsServiceProfileReadinessSchema,
  aiOpsServiceProfileResourceSchema,
  hashAiOpsServiceProfileConfig,
  type AiOpsServiceProfileConfig,
} from '../aiopsServiceProfileContracts.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/aiops-service-profiles',
  name,
), 'utf8'));

describe('AIOps service profile v1 contracts', () => {
  it('keeps the active profile fixture valid and hash-bound to its config', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );

    expect(profile.status).toBe('active');
    expect(profile.latestRevision.config.service).toMatchObject({
      serviceName: 'checkout-api',
      environment: 'production',
    });
    expect(hashAiOpsServiceProfileConfig(profile.latestRevision.config))
      .toBe(profile.latestRevision.sha256);
    expect(profile.activeRevision?.sha256).toBe(profile.latestRevision.sha256);
  });

  it('keeps ready, partial, blocked, forbidden and legacy fixtures executable', () => {
    const global = aiOpsGlobalReadinessSchema.parse(
      fixture('global-readiness-ready.v1.fixture.json'),
    );
    const partial = aiOpsServiceProfileReadinessSchema.parse(
      fixture('profile-readiness-partial.v1.fixture.json'),
    );
    const blocked = aiOpsServiceProfileReadinessSchema.parse(
      fixture('profile-readiness-blocked.v1.fixture.json'),
    );
    const forbidden = aiOpsServiceProfileErrorSchema.parse(
      fixture('profile-forbidden.v1.fixture.json'),
    );
    const legacy = aiOpsLegacyProjectionSchema.parse(
      fixture('legacy-alert-rule-projection.v1.fixture.json'),
    );

    expect(global).toMatchObject({ state: 'ready', presentation: 'connected_summary' });
    expect(partial).toMatchObject({ state: 'degraded', summary: { blockingIssues: 0, optionalGaps: 1 } });
    expect(blocked).toMatchObject({ state: 'blocked', summary: { blockingIssues: 1 } });
    expect(forbidden.error).toMatchObject({
      code: 'forbidden',
      requiredPermission: 'aiops.service_profile.activate',
    });
    expect(legacy).toMatchObject({
      source: 'native-alert-rule-v0',
      resolved: { runtimeRequired: true },
    });
  });

  it('allows provider-only profiles without a Kubernetes selector', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );

    expect(profile.latestRevision.config.selectors.runtime).toBeUndefined();
    expect(profile.latestRevision.config.evidencePolicy.lanes.some(
      lane => lane.lane === 'runtime' && lane.requirement === 'required',
    )).toBe(false);
  });

  it('requires an explicit runtime selector when runtime evidence is required', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );
    const config: AiOpsServiceProfileConfig = structuredClone(profile.latestRevision.config);
    config.evidencePolicy.lanes.push({
      lane: 'runtime',
      requirement: 'required',
      bundleId: 11,
      toolAllowlist: ['aiops_kubernetes_k8s_get_resources'],
      queryTemplates: [],
    });

    expect(aiOpsServiceProfileConfigSchema.safeParse(config)).toMatchObject({ success: false });
  });

  it('rejects disabled lanes that still expose tools', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );
    const config: AiOpsServiceProfileConfig = structuredClone(profile.latestRevision.config);
    config.evidencePolicy.lanes[0] = {
      ...config.evidencePolicy.lanes[0],
      requirement: 'disabled',
    };

    expect(aiOpsServiceProfileConfigSchema.safeParse(config)).toMatchObject({ success: false });
  });

  it('rejects secret or otherwise unsupported query placeholders', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );
    const config: AiOpsServiceProfileConfig = structuredClone(profile.latestRevision.config);
    config.evidencePolicy.lanes[0]!.queryTemplates[0]!.template += ' ${secret.token}';

    expect(aiOpsServiceProfileConfigSchema.safeParse(config)).toMatchObject({ success: false });
  });

  it('accepts a structured service query and requires its tool to stay lane-allowlisted', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );
    const config: AiOpsServiceProfileConfig = structuredClone(profile.latestRevision.config);
    const logs = config.evidencePolicy.lanes.find(lane => lane.lane === 'logs')!;
    logs.queryTemplates = [{
      id: 'checkout-service-errors',
      toolName: 'aiops_loki_query_range',
      source: {
        kind: 'loki',
        resource: 'application logs',
        fields: {
          timestamp: 'timestamp',
          service: 'service_name',
          environment: 'environment',
          message: 'message',
          traceId: 'trace_id',
        },
      },
      defaults: { signalKeyword: 'payment_failed' },
      template: '{"query":"{service_name=\\"${service.name}\\"} |= \\"${signal.keyword}\\"","start":"${window.start}","end":"${window.end}"}',
    }];

    expect(aiOpsServiceProfileConfigSchema.safeParse(config)).toMatchObject({ success: true });
    logs.queryTemplates[0]!.toolName = 'unscoped_log_search';
    expect(aiOpsServiceProfileConfigSchema.safeParse(config)).toMatchObject({ success: false });
  });

  it('rejects non-JSON executable argument templates while preserving legacy provider expressions', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );
    const config: AiOpsServiceProfileConfig = structuredClone(profile.latestRevision.config);
    const logs = config.evidencePolicy.lanes.find(lane => lane.lane === 'logs')!;
    logs.queryTemplates[0] = {
      ...logs.queryTemplates[0]!,
      source: { kind: 'loki' },
    };

    expect(aiOpsServiceProfileConfigSchema.safeParse(config)).toMatchObject({ success: false });
  });

  it('produces a stable hash independent of object key insertion order', () => {
    const profile = aiOpsServiceProfileResourceSchema.parse(
      fixture('service-profile-active.v1.fixture.json'),
    );
    const config = profile.latestRevision.config;
    const reordered = Object.fromEntries(Object.entries(config).reverse());

    expect(hashAiOpsServiceProfileConfig(reordered)).toBe(hashAiOpsServiceProfileConfig(config));
  });

  it('expresses global readiness as at least one recognized read-evidence capability', () => {
    expect(aiOpsCapabilityRequirementSchema.parse({
      version: 1,
      required: [],
      optional: ['topology', 'repository', 'rag'],
      atLeastOneOf: [['metrics', 'logs', 'traces', 'runtime', 'incident']],
    })).toEqual({
      version: 1,
      required: [],
      optional: ['topology', 'repository', 'rag'],
      atLeastOneOf: [['metrics', 'logs', 'traces', 'runtime', 'incident']],
    });
  });
});
