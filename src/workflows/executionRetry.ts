import type { StepResult, WorkflowStep } from './types.js';

export interface WorkflowRetryPlan {
  checkpoint: Record<string, StepResult>;
  failedStepIds: string[];
  retryStepIds: string[];
  reusedStepIds: string[];
  changedInputNames: string[];
}

function comparable(value: unknown): string {
  if (value === undefined) return '__argus_undefined__';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function changedInputNames(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): string[] {
  const names = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...names].filter(name => comparable(previous[name]) !== comparable(next[name])).sort();
}

function collectInputReferences(value: unknown, target: Set<string>): void {
  if (typeof value === 'string') {
    const pattern = /\binput\.([A-Za-z_][A-Za-z0-9_-]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) != null) target.add(match[1]!);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectInputReferences(entry, target);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectInputReferences(entry, target);
    }
  }
}

function stepInputReferences(step: WorkflowStep): Set<string> {
  const references = new Set<string>();
  collectInputReferences(step.args ?? {}, references);
  collectInputReferences(step.condition ?? '', references);
  return references;
}

function addDependents(seed: Set<string>, steps: WorkflowStep[]): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (seed.has(step.id)) continue;
      if ((step.depends_on ?? []).some(dependency => seed.has(dependency))) {
        seed.add(step.id);
        changed = true;
      }
    }
  }
}

/**
 * Builds the immutable checkpoint copied into a new retry execution.
 *
 * - Every failed/waiting step is retried.
 * - Every transitive dependent of an invalidated step is retried.
 * - Changing an input invalidates only steps that reference that input and
 *   their dependents.
 * - Steps which never settled in the source execution are naturally retried.
 */
export function buildWorkflowRetryPlan(
  steps: WorkflowStep[],
  previousResults: Record<string, StepResult>,
  previousInputs: Record<string, unknown>,
  nextInputs: Record<string, unknown>,
): WorkflowRetryPlan {
  const stepIds = new Set(steps.map(step => step.id));
  const failedStepIds = Object.entries(previousResults)
    .filter(([, result]) => result.status === 'failed')
    .map(([stepId]) => stepId)
    .sort();

  if (failedStepIds.length === 0) {
    throw new Error('source execution has no failed workflow step to retry');
  }
  const removedFailures = failedStepIds.filter(stepId => !stepIds.has(stepId));
  if (removedFailures.length > 0) {
    throw new Error(`workflow changed after the failed run; missing failed step(s): ${removedFailures.join(', ')}`);
  }

  const changedInputs = changedInputNames(previousInputs, nextInputs);
  const retry = new Set(failedStepIds);
  for (const [stepId, result] of Object.entries(previousResults)) {
    if (result.status === 'waiting' || result.status === 'running' || result.status === 'pending') {
      if (stepIds.has(stepId)) retry.add(stepId);
    }
  }
  if (changedInputs.length > 0) {
    const changedSet = new Set(changedInputs);
    for (const step of steps) {
      if ([...stepInputReferences(step)].some(name => changedSet.has(name))) retry.add(step.id);
    }
  }
  addDependents(retry, steps);

  const checkpoint: Record<string, StepResult> = {};
  const reusedStepIds: string[] = [];
  for (const step of steps) {
    const result = previousResults[step.id];
    if (!result || retry.has(step.id)) continue;
    if (result.status !== 'completed' && result.status !== 'skipped') continue;
    checkpoint[step.id] = result;
    reusedStepIds.push(step.id);
  }

  return {
    checkpoint,
    failedStepIds,
    retryStepIds: steps.filter(step => checkpoint[step.id] == null).map(step => step.id),
    reusedStepIds,
    changedInputNames: changedInputs,
  };
}
