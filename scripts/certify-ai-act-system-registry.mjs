#!/usr/bin/env node
/**
 * Behavioral gate for an explicitly disposable, fully migrated PostgreSQL DB.
 * It never falls back to the developer database.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { AI_ACT_CONTROL_CATALOG } from '../dist/compliance/aiActControlCatalog.js';
import { createAiSystemAudited, getAiSystemRevision, listAiSystems } from '../dist/compliance/aiSystemRegistry.js';
import { evaluateAiSystemRegistrationReadiness } from '../dist/compliance/aiSystemReadiness.js';

const { Pool } = pg;
const databaseUrl = (process.env.AI_ACT_REGISTRY_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.AI_ACT_REGISTRY_CERTIFICATION_REQUIRED === '1';
const reportPath = process.env.AI_ACT_REGISTRY_CERTIFICATION_REPORT
  || 'test-results/ai-act-system-registry-certification.json';

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
  const scope = { workspaceKey: 'certification-workspace', tenantKey: 'certification-tenant' };
  const producerEventId = `ai-act-registry-certification-${Date.now()}`;
  const context = {
    scope: { ...scope, environment: 'certification' },
    actor: {
      type: 'system',
      id: 'ai-act-registry-certification',
      authMethod: 'certification',
      effectiveRoles: ['platform_admin'],
    },
    producerEventId,
    requestId: producerEventId,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  };
  const input = {
    displayName: `AI Act registry certification ${producerEventId}`,
    intendedPurpose: 'Certify the immutable Argus AI-system registry in an isolated database.',
    prohibitedUses: ['Production use'],
    targetUsers: ['Certification runner'],
    affectedGroups: [],
    regions: ['EU/EEA'],
    marketRoles: [{
      role: 'provider',
      organisationId: 'argus-certification',
      organisationName: 'Argus Certification',
      rationale: 'Owns this isolated technical certification record.',
    }],
    prohibitedPracticeCheck: {
      decision: 'clear',
      articleRefs: ['Article 5'],
      rationale: 'The isolated technical test cannot affect a person or production system.',
    },
    classification: {
      classification: 'out_of_scope',
      articleRefs: ['Article 2'],
      annexRefs: [],
      rationale: 'This record exists solely for an isolated technical persistence test.',
      legalReviewRequired: false,
      nextReviewAt: '2027-09-09T12:00:00.000Z',
    },
    componentBindings: [{
      resourceType: 'agent',
      resourceId: 'certification-agent',
      revision: '1',
      sha256: '1'.repeat(64),
    }],
    dataCategories: ['Synthetic certification data'],
    controlCatalog: {
      catalogId: AI_ACT_CONTROL_CATALOG.catalogId,
      catalogVersion: AI_ACT_CONTROL_CATALOG.catalogVersion,
      catalogSha256: AI_ACT_CONTROL_CATALOG.catalogSha256,
    },
  };

  try {
    const created = await createAiSystemAudited(pool, context, input);
    const replay = await createAiSystemAudited(pool, context, input);
    const loaded = await getAiSystemRevision(pool, scope, created.value.aiSystemId);
    const listed = await listAiSystems(pool, scope, 10);
    const readiness = evaluateAiSystemRegistrationReadiness(loaded, { now: context.now() });
    const event = await pool.query(
      `SELECT event_id, resource_id, resource_revision
         FROM mcp_canonical_audit_events
        WHERE event_id=$1 AND workspace_key=$2 AND tenant_key=$3`,
      [created.auditEvent.eventId, scope.workspaceKey, scope.tenantKey],
    );
    const outbox = await pool.query(
      'SELECT event_id FROM mcp_canonical_audit_outbox WHERE event_id=$1',
      [created.auditEvent.eventId],
    );
    let immutableUpdateBlocked = false;
    try {
      await pool.query(
        'UPDATE mcp_ai_system_revisions SET revision_sha256=$2 WHERE ai_system_id=$1',
        [created.value.aiSystemId, 'f'.repeat(64)],
      );
    } catch {
      immutableUpdateBlocked = true;
    }

    assert(!created.replayed, 'first create unexpectedly replayed');
    assert(replay.replayed, 'idempotent create did not replay');
    assert(replay.value.aiSystemId === created.value.aiSystemId, 'replay resolved a different AI system');
    assert(loaded.revisionSha256 === created.value.revisionSha256, 'loaded revision digest drifted');
    assert(listed.some(item => item.aiSystemId === created.value.aiSystemId), 'scoped registry list missed the created system');
    assert(readiness.state === 'controls_incomplete', 'initial readiness lifecycle is not controls_incomplete');
    assert(readiness.steps.some(step => step.stepId === 'controls' && step.blocking), 'control evidence gap did not block readiness');
    assert(event.rowCount === 1, 'canonical audit event was not persisted');
    assert(outbox.rowCount === 1, 'canonical audit outbox row was not persisted');
    assert(immutableUpdateBlocked, 'immutable revision accepted an update');

    report.status = 'passed';
    report.database = 'explicit disposable database';
    report.checks = {
      create: true,
      idempotent_replay: true,
      scoped_read: true,
      readiness_projection: true,
      canonical_event: true,
      transactional_outbox: true,
      immutable_revision_update_blocked: true,
      ai_system_id: created.value.aiSystemId,
      revision_sha256: created.value.revisionSha256,
    };
  } catch (error) {
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
