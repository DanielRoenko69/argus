import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FabricManagementResponse } from '../types';
import { ToolCoveragePanel } from './ToolCoveragePanel';

const data: FabricManagementResponse = {
  generatedAt: '2026-09-13T12:00:00.000Z',
  bundles: [{
    id: 3,
    name: 'engineering',
    label: 'Engineering',
    description: 'Engineering access',
    icon: 'code',
    agentRole: null,
    systemPrompt: null,
    backendIds: [],
    skillIds: [],
    workflowIds: [],
    workflowCount: 0,
    toolPolicies: [],
    backendCount: 0,
    toolCount: 0,
    compositeCount: 0,
    createdAt: '2026-09-13T12:00:00.000Z',
    updatedAt: '2026-09-13T12:00:00.000Z',
  }],
  backends: [],
  skills: [],
  tools: [{
    backendId: null,
    name: 'issue_create',
    description: 'Create an issue',
    source: 'dynamic',
    enabled: true,
    isWrite: true,
    bundleIds: [],
  }],
};

describe('ToolCoveragePanel safe selection', () => {
  it('never preselects unassigned tools for a security-sensitive bundle mutation', () => {
    render(<ToolCoveragePanel data={data} saving={false} error={null} onAssign={vi.fn()} />);

    expect(screen.getByRole('checkbox', { name: /issue_create/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Assign 0 tools' })).toBeDisabled();
  });
});
