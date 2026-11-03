import { incidentRemediationCanonicalEvent } from '../incidentRemediationAudit.js';

describe('incident remediation canonical business audit projection', () => {
  it('binds SSO actor, request, approval, trace and immutable plan hash without provider output', () => {
    const event = incidentRemediationCanonicalEvent({
      eventKey: 'execution-started',
      action: 'aiops.remediation.execution.started',
      outcome: 'success',
      risk: 'high',
      incidentId: 81,
      remediationId: 91,
      planId: 71,
      resourceType: 'aiops-change-plan',
      resourceId: '71',
      resourceRevision: '3',
      planHash: 'c'.repeat(64),
      rootTraceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      traceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      approvalId: `change-plan:71:${'c'.repeat(64)}`,
      policy: { id: 'aiops.remediation.human-approval', version: 'v1', decision: 'approved' },
      before: { planStatus: 'approved', planVersion: 2 },
      after: { planStatus: 'executing', planVersion: 3 },
      operator: {
        id: 7,
        username: 'entra:developer@example.test',
        audit: {
          producerEventId: 'request-123',
          environment: 'production',
          requestId: 'request-123',
          actor: {
            type: 'human',
            id: '7',
            ssoSubject: 'entra:developer@example.test',
            authMethod: 'oidc',
            effectiveRoles: ['operator'],
          },
        },
      },
    });

    expect(event).toMatchObject({
      producer: { name: 'aiops.remediation.lifecycle', eventId: 'request-123:execution-started' },
      environment: 'production',
      solution: 'argus.aiops',
      actor: { id: '7', authMethod: 'oidc', effectiveRoles: ['operator'] },
      resource: { type: 'aiops-change-plan', id: '71', revision: '3' },
      correlation: {
        rootRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        traceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        requestId: 'request-123',
      },
      payload: {
        before: { planStatus: 'approved', planVersion: 2 },
        after: { planStatus: 'executing', planVersion: 3 },
        context: { incidentId: 81, remediationId: 91, planId: 71, planHash: 'c'.repeat(64) },
      },
    });
    expect(JSON.stringify(event)).not.toContain('providerOutput');
    expect(JSON.stringify(event)).not.toContain('writeArguments');
  });

  it('uses an explicit system principal for scheduler-driven monitoring', () => {
    const event = incidentRemediationCanonicalEvent({
      eventKey: 'monitor-81-healthy',
      action: 'aiops.remediation.monitor.healthy',
      outcome: 'success',
      risk: 'medium',
      incidentId: 81,
      remediationId: 91,
      planId: 71,
      monitorId: 81,
      resourceType: 'aiops-post-change-monitor',
      resourceId: '81',
      resourceRevision: '3',
      traceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      operator: { id: null, username: 'argus.core' },
    });

    expect(event.actor).toEqual({
      type: 'system',
      id: 'argus.core',
      ssoSubject: null,
      authMethod: 'internal-scheduler',
      effectiveRoles: [],
    });
    expect(event.producer.eventId.length).toBeLessThanOrEqual(256);
  });

  it('bounds oversized idempotency keys while retaining deterministic event identity', () => {
    const input = {
      eventKey: 'rollback-succeeded',
      action: 'aiops.remediation.rollback.succeeded',
      outcome: 'success' as const,
      risk: 'critical' as const,
      incidentId: 1,
      remediationId: 2,
      resourceType: 'aiops-change-plan' as const,
      resourceId: '3',
      operator: {
        id: 7,
        username: 'Alex',
        audit: {
          producerEventId: `request-${'x'.repeat(300)}`,
          environment: 'test',
          actor: { type: 'human' as const, id: '7', authMethod: 'session', effectiveRoles: ['admin'] },
        },
      },
    };

    const first = incidentRemediationCanonicalEvent(input);
    const second = incidentRemediationCanonicalEvent(input);
    expect(first.producer.eventId).toBe(second.producer.eventId);
    expect(first.producer.eventId.length).toBeLessThanOrEqual(256);
  });
});
