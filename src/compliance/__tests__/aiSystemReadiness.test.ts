import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { aiActSystemRevisionSchema } from '../aiActContracts.js';
import { evaluateAiSystemRegistrationReadiness } from '../aiSystemReadiness.js';

const revision = aiActSystemRevisionSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/ai-act-compliance/ai-system-revision.v1.fixture.json',
), 'utf8')));

describe('AI-system registration readiness', () => {
  it('projects initial control and independent-review gaps without claiming conformity', () => {
    const initial = aiActSystemRevisionSchema.parse({ ...revision, lifecycleState: 'controls_incomplete' });
    const result = evaluateAiSystemRegistrationReadiness(initial, {
      now: new Date('2026-09-09T12:00:00.000Z'),
      allowedActions: ['read', 'edit_draft', 'view_control_gaps'],
    });

    expect(result.evidenceCoverage.applicable).toBe(8);
    expect(result.steps.find(step => step.stepId === 'controls')).toMatchObject({
      status: 'not_started',
      blocking: true,
    });
    expect(result.steps.find(step => step.stepId === 'classification')).toMatchObject({
      status: 'external_review_required',
      blocking: true,
    });
    expect(result.allowedActions).toEqual(['read', 'edit_draft', 'view_control_gaps']);
    expect(result.claimBoundary).toContain('not a legal conformity decision');
  });

  it('keeps prohibited systems blocked', () => {
    const blocked = aiActSystemRevisionSchema.parse({
      ...revision,
      lifecycleState: 'blocked',
      prohibitedPracticeCheck: { ...revision.prohibitedPracticeCheck, decision: 'blocked' },
      classification: { ...revision.classification, classification: 'prohibited', highRiskBasis: undefined },
    });
    const result = evaluateAiSystemRegistrationReadiness(blocked, {
      now: new Date('2026-09-09T12:00:00.000Z'),
    });

    expect(result.state).toBe('blocked');
    expect(result.steps.filter(step => step.status === 'blocked').length).toBeGreaterThanOrEqual(3);
  });

  it('blocks an expired classification review', () => {
    const expired = aiActSystemRevisionSchema.parse({
      ...revision,
      classification: {
        ...revision.classification,
        legalReviewRequired: false,
        nextReviewAt: '2026-09-01T00:00:00.000Z',
      },
    });
    const result = evaluateAiSystemRegistrationReadiness(expired, {
      now: new Date('2026-09-09T12:00:00.000Z'),
    });

    expect(result.steps.find(step => step.stepId === 'classification')).toMatchObject({
      status: 'blocked',
      issues: ['The classification review deadline has expired.'],
    });
  });
});
