import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionUser } from '../../auth/userAuth.js';
import { buildConsoleNavigationCapabilities } from '../navigationCapabilities.js';

const user = (role: string): SessionUser => ({
  id: 17,
  username: role,
  display_name: role,
  role,
  allowed_bundles: null,
  entra_groups: [],
});

describe('console navigation capabilities', () => {
  it('separates installed and entitled modules from permissions', () => {
    const result = buildConsoleNavigationCapabilities(user('developer'), {
      installedModules: ['argus.core', 'argus.dev', 'compliance'],
      entitledModules: ['argus.core', 'argus.dev'],
      now: () => new Date('2026-09-07T12:00:00.000Z'),
    });

    expect(result.schemaVersion).toBe(1);
    expect(result.generatedAt).toBe('2026-09-07T12:00:00.000Z');
    expect(result.navigation.canUseArgusDev).toBe(true);
    expect(result.navigation.canUseCompliance).toBe(false);
    expect(result.modules.find(module => module.id === 'compliance')).toMatchObject({
      installed: true,
      entitled: false,
      available: false,
      reason: 'not_entitled',
    });
  });

  it('keeps viewer navigation read-only', () => {
    const result = buildConsoleNavigationCapabilities(user('viewer'), {
      installedModules: ['argus.core', 'argus.dev', 'compliance'],
    });
    expect(result.navigation).toMatchObject({
      canUseArgusDev: false,
      canBuildWorkflows: false,
      canManageAgents: false,
      canManageIntegrations: false,
      canObservePlatform: true,
      canSearchWorkspaceResources: true,
      canAdminPlatform: false,
    });
  });

  it('applies explicit denies to discoverability without claiming route authorization', () => {
    const result = buildConsoleNavigationCapabilities(user('platform_admin'), {
      installedModules: ['argus.core', 'argus.dev', 'compliance', 'public-channels'],
      assignments: [{ permission: 'audit.read', effect: 'deny', source: 'sso_group', sourceId: 'restricted' }],
    });
    expect(result.navigation.canReadAuditEvidence).toBe(false);
    expect(result.permissions).not.toContain('audit.read');
    expect(result.navigation.canAdminPlatform).toBe(true);
  });

  it('keeps the H1 wire fixtures synchronized with the capability builder', () => {
    const fixture = JSON.parse(readFileSync(resolve(
      process.cwd(),
      'docs/specs/core-access/navigation-capabilities.v1.fixture.json',
    ), 'utf8')) as { examples: Array<{ name: string; response: Record<string, unknown> }> };
    const installedBase = ['argus.core', 'argus.dev', 'public-channels', 'compliance'] as const;
    const cases = {
      'developer-with-argus-dev': {
        subject: user('developer'),
        installedModules: installedBase,
        entitledModules: ['argus.core', 'argus.dev', 'argus.aiops', 'argus.hermes', 'public-channels'] as const,
      },
      'operator-approver': {
        subject: user('agent_operator'),
        installedModules: installedBase,
        entitledModules: ['argus.core', 'argus.dev', 'public-channels'] as const,
      },
      'auditor-scoped-assignment': {
        subject: user('viewer'),
        installedModules: installedBase,
        entitledModules: installedBase,
        assignments: [
          { permission: 'audit.read', effect: 'allow', source: 'sso_group', sourceId: 'auditors' },
          { permission: 'audit.export', effect: 'allow', source: 'sso_group', sourceId: 'auditors' },
          { permission: 'compliance.read', effect: 'allow', source: 'sso_group', sourceId: 'auditors' },
        ] as const,
      },
      'platform-admin': {
        subject: user('platform_admin'),
        installedModules: ['argus.core', 'argus.dev', 'argus.aiops', 'argus.hermes', 'public-channels', 'compliance'] as const,
        entitledModules: ['argus.core', 'argus.dev', 'argus.aiops', 'argus.hermes', 'public-channels', 'compliance'] as const,
      },
    };

    for (const example of fixture.examples) {
      const testCase = cases[example.name as keyof typeof cases];
      expect(testCase).toBeDefined();
      const expectedActor = example.response['actor'] as { id: number };
      expect(buildConsoleNavigationCapabilities(
        { ...testCase.subject, id: expectedActor.id },
        {
          installedModules: testCase.installedModules,
          entitledModules: testCase.entitledModules,
          ...('assignments' in testCase ? { assignments: testCase.assignments } : {}),
          now: () => new Date('2026-09-07T12:00:00.000Z'),
        },
      )).toEqual(example.response);
    }
  });
});
