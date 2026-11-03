#!/usr/bin/env node
/**
 * Deterministic, provider-free certification of the native evaluation policy.
 * It proves both promotion and rejection semantics without copying prompts or
 * requiring an API key. Live model quality remains an explicit separate gate.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evaluateRegression, summarizeEvaluationResults } from '../dist/evaluation/regression.js';

const reportPath = process.env.ARGUS_EVALUATION_CERTIFICATION_REPORT || 'test-results/evaluation-certification.json';

function check(name, passed, detail) {
  return { name, status: passed ? 'passed' : 'failed', detail: String(detail || '').slice(0, 240) };
}

const policy = { minimumOverall: 0.75, maximumScoreDrop: 0.05, maximumErrorRate: 0.1 };
const baseline = { overall: 0.9, cases: 4, errors: 0 };
const candidate = { overall: 0.88, cases: 4, errors: 0 };
const passingGate = evaluateRegression(baseline, candidate, policy);
const rejectionGate = evaluateRegression(baseline, { overall: 0.6, cases: 4, errors: 2 }, policy);
const aggregate = summarizeEvaluationResults(42, 'completed', [
  { status: 'passed', scores: { non_empty: 1 }, latency_ms: 10, cost_usd: null },
  { status: 'failed', scores: { non_empty: 0 }, latency_ms: 30, cost_usd: null },
]);
const checks = [
  check('promotion_passes', passingGate.status === 'passed', `score_delta=${passingGate.scoreDelta}`),
  check('regression_rejects', rejectionGate.status === 'failed', `failed_checks=${rejectionGate.checks.filter(item => item.status === 'failed').length}`),
  check('aggregate_is_bounded', aggregate.overall === 0.5 && aggregate.cases === 2 && aggregate.latencyMs === 20, `overall=${aggregate.overall} cases=${aggregate.cases}`),
];
const report = {
  schema: 'argus.evaluation-certification.v1',
  generated_at: new Date().toISOString(),
  overall: checks.every(item => item.status === 'passed') ? 'passed' : 'failed',
  provider_neutral: true,
  checks,
  policy,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.overall === 'failed') process.exitCode = 2;

