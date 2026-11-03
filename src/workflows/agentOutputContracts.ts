import { z } from 'zod';
import type { AgentOutputContractName } from './types.js';

const text = z.string().trim().min(1);

const contracts = {
  planner_plan: z.object({
    summary: text,
    steps: z.array(text).min(1),
    validation: z.array(text).default([]),
    risks: z.array(text).default([]),
    assumptions: z.array(text).default([]),
  }).passthrough(),
  implementation_evidence: z.object({
    summary: text,
    changed_files: z.array(z.object({
      path: text,
      summary: z.string().trim().optional(),
    }).passthrough()).default([]),
    validation: z.array(z.object({
      command: text,
      status: z.enum(['passed', 'failed', 'not_run']),
      evidence: z.string().trim().optional(),
    }).passthrough()).default([]),
    notes: z.array(text).default([]),
  }).passthrough(),
  review_verdict: z.object({
    verdict: z.enum(['APPROVE', 'REQUEST_CHANGES']),
    summary: text,
    findings: z.array(z.object({
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      message: text,
      file: z.string().trim().optional(),
    }).passthrough()).default([]),
    required_changes: z.array(text).default([]),
  }).passthrough(),
} satisfies Record<AgentOutputContractName, z.ZodType<Record<string, unknown>>>;

export const AGENT_OUTPUT_CONTRACT_NAMES = Object.freeze(
  Object.keys(contracts) as AgentOutputContractName[],
);

/** Internal runner hint used by mock/runtime adapters; never persisted as workflow input. */
export const AGENT_OUTPUT_CONTRACT_ARG = '__argus_output_contract';

const instructions: Record<AgentOutputContractName, string> = {
  planner_plan: `Return exactly one JSON object and no Markdown. Required shape:
{"summary":"...","steps":["..."],"validation":["..."],"risks":["..."],"assumptions":["..."]}`,
  implementation_evidence: `Return exactly one JSON object and no Markdown. Required shape:
{"summary":"...","changed_files":[{"path":"...","summary":"..."}],"validation":[{"command":"...","status":"passed|failed|not_run","evidence":"..."}],"notes":["..."]}`,
  review_verdict: `Return exactly one JSON object and no Markdown. Required shape:
{"verdict":"APPROVE|REQUEST_CHANGES","summary":"...","findings":[{"severity":"critical|high|medium|low|info","message":"...","file":"optional"}],"required_changes":["..."]}`,
};

export interface ParsedAgentOutput {
  value: Record<string, unknown>;
  canonical: string;
}

export class AgentOutputContractError extends Error {
  constructor(
    public readonly contract: AgentOutputContractName,
    message: string,
  ) {
    super(message);
    this.name = 'AgentOutputContractError';
  }
}

export function isAgentOutputContractName(value: unknown): value is AgentOutputContractName {
  return typeof value === 'string' && AGENT_OUTPUT_CONTRACT_NAMES.includes(value as AgentOutputContractName);
}

export function agentOutputContractInstruction(contract: AgentOutputContractName): string {
  return `ARGUS STRUCTURED OUTPUT CONTRACT (${contract})\n${instructions[contract]}`;
}

function jsonCandidates(output: string): string[] {
  const trimmed = output.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  return [...new Set(candidates)];
}

export function parseAgentOutputContract(
  contract: AgentOutputContractName,
  output: string,
): ParsedAgentOutput {
  let parsed: unknown;
  for (const candidate of jsonCandidates(output)) {
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch { /* try the next tolerant extraction candidate */ }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentOutputContractError(contract, 'response does not contain a valid JSON object');
  }

  const validated = contracts[contract].safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues.slice(0, 6).map(issue => {
      const path = issue.path.length ? issue.path.join('.') : 'root';
      return `${path}: ${issue.message}`;
    });
    throw new AgentOutputContractError(contract, issues.join('; '));
  }
  return { value: validated.data, canonical: JSON.stringify(validated.data) };
}

export function mockAgentOutputForContract(
  contract: AgentOutputContractName,
  agentId: number,
): string {
  if (contract === 'planner_plan') {
    return JSON.stringify({
      summary: `[mock] plan from Agent #${agentId}`,
      steps: ['Inspect the scoped task', 'Implement the smallest coherent change'],
      validation: ['Run targeted tests'],
      risks: [],
      assumptions: ['Mock execution performs no external calls'],
    });
  }
  if (contract === 'implementation_evidence') {
    return JSON.stringify({
      summary: `[mock] implementation from Agent #${agentId}`,
      changed_files: [{ path: 'mock/example.ts', summary: 'Synthetic evidence only' }],
      validation: [{ command: 'mock:test', status: 'passed', evidence: 'No command was executed' }],
      notes: ['Mock execution performs no workspace writes'],
    });
  }
  return JSON.stringify({
    verdict: 'APPROVE',
    summary: `[mock] review from Agent #${agentId}`,
    findings: [],
    required_changes: [],
  });
}
