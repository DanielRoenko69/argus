import { describe, expect, it } from '@jest/globals';
import { evaluateRegression, summarizeEvaluationResults } from '../regression.js';

describe('evaluateRegression', () => {
  it('passes a candidate above the minimum without excessive score or error regression', () => {
    const result = evaluateRegression(
      { overall: 0.82, cases: 20, errors: 0 },
      { overall: 0.80, cases: 20, errors: 0 },
      { minimumOverall: 0.75, maximumScoreDrop: 0.05, maximumErrorRate: 0.1 },
    );
    expect(result.status).toBe('passed');
    expect(result.scoreDelta).toBe(-0.02);
    expect(result.checks.every(check => check.status === 'passed')).toBe(true);
  });

  it('fails a candidate with a score drop or error-rate breach', () => {
    const result = evaluateRegression(
      { overall: 0.90, cases: 10, errors: 0 },
      { overall: 0.70, cases: 10, errors: 2 },
      { minimumOverall: 0.75, maximumScoreDrop: 0.05, maximumErrorRate: 0.1 },
    );
    expect(result.status).toBe('failed');
    expect(result.checks.filter(check => check.status === 'failed').map(check => check.name)).toEqual(
      expect.arrayContaining(['minimum_overall', 'maximum_score_drop', 'maximum_error_rate']),
    );
  });

  it('summarizes persisted result scores deterministically', () => {
    const summary = summarizeEvaluationResults(7, 'completed', [
      { status: 'passed', latency_ms: 20, cost_usd: null, scores: { non_empty: 1 } },
      { status: 'error', latency_ms: 40, cost_usd: null, scores: { non_empty: 0 } },
    ]);
    expect(summary).toMatchObject({ experimentId: 7, status: 'completed', overall: 0.5, cases: 2, errors: 1, latencyMs: 30 });
  });
});
