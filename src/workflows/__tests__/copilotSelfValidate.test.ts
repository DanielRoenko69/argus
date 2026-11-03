/**
 * Unit tests for the POST /api/workflows/copilot SELF-VALIDATE loop (P1-7).
 *
 * After the copilot agent returns {rationale, add_nodes[], add_edges[]} the
 * handler lints (currentNodes + add_nodes / add_edges) with the SAME pure
 * validator the manual /validate route uses (validateWorkflowSteps). On
 * errors it does ONE corrective re-prompt (naming the errors); if still
 * invalid it soft-fails: HTTP 200 with a `warnings: string[]` field.
 *
 * Design: we use the REAL validateWorkflowSteps (it is pure / no DB) and craft
 * node payloads that genuinely pass or fail the linter — this exercises the
 * actual integration. Only the LLM (runAgentChatSync) + rbacHelpers are mocked,
 * matching copilotRoutes.test.ts.
 *
 * Cases:
 *   1. valid on first try            → 200, no warnings, agent called once
 *   2. invalid → re-prompt → valid   → 200, no warnings, agent called twice,
 *                                       2nd user message names the error
 *   3. invalid → re-prompt → invalid → 200 with warnings[], agent called twice
 *   4. re-prompt agent throws        → 200 with first result + warning, never 500
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';

// ── mocks (must come before importing the module under test) ─────────────────

jest.mock('../../agents/agentRunner.js', () => ({
  runAgentChatSync: jest.fn(),
}));

jest.mock('../rbacHelpers.js', () => ({
  getRbacUser: jest.fn().mockReturnValue({ allowed_bundles: null }),
  isAdmin: jest.fn().mockReturnValue(true),
}));

jest.mock('../../agents/agentStore.js', () => ({
  createSession: jest.fn(async () => ({})),
}));

// ── imports after mocks ──────────────────────────────────────────────────────

import { runAgentChatSync } from '../../agents/agentRunner.js';
import { registerCopilotRoutes } from '../copilotRoutes.js';

// ── fake pg.Pool ─────────────────────────────────────────────────────────────
// Same shape as copilotRoutes.test.ts: getCopilotAgentId query (contains
// 'workflow_copilot') → [{id:42}], all palette queries → [].
function makeFakePool() {
  return {
    query: jest.fn().mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('workflow_copilot')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      if (typeof sql === 'string' && sql.includes('FROM mcp_tools')) {
        return Promise.resolve({ rows: [{
          id: 9,
          name: 'k8s_get',
          description: 'Read Kubernetes state',
          backend: 'custom:kubernetes',
          tool_type: 'dynamic',
          parameters: [],
          connection_id: 3,
          connection_name: 'kubernetes',
          is_write: false,
          risk_level: 'low',
        }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

// ── agent output fixtures ────────────────────────────────────────────────────
// VALID: a manual trigger feeding a tool step that HAS a `tool` name, connected
// by an edge. Passes the real validator with zero errors.
const VALID_OUTPUT = JSON.stringify({
  rationale: 'add a manual trigger and a tool step',
  add_nodes: [
    { id: 'trigger.1', type: 'trigger.manual', position: { x: 50, y: 150 }, data: { label: 'start' } },
    { id: 'step.tool1', type: 'argus.tool', position: { x: 300, y: 150 }, data: { label: 'run', tool: 'k8s_get' } },
  ],
  add_edges: [{ source: 'trigger.1', target: 'step.tool1' }],
});

// INVALID: an argus.tool node WITHOUT a `tool` name → real validator error
// "step.bad: argus.tool step missing `tool` name".
const INVALID_OUTPUT = JSON.stringify({
  rationale: 'add a tool step without a tool name (invalid)',
  add_nodes: [{ id: 'step.bad', type: 'argus.tool', position: { x: 50, y: 150 }, data: { label: 'broken' } }],
  add_edges: [],
});

const VALID_AGENT_OUTPUT = JSON.stringify({
  rationale: 'add a portable planner Agent',
  add_nodes: [{
    id: 'step.plan',
    type: 'argus.agent',
    position: { x: 50, y: 150 },
    data: { label: 'Plan', args: { agent_role: 'planner', prompt: 'Plan the task' } },
  }],
  add_edges: [],
});

const EXPECTED_TOOL_ERROR = 'step.bad: argus.tool step missing `tool` name';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  const noAuth = (_req: express.Request, _res: express.Response, next: () => void): void => next();
  registerCopilotRoutes(
    app,
    makeFakePool() as unknown as import('pg').Pool,
    {} as import('../../config/env.js').Config,
    noAuth,
  );
  return app;
}

// ── test suite ───────────────────────────────────────────────────────────────

describe('POST /api/workflows/copilot — self-validate loop', () => {
  let server: Server;
  let baseUrl: string;
  const mockRunAgent = runAgentChatSync as jest.MockedFunction<typeof runAgentChatSync>;

  beforeEach(async () => {
    mockRunAgent.mockReset();
    await new Promise<void>((resolve) => { server = makeApp().listen(0, () => resolve()); });
    const addr = server.address();
    if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
    else throw new Error('test server failed to bind');
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function agentReply(response: string): Awaited<ReturnType<typeof runAgentChatSync>> {
    return { response, tool_calls: [] } as unknown as Awaited<ReturnType<typeof runAgentChatSync>>;
  }

  async function post(prompt: string): Promise<Response> {
    return fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: 1, prompt, current_nodes: [] }),
    });
  }

  it('valid on first try → 200, no warnings, agent called exactly once', async () => {
    mockRunAgent.mockResolvedValueOnce(agentReply(VALID_OUTPUT));

    const r = await post('add a trigger and a tool');
    expect(r.status).toBe(200);
    const body = await r.json() as { rationale: string; add_nodes: unknown[]; warnings?: string[] };
    expect(body.add_nodes).toHaveLength(2);
    expect(body.warnings).toBeUndefined();
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('repairs a nested portable Agent role before validation without a corrective model call', async () => {
    mockRunAgent.mockResolvedValueOnce(agentReply(VALID_AGENT_OUTPUT));

    const r = await post('add a planner');
    expect(r.status).toBe(200);
    const body = await r.json() as {
      add_nodes: Array<{ data: Record<string, unknown> }>;
      warnings?: string[];
    };
    expect(body.warnings).toBeUndefined();
    expect(body.add_nodes[0]?.data['agent_role']).toBe('planner');
    expect(body.add_nodes[0]?.data['args']).toEqual({ prompt: 'Plan the task' });
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it('invalid first → ONE corrective re-prompt → valid: 200, no warnings, agent called twice', async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentReply(INVALID_OUTPUT))
      .mockResolvedValueOnce(agentReply(VALID_OUTPUT));

    const r = await post('add a tool');
    expect(r.status).toBe(200);
    const body = await r.json() as { add_nodes: unknown[]; warnings?: string[] };
    expect(body.add_nodes).toHaveLength(2);            // the corrected (valid) output
    expect(body.warnings).toBeUndefined();
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    // The 2nd (corrective) call must carry the validation error in its user message.
    const secondMsg = mockRunAgent.mock.calls[1]![2];
    expect(secondMsg).toContain(EXPECTED_TOOL_ERROR);
  });

  it('still invalid after re-prompt → 200 with warnings[], agent called twice', async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentReply(INVALID_OUTPUT))
      .mockResolvedValueOnce(agentReply(INVALID_OUTPUT));

    const r = await post('add a tool');
    expect(r.status).toBe(200);
    const body = await r.json() as { add_nodes: unknown[]; warnings?: string[] };
    expect(body.add_nodes).toHaveLength(1);            // the (still-invalid) last output is returned
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings).toContain(EXPECTED_TOOL_ERROR);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('re-prompt agent throws → 200 with first result + warning, never 500/empty', async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentReply(INVALID_OUTPUT))
      .mockRejectedValueOnce(new Error('upstream gateway 502'));

    const r = await post('add a tool');
    expect(r.status).toBe(200);                         // soft-fail, NOT 500
    const text = await r.text();
    expect(text.length).toBeGreaterThan(0);             // never an empty response
    const body = JSON.parse(text) as { add_nodes: unknown[]; warnings?: string[] };
    expect(body.add_nodes).toHaveLength(1);             // the first (un-revalidated) result
    expect(Array.isArray(body.warnings)).toBe(true);
    // warnings carry both the original validation error and the re-prompt failure note.
    expect(body.warnings).toContain(EXPECTED_TOOL_ERROR);
    expect(body.warnings!.some((w) => /re-prompt failed/i.test(w) && /gateway 502/i.test(w))).toBe(true);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });
});
