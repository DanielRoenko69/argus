#!/usr/bin/env node
/** Behavioral certification for an explicitly disposable PostgreSQL database. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { AI_ACT_CONTROL_CATALOG } from '../dist/compliance/aiActControlCatalog.js';
import { bindAiSystemProductionRunAudited } from '../dist/compliance/aiSystemRunBinding.js';
import { configureWorkflowAiSystemBindingAudited } from '../dist/compliance/aiSystemWorkflowBinding.js';

const { Pool } = pg;
const databaseUrl = (process.env.AI_ACT_GATE_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.AI_ACT_GATE_CERTIFICATION_REQUIRED === '1';
const reportPath = process.env.AI_ACT_GATE_CERTIFICATION_REPORT
  || 'test-results/ai-act-production-gate-certification.json';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500) || 'unknown error';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function writeReport(report) {
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const report = {
    generated_at: new Date().toISOString(),
    status: 'not_run',
    database: 'explicit disposable database not configured',
    checks: {},
  };
  if (!databaseUrl) {
    await writeReport(report);
    if (required) process.exitCode = 2;
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 10_000 });
  const stamp = Date.now();
  const systemId = randomUUID();
  const revisionId = randomUUID();
  const classificationAssessmentId = randomUUID();
  const scope = { workspaceKey: 'default', tenantKey: 'default', environment: 'certification' };
  const revision = {
    schemaVersion: 1,
    kind: 'ai-system-revision',
    aiSystemId: systemId,
    revisionId,
    revision: 1,
    revisionSha256: 'a'.repeat(64),
    displayName: `Production gate certification ${stamp}`,
    lifecycleState: 'released',
    owner: { actorType: 'system', actorId: 'ai-act-gate-certification' },
    intendedPurpose: 'Execute an isolated synthetic workflow to certify the fail-closed production gate.',
    prohibitedUses: ['Any non-certification use'],
    targetUsers: ['Certification runner'],
    affectedGroups: [],
    regions: ['EU/EEA'],
    marketRoles: [{
      role: 'provider',
      organisationId: 'argus-certification',
      organisationName: 'Argus Certification',
      rationale: 'Owns this isolated technical certification record.',
      confirmedBy: { actorType: 'system', actorId: 'ai-act-gate-certification' },
      confirmedAt: '2026-09-09T08:00:00.000Z',
    }],
    prohibitedPracticeCheck: {
      decision: 'clear',
      articleRefs: ['Article 5'],
      rationale: 'The isolated synthetic test cannot affect a person or production system.',
      decidedBy: { actorType: 'system', actorId: 'ai-act-gate-certification' },
      decidedAt: '2026-09-09T08:00:00.000Z',
    },
    classification: {
      assessmentId: classificationAssessmentId,
      classification: 'out_of_scope',
      articleRefs: ['Article 2'],
      annexRefs: [],
      rationale: 'The isolated record exists solely for technical gate certification.',
      legalReviewRequired: false,
      assessedBy: { actorType: 'system', actorId: 'ai-act-gate-certification' },
      assessedAt: '2026-09-09T08:00:00.000Z',
      nextReviewAt: '2027-09-09T08:00:00.000Z',
    },
    componentBindings: [{
      resourceType: 'workflow',
      resourceId: 'certification-workflow',
      revision: '1',
      sha256: 'b'.repeat(64),
    }],
    dataCategories: ['Synthetic certification data'],
    controlCatalog: {
      catalogId: AI_ACT_CONTROL_CATALOG.catalogId,
      catalogVersion: AI_ACT_CONTROL_CATALOG.catalogVersion,
      catalogSha256: AI_ACT_CONTROL_CATALOG.catalogSha256,
    },
    createdAt: '2026-09-09T08:00:00.000Z',
    releasedAt: '2026-09-09T08:30:00.000Z',
  };
  try {
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO mcp_ai_systems
         (id, workspace_key, tenant_key, display_name, lifecycle_state,
          owner_actor_type, owner_actor_id, current_revision, created_at, updated_at)
       VALUES ($1,'default','default',$2,'released','system','ai-act-gate-certification',NULL,$3,$3)`,
      [systemId, revision.displayName, revision.createdAt],
    );
    await pool.query(
      `INSERT INTO mcp_ai_system_revisions
         (ai_system_id, revision, revision_id, schema_version, revision_sha256,
          revision_json, created_by_actor_type, created_by_actor_id, created_at, released_at)
       VALUES ($1,1,$2,1,$3,$4::jsonb,'system','ai-act-gate-certification',$5,$6)`,
      [systemId, revisionId, revision.revisionSha256, JSON.stringify(revision), revision.createdAt, revision.releasedAt],
    );
    await pool.query('UPDATE mcp_ai_systems SET current_revision=1 WHERE id=$1', [systemId]);
    const workflowResult = await pool.query(
      `INSERT INTO mcp_workflows (name, description, steps, input_params, enabled, lifecycle_status)
       VALUES ($1,'AI Act production gate certification','[]'::jsonb,'[]'::jsonb,true,'draft') RETURNING id`,
      [`ai_act_gate_certification_${stamp}`],
    );
    await pool.query('COMMIT');
    const workflowId = Number(workflowResult.rows[0].id);

    const configured = await configureWorkflowAiSystemBindingAudited(pool, {
      scope,
      actor: { type: 'human', id: 'certifier', ssoSubject: 'oidc:certifier', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
      producerEventId: `gate-cert-workflow-binding-${stamp}`,
      now: () => new Date('2026-09-09T09:00:00.000Z'),
    }, { workflowId, governed: true, aiSystemId: systemId, aiSystemRevision: 1 });
    await pool.query("UPDATE mcp_workflows SET lifecycle_status='production' WHERE id=$1", [workflowId]);

    const allowedExecution = await pool.query(
      `INSERT INTO mcp_workflow_executions (workflow_id, status, triggered_by)
       VALUES ($1,'running','certification:allowed') RETURNING id`, [workflowId],
    );
    const allowedExecutionId = Number(allowedExecution.rows[0].id);
    const allowed = await bindAiSystemProductionRunAudited(pool, {
      scope,
      environment: 'certification',
      workflowExecutionId: allowedExecutionId,
      aiSystemId: systemId,
      aiSystemRevision: 1,
      identity: {
        actorType: 'service', subjectId: 'workload:argus-core:certification',
        role: 'workflow_trigger', authenticationMethod: 'workload_identity',
        identityVerified: true, mfaStepUpAt: null,
      },
      actor: { type: 'service', id: 'workload:argus-core:certification', authMethod: 'workload_identity', effectiveRoles: ['workflow_trigger'] },
      producerEventId: `gate-cert-allow-${stamp}`,
      now: () => new Date('2026-09-09T09:01:00.000Z'),
    });

    const blockedExecution = await pool.query(
      `INSERT INTO mcp_workflow_executions (workflow_id, status, triggered_by)
       VALUES ($1,'running','certification:blocked') RETURNING id`, [workflowId],
    );
    const blockedExecutionId = Number(blockedExecution.rows[0].id);
    const blocked = await bindAiSystemProductionRunAudited(pool, {
      scope,
      environment: 'certification',
      workflowExecutionId: blockedExecutionId,
      aiSystemId: systemId,
      aiSystemRevision: 1,
      identity: {
        actorType: 'service', subjectId: 'api-key:unverified-certification',
        role: 'workflow_trigger', authenticationMethod: 'api_key',
        identityVerified: false, mfaStepUpAt: null,
      },
      actor: { type: 'service', id: 'api-key:unverified-certification', authMethod: 'api_key', effectiveRoles: ['workflow_trigger'] },
      producerEventId: `gate-cert-deny-${stamp}`,
      now: () => new Date('2026-09-09T09:02:00.000Z'),
    });

    const persisted = await pool.query(
      `SELECT workflow_execution_id, execution_authorized, binding_sha256
         FROM mcp_ai_system_run_bindings
        WHERE workflow_execution_id=ANY($1::bigint[]) ORDER BY workflow_execution_id`,
      [[allowedExecutionId, blockedExecutionId]],
    );
    const canonical = await pool.query(
      `SELECT action, outcome FROM mcp_canonical_audit_events
        WHERE producer_event_id=ANY($1::text[]) ORDER BY action`,
      [[`gate-cert-workflow-binding-${stamp}`, `gate-cert-allow-${stamp}`, `gate-cert-deny-${stamp}`]],
    );
    let immutableUpdateBlocked = false;
    try {
      await pool.query(
        'UPDATE mcp_ai_system_run_bindings SET execution_authorized=false WHERE workflow_execution_id=$1',
        [allowedExecutionId],
      );
    } catch {
      immutableUpdateBlocked = true;
    }

    assert(configured.value.governed, 'workflow did not retain its governed binding');
    assert(allowed.binding.executionAuthorized, 'released revision with verified workload identity was blocked');
    assert(!blocked.binding.executionAuthorized, 'unverified API-key service identity was authorized');
    assert(blocked.binding.releaseGate.blockingReasons.length >= 2, 'blocked binding did not retain reasons');
    assert(persisted.rowCount === 2, 'run bindings were not persisted exactly once');
    assert(persisted.rows.every(row => /^[a-f0-9]{64}$/.test(row.binding_sha256)), 'binding digest is malformed');
    assert(canonical.rowCount === 3, 'workflow binding and gate decisions did not emit canonical events');
    assert(immutableUpdateBlocked, 'immutable run binding accepted an update');

    report.status = 'passed';
    report.database = 'explicit disposable database';
    report.checks = {
      workflow_binding_audited: true,
      released_revision_authorized: true,
      unverified_identity_failed_closed: true,
      exact_binding_persisted: true,
      canonical_allow_and_deny_events: true,
      immutable_binding_update_blocked: true,
      allowed_execution_id: allowedExecutionId,
      blocked_execution_id: blockedExecutionId,
    };
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    report.status = 'failed';
    report.database = 'explicit disposable database';
    report.error = safeError(error);
    process.exitCode = 2;
  } finally {
    await pool.end().catch(() => undefined);
  }
  await writeReport(report);
}

try {
  await main();
} catch (error) {
  await writeReport({ generated_at: new Date().toISOString(), status: 'failed', error: safeError(error) });
  process.exitCode = 2;
}
