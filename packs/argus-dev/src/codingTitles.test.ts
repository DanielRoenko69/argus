import assert from 'node:assert/strict';
import test from 'node:test';
import { commitTitleFor, pullRequestTitleFor } from './workflows/titles.js';

type CodingState = Parameters<typeof commitTitleFor>[0];

test('derives a concise change title from the actionable ticket sentence', () => {
  const state = {
    description: 'Implement Gitea issue #1 in the imported FastAPI repository. Add an unauthenticated GET /api/v1/utils/readiness/ endpoint.',
    plan: '1. In [backend/app/models.py](/workspace/backend/app/models.py), add the model.',
  } as CodingState;

  assert.equal(commitTitleFor(state, 'FASTAPI-E2E-1'), 'Add an unauthenticated GET /api/v1/utils/readiness/ endpoint');
  assert.equal(pullRequestTitleFor(state, 'FASTAPI-E2E-1'), 'FASTAPI-E2E-1: Add an unauthenticated GET /api/v1/utils/readiness/ endpoint');
});

test('strips markdown and numbered-list syntax from a plan fallback', () => {
  const state = {
    description: '',
    plan: '1. In [backend/app/models.py](/workspace/backend/app/models.py), add the model.',
  } as CodingState;

  assert.equal(commitTitleFor(state, 'ARGUS-1'), 'In backend/app/models.py, add the model');
});
