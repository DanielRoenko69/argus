import type { AgentRuntimeAssignment, AgentRuntimeType } from './runtimeProfiles.js';

export interface AgentRuntimeExecutorStatus {
  enabled: boolean;
  authenticated: boolean;
  activeRuns: number | null;
  maxConcurrentRuns: number | null;
  detail: string;
  trust: 'core_governed' | 'external_attested';
}

export interface ManagedAgentRuntimeContext {
  requestId: string;
  rootTraceId: string;
  coreAgentName: string;
  principal: {
    kind: 'user' | 'api_key' | 'service';
    id: string;
    allowedBundleIds: number[] | null;
  };
  bundleIds: number[];
  workspaceRoot: string;
  workspaceAccess: 'read' | 'write';
}

export interface AgentRuntimeExecutionInput {
  text: string;
  managed?: ManagedAgentRuntimeContext;
}

export interface AgentRuntimeExecutionResult {
  output: string;
  externalRunId: string;
  trust: 'core_governed' | 'external_attested';
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
    apiCalls?: number;
    estimatedCostUsd?: number;
  };
}

/**
 * Narrow runtime boundary owned by Core. Implementations normalize a native
 * runtime into Core status/output without exposing native credentials or raw
 * transport frames.
 */
export interface AgentRuntimeExecutor {
  readiness(assignment: AgentRuntimeAssignment): Promise<AgentRuntimeExecutorStatus>;
  execute(
    assignment: AgentRuntimeAssignment,
    input: AgentRuntimeExecutionInput,
  ): Promise<AgentRuntimeExecutionResult>;
}

const executors = new Map<AgentRuntimeType, AgentRuntimeExecutor>();

export function configureAgentRuntimeExecutor(
  runtimeType: AgentRuntimeType,
  executor: AgentRuntimeExecutor | undefined,
): void {
  if (executor) executors.set(runtimeType, executor);
  else executors.delete(runtimeType);
}

export function getAgentRuntimeExecutor(runtimeType: AgentRuntimeType): AgentRuntimeExecutor | undefined {
  return executors.get(runtimeType);
}
