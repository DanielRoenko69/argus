import type pg from 'pg';
import { bindAiSystemProductionRunAudited } from '../compliance/aiSystemRunBinding.js';
import type { RbacUser } from './rbacHelpers.js';

export interface HumanAiActProductionGateTarget {
  aiSystemId: string | null | undefined;
  aiSystemRevision: number | null | undefined;
}

export interface HumanAiActProductionGateResult {
  authorized: boolean;
  message: string | null;
  bindingId: string | null;
  bindingSha256: string | null;
}

function isSsoUsername(username: string | undefined): boolean {
  return /^(?:entra|oidc):/i.test(username ?? '');
}

/**
 * Apply the AI-system release gate before an interactive production workflow
 * can invoke an Agent or tool. Local-password sessions deliberately fail
 * closed: production execution requires an identity verified by the SSO
 * provider, while mock/sandbox runs never call this helper.
 */
export async function enforceHumanAiActProductionGate(
  pool: pg.Pool,
  input: {
    executionId: number;
    target: HumanAiActProductionGateTarget;
    user: RbacUser;
    source: 'builder' | 'builder-retry' | 'golden-path';
    environment?: string;
  },
): Promise<HumanAiActProductionGateResult> {
  const fail = async (
    message: string,
    bindingId: string | null = null,
    bindingSha256: string | null = null,
  ): Promise<HumanAiActProductionGateResult> => {
    await pool.query(
      `UPDATE mcp_workflow_executions
          SET status='failed', completed_at=now(), error_message=$2,
              execution_snapshot=COALESCE(execution_snapshot, '{}'::jsonb) || jsonb_build_object(
                'aiActProductionGate',
                COALESCE(execution_snapshot->'aiActProductionGate', '{}'::jsonb)
                  || jsonb_build_object('status','blocked','reason',$2)
              )
        WHERE id=$1`,
      [input.executionId, message],
    );
    return { authorized: false, message, bindingId, bindingSha256 };
  };

  if (!input.target.aiSystemId || !input.target.aiSystemRevision) {
    return fail('AI Act governed workflow has no complete AI-system revision binding.');
  }

  const ssoVerified = isSsoUsername(input.user.username);
  const subjectId = ssoVerified
    ? input.user.username!
    : `local-user:${input.user.id ?? 'anonymous'}`;
  const role = input.user.role ?? 'unknown';

  try {
    const gate = await bindAiSystemProductionRunAudited(pool, {
      scope: {
        workspaceKey: 'default',
        tenantKey: 'default',
        environment: input.environment ?? process.env['ARGUS_ENVIRONMENT'] ?? 'production',
      },
      environment: input.environment ?? process.env['ARGUS_ENVIRONMENT'] ?? 'production',
      workflowExecutionId: input.executionId,
      aiSystemId: input.target.aiSystemId,
      aiSystemRevision: input.target.aiSystemRevision,
      identity: {
        actorType: 'human',
        subjectId,
        role,
        authenticationMethod: ssoVerified ? 'sso' : 'local',
        identityVerified: ssoVerified,
        mfaStepUpAt: null,
      },
      actor: {
        type: 'human',
        id: String(input.user.id ?? subjectId),
        ssoSubject: ssoVerified ? subjectId : null,
        authMethod: ssoVerified ? 'oidc' : 'session',
        effectiveRoles: [role],
      },
      producerEventId: `workflow-${input.source}-production-gate:${input.executionId}`,
    });

    await pool.query(
      `UPDATE mcp_workflow_executions
          SET execution_snapshot=COALESCE(execution_snapshot, '{}'::jsonb) || jsonb_build_object(
            'aiActProductionGate', jsonb_build_object(
              'status',$2::text,
              'bindingId',$3::text,
              'bindingSha256',$4::text,
              'aiSystemId',$5::text,
              'aiSystemRevision',$6::integer
            )
          )
        WHERE id=$1`,
      [
        input.executionId,
        gate.binding.releaseGate.status,
        gate.bindingId,
        gate.bindingSha256,
        input.target.aiSystemId,
        input.target.aiSystemRevision,
      ],
    );

    if (!gate.binding.executionAuthorized) {
      return fail(
        `AI Act production release gate blocked execution: ${gate.binding.releaseGate.blockingReasons.join('; ')}`,
        gate.bindingId,
        gate.bindingSha256,
      );
    }
    return {
      authorized: true,
      message: null,
      bindingId: gate.bindingId,
      bindingSha256: gate.bindingSha256,
    };
  } catch (error) {
    return fail(`AI Act production release gate failed closed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
