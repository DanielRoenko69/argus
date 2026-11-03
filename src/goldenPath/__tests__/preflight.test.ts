import { describe, expect, it } from '@jest/globals';
import { buildGoldenPathPreflight, loadGoldenPathDeploymentProfile, parseGoldenPathPreflightQuery, type GoldenPathPreflightSnapshot } from '../preflight.js';

const HASH_INPUT = { bounded: true };

function readySnapshot(): GoldenPathPreflightSnapshot {
  const profile = loadGoldenPathDeploymentProfile('certification', {});
  return {
    generatedAt: '2026-09-10T10:00:00.000Z',
    profile,
    coreReady: true,
    argusDev: { state: 'ready', detail: 'Argus Dev is ready.' },
    workflow: {
      id: 42,
      name: profile.workflowName,
      revision: 3,
      definition: {
        ...HASH_INPUT,
        steps: [
          { id: 'read_issue', type: 'argus.tool', tool: 'get_issue', args: {} },
          { id: 'approval', type: 'argus.approval', condition: "input.write_mode === 'guarded'", depends_on: ['read_issue'], args: {} },
          { id: 'comment', type: 'argus.tool', tool: 'comment_issue', condition: "input.write_mode === 'guarded'", depends_on: ['approval'], args: {} },
          { id: 'notify', type: 'argus.tool', tool: 'post_message', condition: "input.write_mode === 'guarded'", depends_on: ['approval'], args: {} },
        ],
      },
      humanOversightRequired: true,
      agentBound: true,
    },
    agent: { id: 7, name: profile.agentName, revision: '2026-09-10T09:00:00.000Z', definition: HASH_INPUT, authorized: true },
    runtime: { state: 'ready', detail: 'Hermes is ready.', selected: 'hermes', profileId: '9', binding: HASH_INPUT },
    git: { bundleName: profile.git.bundleName, bundleId: 3, authorized: true, assignedToWorkflow: true, state: 'ready', detail: 'Git ready.', toolNames: ['get_issue', 'comment_issue'] },
    notification: { bundleName: profile.notification.bundleName, bundleId: 4, authorized: true, assignedToWorkflow: true, state: 'ready', detail: 'Slack fixture ready.', toolNames: ['post_message'] },
    evidence: { state: 'ready', detail: 'Evidence ready.' },
  };
}

describe('Golden Path live preflight projection', () => {
  it('builds a startable guarded certification result from real-state snapshots', () => {
    const result = buildGoldenPathPreflight(readySnapshot(), { mode: 'certification', writeMode: 'guarded' });
    expect(result).toMatchObject({
      state: 'ready',
      allowedActions: ['start', 'refresh'],
      workflow: { id: '42', revision: '3', saved: true, agent: { id: '7' } },
      runtime: { preferred: 'hermes', selected: 'hermes' },
      policy: { approvalRequired: true, separationOfDutiesRequired: true },
    });
    expect(result.targets.git.writeScopeSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps the same saved workflow read-only without manufacturing approval', () => {
    const result = buildGoldenPathPreflight(readySnapshot(), { mode: 'certification', writeMode: 'read_only' });
    expect(result).toMatchObject({
      state: 'ready',
      policy: { writeMode: 'read_only', approvalRequired: false, separationOfDutiesRequired: false, writes: [] },
    });
  });

  it('blocks start and provides recovery links when a required connector is missing', () => {
    const snapshot = readySnapshot();
    snapshot.notification.state = 'not_configured';
    snapshot.notification.detail = 'Missing exact bundle.';
    const result = buildGoldenPathPreflight(snapshot, { mode: 'certification', writeMode: 'guarded' });
    expect(result.state).toBe('blocked');
    expect(result.allowedActions).toEqual(['refresh', 'configure']);
    expect(result.checks.find(check => check.id === 'mcp_notification')).toMatchObject({
      state: 'not_configured',
      recovery: { href: '/build/mcp-fabric?intent=golden-path-notification' },
    });
  });

  it('does not treat an editable workflow row without a saved revision as frozen', () => {
    const snapshot = readySnapshot();
    snapshot.workflow!.revision = 0;
    const result = buildGoldenPathPreflight(snapshot, { mode: 'certification', writeMode: 'guarded' });
    expect(result.state).toBe('blocked');
    expect(result.checks.find(check => check.id === 'workflow')).toMatchObject({ state: 'blocked' });
  });

  it('blocks a workflow whose writes can bypass the conditional approval', () => {
    const snapshot = readySnapshot();
    const definition = snapshot.workflow!.definition as { steps: Array<Record<string, unknown>> };
    definition.steps[2] = { ...definition.steps[2], condition: undefined };
    const result = buildGoldenPathPreflight(snapshot, { mode: 'certification', writeMode: 'read_only' });
    expect(result.state).toBe('blocked');
    expect(result.checks.find(check => check.id === 'policy')?.detail).toContain('must be guarded');
  });

  it('requires every live target identifier without falling back to certification fixtures', () => {
    const profile = loadGoldenPathDeploymentProfile('live_demo', {});
    expect(profile.configured).toBe(false);
    expect(profile.missing).toEqual(expect.arrayContaining([
      'ARGUS_GOLDEN_PATH_GIT_REPOSITORY',
      'ARGUS_GOLDEN_PATH_NOTIFICATION_DESTINATION',
    ]));
    expect(profile.git.provider).toBe('github');
    expect(profile.notification.provider).toBe('slack');
  });

  it('validates mode, write mode and credential-free origins', () => {
    expect(parseGoldenPathPreflightQuery({})).toEqual({ mode: 'certification', writeMode: 'guarded' });
    expect(() => parseGoldenPathPreflightQuery({ mode: 'mock' })).toThrow(/mode/);
    expect(() => loadGoldenPathDeploymentProfile('certification', {
      ARGUS_GOLDEN_PATH_GIT_ORIGIN: 'https://token@example.com',
    })).toThrow(/without credentials/);
  });
});
