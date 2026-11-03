/**
 * Fix B — JSON-repair re-prompt before the Stage-2 422.
 *
 * Very vague prompts (e.g. "Baue einen Self-Healing-Workflow") make gpt-5.1
 * emit prose / truncated / fenced output that JSON.parse rejects → the handler
 * returned HTTP 422 and the Dev got nothing (verified 2026-06-02, 2/2). Fix B
 * does ONE targeted repair re-prompt ("return ONLY valid JSON; if too vague,
 * empty add_nodes with an explanatory rationale") reusing the session, and only
 * 422s if the repair also fails to parse. This turns most vague prompts into a
 * helpful 200 with empty nodes + a "what I need" rationale.
 *
 * Cases:
 *   1. bad JSON → repair returns valid JSON → 200, agent called twice
 *   2. bad JSON → repair also bad → 422, agent called twice
 *   3. valid JSON on first try → 200, agent called ONCE (no repair)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';

jest.mock('../../agents/agentRunner.js', () => ({ runAgentChatSync: jest.fn() }));
jest.mock('../rbacHelpers.js', () => ({
  getRbacUser: jest.fn().mockReturnValue({ allowed_bundles: null }),
  isAdmin: jest.fn().mockReturnValue(true),
}));
jest.mock('../../agents/agentStore.js', () => ({ createSession: jest.fn(async () => ({})) }));

import { runAgentChatSync } from '../../agents/agentRunner.js';
import { registerCopilotRoutes } from '../copilotRoutes.js';

// Empty palette (no tools) so neither the linter nor the arg-check interferes.
function makeFakePool() {
  return {
    query: jest.fn().mockImplementation((sql: unknown) => {
      if (typeof sql === 'string' && sql.includes('workflow_copilot')) {
        return Promise.resolve({ rows: [{ id: 42 }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
}

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

// A structurally-valid response that passes schema + (empty-palette) linter.
const VALID_OUTPUT = JSON.stringify({
  rationale: 'add a manual trigger and a response',
  add_nodes: [
    { id: 'trig', type: 'trigger.manual', position: { x: 50, y: 150 }, data: { label: 'start' } },
    { id: 'resp', type: 'logic.response', position: { x: 300, y: 150 }, data: { label: 'out', value: 'ok' } },
  ],
  add_edges: [{ source: 'trig', target: 'resp' }],
});

// Non-JSON prose (what a vague prompt produces).
const PROSE = 'Sure! Here is a self-healing workflow idea: first you watch the pods, then ...';

describe('POST /api/workflows/copilot — JSON-repair re-prompt (Fix B)', () => {
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
  afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

  function agentReply(response: string): Awaited<ReturnType<typeof runAgentChatSync>> {
    return { response, tool_calls: [] } as unknown as Awaited<ReturnType<typeof runAgentChatSync>>;
  }
  async function post(prompt: string): Promise<Response> {
    return fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: 1, prompt, current_nodes: [] }),
    });
  }

  it('bad JSON first → repair returns valid JSON → 200, agent called twice', async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentReply(PROSE))
      .mockResolvedValueOnce(agentReply(VALID_OUTPUT));

    const r = await post('Baue einen Self-Healing-Workflow');
    expect(r.status).toBe(200);
    const body = await r.json() as { add_nodes: unknown[] };
    expect(body.add_nodes).toHaveLength(2);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    // the repair message must demand valid JSON only
    const repairMsg = mockRunAgent.mock.calls[1]![2] as string;
    expect(repairMsg.toLowerCase()).toContain('valid json');
  });

  it('bad JSON twice → 422, agent called twice', async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentReply(PROSE))
      .mockResolvedValueOnce(agentReply('still not json'));

    const r = await post('Baue einen Self-Healing-Workflow');
    expect(r.status).toBe(422);
    const body = await r.json() as { error: string };
    expect(body.error).toMatch(/valid JSON/i);
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('valid JSON on first try → 200, agent called ONCE (no repair)', async () => {
    mockRunAgent.mockResolvedValueOnce(agentReply(VALID_OUTPUT));

    const r = await post('manueller trigger dann response');
    expect(r.status).toBe(200);
    const body = await r.json() as { add_nodes: unknown[] };
    expect(body.add_nodes).toHaveLength(2);
    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });
});
