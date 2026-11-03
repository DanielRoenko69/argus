import { afterEach, describe, expect, it } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { registerBuilderRoutes } from '../builderRoutes.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

describe('visual workflow template cloning', () => {
  it('preserves inputs, trigger, oversight and the portable Agent contract', async () => {
    const template = {
      id: 197,
      name: 'tpl_governed_agent_delivery',
      description: 'Governed Agent chain',
      steps: [{ id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', args: {} }],
      input_params: [{ name: 'task', type: 'string', description: 'Task', required: true }],
      canvas_state: { viewport: { x: 10, y: 20, zoom: 0.8 } },
      trigger_config: { type: 'manual' },
      block_definitions: [{ id: 'plan', type: 'argus.agent', position: { x: 10, y: 20 }, data: { agent_role: 'planner' } }],
      human_oversight_required: true,
      agent_requirements: [{
        role: 'planner', stepIds: ['plan'], allowedModes: ['chat'],
        requiredSkillNames: [], requiredToolPatterns: [], minimumBundleCount: 0,
      }],
    };
    let insertSql = '';
    let insertParams: unknown[] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("WHERE id = $1 AND source = 'template'")) return { rows: [template] };
        if (sql.includes('INSERT INTO mcp_workflows')) {
          insertSql = sql;
          insertParams = params;
          return { rows: [{ id: 901 }] };
        }
        return { rows: [] };
      },
    } as unknown as pg.Pool;

    const app = express();
    app.use(express.json());
    registerBuilderRoutes(app, pool, (req: Request, _res: Response, next: () => void) => {
      (req as Request & { user: unknown }).user = { id: 42, role: 'admin', allowed_bundles: null };
      next();
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflows/from-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ template_id: 197, name: 'My Agent Flow' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: 901, name: 'my_agent_flow' });
    expect(insertSql).toContain('input_params');
    expect(insertSql).toContain('trigger_config');
    expect(insertSql).toContain('human_oversight_required');
    expect(insertSql).toContain('agent_requirements');
    expect(JSON.parse(String(insertParams[3]))).toEqual(template.input_params);
    expect(JSON.parse(String(insertParams[5]))).toEqual(template.trigger_config);
    expect(insertParams[7]).toBe(42);
    expect(insertParams[8]).toBe(true);
    expect(JSON.parse(String(insertParams[9]))).toEqual(template.agent_requirements);
  });

  it('binds portable integration requirements to the cloning user MCP catalog', async () => {
    const template = {
      id: 200,
      name: 'tpl_github_issue_triage_slack',
      description: 'Portable integration flow',
      steps: [
        {
          id: 'read', label: 'Read issue', type: 'argus.tool',
          tool_binding: {
            integration_id: 'github', action_hints: ['get_issue'], access: 'read',
            required_parameters: ['method', 'owner', 'repo', 'issue_number'],
          },
          args: { method: 'get', owner: '{{ input.owner }}', repo: '{{ input.repo }}', issue_number: '{{ input.issue }}' },
        },
        {
          id: 'notify', label: 'Notify', type: 'argus.tool',
          args: { channel_id: '{{ input.channel }}', text: '{{ steps.read.result }}' }, depends_on: ['read'],
          tool_binding: {
            integration_id: 'slack', action_hints: ['post_message'], access: 'write',
            required_parameters: ['channel_id', 'text'],
          },
        },
      ],
      input_params: [],
      canvas_state: {},
      trigger_config: { type: 'manual' },
      block_definitions: [
        { id: 'read', type: 'argus.tool', position: { x: 0, y: 0 }, data: {} },
        { id: 'notify', type: 'argus.tool', position: { x: 200, y: 0 }, data: {} },
      ],
      human_oversight_required: true,
      agent_requirements: [],
    };
    let insertParams: unknown[] = [];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes("WHERE id = $1 AND source = 'template'")) return { rows: [template] };
        if (sql.includes('FROM mcp_tools t')) {
          return { rows: [
            {
              id: 11, name: 'github_product_get_issue', description: '', backend: 'custom:github-product',
              tool_type: 'dynamic', connection_id: 4, connection_name: 'github-product', is_write: false, risk_level: 'low',
              parameters: [
                { name: 'owner', type: 'string', required: true },
                { name: 'repo', type: 'string', required: true },
                { name: 'issue_number', type: 'number', required: true },
                { name: 'method', type: 'string', required: true },
              ],
            },
            {
              id: 12, name: 'slack_ops_post_message', description: '', backend: 'custom:slack-ops',
              tool_type: 'dynamic', connection_id: 5, connection_name: 'slack-ops', is_write: true, risk_level: 'medium',
              parameters: [
                { name: 'channel_id', type: 'string', required: true },
                { name: 'text', type: 'string', required: true },
              ],
            },
          ] };
        }
        if (sql.includes('FROM mcp_remote_tools')) return { rows: [] };
        if (sql.includes('INSERT INTO mcp_workflows')) {
          insertParams = params;
          return { rows: [{ id: 902 }] };
        }
        return { rows: [] };
      },
    } as unknown as pg.Pool;

    const app = express();
    app.use(express.json());
    registerBuilderRoutes(app, pool, (req: Request, _res: Response, next: () => void) => {
      (req as Request & { user: unknown }).user = { id: 42, role: 'admin', allowed_bundles: null };
      next();
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflows/from-template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ template_id: 200 }),
    });

    expect(response.status).toBe(200);
    const insertedSteps = JSON.parse(String(insertParams[2])) as Array<{ id: string; tool?: string }>;
    const insertedBlocks = JSON.parse(String(insertParams[6])) as Array<{ id: string; data: { tool?: string } }>;
    expect(insertedSteps.find(step => step.id === 'read')?.tool).toBe('github_product_get_issue');
    expect(insertedSteps.find(step => step.id === 'notify')?.tool).toBe('slack_ops_post_message');
    expect(insertedBlocks.find(block => block.id === 'notify')?.data.tool).toBe('slack_ops_post_message');
  });

  it('does not instantiate an integration template with missing capabilities', async () => {
    const template = {
      id: 201,
      name: 'tpl_missing_slack',
      description: 'Missing integration flow',
      steps: [{
        id: 'notify', label: 'Notify', type: 'argus.tool', args: {},
        tool_binding: { integration_id: 'slack', action_hints: ['post_message'], access: 'write' },
      }],
      input_params: [], canvas_state: {}, trigger_config: { type: 'manual' }, block_definitions: [],
      human_oversight_required: true, agent_requirements: [],
    };
    let inserted = false;
    const pool = {
      async query(sql: string) {
        if (sql.includes("WHERE id = $1 AND source = 'template'")) return { rows: [template] };
        if (sql.includes('INSERT INTO mcp_workflows')) inserted = true;
        return { rows: [] };
      },
    } as unknown as pg.Pool;

    const app = express();
    app.use(express.json());
    registerBuilderRoutes(app, pool, (req: Request, _res: Response, next: () => void) => {
      (req as Request & { user: unknown }).user = { id: 42, role: 'admin', allowed_bundles: null };
      next();
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflows/from-template`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ template_id: 201 }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Template integrations are not ready',
      requirements: [expect.objectContaining({ integrationId: 'slack', ready: false })],
    });
    expect(inserted).toBe(false);
  });
});
