import type { IncidentAiopsTaskRecord } from '../observability/incidentAiopsTasks.js';

export type AiopsDemoRemediation =
  | { adapter: 'scale'; desiredReplicas: number }
  | { adapter: 'deployment-revision'; targetRevision: number };

function boundedPositiveInteger(value: unknown, maximum: number): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : null;
}

export function aiopsDemoRemediationFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): AiopsDemoRemediation {
  const adapter = environment['ARGUS_AIOPS_DEMO_REMEDIATION']?.trim();
  if (adapter === 'deployment-revision') {
    const targetRevision = boundedPositiveInteger(environment['ARGUS_AIOPS_TARGET_REVISION'], 1_000_000_000);
    if (targetRevision == null) {
      throw new Error('ARGUS_AIOPS_TARGET_REVISION must identify one retained positive Deployment revision');
    }
    return { adapter, targetRevision };
  }
  if (adapter && adapter !== 'scale') {
    throw new Error(`Unsupported ARGUS_AIOPS_DEMO_REMEDIATION: ${adapter}`);
  }
  const desiredReplicas = boundedPositiveInteger(environment['ARGUS_AIOPS_DESIRED_REPLICAS'] ?? 3, 50);
  if (desiredReplicas == null) throw new Error('ARGUS_AIOPS_DESIRED_REPLICAS must be between 1 and 50');
  return { adapter: 'scale', desiredReplicas };
}

export function withBoundDemoRemediation(
  record: IncidentAiopsTaskRecord,
  remediation: AiopsDemoRemediation,
): IncidentAiopsTaskRecord {
  if (!record.result) throw new Error('AIOps investigation has no structured reviewer result');
  const action = remediation.adapter === 'deployment-revision'
    ? {
        priority: 'now' as const,
        action: `Restore the checkout-api Deployment to retained revision ${remediation.targetRevision}.`,
        rationale: 'The controlled rollout introduced an unready pod template. This exact retained revision is the pre-incident deployment state and exercises the governed, fingerprint-bound restore lifecycle.',
        requiresApproval: true,
        executionIntent: {
          adapterKey: 'kubernetes.deployment-revision-rollback.v1' as const,
          workloadKind: 'Deployment' as const,
          workloadName: 'checkout-api',
          targetRevision: remediation.targetRevision,
        },
      }
    : {
        priority: 'next' as const,
        action: `Scale the checkout-api Deployment from its current replica count to ${remediation.desiredReplicas} replicas.`,
        rationale: 'This local demo action exercises the complete governed-write lifecycle against the isolated argus-demo namespace.',
        requiresApproval: true,
        executionIntent: {
          adapterKey: 'kubernetes.scale.v1' as const,
          workloadKind: 'Deployment' as const,
          workloadName: 'checkout-api',
          desiredReplicas: remediation.desiredReplicas,
        },
      };
  if (record.result.recommendedActions.some(item =>
    item.executionIntent?.adapterKey === action.executionIntent.adapterKey)) return record;
  return {
    ...record,
    result: {
      ...record.result,
      recommendedActions: [...record.result.recommendedActions.slice(0, 5), action],
    },
  };
}
