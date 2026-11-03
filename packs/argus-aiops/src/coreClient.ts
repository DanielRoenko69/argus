import type { PackExecutionGrant } from './executionGrant.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;

export interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  toolCallId?: string;
  traceId?: string;
  spanId?: string;
}

export interface CoreAgentResponse {
  response: string;
  sessionId: string;
  toolCalls: AgentToolCall[];
  iterations: number;
  agent: { id: number; name: string; label: string; model: string };
  ragCitations?: Array<{ source: string; index: string; score: number }>;
}

export interface CoreAgentInvoker {
  callAgent(input: {
    agentName: string;
    message: string;
    grant: PackExecutionGrant;
    sessionId?: string;
  }): Promise<CoreAgentResponse>;
}

export const CORE_AGENT_NAME_BY_ROLE = {
  researcher: 'aiops-researcher',
  knowledge: 'aiops-knowledge',
  reviewer: 'aiops-reviewer',
} as const;

const CORE_AGENT_TOOL_PATTERNS_BY_ROLE = {
  researcher: ['aiops_*', 'argus_observe_*'],
  knowledge: ['rag_*', '*knowledge*', '*runbook*', '*incident_history*'],
  reviewer: [],
} as const;

export class CoreAgentClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'CoreAgentClientError';
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('ARGUS_URL must be an HTTP(S) origin without credentials, query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedId(value: unknown, max = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function uuid(value: unknown): string | undefined {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function parseToolCalls(value: unknown): AgentToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap(item => {
    const parsed = record(item);
    const args = record(parsed?.['args']);
    return typeof parsed?.['name'] === 'string' && args ? [{
      name: parsed['name'],
      args,
      ...(typeof parsed['result'] === 'string'
        ? { result: parsed['result'].slice(0, MAX_TOOL_RESULT_BYTES) }
        : {}),
      ...(boundedId(parsed['tool_call_id']) ? { toolCallId: boundedId(parsed['tool_call_id']) } : {}),
      ...(uuid(parsed['trace_id']) ? { traceId: uuid(parsed['trace_id']) } : {}),
      ...(uuid(parsed['span_id']) ? { spanId: uuid(parsed['span_id']) } : {}),
    }] : [];
  });
}

function parseRagCitations(value: unknown): Array<{ source: string; index: string; score: number }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(item => {
    const parsed = record(item);
    if (typeof parsed?.['source'] !== 'string' || typeof parsed['index'] !== 'string') return [];
    return [{
      source: parsed['source'].slice(0, 1_000),
      index: parsed['index'].slice(0, 256),
      score: typeof parsed['score'] === 'number' && Number.isFinite(parsed['score']) ? parsed['score'] : 0,
    }];
  });
}

export class ArgusCoreClient implements CoreAgentInvoker {
  private readonly baseUrl: string;

  constructor(options: { baseUrl: string; fetchFn?: typeof fetch; timeoutMs?: number }) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = Math.min(15 * 60_000, Math.max(1_000, options.timeoutMs ?? 5 * 60_000));
  }

  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  async callAgent(input: {
    agentName: string;
    message: string;
    grant: PackExecutionGrant;
    sessionId?: string;
  }): Promise<CoreAgentResponse> {
    const coreAgentName = CORE_AGENT_NAME_BY_ROLE[input.agentName as keyof typeof CORE_AGENT_NAME_BY_ROLE]
      ?? input.agentName;
    const binding = input.grant.claims.coreAgents.find(agent => agent.name === coreAgentName);
    if (!binding) throw new CoreAgentClientError(403, `execution grant does not bind Core Agent '${coreAgentName}'`);
    if (!input.message.trim() || input.message.length > 100_000) {
      throw new CoreAgentClientError(400, 'agent message must contain 1 to 100000 characters');
    }
    const roleToolPatterns = CORE_AGENT_TOOL_PATTERNS_BY_ROLE[
      input.agentName as keyof typeof CORE_AGENT_TOOL_PATTERNS_BY_ROLE
    ] ?? [];
    const executionToolAllowPatterns = input.agentName === 'researcher'
      && input.grant.claims.aiopsServiceContext
      && input.grant.claims.toolNames?.length
      ? input.grant.claims.toolNames
      : roleToolPatterns;

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/api/agents/${binding.id}/chat`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.grant.token}`,
          'content-type': 'application/json',
          'x-argus-root-trace-id': input.grant.claims.rootTraceId,
          'x-langfuse-session-id': input.grant.claims.rootTraceId,
        },
        body: JSON.stringify({
          message: input.message.trim(),
          include_tool_results: true,
          execution_tool_allow_patterns: executionToolAllowPatterns,
          ...(input.sessionId ? { session_id: input.sessionId } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new CoreAgentClientError(502, cause instanceof Error ? cause.message : 'Core Agent request failed');
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_RESPONSE_BYTES) throw new CoreAgentClientError(502, 'Core Agent response exceeds 1 MiB');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new CoreAgentClientError(502, 'Core Agent response exceeds 1 MiB');
    if (!response.ok) throw new CoreAgentClientError(response.status, `Core Agent '${input.agentName}' rejected the task: ${text.slice(0, 500)}`);

    let body: Record<string, unknown>;
    try {
      body = record(JSON.parse(text)) ?? {};
    } catch {
      throw new CoreAgentClientError(502, `Core Agent '${input.agentName}' returned invalid JSON`);
    }
    const agent = record(body['agent']);
    const toolCalls = parseToolCalls(body['tool_calls']);
    const resultText = typeof body['response'] === 'string' ? body['response'].trim() : '';
    if (!agent || Number(agent['id']) !== binding.id || !resultText) {
      throw new CoreAgentClientError(502, `Core Agent '${input.agentName}' returned an invalid response contract`);
    }
    return {
      response: resultText.slice(0, 100_000),
      sessionId: typeof body['session_id'] === 'string' ? body['session_id'] : '',
      toolCalls,
      ragCitations: parseRagCitations(body['citations']),
      iterations: Number.isInteger(body['iterations']) ? Number(body['iterations']) : 0,
      agent: {
        id: binding.id,
        name: typeof agent['name'] === 'string' ? agent['name'] : input.agentName,
        label: typeof agent['label'] === 'string' ? agent['label'] : input.agentName,
        model: typeof agent['model'] === 'string' ? agent['model'] : 'unknown',
      },
    };
  }
}
