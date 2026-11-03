import { redact } from '../lib/redaction.js';
import type { Finding, Framework, Run } from '../admin/compliance/store.js';

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeText(value: string | null | undefined): string | null {
  return value ? redact(value).text.slice(0, 20_000) : null;
}

function safeRunError(value: string | null | undefined): string | null {
  if (!value) return null;
  const known = [
    'has no skill_id',
    'has no skill configured',
    'No compliance auditor agent configured',
    'not found or empty',
    'response contained no parseable JSON array',
    'none were valid findings',
    'without executing an evidence tool',
    'is disabled',
  ].find(fragment => value.includes(fragment));
  if (!known) return 'Assessment execution failed. Inspect the protected server logs or trace for details.';
  return safeText(value)?.slice(0, 2_000) ?? 'Assessment execution failed.';
}

export function mapComplianceFramework(framework: Framework, auditorReady: boolean) {
  const checklistReady = framework.skill_id != null;
  return {
    id: framework.id,
    slug: framework.slug,
    label: framework.label,
    version: framework.version,
    jurisdiction: framework.jurisdiction,
    description: framework.description,
    enabled: framework.enabled,
    checklistReady,
    knowledgeAttached: framework.rag_index_id != null,
    ready: framework.enabled && checklistReady && auditorReady,
  };
}

export function mapComplianceRun(run: Run) {
  return {
    id: run.id,
    frameworkId: run.framework_id,
    frameworkSlug: run.framework_slug ?? null,
    frameworkLabel: run.framework_label ?? null,
    target: safeText(run.target) ?? '',
    agentId: run.agent_id,
    status: run.status,
    score: run.score == null ? null : Number(run.score),
    counts: {
      passed: run.passed_count,
      warning: run.warning_count,
      failed: run.failed_count,
      notApplicable: run.na_count,
    },
    triggeredBy: safeText(run.triggered_by),
    startedAt: iso(run.started_at),
    completedAt: iso(run.completed_at),
    durationMs: run.duration_ms == null ? null : Number(run.duration_ms),
    error: safeRunError(run.error_message),
  };
}

export function mapComplianceFinding(finding: Finding) {
  return {
    id: finding.id ?? null,
    article: safeText(finding.article) ?? '',
    title: safeText(finding.title) ?? '',
    verdict: finding.verdict,
    severity: finding.severity,
    evidence: safeText(finding.evidence),
    remediation: safeText(finding.remediation),
    codePointers: (finding.code_pointers ?? []).slice(0, 100).map(pointer => ({
      file: safeText(pointer.file)?.slice(0, 1_024) ?? '',
      line: Number.isSafeInteger(pointer.line) && (pointer.line ?? 0) > 0 ? pointer.line : null,
      snippet: safeText(pointer.snippet)?.slice(0, 4_000) ?? null,
    })),
    createdAt: iso(finding.created_at),
  };
}

export function buildComplianceWorkspace(
  frameworks: Framework[],
  runs: Run[],
  auditorAgentId: number,
) {
  const auditorReady = auditorAgentId > 0;
  const mappedFrameworks = frameworks.map(framework => mapComplianceFramework(framework, auditorReady));
  const mappedRuns = runs.map(mapComplianceRun);
  const completed = mappedRuns.filter(run => run.status === 'completed' && run.score != null);
  const scored = completed.map(run => run.score as number);
  return {
    generatedAt: new Date().toISOString(),
    assessmentNotice: 'Automated evidence assessment. Results support human review and do not constitute certification or legal advice.',
    auditor: { ready: auditorReady, agentId: auditorReady ? auditorAgentId : null },
    stats: {
      frameworks: mappedFrameworks.length,
      readyFrameworks: mappedFrameworks.filter(framework => framework.ready).length,
      activeRuns: mappedRuns.filter(run => run.status === 'queued' || run.status === 'running').length,
      completedRuns: completed.length,
      averageScore: scored.length ? Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length) : null,
      recentGaps: mappedRuns.reduce((sum, run) => sum + run.counts.failed + run.counts.warning, 0),
    },
    frameworks: mappedFrameworks,
    runs: mappedRuns,
  };
}
