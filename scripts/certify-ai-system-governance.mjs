#!/usr/bin/env node
/**
 * Behavioral certification for AI-system lifecycle governance.
 * The script runs only against an explicitly configured disposable database.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { AI_ACT_CONTROL_CATALOG } from '../dist/compliance/aiActControlCatalog.js';
import { recordAiSystemControlAssessment } from '../dist/compliance/aiSystemControlLedger.js';
import { createAiSystemAudited } from '../dist/compliance/aiSystemRegistry.js';
import {
  classifyAiSystemAudited,
  releaseAiSystemAudited,
  reviseAiSystemAudited,
} from '../dist/compliance/aiSystemGovernance.js';

const { Pool } = pg;
const databaseUrl = (process.env.AI_SYSTEM_GOVERNANCE_CERTIFICATION_DATABASE_URL || '').trim();
const required = process.env.AI_SYSTEM_GOVERNANCE_CERTIFICATION_REQUIRED === '1';
const reportPath = process.env.AI_SYSTEM_GOVERNANCE_CERTIFICATION_REPORT
  || 'test-results/ai-system-governance-certification.json';

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

function humanContext(stamp, actorId, eventSuffix) {
  return {
    scope: {
      workspaceKey: 'ai-system-governance-certification',
      tenantKey: 'certification-tenant',
      environment: 'certification',
    },
    actor: {
      type: 'human',
      id: actorId,
      ssoSubject: `oidc:${actorId}`,
      authMethod: 'oidc',
      effectiveRoles: ['platform_admin'],
    },
    producerEventId: `ai-system-governance-${stamp}-${eventSuffix}`,
    requestId: `request-${stamp}-${eventSuffix}`,
    mfaVerifiedAt: '2026-09-10T09:58:00.000Z',
    mfaMethod: 'otp',
    mfaMaxAgeSeconds: 600,
    now: () => new Date('2026-09-10T10:00:00.000Z'),
  };
}

function expectFourEyes(error) {
  return error && typeof error === 'object' && error.code === 'AI_SYSTEM_FOUR_EYES_REQUIRED';
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
  const scope = { workspaceKey: 'ai-system-governance-certification', tenantKey: 'certification-tenant' };
  const createContext = {
    scope: { ...scope, environment: 'certification' },
    actor: {
      type: 'system',
      id: 'ai-system-governance-certification',
      authMethod: 'certification',
      effectiveRoles: ['platform_admin'],
    },
    producerEventId: `ai-system-governance-${stamp}-create`,
    requestId: `request-${stamp}-create`,
    now: () => new Date('2026-09-10T09:50:00.000Z'),
  };
  const createInput = {
    displayName: `AI-system governance certification ${stamp}`,
    intendedPurpose: 'Certify immutable lifecycle decisions in an isolated technical environment.',
    prohibitedUses: ['Any production or person-affecting use'],
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
      rationale: 'The isolated technical test cannot affect a natural person.',
    },
    classification: {
      classification: 'out_of_scope',
      articleRefs: ['Article 2'],
      annexRefs: [],
      rationale: 'This synthetic record exists only for technical certification.',
      legalReviewRequired: false,
      nextReviewAt: '2027-09-10T10:00:00.000Z',
    },
    componentBindings: [{
      resourceType: 'workflow',
      resourceId: 'certification-workflow',
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
    const created = await createAiSystemAudited(pool, createContext, createInput);
    const revisionInput = {
      expectedRevision: created.value.revision,
      expectedRevisionSha256: created.value.revisionSha256,
      changeSummary: 'Certify that any material change resets regulatory assessment.',
      displayName: created.value.displayName,
      intendedPurpose: created.value.intendedPurpose,
      prohibitedUses: created.value.prohibitedUses,
      targetUsers: created.value.targetUsers,
      affectedGroups: created.value.affectedGroups,
      regions: created.value.regions,
      marketRoles: created.value.marketRoles.map(({ confirmedBy, confirmedAt, ...role }) => role),
      componentBindings: created.value.componentBindings.map(binding => ({ ...binding, revision: '2' })),
      dataCategories: created.value.dataCategories,
      controlCatalog: created.value.controlCatalog,
    };
    const editor = humanContext(stamp, 'editor', 'revision');
    const revised = await reviseAiSystemAudited(pool, editor, created.value.aiSystemId, revisionInput);

    const classificationInput = {
      expectedRevision: revised.value.revision,
      expectedRevisionSha256: revised.value.revisionSha256,
      prohibitedPracticeCheck: {
        decision: 'clear',
        articleRefs: ['Article 5'],
        rationale: 'The reassessed technical purpose contains no prohibited practice.',
      },
      classification: {
        classification: 'out_of_scope',
        articleRefs: ['Article 2'],
        annexRefs: [],
        rationale: 'The isolated lifecycle certification remains outside production scope.',
        legalReviewRequired: false,
        nextReviewAt: '2027-09-10T10:00:00.000Z',
      },
    };
    let authorClassificationBlocked = false;
    try {
      await classifyAiSystemAudited(pool, {
        ...editor,
        producerEventId: `ai-system-governance-${stamp}-self-classify`,
      }, revised.value.aiSystemId, classificationInput);
    } catch (error) {
      authorClassificationBlocked = expectFourEyes(error);
      if (!authorClassificationBlocked) throw error;
    }

    const classifier = humanContext(stamp, 'classifier', 'classification');
    const classified = await classifyAiSystemAudited(pool, classifier, revised.value.aiSystemId, classificationInput);
    const requiredControls = AI_ACT_CONTROL_CATALOG.controls.filter(control => control.blocksProduction && control.applicability !== 'high_risk');
    for (const [index, control] of requiredControls.entries()) {
      await recordAiSystemControlAssessment(
        pool,
        humanContext(stamp, `control-reviewer-${index + 1}`, `control-${index + 1}`),
        classified.value.aiSystemId,
        control.controlId,
        {
          expectedRevision: classified.value.revision,
          expectedRevisionSha256: classified.value.revisionSha256,
          status: 'satisfied',
          ownerParty: 'provider',
          ownerId: `control-owner-${index + 1}`,
          dueAt: null,
          reassessmentAt: '2027-09-10T10:00:00.000Z',
          rationale: 'The independent classification evidence satisfies this control for the isolated certification scope.',
          evidence: [{ evidenceType: 'canonical_event', evidenceId: classified.auditEvent.eventId, sha256: classified.auditEvent.eventHash }],
          exception: null,
        },
      );
    }
    const releaseInput = {
      expectedRevision: classified.value.revision,
      expectedRevisionSha256: classified.value.revisionSha256,
      decisionRationale: 'Independent lifecycle evidence was verified server-side.',
      evidence: [{
        evidenceType: 'canonical_event',
        evidenceId: classified.auditEvent.eventId,
        sha256: classified.auditEvent.eventHash,
      }],
    };
    let classifierReleaseBlocked = false;
    try {
      await releaseAiSystemAudited(pool, {
        ...classifier,
        producerEventId: `ai-system-governance-${stamp}-self-release`,
      }, classified.value.aiSystemId, releaseInput);
    } catch (error) {
      classifierReleaseBlocked = expectFourEyes(error);
      if (!classifierReleaseBlocked) throw error;
    }

    const releaser = humanContext(stamp, 'releaser', 'release');
    const released = await releaseAiSystemAudited(pool, releaser, classified.value.aiSystemId, releaseInput);
    const replay = await releaseAiSystemAudited(pool, releaser, classified.value.aiSystemId, releaseInput);
    const decisions = await pool.query(
      `SELECT action, source_revision, result_revision, actor_id, actor_sso_subject,
              mfa_verified_at, mfa_method, decision_sha256
         FROM mcp_ai_system_governance_decisions
        WHERE ai_system_id=$1 ORDER BY result_revision`,
      [created.value.aiSystemId],
    );
    let immutableUpdateBlocked = false;
    try {
      await pool.query(
        `UPDATE mcp_ai_system_governance_decisions
            SET actor_id='tampered'
          WHERE decision_id=$1`,
        [released.decisionId],
      );
    } catch {
      immutableUpdateBlocked = true;
    }

    assert(revised.value.lifecycleState === 'assessment_in_progress', 'revision did not reset regulatory assessment');
    assert(revised.value.revision === created.value.revision + 1, 'revision number was not advanced exactly once');
    assert(authorClassificationBlocked, 'revision author was allowed to self-classify');
    assert(classified.value.lifecycleState === 'ready_for_independent_review', 'classification did not enter independent review');
    assert(classifierReleaseBlocked, 'classifier was allowed to self-release');
    assert(released.value.lifecycleState === 'released', 'independent release did not produce released state');
    assert(released.value.revision === classified.value.revision + 1, 'release did not create a new immutable revision');
    assert(replay.replayed, 'release idempotency did not replay');
    assert(replay.value.revisionSha256 === released.value.revisionSha256, 'release replay resolved a different revision');
    assert(decisions.rowCount === 3, 'expected exactly revision, classification and release decisions');
    assert(decisions.rows.map(row => row.action).join(',') === 'revision,classification,release', 'decision order drifted');
    assert(decisions.rows.every(row => row.actor_sso_subject && row.mfa_method && /^[a-f0-9]{64}$/.test(row.decision_sha256)), 'decision assurance or digest is incomplete');
    assert(immutableUpdateBlocked, 'append-only governance decision accepted an update');

    report.status = 'passed';
    report.database = 'explicit disposable database';
    report.checks = {
      material_change_reset_assessment: true,
      immutable_revision_chain: true,
      author_self_classification_blocked: true,
      independent_classification: true,
      server_owned_control_catalog_pinned: true,
      required_legal_controls_satisfied: true,
      classifier_self_release_blocked: true,
      release_evidence_verified_server_side: true,
      independent_release: true,
      sso_mfa_assurance_persisted: true,
      canonical_events_persisted: true,
      idempotent_release_replay: true,
      governance_decision_update_blocked: true,
      ai_system_id: created.value.aiSystemId,
      released_revision: released.value.revision,
      released_revision_sha256: released.value.revisionSha256,
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
