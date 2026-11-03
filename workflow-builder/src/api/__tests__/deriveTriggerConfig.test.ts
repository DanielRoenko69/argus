import { describe, it, expect } from 'vitest';
import type { Node } from 'reactflow';
import { deriveTriggerConfig, buildSavePayload } from '../workflows';

const node = (type: string, data: Record<string, unknown>): Node =>
  ({ id: 't1', type, position: { x: 0, y: 0 }, data } as Node);

describe('deriveTriggerConfig', () => {
  it('returns undefined when there is no trigger node', () => {
    const nodes = [node('argus.tool', { tool: 'k8s_apply' })];
    expect(deriveTriggerConfig(nodes)).toBeUndefined();
  });

  it('derives a cron config from a schedule trigger', () => {
    expect(deriveTriggerConfig([node('trigger.schedule', { cron_expr: '*/5 * * * *' })]))
      .toEqual({ type: 'cron', cron_expr: '*/5 * * * *' });
  });

  it('persists static non-secret inputs for scheduled workflows', () => {
    expect(deriveTriggerConfig([node('trigger.schedule', {
      cron_expr: '*/5 * * * *',
      schedule_static_inputs: '{"repository_owner":"argus","issue_number":7}',
    })])).toEqual({
      type: 'cron',
      cron_expr: '*/5 * * * *',
      static_inputs: { repository_owner: 'argus', issue_number: 7 },
    });
  });

  it('does not publish malformed scheduled input JSON', () => {
    expect(deriveTriggerConfig([node('trigger.schedule', {
      cron_expr: '*/5 * * * *',
      schedule_static_inputs: '{broken',
    })])).toEqual({ type: 'cron', cron_expr: '*/5 * * * *' });
  });

  it('defaults the cron expression when blank', () => {
    expect(deriveTriggerConfig([node('trigger.schedule', { cron_expr: '  ' })]))
      .toEqual({ type: 'cron', cron_expr: '0 * * * *' });
  });

  it('derives a webhook config and normalises the path to a single leading slash', () => {
    expect(deriveTriggerConfig([node('trigger.webhook', { webhook_path: 'deploy' })]))
      .toEqual({ type: 'webhook', webhook_path: '/deploy' });
    expect(deriveTriggerConfig([node('trigger.webhook', { webhook_path: '///deploy' })]))
      .toEqual({ type: 'webhook', webhook_path: '/deploy' });
  });

  it('includes webhook_secret_env only when set (audit #1 per-workflow secret)', () => {
    expect(deriveTriggerConfig([node('trigger.webhook', { webhook_path: 'd', webhook_secret_env: '  ' })]))
      .toEqual({ type: 'webhook', webhook_path: '/d' });
    expect(deriveTriggerConfig([node('trigger.webhook', { webhook_path: 'd', webhook_secret_env: 'WF_DEPLOY_SECRET' })]))
      .toEqual({ type: 'webhook', webhook_path: '/d', webhook_secret_env: 'WF_DEPLOY_SECRET' });
  });

  it('persists provider event filters and static workflow inputs', () => {
    expect(deriveTriggerConfig([node('trigger.webhook', {
      webhook_path: 'github-issues',
      webhook_provider: 'github',
      webhook_allowed_events: 'issues, ping',
      webhook_static_inputs: '{"notification_channel":"C123"}',
    })])).toEqual({
      type: 'webhook',
      webhook_path: '/github-issues',
      provider: 'github',
      allowed_events: ['issues', 'ping'],
      static_inputs: { notification_channel: 'C123' },
    });
  });

  it('does not publish malformed static-input JSON into the executable config', () => {
    expect(deriveTriggerConfig([node('trigger.webhook', {
      webhook_path: 'github-issues',
      webhook_static_inputs: '{broken',
    })])).toEqual({ type: 'webhook', webhook_path: '/github-issues' });
  });

  it('maps a manual trigger to {type:manual}', () => {
    expect(deriveTriggerConfig([node('trigger.manual', {})])).toEqual({ type: 'manual' });
  });

  it('buildSavePayload includes trigger_config when a trigger node exists, omits otherwise', () => {
    const withTrigger = buildSavePayload(
      [node('trigger.webhook', { webhook_path: 'x' })],
      [],
      { x: 0, y: 0, zoom: 1 },
    );
    expect(withTrigger.trigger_config).toEqual({ type: 'webhook', webhook_path: '/x' });

    const withoutTrigger = buildSavePayload(
      [node('argus.tool', { tool: 'k8s_apply' })],
      [],
      { x: 0, y: 0, zoom: 1 },
    );
    expect('trigger_config' in withoutTrigger).toBe(false);
  });
});
