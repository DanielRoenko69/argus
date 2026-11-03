import { describe, expect, it } from '@jest/globals';
import { assertGitReference, bindGitReference, gitTarget, gitCloneUrl, gitOperationSchema } from '../devGitBroker.js';
import type { CustomBackendRow } from '../../backends/customBackends.js';
import type { ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';

const backend = { id: 5, name: 'gitea', base_url: 'http://gitea:3000', auth_mode: 'strict', oauth_client_id: 'app',
  oauth_scopes: ['write:repository'], config: { kind: 'gitea', owner: 'alex', repo: 'demo', target_branch: 'main' } } as unknown as CustomBackendRow;
const grant = { principalKind: 'user', principalId: '3', rootTraceId: 'run', workspaceRoot: '/workspace/RUN',
  jti: 'old', tenantKey: 'default', workspaceKey: 'default' } as ExecutionGrantClaims;
const secret = 's'.repeat(32);

describe('Core Git reference and operation boundary', () => {
  it('contains no credential and survives token/grant rotation', () => {
    const ref = bindGitReference(secret, grant, 50, backend);
    expect(Object.keys(ref).sort()).toEqual(['backendId','binding','bundleId','version']);
    expect(bindGitReference(secret, { ...grant, jti: 'new' }, 50, { ...backend, auth_value: 'rotated-token' })).toEqual(ref);
    expect(gitCloneUrl(gitTarget(backend))).toBe('http://gitea:3000/alex/demo.git');
  });
  it.each(['principalId','rootTraceId','workspaceRoot','tenantKey','workspaceKey'] as const)('binds %s', key => {
    const ref = bindGitReference(secret, grant, 50, backend);
    expect(() => assertGitReference(ref, bindGitReference(secret, { ...grant, [key]: 'other' }, 50, backend))).toThrow('changed');
  });
  it('rejects backend, Bundle, policy, repository and OAuth scope drift', () => {
    const ref = bindGitReference(secret, grant, 50, backend);
    for (const change of [{ id: 6 }, { auth_mode: 'service-account' }, { oauth_scopes: ['read:repository'] },
      { config: { ...backend.config, repo: 'other' } }, { oauth_client_id: 'other-app' }]) {
      expect(() => assertGitReference(ref, bindGitReference(secret, grant, 50, { ...backend, ...change } as CustomBackendRow))).toThrow();
    }
    expect(() => assertGitReference(ref, bindGitReference(secret, grant, 51, backend))).toThrow();
  });
  it.each(['http://user:secret@gitea/repo','file:///tmp/repo','http://gitea/x?token=secret','http://gitea/%2e%2e'])('rejects unsafe origin %s', base_url => {
    expect(() => gitTarget({ ...backend, base_url })).toThrow();
  });
  it('accepts approved exact-commit delivery only', () => {
    const base = { reference: bindGitReference(secret, grant, 50, backend), operation: 'push', branch: 'feature/DEMO-1',
      commitSha: 'a'.repeat(40), codeApproved: true, testsPassed: true, reviewPassed: true };
    expect(gitOperationSchema.safeParse(base).success).toBe(true);
    expect(gitOperationSchema.safeParse({ ...base, testsPassed: undefined, verificationMode: 'review-only-image' }).success).toBe(true);
    expect(gitOperationSchema.safeParse({ ...base, verificationMode: 'review-only-image' }).success).toBe(false);
    for (const key of ['commitSha','codeApproved','testsPassed','reviewPassed']) expect(gitOperationSchema.safeParse({ ...base, [key]: undefined }).success).toBe(false);
    for (const branch of ['main','feature/a;env','feature/../main','feature/x.lock','feature/x//y']) expect(gitOperationSchema.safeParse({ ...base, branch }).success).toBe(false);
    expect(gitOperationSchema.safeParse({ ...base, operation: 'pull-request', title: 'Change', description: 'Evidence' }).success).toBe(false);
    expect(gitOperationSchema.safeParse({ ...base, operation: 'pull-request', title: 'Change', description: 'Evidence', prApproved: true, ciPassed: true }).success).toBe(true);
    expect(gitOperationSchema.safeParse({ ...base, url: 'http://attacker' }).success).toBe(false);
  });
});
