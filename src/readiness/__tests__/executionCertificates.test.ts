import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { PlatformExecutionCertificateError, validatePlatformExecutionProof } from '../executionCertificates.js';

function digest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, current: unknown) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current;
    const object = current as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, object[key]]));
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function proof() {
  const payload = {
    schema: 'argus.solution-showcase-golden-runs.v1',
    generatedAt: '2026-10-06T12:00:00.000Z',
    browser: 'msedge',
    baseUrl: 'http://localhost:3000',
    mode: 'verify-only',
    identity: { displayName: 'Alex', username: 'oidc:alex', authMethod: 'oidc', mfaMethod: 'otp' },
    runs: {
      dev: {
        taskId: '6757d711-9bd8-4feb-b929-69e710dbcf1b',
        rootTraceId: 'ae34738f-65a1-4699-8bd0-d13c2c4d229c',
        workflowId: 'ticket-to-image-pull-request', verificationMode: 'review-only-image', testExecution: 'intentionally_skipped',
        ticketId: 'ARGUS-1', repository: 'alex/demo', branchName: 'feature/ARGUS-1', commitSha: 'a'.repeat(40),
        pullRequestUrl: 'http://localhost:3005/alex/demo/pulls/1', changedFiles: ['src/app.js'],
        ci: { provider: 'jenkins', status: 'success', run_url: 'http://localhost:8081/job/demo/1/', imageTag: 'demo:1', imageId: `sha256:${'b'.repeat(64)}` },
        checks: { completed: true, testsPassed: true, pullRequestCreated: true }, passed: true,
      },
      aiops: {
        taskId: '44cba26e-8b6c-487f-8267-9040c089127b',
        rootTraceId: 'f7b150a3-ebfc-461a-993e-6c66f8e471c8', state: 'TASK_STATE_COMPLETED',
        profile: { displayName: 'Checkout API', service: 'checkout-api', environment: 'demo', revision: 2, sha256: 'c'.repeat(64) },
        quality: 'reviewed', evidenceLanes: [{ lane: 'metrics', status: 'collected' }],
        providerToolNames: ['aiops_prometheus_query_range'], checks: { completed: true, reviewed: true }, passed: true,
      },
    },
    pages: {},
    checks: { alexSsoLinked: true, freshMfa: true, devPassed: true, aiopsPassed: true, modulePagesVisible: true },
  };
  return {
    ...payload,
    payloadSha256: digest(payload),
    passed: true,
  };
}

describe('platform execution proof validation', () => {
  it('accepts a digest-bound passing Dev and AIOps proof', () => {
    const result = validatePlatformExecutionProof({ report: proof() });
    expect(result.summary.sourceMode).toBe('verify-only');
    expect(result.summary.dev.ci.provider).toBe('jenkins');
    expect(result.summary.dev.testExecution).toBe('intentionally_skipped');
    expect(result.summary.aiops.profile.service).toBe('checkout-api');
  });

  it('rejects evidence changed after the runner signed its payload', () => {
    const report = proof();
    report.runs.dev.commitSha = 'tampered';
    expect(() => validatePlatformExecutionProof({ report })).toThrow(
      expect.objectContaining({ code: 'PLATFORM_EXECUTION_PROOF_DIGEST_MISMATCH' }),
    );
  });

  it('rejects an internally failing check even with a matching digest', () => {
    const report = proof();
    report.runs.aiops.checks.reviewed = false;
    const { payloadSha256: _digest, passed: _passed, ...payload } = report;
    report.payloadSha256 = digest(payload);
    expect(() => validatePlatformExecutionProof({ report })).toThrow(PlatformExecutionCertificateError);
  });

  it('rejects a reviewer-gated proof that claims automated tests passed', () => {
    const report = proof();
    report.runs.dev.testExecution = 'passed';
    const { payloadSha256: _digest, passed: _passed, ...payload } = report;
    report.payloadSha256 = digest(payload);
    expect(() => validatePlatformExecutionProof({ report })).toThrow(
      'Dev verification mode and test execution evidence are inconsistent',
    );
  });
});
