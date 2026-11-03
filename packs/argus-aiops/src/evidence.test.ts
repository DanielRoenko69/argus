import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvestigationPlan } from './domain.js';
import { parseReviewerDiagnosis, reviewerPrompt } from './evidence.js';

const plan = buildInvestigationPlan({
  title: 'Checkout latency',
  summary: 'P95 latency increased.',
  severity: 'critical',
  service: 'checkout-api',
  environment: 'production',
  labels: {
    'argus.core.impact.candidate.1': 'confidence=high; target=database:postgresql',
  },
}, {
  now: new Date('2026-08-12T20:00:00.000Z'),
  selectedBundleIds: [8],
  resourceScope: {
    kind: 'kubernetes', backendId: 42, targetId: 'production', cluster: 'argus-production',
    namespace: 'checkout', environment: 'production',
  },
});

function diagnosis(candidateRef: string | null): string {
  return JSON.stringify({
    conclusion: 'confirmed',
    executiveAssessment: 'PostgreSQL failures explain the latency regression.',
    rootCause: {
      candidateRef,
      targetKind: 'database',
      targetName: 'postgresql',
      statement: 'The database query path is failing.',
      confidence: 94,
      rationale: 'Metrics, traces and topology agree.',
    },
    hypotheses: [],
    evidence: [{ lane: 'traces', claim: 'Failures begin on PostgreSQL spans.', sourceRefs: ['trace:81'] }],
    recommendedActions: [{ priority: 'now', action: 'Inspect database availability.', rationale: 'It is the failing edge.', requiresApproval: false }],
  });
}

test('parses the strict reviewer verdict and preserves only a Core-issued candidate reference', () => {
  const accepted = parseReviewerDiagnosis(`\`\`\`json\n${diagnosis('argus.core.impact.candidate.1')}\n\`\`\``, plan);
  assert.equal(accepted.valid, true);
  assert.equal(accepted.diagnosis.rootCause?.candidateRef, 'argus.core.impact.candidate.1');

  const untrusted = parseReviewerDiagnosis(diagnosis('argus.core.impact.candidate.5'), plan);
  assert.equal(untrusted.valid, true);
  assert.equal(untrusted.diagnosis.rootCause?.candidateRef, null);
});

test('falls back to an explicit inconclusive result for malformed model output', () => {
  const parsed = parseReviewerDiagnosis('The database is definitely broken.', plan);
  assert.equal(parsed.valid, false);
  assert.equal(parsed.diagnosis.conclusion, 'inconclusive');
  assert.equal(parsed.diagnosis.rootCause, null);
  assert.equal(parsed.diagnosis.hypotheses.every(item => item.verdict === 'unresolved'), true);
});

test('requires JSON-only reviewer output and names the exact safety constraints', () => {
  const prompt = reviewerPrompt(plan, []);
  assert.match(prompt, /Return ONLY one JSON object/);
  assert.match(prompt, /Use "confirmed" only when multiple independent signals support causality/);
  assert.match(prompt, /never imply they were executed/);
});
