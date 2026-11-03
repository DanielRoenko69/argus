import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';

jest.mock('../executor.js', () => ({
  executeWorkflow: jest.fn(async () => ({ status: 'completed', stepResults: {}, durationMs: 0 })),
  MAX_SUBWORKFLOW_DEPTH: 5,
}));
jest.mock('../../compliance/aiSystemRunBinding.js', () => ({
  bindAiSystemProductionRunAudited: jest.fn(),
}));

import { executeWorkflow } from '../executor.js';
import { bindAiSystemProductionRunAudited } from '../../compliance/aiSystemRunBinding.js';
import { fireWorkflow } from '../triggerWorker.js';
import type { StepRunners } from '../executor.js';
import type { ToolRunner } from '../types.js';

const executeMock = executeWorkflow as jest.MockedFunction<typeof executeWorkflow>;
const gateMock = bindAiSystemProductionRunAudited as jest.MockedFunction<typeof bindAiSystemProductionRunAudited>;

describe('triggered workflow AI-system release gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists the denied root-run decision and never invokes workflow side effects', async () => {
    const updates: string[] = [];
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM mcp_workflows WHERE id')) {
          return {
            rows: [{
              id: 9,
              name: 'governed_trigger',
              description: '',
              steps: [{ id: 'response', label: 'Response', type: 'logic.response', args: { value: 'ok' } }],
              input_params: [],
              enabled: true,
              agent_requirements: [],
              lifecycle_status: 'production',
              ai_act_governed: true,
              ai_system_id: '10000000-0000-4000-8000-000000000001',
              ai_system_revision: 3,
            }],
          };
        }
        if (sql.includes('INSERT INTO mcp_workflow_executions')) return { rows: [{ id: 77 }] };
        if (sql.includes('UPDATE mcp_workflow_executions')) {
          updates.push(sql);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      }),
    } as unknown as pg.Pool;
    gateMock.mockResolvedValueOnce({
      binding: {
        executionAuthorized: false,
        releaseGate: { status: 'blocked', blockingReasons: ['Classification review expired.'] },
      },
      bindingId: '40000000-0000-4000-8000-000000000001',
      bindingSha256: 'a'.repeat(64),
      replayed: false,
      auditEvent: { eventId: 'gate-77' },
    } as never);
    const toolRunner: ToolRunner = async () => ({ content: [{ type: 'text', text: 'unused' }] });
    const toolRunnerFactory = jest.fn(() => toolRunner);

    const result = await fireWorkflow(
      pool,
      9,
      {},
      'cron-scheduler',
      toolRunnerFactory,
      {} as StepRunners,
      undefined,
      { production: true },
    );

    expect(result).toEqual({ executionId: 77, status: 'blocked', duplicate: false });
    expect(gateMock).toHaveBeenCalledWith(pool, expect.objectContaining({
      workflowExecutionId: 77,
      aiSystemRevision: 3,
      producerEventId: 'workflow-production-gate:77',
    }));
    expect(updates).toHaveLength(2);
    expect(toolRunnerFactory).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('does not apply the production gate to a local webhook test', async () => {
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM mcp_workflows WHERE id')) return {
          rows: [{
            id: 9,
            name: 'governed_trigger',
            description: '',
            steps: [{ id: 'response', label: 'Response', type: 'logic.response', args: { value: 'ok' } }],
            input_params: [],
            enabled: true,
            agent_requirements: [],
            lifecycle_status: 'production',
            ai_act_governed: true,
            ai_system_id: '10000000-0000-4000-8000-000000000001',
            ai_system_revision: 3,
          }],
        };
        if (sql.includes('INSERT INTO mcp_workflow_executions')) return { rows: [{ id: 78 }] };
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as pg.Pool;
    const toolRunner: ToolRunner = async () => ({ content: [{ type: 'text', text: 'unused' }] });

    const result = await fireWorkflow(
      pool, 9, {}, 'webhook-test:github', () => toolRunner, {} as StepRunners,
      undefined, { production: false },
    );

    expect(result).toEqual({ executionId: 78, status: 'started', duplicate: false });
    expect(gateMock).not.toHaveBeenCalled();
  });
});
