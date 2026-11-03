export type LlmProvider = 'openai' | 'anthropic' | 'openai-compatible';

export interface LlmTarget {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  authType?: 'bearer' | 'api-key' | 'none';
  model: string;
  timeoutMs: number;
  supportsReasoning?: boolean;
  credentialProfileId?: number;
  credentialProfileName?: string;
  /** Internal subscription runtime. Never persisted as a provider credential. */
  runtimeType?: 'codex-subscription' | 'claude-code-subscription';
  runtimeReasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  runtimeAgentId?: number;
  runtimeRootTraceId?: string;
  runtimeWorkingDirectory?: string;
}

export interface LlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: LlmToolCall[];
}

export interface LlmTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: LlmTool[];
  tool_choice?: 'auto' | 'none' | 'required' | Record<string, unknown>;
  response_format?: Record<string, unknown>;
  user?: string;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  thinking?: { type: 'enabled'; budget_tokens: number };
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ChatCompletionResponse {
  /** Actual reported fields, before compatibility defaults (when provided). */
  usage_observed?: Partial<LlmUsage> | null;
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: LlmToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: LlmUsage;
}

export interface ChatStreamChunk {
  id?: string;
  model?: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: LlmUsage;
}

export interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index?: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}
