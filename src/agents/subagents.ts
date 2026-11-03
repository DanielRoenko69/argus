/**
 * Subagents â€” call other Argus agents from within a running agent turn.
 *
 * Two synthetic tools are exposed:
 *   - __call_agent__:  one sub-call, returns its plain-text response
 *   - __call_agents__: parallel batch, returns aggregated structured results
 *
 * Each sub-call gets its own session UUID so context is isolated. A depth
 * counter prevents accidental infinite recursion (sub-agent calls another
 * sub-agent which calls another...).
 *
 * Worker-mode and chat-mode both call into the provider-neutral dispatcher
 * here so the same semantics apply.
 */

import { randomUUID } from 'crypto';
import type pg from 'pg';
import type { Config } from '../config/env.js';
import { agentAccessGate, createSession } from './agentStore.js';
import { logger } from '../lib/logger.js';

export const SUBAGENT_TOOL_SINGLE = '__call_agent__';
export const SUBAGENT_TOOL_PARALLEL = '__call_agents__';
export const MAX_SUBAGENT_DEPTH = 2;  // reduced from 3 â€” limits worst-case fanout to 4^2=16 calls
export const MAX_PARALLEL_SUBAGENTS = 4;  // reduced from 8 â€” caps parallel cost
export const MAX_TOTAL_SUBAGENTS = 20;  // global call budget per root session

export interface SubagentCall { agent_id: number; message: string }
export interface SubagentResult {
  agent_id:    number;
  agent_name:  string;
  agent_label: string;
  response:    string;
  tool_calls:  number;
  duration_ms: number;
  error?:      string;
}

export interface SubagentCallingUser {
  id: number;
  entra_groups: string[];
  role?: string | null;
  allowed_bundles?: number[] | null;
  service?: boolean;
}

/** Per-call depth tracking â€” avoids `depth` plumbing through every layer. */
const sessionDepth = new Map<string, number>();
/** Total sub-agent call count per root session â€” global budget to cap runaway trees. */
const sessionBudget = new Map<string, number>();

export function getSubagentDepth(sessionId: string): number {
  return sessionDepth.get(sessionId) ?? 0;
}
export function setSubagentDepth(sessionId: string, depth: number): void {
  sessionDepth.set(sessionId, depth);
}
export function clearSubagentDepth(sessionId: string): void {
  sessionDepth.delete(sessionId);
  sessionBudget.delete(sessionId);
  // audit (mem-leak): sessionRoot was written on every sub-call but never
  // deleted → the Map grew unbounded for the pod's lifetime. Clear the
  // sub-session's root mapping here too (it's no longer needed once the
  // sub-call has finished).
  sessionRoot.delete(sessionId);
}

/** Returns true if the root session still has budget for more sub-calls. */
export function consumeSubagentBudget(rootSessionId: string): boolean {
  const used = sessionBudget.get(rootSessionId) ?? 0;
  if (used >= MAX_TOTAL_SUBAGENTS) return false;
  sessionBudget.set(rootSessionId, used + 1);
  return true;
}

/** Resolve the root session (depth=0 session) for budget tracking. */
const sessionRoot = new Map<string, string>();
export function registerSubSession(subSessionId: string, rootSessionId: string): void {
  sessionRoot.set(subSessionId, rootSessionId);
}
export function getRootSession(sessionId: string): string {
  return sessionRoot.get(sessionId) ?? sessionId;
}

/**
 * Run a single sub-agent and return its full text response.
 * Imports runAgentChatSync lazily to break the circular import with agentRunner.
 */
export async function callSubagentSingle(
  agentId: number,
  message: string,
  pool: pg.Pool,
  config: Config,
  parentSessionId: string,
  callingUser?: SubagentCallingUser,
): Promise<SubagentResult> {
  const access = await agentAccessGate(pool, agentId, callingUser);
  const subAgent = access.agent;
  if (access.verdict === 'not_found' || !subAgent) {
    return {
      agent_id: agentId, agent_name: '?', agent_label: '?',
      response: '', tool_calls: 0, duration_ms: 0,
      error: `Agent ${agentId} not found`,
    };
  }
  if (access.verdict === 'forbidden') {
    return {
      agent_id: agentId, agent_name: '?', agent_label: '?',
      response: '', tool_calls: 0, duration_ms: 0,
      error: `Agent ${agentId} is not permitted for this caller`,
    };
  }

  // Check total budget for this call tree before spawning
  const rootSession = getRootSession(parentSessionId);
  if (!consumeSubagentBudget(rootSession)) {
    return {
      agent_id: agentId, agent_name: subAgent.name, agent_label: subAgent.label,
      response: '', tool_calls: 0, duration_ms: 0,
      error: `Subagent budget exhausted (max ${MAX_TOTAL_SUBAGENTS} calls per root session)`,
    };
  }

  const subSessionId = randomUUID();
  await createSession(pool, agentId, subSessionId);
  setSubagentDepth(subSessionId, getSubagentDepth(parentSessionId) + 1);
  registerSubSession(subSessionId, rootSession);

  const start = Date.now();
  try {
    const { runAgentChatSync } = await import('./agentRunner.js');
    const r = await runAgentChatSync(agentId, subSessionId, message, pool, config, undefined, callingUser);
    return {
      agent_id:    agentId,
      agent_name:  subAgent.name,
      agent_label: subAgent.label,
      response:    r.response,
      tool_calls:  r.tool_calls.length,
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, agentId }, 'Subagent call failed');
    return {
      agent_id:    agentId,
      agent_name:  subAgent.name,
      agent_label: subAgent.label,
      response:    '',
      tool_calls:  0,
      duration_ms: Date.now() - start,
      error:       msg,
    };
  } finally {
    clearSubagentDepth(subSessionId);
  }
}

/** Parallel batch â€” runs all sub-agent calls concurrently via Promise.all. */
export async function callSubagentsParallel(
  calls: SubagentCall[],
  pool: pg.Pool,
  config: Config,
  parentSessionId: string,
  callingUser?: SubagentCallingUser,
): Promise<SubagentResult[]> {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  if (calls.length > MAX_PARALLEL_SUBAGENTS) {
    return [{
      agent_id: -1, agent_name: '?', agent_label: '?',
      response: '', tool_calls: 0, duration_ms: 0,
      error: `Too many parallel subagent calls (${calls.length}), max ${MAX_PARALLEL_SUBAGENTS}`,
    }];
  }
  return Promise.all(calls.map((c) => callSubagentSingle(c.agent_id, c.message, pool, config, parentSessionId, callingUser)));
}

/** Format an array of subagent results for inclusion in another agent's tool result. */
export function formatParallelResults(results: SubagentResult[]): string {
  if (results.length === 0) return '(no subagents called)';
  return results.map((r, i) => {
    const head = `### Subagent ${i + 1}: ${r.agent_label} (id=${r.agent_id})`;
    const meta = `tool_calls=${r.tool_calls}, duration=${r.duration_ms}ms`;
    if (r.error) return `${head}\n[${meta}]\n**ERROR:** ${r.error}`;
    return `${head}\n[${meta}]\n${r.response}`;
  }).join('\n\n---\n\n');
}

/** Synthetic tool definitions appended to every agent's tool list. */
export function subagentToolDefs(availableAgents?: Array<{ id: number; name: string; label: string; agent_mode: string }>): unknown[] {
  const agentHint = availableAgents && availableAgents.length > 0
    ? ' Available agent IDs: ' + availableAgents.map(a => `${a.id}=${a.label}(${a.name})`).join(', ') + '. NEVER guess an agent ID — only use IDs from this list.'
    : ' IMPORTANT: You must know the exact agent ID before calling. Do NOT guess — ask the user which agent to delegate to if unsure.';

  return [
    {
      type: 'function',
      function: {
        name: SUBAGENT_TOOL_SINGLE,
        description:
          'Call ONE other Argus agent and return its response. ' +
          'Use when: you need a specialised sub-agent (RAG lookup, Code Review, etc.) for a focused sub-task. ' +
          'Each call gets its own isolated context. ' +
          'Prefer direct tools (atlassian_jira_get_issue, rag_search, etc.) over subagent calls when possible.' +
          agentHint,
        parameters: {
          type: 'object',
          properties: {
            agent_id: { type: 'number', description: 'Exact numeric ID of the agent to call (see description for valid IDs)' },
            message:  { type: 'string', description: 'Task/message for the sub-agent' },
          },
          required: ['agent_id', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: SUBAGENT_TOOL_PARALLEL,
        description:
          'Call multiple Argus agents IN PARALLEL and return all their responses aggregated. ' +
          'Use when: you need parallel review/analysis from several specialized sub-agents ' +
          '(e.g., style-reviewer + security-scanner + test-runner). ' +
          'Each sub-agent runs in its own isolated context with its own toolset. ' +
          'Max 8 parallel calls. Returns structured results with per-agent timing and errors.',
        parameters: {
          type: 'object',
          properties: {
            calls: {
              type: 'array',
              description: 'Array of {agent_id, message} pairs to dispatch in parallel',
              items: {
                type: 'object',
                properties: {
                  agent_id: { type: 'number' },
                  message:  { type: 'string' },
                },
                required: ['agent_id', 'message'],
              },
            },
          },
          required: ['calls'],
        },
      },
    },
  ];
}
