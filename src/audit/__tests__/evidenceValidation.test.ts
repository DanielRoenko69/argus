import { describe, expect, it } from '@jest/globals';
import {
  AuditEvidenceValidationError,
  decodeAuditEvidenceCursor,
  encodeAuditEvidenceCursor,
  parseAuditEvidenceQuery,
} from '../evidenceValidation.js';

describe('audit evidence query validation', () => {
  it('normalizes the supported exact-match and time filters', () => {
    const cursor = encodeAuditEvidenceCursor({
      occurredAt: '2026-09-07T12:01:04.000Z',
      eventId: '6d826b73-3280-4fdc-a387-6c8ceee493ad',
    });
    expect(parseAuditEvidenceQuery({
      limit: '25', cursor, actor_id: '17', actor_type: 'human',
      resource_type: 'workflow', resource_id: '161', tag: '4',
      action: 'approval.approved', outcome: 'success', risk: 'high',
      policy_id: 'four-eyes', root_run_id: 'run-root-24', trace_id: 'trace-root-24',
      environment: 'production-eu', from: '2026-09-01', to: '2026-09-08',
    })).toEqual({
      limit: 25, cursor, actorId: '17', actorType: 'human',
      resourceType: 'workflow', resourceId: '161', tagId: '4',
      action: 'approval.approved', outcome: 'success', risk: 'high',
      policyId: 'four-eyes', rootRunId: 'run-root-24', traceId: 'trace-root-24',
      environment: 'production-eu',
      from: '2026-09-01T00:00:00.000Z', to: '2026-09-08T00:00:00.000Z',
    });
    expect(decodeAuditEvidenceCursor(cursor)).toEqual({
      occurredAt: '2026-09-07T12:01:04.000Z',
      eventId: '6d826b73-3280-4fdc-a387-6c8ceee493ad',
    });
  });

  it.each([
    [{ limit: '0' }, 'limit must be between 1 and 100'],
    [{ tag: '0' }, 'tag must be a positive integer ID'],
    [{ cursor: 'not-base64-json' }, 'cursor is invalid'],
    [{ actor_type: 'robot' }, 'actor_type is invalid'],
    [{ action: 'NOT VALID' }, 'action is invalid'],
    [{ from: '2026-09-09', to: '2026-09-08' }, 'from must not be after to'],
  ])('rejects malformed evidence query %#', (input, message) => {
    expect(() => parseAuditEvidenceQuery(input)).toThrow(new AuditEvidenceValidationError(message));
  });
});
