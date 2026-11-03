/**
 * Unit tests for POST /api/workflows/copilot
 *
 * Mocks:
 *   - ../../agents/agentRunner.js (runAgentChatSync)
 *   - ../rbacHelpers.js (getRbacUser, isAdmin)
 *   - pg.Pool (first query returns [{id:42}], rest return [])
 *
 * Four cases:
 *   1. agent throws  → 500, non-empty body, error contains 'gateway 502'
 *   2. non-JSON reply → 422, error /json/i, raw contains 'sorry'
 *   3. valid JSON but missing add_nodes → 422, error contains 'add_nodes'
 *   4. good reply   → 200, validated CopilotResponse
 */

import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
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
import { createSession } from '../../agents/agentStore.js';
import { registerCopilotRoutes } from '../copilotRoutes.js';

// ── fake pg.Pool ─────────────────────────────────────────────────────────────
//
// Per request the handler makes exactly 4 queries:
//   1. getCopilotAgentId → [{id:42}]
//   2. loadAccessiblePalette: skills  → []
//   3. loadAccessiblePalette: agents  → []
//   4. loadAccessiblePalette: tools   → []
// We detect the agent-id query by its SQL content and return {id:42},
// otherwise return an empty rowset.
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

// ── test suite ───────────────────────────────────────────────────────────────

describe('POST /api/workflows/copilot', () => {
  let server: Server;
  let baseUrl: string;
  const mockRunAgent = runAgentChatSync as jest.MockedFunction<typeof runAgentChatSync>;
  const mockCreateSession = createSession as jest.MockedFunction<typeof createSession>;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());

    // Stub requireAuth — just calls next()
    const noAuth = (_req: express.Request, _res: express.Response, next: () => void) => next();

    const fakeConfig = {} as import('../../config/env.js').Config;

    registerCopilotRoutes(app, makeFakePool() as unknown as import('pg').Pool, fakeConfig, noAuth);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    if (typeof addr === 'object' && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`;
    } else {
      throw new Error('test server failed to bind');
    }
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('500 with non-empty error body when agent throws', async () => {
    mockRunAgent.mockRejectedValueOnce(new Error('upstream gateway 502'));

    const res = await fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: 1, prompt: 'add a trigger' }),
    });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toMatch(/gateway 502/i);
  });

  it('422 with error /json/i and raw when agent returns non-JSON', async () => {
    mockRunAgent.mockResolvedValueOnce({
      response: "sorry, I don't know",
      tool_calls: [],
    } as unknown as Awaited<ReturnType<typeof runAgentChatSync>>);

    const res = await fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: 1, prompt: 'add a trigger' }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; raw: string };
    expect(body.error).toMatch(/json/i);
    expect(body.raw).toContain('sorry');
  });

  it('422 when JSON is valid but missing add_nodes field', async () => {
    mockRunAgent.mockResolvedValueOnce({
      response: JSON.stringify({ rationale: 'here you go', add_edges: [] }),
      tool_calls: [],
    } as unknown as Awaited<ReturnType<typeof runAgentChatSync>>);

    const res = await fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: 1, prompt: 'add a trigger' }),
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('add_nodes');
  });

  it('200 with validated CopilotResponse on good reply', async () => {
    const goodReply = {
      rationale: 'Adding a manual trigger',
      add_nodes: [
        {
          id: 'step.abc123',
          type: 'trigger.manual',
          position: { x: 50, y: 150 },
          data: { label: 'Start' },
        },
      ],
      add_edges: [],
    };

    mockRunAgent.mockResolvedValueOnce({
      response: JSON.stringify(goodReply),
      tool_calls: [],
    } as unknown as Awaited<ReturnType<typeof runAgentChatSync>>);

    const res = await fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow_id: 1,
        prompt: 'add a trigger',
        current_nodes: [
          { id: 'existing.start', type: 'trigger.manual', position: { x: 0, y: 0 }, data: { label: 'Existing start' } },
          { id: 'existing.read', type: 'argus.tool', position: { x: 200, y: 0 }, data: { label: 'Existing read', tool: 'read' } },
        ],
        current_edges: [{ source: 'existing.start', target: 'existing.read' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as typeof goodReply;
    expect(body.rationale).toBe('Adding a manual trigger');
    expect(body.add_nodes).toHaveLength(1);
    expect(body.add_nodes[0]?.type).toBe('trigger.manual');
    expect(body.add_edges).toHaveLength(0);
    expect((body as typeof body & { update_nodes: unknown[] }).update_nodes).toEqual([]);
    const prompt = mockRunAgent.mock.calls.at(-1)?.[2];
    expect(prompt).toContain('EXISTING_EDGES on canvas:');
    expect(prompt).toContain('existing.start -> existing.read');
    expect(prompt).toContain('data={"label":"Existing read","tool":"read"}');
  });

  it('returns a data-only patch for an existing canvas node', async () => {
    const reply = {
      rationale: 'Rename the existing trigger without replacing it',
      add_nodes: [],
      update_nodes: [{ id: 'existing.start', data: { label: 'Start triage' } }],
      add_edges: [],
    };
    mockRunAgent.mockResolvedValueOnce({
      response: JSON.stringify(reply),
      tool_calls: [],
    } as unknown as Awaited<ReturnType<typeof runAgentChatSync>>);

    const res = await fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workflow_id: 1,
        prompt: 'rename the existing trigger',
        current_nodes: [{ id: 'existing.start', type: 'trigger.manual', position: { x: 10, y: 20 }, data: { label: 'Start', retained: true } }],
        current_edges: [],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as typeof reply;
    expect(body.update_nodes).toEqual([{
      id: 'existing.start',
      data: { label: 'Start triage', retained: true },
    }]);
    expect(body.add_nodes).toEqual([]);
  });

  it('500 with non-empty JSON error body when createSession rejects', async () => {
    mockCreateSession.mockRejectedValueOnce(new Error('DB connection refused'));

    const res = await fetch(`${baseUrl}/api/workflows/copilot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflow_id: 1, prompt: 'add a trigger' }),
    });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    const body = JSON.parse(text) as { error: string };
    expect(body.error).toMatch(/DB connection refused/i);
  });
});
