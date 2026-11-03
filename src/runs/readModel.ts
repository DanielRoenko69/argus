import { aggregateDisplayStatus, allowedRunActions, EMPTY_CHILD_COUNTS, statusBucket } from './presentation.js';
import { decodeRunCursor, encodeRunCursor } from './validation.js';
import type {
  RunActionPolicy,
  RunChildCounts,
  RunPageV2,
  RunReadModelQuery,
  RunSourceRecord,
  RunSummaryV2,
} from './types.js';

function keyOf(run: Pick<RunSourceRecord, 'kind' | 'id'>): string {
  return `${run.kind}:${run.id}`;
}

function addCounts(target: RunChildCounts, source: RunChildCounts): void {
  target.running += source.running;
  target.waiting += source.waiting;
  target.completed += source.completed;
  target.failed += source.failed;
  target.cancelled += source.cancelled;
}

function laterIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

interface Hierarchy {
  byKey: Map<string, RunSourceRecord>;
  parentByKey: Map<string, string>;
  childrenByKey: Map<string, string[]>;
  orphanKeys: Set<string>;
}

function buildHierarchy(input: RunSourceRecord[]): Hierarchy {
  const byKey = new Map<string, RunSourceRecord>();
  for (const run of input) {
    const key = keyOf(run);
    const existing = byKey.get(key);
    if (!existing || Date.parse(run.updatedAt) > Date.parse(existing.updatedAt)) byKey.set(key, run);
  }
  const executionToKey = new Map<string, string>();
  const traceToKey = new Map<string, string>();
  for (const [key, run] of byKey) {
    if (run.kind === 'workflow') executionToKey.set(run.id, key);
    if (run.traceId) traceToKey.set(run.traceId, key);
  }

  const parentByKey = new Map<string, string>();
  const orphanKeys = new Set<string>();
  for (const [key, run] of byKey) {
    const candidates: Array<string | undefined> = run.kind === 'workflow'
      ? [
        run.parentExecutionId ? executionToKey.get(run.parentExecutionId) : undefined,
        run.retryOfExecutionId ? executionToKey.get(run.retryOfExecutionId) : undefined,
        run.parentTraceId ? traceToKey.get(run.parentTraceId) : undefined,
        run.rootTraceId && run.rootTraceId !== run.traceId ? traceToKey.get(run.rootTraceId) : undefined,
      ]
      : [
        run.parentTraceId ? traceToKey.get(run.parentTraceId) : undefined,
        run.rootTraceId && run.rootTraceId !== run.traceId ? traceToKey.get(run.rootTraceId) : undefined,
      ];
    const parent = candidates.find(candidate => candidate != null && candidate !== key);
    if (parent) parentByKey.set(key, parent);
    else if (run.requestedParent) orphanKeys.add(key);
  }

  // A malformed historical lineage must not make recursive UI rendering loop.
  for (const key of byKey.keys()) {
    const seen = new Set([key]);
    let cursor = parentByKey.get(key);
    while (cursor) {
      if (seen.has(cursor)) {
        parentByKey.delete(key);
        orphanKeys.add(key);
        break;
      }
      seen.add(cursor);
      cursor = parentByKey.get(cursor);
    }
  }

  const childrenByKey = new Map<string, string[]>();
  for (const [child, parent] of parentByKey) {
    const children = childrenByKey.get(parent) ?? [];
    children.push(child);
    childrenByKey.set(parent, children);
  }
  for (const children of childrenByKey.values()) {
    children.sort((left, right) => Date.parse(byKey.get(left)!.startedAt) - Date.parse(byKey.get(right)!.startedAt));
  }
  return { byKey, parentByKey, childrenByKey, orphanKeys };
}

interface DescendantSummary {
  counts: RunChildCounts;
  updatedAt: string;
  hasActionRequired: boolean;
}

function descendants(hierarchy: Hierarchy, key: string, stack = new Set<string>()): DescendantSummary {
  const run = hierarchy.byKey.get(key)!;
  if (stack.has(key)) return { counts: { ...EMPTY_CHILD_COUNTS }, updatedAt: run.updatedAt, hasActionRequired: false };
  const nextStack = new Set(stack).add(key);
  const counts: RunChildCounts = { ...EMPTY_CHILD_COUNTS };
  let updatedAt = run.updatedAt;
  let hasActionRequired = false;
  for (const childKey of hierarchy.childrenByKey.get(key) ?? []) {
    const child = hierarchy.byKey.get(childKey)!;
    counts[statusBucket(child.status)] += 1;
    if (child.status === 'waiting_for_approval') hasActionRequired = true;
    const nested = descendants(hierarchy, childKey, nextStack);
    addCounts(counts, nested.counts);
    updatedAt = laterIso(updatedAt, nested.updatedAt);
    hasActionRequired ||= nested.hasActionRequired;
  }
  return { counts, updatedAt, hasActionRequired };
}

function materialize(
  hierarchy: Hierarchy,
  key: string,
  policy: RunActionPolicy,
  includeFullChildren: boolean,
  stack = new Set<string>(),
): RunSummaryV2 {
  const run = hierarchy.byKey.get(key)!;
  const nested = descendants(hierarchy, key);
  const displayStatus = aggregateDisplayStatus(run.status, nested.counts, nested.hasActionRequired, run.staleCandidate);
  const parentKey = hierarchy.parentByKey.get(key);
  const orphaned = hierarchy.orphanKeys.has(key);
  const summary: RunSummaryV2 = {
    id: run.id,
    kind: run.kind,
    title: run.title,
    status: run.status,
    displayStatus,
    attentionReason: run.attentionReason,
    currentPhase: run.currentPhase,
    startedAt: run.startedAt,
    updatedAt: nested.updatedAt,
    durationMs: run.durationMs,
    // A retained child may outlive its parent or be visible under a narrower
    // authorization scope. Never expose the missing root's identifier through
    // an otherwise safe orphan response.
    rootTraceId: orphaned ? run.traceId : run.rootTraceId,
    parentRunId: parentKey ? hierarchy.byKey.get(parentKey)?.id ?? null : null,
    childCounts: nested.counts,
    resourceRefs: run.resourceRefs,
    evidenceCompleteness: run.evidenceCompleteness,
    allowedActions: allowedRunActions(run, displayStatus, policy),
    href: run.href,
    orphaned,
  };
  if (includeFullChildren && !stack.has(key)) {
    const nextStack = new Set(stack).add(key);
    summary.children = (hierarchy.childrenByKey.get(key) ?? [])
      .map(childKey => materialize(hierarchy, childKey, policy, true, nextStack));
  }
  return summary;
}

function familyKeys(hierarchy: Hierarchy, key: string): string[] {
  const output: string[] = [key];
  for (const child of hierarchy.childrenByKey.get(key) ?? []) output.push(...familyKeys(hierarchy, child));
  return output;
}

function matchesFilters(
  hierarchy: Hierarchy,
  key: string,
  summary: RunSummaryV2,
  query: RunReadModelQuery,
): boolean {
  const keys = query.view === 'root' ? familyKeys(hierarchy, key) : [key];
  const family = keys.map(item => hierarchy.byKey.get(item)!).filter(Boolean);
  if (query.kinds.length > 0 && !query.kinds.includes(summary.kind)) return false;
  if (query.statuses.length > 0
    && !query.statuses.includes(summary.status)
    && !query.statuses.includes(summary.displayStatus)) return false;
  if (query.query) {
    const needle = query.query.toLowerCase();
    if (!family.some(run => run.title.toLowerCase().includes(needle)
      || run.currentPhase?.toLowerCase().includes(needle)
      || run.resourceRefs.some(ref => ref.label.toLowerCase().includes(needle)))) return false;
  }
  if (query.tagIds.length > 0) {
    const present = new Set(family.flatMap(run => run.resourceRefs.flatMap(ref => ref.tags.map(tag => tag.id))));
    if (!query.tagIds.every(tagId => present.has(tagId))) return false;
  }
  return true;
}

function afterCursor(items: RunSummaryV2[], cursorValue: string | null): RunSummaryV2[] {
  if (!cursorValue) return items;
  const cursor = decodeRunCursor(cursorValue);
  const cursorTime = Date.parse(cursor.updatedAt);
  return items.filter(item => {
    const time = Date.parse(item.updatedAt);
    return time < cursorTime || (time === cursorTime && `${item.kind}:${item.id}` > cursor.id);
  });
}

export function buildRunPageV2(
  records: RunSourceRecord[],
  query: RunReadModelQuery,
  policy: RunActionPolicy,
  now = new Date(),
): RunPageV2 {
  const hierarchy = buildHierarchy(records);
  const candidateKeys = [...hierarchy.byKey.keys()].filter(key => query.view === 'all' || !hierarchy.parentByKey.has(key));
  const materialized = candidateKeys
    .map(key => ({ key, summary: materialize(hierarchy, key, policy, query.includeChildren === 'full') }))
    .filter(item => matchesFilters(hierarchy, item.key, item.summary, query))
    .map(item => item.summary)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      || `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  const remaining = afterCursor(materialized, query.cursor);
  const pageItems = remaining.slice(0, query.limit);
  const hasMore = remaining.length > query.limit;
  const last = pageItems.at(-1);
  return {
    schemaVersion: 2,
    generatedAt: now.toISOString(),
    view: query.view,
    includeChildren: query.includeChildren,
    items: pageItems,
    nextCursor: hasMore && last
      ? encodeRunCursor({ updatedAt: last.updatedAt, id: `${last.kind}:${last.id}` })
      : null,
    orphanCount: hierarchy.orphanKeys.size,
  };
}
