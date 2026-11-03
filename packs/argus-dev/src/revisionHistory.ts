import type {
  FileDiff,
  RevisionAgentEvidence,
  RevisionEvidence,
  RevisionHumanDecision,
  RevisionReviewEvidence,
  RevisionTestEvidence,
  RevisionTrigger,
} from './state.js';

const MAX_REVISIONS = 20;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_DIFFS = 100;

function bounded(value: string): string {
  return value.slice(0, MAX_OUTPUT_CHARS);
}

function updateLatest(
  history: RevisionEvidence[],
  update: (revision: RevisionEvidence) => RevisionEvidence,
): RevisionEvidence[] {
  if (history.length === 0) return history;
  const next = history.slice();
  next[next.length - 1] = update(next[next.length - 1]!);
  return next;
}

export function appendRevision(
  history: RevisionEvidence[],
  input: {
    retryCount: number;
    trigger: RevisionTrigger;
    triggerFeedback: string;
    coder: RevisionAgentEvidence;
  },
): RevisionEvidence[] {
  return [...history, {
    attempt: input.retryCount + 1,
    retryCount: input.retryCount,
    trigger: input.trigger,
    triggerFeedback: bounded(input.triggerFeedback),
    startedAt: input.coder.recordedAt,
    coder: { ...input.coder, output: bounded(input.coder.output) },
    humanDecisions: [],
    fileDiffs: [],
  }].slice(-MAX_REVISIONS);
}

export function recordRevisionTests(
  history: RevisionEvidence[],
  tests: RevisionTestEvidence,
): RevisionEvidence[] {
  return updateLatest(history, revision => ({
    ...revision,
    tests: { ...tests, output: bounded(tests.output), profiles: tests.profiles.slice(0, 20) },
  }));
}

export function recordRevisionReview(
  history: RevisionEvidence[],
  reviewer: RevisionReviewEvidence,
  fileDiffs: FileDiff[],
): RevisionEvidence[] {
  return updateLatest(history, revision => ({
    ...revision,
    reviewer: {
      ...reviewer,
      output: bounded(reviewer.output),
      findings: reviewer.findings.slice(0, 100),
      requiredChanges: reviewer.requiredChanges.slice(0, 100),
    },
    fileDiffs: fileDiffs.slice(0, MAX_DIFFS),
  }));
}

export function recordRevisionHumanDecision(
  history: RevisionEvidence[],
  decision: RevisionHumanDecision,
): RevisionEvidence[] {
  return updateLatest(history, revision => ({
    ...revision,
    humanDecisions: [...revision.humanDecisions, {
      ...decision,
      feedback: bounded(decision.feedback),
    }].slice(-10),
  }));
}
