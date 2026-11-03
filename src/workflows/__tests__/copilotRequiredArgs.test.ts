/**
 * Fix A — required-arg check in the copilot self-validate loop.
 *
 * The palette already carries each tool's `parameters` (name/type/required,
 * exposed in P2-4). The copilot's #1 reliability gap is that on long tool
 * chains gpt-5.1 picks the RIGHT tool but emits it with EMPTY args (verified
 * 2026-06-02 live test: same coding prompt 3× → 1 filled, 2 all-empty). The
 * structural linter (validateWorkflowSteps) can't catch this — it doesn't know
 * tool arg schemas. findMissingRequiredArgs closes that gap by checking each
 * argus.tool node's `data.args` against the palette's required params, feeding
 * the SAME corrective re-prompt + warnings[] path the linter uses.
 *
 * Two layers of test:
 *   (1) pure unit tests of findMissingRequiredArgs (no DB, no HTTP)
 *   (2) integration over POST /api/workflows/copilot with a palette-bearing
 *       fake pool — empty-arg tool node → re-prompt names the missing arg →
 *       filled → 200; still-missing → 200 with warnings[].
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';

// ── pure unit tests (no mocks needed) ─────────────────────────────────────────
import {
  enrichCopilotToolBindings,
  findMissingRequiredArgs,
  findUnavailableTools,
  parameterizeCopilotResourceArgs,
} from '../copilotRoutes.js';

// A minimal palette: one tool with a required arg, one with none, one optional-only.
const PALETTE = {
  skills: [],
  agents: [],
  tools: [
    { id: 1, name: 'jira_get_issue', backend: 'custom', parameters: [
      { name: 'issueKey', type: 'string', required: true },
    ] },
    { id: 2, name: 'bitbucket_create_branch', backend: 'custom', parameters: [
      { name: 'project', type: 'string', required: true },
      { name: 'repo', type: 'string', required: true },
      { name: 'branch', type: 'string', required: true },
      { name: 'start_point', type: 'string', required: false },
    ] },
    { id: 3, name: 'noparams_tool', backend: 'custom', parameters: [] },
    { id: 4, name: 'opt_only_tool', backend: 'custom', parameters: [
      { name: 'limit', type: 'number', required: false },
    ] },
    { id: 5, name: 'falsy_args_tool', backend: 'custom', parameters: [
      { name: 'count', type: 'number', required: true },
      { name: 'flag', type: 'boolean', required: true },
    ] },
  ],
};

function toolNode(tool: string | undefined, args?: Record<string, unknown>) {
  const data: Record<string, unknown> = { label: 'x' };
  if (tool !== undefined) data['tool'] = tool;
  if (args !== undefined) data['args'] = args;
  return { id: `n_${tool ?? 'none'}`, type: 'argus.tool', data };
}

describe('findMissingRequiredArgs (pure)', () => {
  it('returns [] when all required args are present and non-empty', () => {
    const issues = findMissingRequiredArgs([toolNode('jira_get_issue', { issueKey: 'ARGUS-1' })], PALETTE);
    expect(issues).toEqual([]);
  });

  it('flags a tool node with NO args object at all', () => {
    const issues = findMissingRequiredArgs([toolNode('jira_get_issue')], PALETTE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('issueKey');
    expect(issues[0]).toContain('jira_get_issue');
  });

  it('flags a required arg present but whitespace-only', () => {
    const issues = findMissingRequiredArgs([toolNode('jira_get_issue', { issueKey: '   ' })], PALETTE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('issueKey');
  });

  it('flags a required arg present but literal empty string', () => {
    const issues = findMissingRequiredArgs([toolNode('jira_get_issue', { issueKey: '' })], PALETTE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('issueKey');
  });

  it('does NOT flag falsy-but-present required args (number 0, boolean false)', () => {
    // Regression guard: the missing-check must treat 0 / false as PRESENT.
    // A naive `if (!v)` rewrite would wrongly flag these and this test would catch it.
    const issues = findMissingRequiredArgs([toolNode('falsy_args_tool', { count: 0, flag: false })], PALETTE);
    expect(issues).toEqual([]);
  });

  it('flags each missing required arg independently, ignores optional', () => {
    const issues = findMissingRequiredArgs(
      [toolNode('bitbucket_create_branch', { project: 'P' })], // repo + branch missing, start_point optional
      PALETTE,
    );
    expect(issues).toHaveLength(2);
    expect(issues.join(' ')).toContain('repo');
    expect(issues.join(' ')).toContain('branch');
    expect(issues.join(' ')).not.toContain('start_point');
  });

  it('ignores tools with no params (freeform)', () => {
    expect(findMissingRequiredArgs([toolNode('noparams_tool')], PALETTE)).toEqual([]);
  });

  it('ignores tools whose only params are optional', () => {
    expect(findMissingRequiredArgs([toolNode('opt_only_tool')], PALETTE)).toEqual([]);
  });

  it('ignores a tool name not present in the palette (cannot check schema)', () => {
    expect(findMissingRequiredArgs([toolNode('unknown_tool')], PALETTE)).toEqual([]);
  });

  it('ignores non argus.tool nodes entirely', () => {
    const nodes = [
      { id: 't', type: 'trigger.manual', data: {} },
      { id: 'a', type: 'argus.agent', data: { agent_id: 8 } },
      { id: 'r', type: 'logic.response', data: {} },
    ];
    expect(findMissingRequiredArgs(nodes, PALETTE)).toEqual([]);
  });

  it('ignores an argus.tool node missing its `tool` key (linter already flags that)', () => {
    expect(findMissingRequiredArgs([toolNode(undefined)], PALETTE)).toEqual([]);
  });
});

describe('findUnavailableTools (pure)', () => {
  it('accepts an exact tool from the RBAC-filtered palette', () => {
    expect(findUnavailableTools([toolNode('jira_get_issue')], PALETTE)).toEqual([]);
  });

  it('flags a model-invented tool name before it reaches the canvas', () => {
    expect(findUnavailableTools([toolNode('github_delete_everything')], PALETTE)).toEqual([
      "n_github_delete_everything: tool 'github_delete_everything' is not available in the user's MCP bundle palette",
    ]);
  });
});

describe('enrichCopilotToolBindings (pure)', () => {
  it('adds a portable write contract to a Copilot-selected Slack tool', () => {
    const palette = {
      skills: [],
      agents: [],
      tools: [{
        id: 9,
        name: 'company_slack_post_message',
        backend: 'remote:company-slack',
        parameters: [
          { name: 'channel_id', type: 'string', required: true },
          { name: 'text', type: 'string', required: true },
          { name: 'thread_ts', type: 'string', required: false },
        ],
        action_label: 'Post Message',
        integration_id: 'slack',
        integration_label: 'Slack',
        is_write: true,
      }],
    };

    const [node] = enrichCopilotToolBindings([
      toolNode('company_slack_post_message', { channel_id: 'C1', text: 'Done' }),
    ], palette);

    expect(node?.data).toMatchObject({
      tool: 'company_slack_post_message',
      integration_id: 'slack',
      tool_binding: {
        integration_id: 'slack',
        action_hints: ['post_message'],
        access: 'write',
        required_parameters: ['channel_id', 'text'],
      },
    });
  });

  it('leaves an unclassified concrete tool unchanged', () => {
    const [node] = enrichCopilotToolBindings([toolNode('jira_get_issue')], PALETTE);
    expect(node?.data['tool_binding']).toBeUndefined();
    expect(node?.data['tool']).toBe('jira_get_issue');
  });
});

describe('parameterizeCopilotResourceArgs (pure)', () => {
  const slackPalette = {
    skills: [],
    agents: [],
    tools: [{
      id: 9,
      name: 'company_slack_post_message',
      backend: 'remote:company-slack',
      parameters: [
        { name: 'channel_id', type: 'string', required: true },
        { name: 'text', type: 'string', required: true },
      ],
      integration_id: 'slack',
      is_write: true,
    }],
  };

  it('turns a Slack display name into a required environment-specific run input', () => {
    const result = parameterizeCopilotResourceArgs([
      toolNode('company_slack_post_message', { channel_id: 'coding-ops', text: 'Done' }),
    ], slackPalette);

    expect(result.nodes[0]?.data['args']).toMatchObject({
      channel_id: '{{ input.notification_channel }}',
      text: 'Done',
    });
    expect(result.inputParams).toEqual([{
      name: 'notification_channel',
      type: 'string',
      description: 'Slack channel ID for requested destination "coding-ops" (for example C01234567)',
      required: true,
    }]);
  });

  it('keeps a concrete Slack channel id without adding a run input', () => {
    const result = parameterizeCopilotResourceArgs([
      toolNode('company_slack_post_message', { channel_id: 'C063971UL64', text: 'Done' }),
    ], slackPalette);

    expect(result.nodes[0]?.data['args']).toMatchObject({ channel_id: 'C063971UL64' });
    expect(result.inputParams).toEqual([]);
  });

  it('declares an existing Slack input reference without renaming it', () => {
    const result = parameterizeCopilotResourceArgs([
      toolNode('company_slack_post_message', { channel_id: '{{ input.slack_target }}', text: 'Done' }),
    ], slackPalette);

    expect(result.nodes[0]?.data['args']).toMatchObject({ channel_id: '{{ input.slack_target }}' });
    expect(result.inputParams).toEqual([expect.objectContaining({ name: 'slack_target', required: true })]);
  });
});

// ── integration over the HTTP route ───────────────────────────────────────────

jest.mock('../../agents/agentRunner.js', () => ({ runAgentChatSync: jest.fn() }));
jest.mock('../rbacHelpers.js', () => ({
  getRbacUser: jest.fn().mockReturnValue({ allowed_bundles: null }),
  isAdmin: jest.fn().mockReturnValue(true),
}));
jest.mock('../../agents/agentStore.js', () => ({ createSession: jest.fn(async () => ({})) }));

import { runAgentChatSync } from '../../agents/agentRunner.js';
import { registerCopilotRoutes } from '../copilotRoutes.js';

// Fake pool: copilot-agent lookup → {id:42}; the tools palette query (FROM
// mcp_tools) → the jira tool with a REQUIRED issueKey; everything else → [].
function makeFakePool() {
  return {
    query: jest.fn().mockImplementation((sql: unknown) => {
      const s = typeof sql === 'string' ? sql : '';
      if (s.includes('workflow_copilot')) return Promise.resolve({ rows: [{ id: 42 }] });
      if (s.includes('FROM mcp_tools')) {
        return Promise.resolve({ rows: [
          { id: 1, name: 'jira_get_issue', backend: 'custom',
            parameters: [{ name: 'issueKey', type: 'string', required: true }] },
        ] });
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

// trigger → jira_get_issue WITHOUT args (passes the structural linter, fails the arg check).
const MISSING_ARG_OUTPUT = JSON.stringify({
  rationale: 'fetch the issue',
  add_nodes: [
    { id: 'trig', type: 'trigger.manual', position: { x: 50, y: 150 }, data: { label: 'start' } },
    { id: 'get',  type: 'argus.tool',     position: { x: 300, y: 150 }, data: { label: 'get', tool: 'jira_get_issue' } },
  ],
  add_edges: [{ source: 'trig', target: 'get' }],
});

// Same, but with the required arg filled (already nested under data.args).
const FILLED_ARG_OUTPUT = JSON.stringify({
  rationale: 'fetch the issue (corrected)',
  add_nodes: [
    { id: 'trig', type: 'trigger.manual', position: { x: 50, y: 150 }, data: { label: 'start' } },
    { id: 'get',  type: 'argus.tool',     position: { x: 300, y: 150 }, data: { label: 'get', tool: 'jira_get_issue', args: { issueKey: '{{ input.key }}' } } },
  ],
  add_edges: [{ source: 'trig', target: 'get' }],
});

// Corrected, but with the arg emitted FLAT in data (data.issueKey, no args wrapper)
// — the exact shape the copilot LLM produces that normalizeNodeArgs must fix.
// Exercises the re-normalize-after-re-prompt line: without it the arg stays flat,
// the serializer drops it, AND findMissingRequiredArgs mis-fires (warnings appear).
const FLAT_FILLED_ARG_OUTPUT = JSON.stringify({
  rationale: 'fetch the issue (corrected, flat args)',
  add_nodes: [
    { id: 'trig', type: 'trigger.manual', position: { x: 50, y: 150 }, data: { label: 'start' } },
    { id: 'get',  type: 'argus.tool',     position: { x: 300, y: 150 }, data: { label: 'get', tool: 'jira_get_issue', issueKey: '{{ input.key }}' } },
  ],
  add_edges: [{ source: 'trig', target: 'get' }],
});

// Non-JSON prose — what a vague prompt produces, triggering the Fix B repair.
const PROSE = 'Sure! First fetch the ticket, then create a branch, then ...';

describe('POST /api/workflows/copilot — required-arg self-validate (Fix A)', () => {
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

  it('empty-arg tool node → ONE re-prompt naming the missing arg → filled → 200, no warnings', async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentReply(MISSING_ARG_OUTPUT))
      .mockResolvedValueOnce(agentReply(FILLED_ARG_OUTPUT));

    const r = await post('hol das jira issue');
    expect(r.status).toBe(200);
    const body = await r.json() as { add_nodes: Array<{ data: { args?: Record<string, unknown> } }>; warnings?: string[] };
    expect(body.warnings).toBeUndefined();
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    // the corrective message names the missing required arg
    const secondMsg = mockRunAgent.mock.calls[1]![2] as string;
    expect(secondMsg).toContain('issueKey');
    // the returned node carries the filled arg under data.args
    const toolNodeOut = body.add_nodes.find((n) => (n.data as { tool?: string }).tool === 'jira_get_issue');
    expect(toolNodeOut?.data.args?.['issueKey']).toBe('{{ input.key }}');
  });

  it('still missing after re-prompt → 200 with warnings[] naming the arg', async () => {
    mockRunAgent
      .mockResolvedValueOnce(agentReply(MISSING_ARG_OUTPUT))
      .mockResolvedValueOnce(agentReply(MISSING_ARG_OUTPUT));

    const r = await post('hol das jira issue');
    expect(r.status).toBe(200);
    const body = await r.json() as { warnings?: string[] };
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings!.join(' ')).toContain('issueKey');
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('re-prompt returning FLAT args → normalized into data.args, no mis-fire (re-normalize fix)', async () => {
    // Load-bearing guard for the re-normalize-after-re-prompt line: if it were
    // removed, the corrected node would keep data.issueKey flat → arg-check
    // mis-fires (warnings appear) AND data.args.issueKey is undefined.
    mockRunAgent
      .mockResolvedValueOnce(agentReply(MISSING_ARG_OUTPUT))
      .mockResolvedValueOnce(agentReply(FLAT_FILLED_ARG_OUTPUT));

    const r = await post('hol das jira issue');
    expect(r.status).toBe(200);
    const body = await r.json() as { add_nodes: Array<{ data: { tool?: string; args?: Record<string, unknown> } }>; warnings?: string[] };
    expect(body.warnings).toBeUndefined();             // arg-check did NOT mis-fire after re-normalize
    const toolNodeOut = body.add_nodes.find((n) => n.data.tool === 'jira_get_issue');
    expect(toolNodeOut?.data.args?.['issueKey']).toBe('{{ input.key }}'); // moved flat→data.args
    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it('Fix B repair THEN Fix A re-prompt compose in one request → 200, no warnings, agent called 3×', async () => {
    // bad JSON → repair yields valid-but-missing-arg JSON → arg-check re-prompt → filled.
    // Guards the response-sent-exactly-once invariant across BOTH re-prompt mechanisms.
    mockRunAgent
      .mockResolvedValueOnce(agentReply(PROSE))             // Stage 2: unparseable → Fix B repair
      .mockResolvedValueOnce(agentReply(MISSING_ARG_OUTPUT)) // repair parses but missing arg → Fix A re-prompt
      .mockResolvedValueOnce(agentReply(FILLED_ARG_OUTPUT)); // corrective → filled

    const r = await post('coding workflow für ein ticket');
    expect(r.status).toBe(200);
    const body = await r.json() as { warnings?: string[] };
    expect(body.warnings).toBeUndefined();
    expect(mockRunAgent).toHaveBeenCalledTimes(3);
  });
});
