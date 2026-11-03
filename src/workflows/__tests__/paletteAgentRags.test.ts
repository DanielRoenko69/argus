import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { describeLiveDb } from '../../__tests__/helpers/liveDb.js';
import express from 'express';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import pg from 'pg';
import { registerFlowRoutes } from '../flowRoutes.js';

function fakeAuth(role: 'admin' | 'user', allowed: number[] | null) {
  return (req: Request, _res: Response, next: () => void): void => {
    (req as unknown as { user: { role: string; allowed_bundles: number[] | null } }).user = {
      role, allowed_bundles: allowed,
    };
    next();
  };
}

describeLiveDb('workflow palette — agent rag_indexes (Item 3)', () => {
  let pool: pg.Pool;
  let app: express.Express;
  let server: Server;
  let baseUrl: string;
  let agentId: number;
  let ragEnabledId: number;
  let ragDisabledId: number;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });

    const a = await pool.query<{ id: number }>(`
      INSERT INTO mcp_agents (name, label, model, agent_role, enabled)
      VALUES ('palette_ragsel_agent_i3', 'RagSel Agent I3', 'gpt-4o', 'knowledge', true)
      ON CONFLICT (name) DO UPDATE SET enabled = true, agent_role = EXCLUDED.agent_role RETURNING id
    `);
    agentId = a.rows[0]!.id;

    const r1 = await pool.query<{ id: number }>(`
      INSERT INTO mcp_rag_indexes (name, label, endpoint, index_name, enabled)
      VALUES ('palette_rag_enabled_i3', 'Postmortems I3', 'https://x', 'idx', true)
      ON CONFLICT (name) DO UPDATE SET enabled = true, label = EXCLUDED.label RETURNING id
    `);
    ragEnabledId = r1.rows[0]!.id;

    const r2 = await pool.query<{ id: number }>(`
      INSERT INTO mcp_rag_indexes (name, label, endpoint, index_name, enabled)
      VALUES ('palette_rag_disabled_i3', 'Disabled I3', 'https://x', 'idx', false)
      ON CONFLICT (name) DO UPDATE SET enabled = false, label = EXCLUDED.label RETURNING id
    `);
    ragDisabledId = r2.rows[0]!.id;

    await pool.query(
      `INSERT INTO mcp_agent_rag_indexes (agent_id, rag_index_id, priority)
       VALUES ($1, $2, 0), ($1, $3, 1) ON CONFLICT DO NOTHING`,
      [agentId, ragEnabledId, ragDisabledId]
    );

    app = express();
    app.use(express.json());
    registerFlowRoutes(app, pool, fakeAuth('admin', null));
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
    const addr = server.address();
    if (typeof addr === 'object' && addr) baseUrl = `http://127.0.0.1:${addr.port}`;
    else throw new Error('test server failed to bind');
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) {
      try {
        await pool.query('DELETE FROM mcp_agent_rag_indexes WHERE agent_id = $1', [agentId]);
        await pool.query("DELETE FROM mcp_rag_indexes WHERE name IN ('palette_rag_enabled_i3','palette_rag_disabled_i3')");
        await pool.query("DELETE FROM mcp_agents WHERE name = 'palette_ragsel_agent_i3'");
      } finally {
        await pool.end();
      }
    }
  });

  it('attaches enabled rag_indexes to the agent, ordered by priority/label', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/palette`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      agents: Array<{
        id: number;
        agent_role?: string | null;
        runtime_type?: string | null;
        runtime_profile_label?: string | null;
        runtime_model?: string | null;
        runtime_enabled?: boolean | null;
        rag_indexes?: Array<{ id: number; label: string; name: string }>;
      }>;
    };
    const agent = body.agents.find((a) => a.id === agentId);
    expect(agent).toBeDefined();
    expect(agent!.agent_role).toBe('knowledge');
    expect(agent).toHaveProperty('runtime_type');
    expect(agent).toHaveProperty('runtime_profile_label');
    expect(agent).toHaveProperty('runtime_model');
    expect(agent).toHaveProperty('runtime_enabled');
    expect(Array.isArray(agent!.rag_indexes)).toBe(true);
    // disabled index excluded
    expect(agent!.rag_indexes!.map((r) => r.id)).toEqual([ragEnabledId]);
    expect(agent!.rag_indexes![0]!.label).toBe('Postmortems I3');
    expect(agent!.rag_indexes![0]!.name).toBe('palette_rag_enabled_i3');
  });

  it('returns an empty rag_indexes array for agents with no bindings', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/palette`);
    const body = await res.json() as {
      agents: Array<{ id: number; rag_indexes?: unknown[] }>;
    };
    for (const a of body.agents) expect(Array.isArray(a.rag_indexes)).toBe(true);
  });

  it('exposes enabled Knowledge Sources for the standalone workflow picker', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/palette`);
    const body = await res.json() as {
      rag_indexes: Array<{ id: number; name: string; label: string; provider: string }>;
    };

    expect(body.rag_indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ragEnabledId,
        name: 'palette_rag_enabled_i3',
        label: 'Postmortems I3',
      }),
    ]));
    expect(body.rag_indexes.some((source) => source.id === ragDisabledId)).toBe(false);
  });
});
