import type { ResourceRef } from '../tags/types.js';

export const RUN_KINDS = ['workflow', 'agent'] as const;
export type RunKindV2 = typeof RUN_KINDS[number];

export const RUN_STATUSES = [
  'running',
  'waiting_for_approval',
  'waiting_for_external',
  'completed',
  'failed',
  'stopped',
  'cancelled',
  'stale',
  'unknown',
] as const;
export type RunStatusV2 = typeof RUN_STATUSES[number];

export const RUN_DISPLAY_STATUSES = [
  'active',
  'waiting',
  'action_required',
  'succeeded',
  'failed',
  'cancelled',
  'stale',
] as const;
export type RunDisplayStatus = typeof RUN_DISPLAY_STATUSES[number];

export type RunAllowedAction = 'open' | 'cancel' | 'review_approval';
export type RunEvidenceCompleteness = 'frozen' | 'legacy_live_fallback' | 'missing';

export interface RunChildCounts {
  running: number;
  waiting: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface RunSummaryV2 {
  id: string;
  kind: RunKindV2;
  title: string;
  status: RunStatusV2;
  displayStatus: RunDisplayStatus;
  attentionReason: string | null;
  currentPhase: string | null;
  startedAt: string;
  updatedAt: string;
  durationMs: number | null;
  rootTraceId: string | null;
  parentRunId: string | null;
  childCounts: RunChildCounts;
  resourceRefs: ResourceRef[];
  evidenceCompleteness: RunEvidenceCompleteness;
  allowedActions: RunAllowedAction[];
  href: string;
  orphaned: boolean;
  children?: RunSummaryV2[];
}

export interface RunPageV2 {
  schemaVersion: 2;
  generatedAt: string;
  view: 'root' | 'all';
  includeChildren: 'none' | 'summary' | 'full';
  items: RunSummaryV2[];
  nextCursor: string | null;
  orphanCount: number;
}

export interface RunReadModelQuery {
  view: 'root' | 'all';
  includeChildren: 'none' | 'summary' | 'full';
  limit: number;
  cursor: string | null;
  kinds: RunKindV2[];
  statuses: Array<RunStatusV2 | RunDisplayStatus>;
  tagIds: string[];
  query: string;
  hours: number;
}

export interface RunSourceRecord {
  id: string;
  kind: RunKindV2;
  title: string;
  status: RunStatusV2;
  startedAt: string;
  updatedAt: string;
  durationMs: number | null;
  traceId: string | null;
  rootTraceId: string | null;
  parentTraceId: string | null;
  parentExecutionId: string | null;
  retryOfExecutionId: string | null;
  requestedParent: boolean;
  staleCandidate: boolean;
  attentionReason: string | null;
  currentPhase: string | null;
  resourceRefs: ResourceRef[];
  evidenceCompleteness: RunEvidenceCompleteness;
  href: string;
}

export interface RunActionPolicy {
  canRunAgents: boolean;
  canRunWorkflows: boolean;
  canReviewApprovals: boolean;
}
