import { describe, it, expect } from 'vitest';
import { serializeToolNodeData, type ToolNodeData } from '../toolNodeSerialize';

describe('serializeToolNodeData', () => {
  it('produces an argus.tool step shape with tool + args', () => {
    const data: ToolNodeData = {
      label: 'Create Jira issue',
      tool: 'jira_create_issue',
      args: { project: 'OPS', summary: '{{ trigger.title }}' },
    };
    expect(serializeToolNodeData(data)).toEqual({
      type: 'argus.tool',
      tool: 'jira_create_issue',
      args: { project: 'OPS', summary: '{{ trigger.title }}' },
    });
  });

  it('includes cred_ref when a bundle is bound', () => {
    const data: ToolNodeData = {
      label: 'Grafana query',
      tool: 'grafana_query',
      args: {},
      cred_ref: { bundle_id: 7 },
    };
    expect(serializeToolNodeData(data)).toEqual({
      type: 'argus.tool',
      tool: 'grafana_query',
      args: {},
      cred_ref: { bundle_id: 7 },
    });
  });

  it('omits cred_ref for the default service account (no bundle)', () => {
    const result = serializeToolNodeData({ label: 'x', tool: 'http_request', args: {} });
    expect('cred_ref' in result).toBe(false);
  });

  it('defaults tool/args to empty when unset', () => {
    const result = serializeToolNodeData({ label: 'empty' });
    expect(result).toEqual({ type: 'argus.tool', tool: null, args: {} });
  });
});
