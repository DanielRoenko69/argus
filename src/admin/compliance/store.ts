/**
 * Compliance Audit DAO.
 *
 * Three tables (see db/migrations/064_compliance_audit.sql):
 *   mcp_compliance_frameworks — catalogue (eu_ai_act, nis2, …)
 *   mcp_compliance_runs       — one row per "audit start" click
 *   mcp_compliance_findings   — per-article verdicts from a run
 *
 * The runner reuses the existing reviewer-mode agent pipeline rather than
 * adding a new LangGraph workflow. See ./runner.ts for the dispatch logic.
 */
import type pg from 'pg';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type Verdict   = 'passed' | 'warning' | 'failed' | 'not_applicable';
export type Severity  = 'low' | 'medium' | 'high' | 'critical';

export interface Framework {
  id: number;
  slug: string;
  label: string;
  version: string;
  jurisdiction: string | null;
  skill_id: number | null;
  rag_index_id: number | null;
  description: string;
  enabled: boolean;
  created_at: string;
}

export interface Run {
  id: number;
  framework_id: number;
  framework_slug?: string;
  framework_label?: string;
  target: string;
  agent_id: number | null;
  status: RunStatus;
  score: number | null;
  passed_count: number;
  warning_count: number;
  failed_count: number;
  na_count: number;
  triggered_by: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
}

export interface CodePointer {
  file: string;
  line?: number;
  snippet?: string;
}

export interface Finding {
  id?: number;
  run_id?: number;
  article: string;
  title: string;
  verdict: Verdict;
  severity: Severity;
  evidence: string | null;
  code_pointers: CodePointer[];
  remediation: string | null;
  created_at?: string;
}

// ── Frameworks ───────────────────────────────────────────────────

export async function listFrameworks(pool: pg.Pool): Promise<Framework[]> {
  const { rows } = await pool.query<Framework>(
    `SELECT id, slug, label, version, jurisdiction, skill_id, rag_index_id,
            description, enabled, created_at
       FROM mcp_compliance_frameworks
      ORDER BY label`
  );
  return rows;
}

export async function getFrameworkById(pool: pg.Pool, id: number): Promise<Framework | null> {
  const { rows } = await pool.query<Framework>(
    `SELECT * FROM mcp_compliance_frameworks WHERE id=$1`, [id]
  );
  return rows[0] ?? null;
}

export async function getFrameworkBySlug(pool: pg.Pool, slug: string): Promise<Framework | null> {
  const { rows } = await pool.query<Framework>(
    `SELECT * FROM mcp_compliance_frameworks WHERE slug=$1`, [slug]
  );
  return rows[0] ?? null;
}

// ── Runs ─────────────────────────────────────────────────────────

export async function startRun(
  pool: pg.Pool,
  frameworkId: number,
  target: string,
  triggeredBy: string | null,
  agentId: number | null,
): Promise<Run> {
  const { rows } = await pool.query<Run>(
    `INSERT INTO mcp_compliance_runs (framework_id, target, agent_id, status, triggered_by)
     VALUES ($1, $2, $3, 'running', $4)
     RETURNING *`,
    [frameworkId, target, agentId, triggeredBy]
  );
  return rows[0]!;
}

export async function listRuns(pool: pg.Pool, limit = 20): Promise<Run[]> {
  const { rows } = await pool.query<Run>(
    `SELECT r.*, f.slug AS framework_slug, f.label AS framework_label
       FROM mcp_compliance_runs r
       JOIN mcp_compliance_frameworks f ON f.id = r.framework_id
      ORDER BY r.started_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getRun(pool: pg.Pool, id: number): Promise<Run | null> {
  const { rows } = await pool.query<Run>(
    `SELECT r.*, f.slug AS framework_slug, f.label AS framework_label
       FROM mcp_compliance_runs r
       JOIN mcp_compliance_frameworks f ON f.id = r.framework_id
      WHERE r.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function appendFinding(pool: pg.Pool, runId: number, f: Finding): Promise<void> {
  await pool.query(
    `INSERT INTO mcp_compliance_findings
       (run_id, article, title, verdict, severity, evidence, code_pointers, remediation)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      runId, f.article, f.title, f.verdict, f.severity,
      f.evidence ?? null,
      JSON.stringify(f.code_pointers ?? []),
      f.remediation ?? null,
    ]
  );
}

export async function listFindings(pool: pg.Pool, runId: number): Promise<Finding[]> {
  const { rows } = await pool.query<Finding>(
    `SELECT id, run_id, article, title, verdict, severity, evidence,
            code_pointers, remediation, created_at
       FROM mcp_compliance_findings
      WHERE run_id = $1
      ORDER BY id`,
    [runId]
  );
  return rows;
}

export interface RunCounts { passed: number; warning: number; failed: number; na: number }

export async function completeRun(
  pool: pg.Pool, runId: number, score: number, counts: RunCounts,
): Promise<void> {
  await pool.query(
    `UPDATE mcp_compliance_runs
        SET status        = 'completed',
            score         = $2,
            passed_count  = $3,
            warning_count = $4,
            failed_count  = $5,
            na_count      = $6,
            completed_at  = NOW(),
            duration_ms   = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
      WHERE id = $1`,
    [runId, score, counts.passed, counts.warning, counts.failed, counts.na]
  );
}

export async function failRun(pool: pg.Pool, runId: number, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE mcp_compliance_runs
        SET status = 'failed',
            error_message = $2,
            completed_at = NOW(),
            duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
      WHERE id = $1`,
    [runId, errorMessage]
  );
}

export async function deleteRun(pool: pg.Pool, runId: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM mcp_compliance_runs WHERE id = $1`, [runId]
  );
  return (rowCount ?? 0) > 0;
}

// ── Helpers ──────────────────────────────────────────────────────

export function tally(findings: Finding[]): RunCounts {
  const c: RunCounts = { passed: 0, warning: 0, failed: 0, na: 0 };
  for (const f of findings) {
    if (f.verdict === 'passed')         c.passed++;
    else if (f.verdict === 'warning')   c.warning++;
    else if (f.verdict === 'failed')    c.failed++;
    else if (f.verdict === 'not_applicable') c.na++;
  }
  return c;
}

/**
 * Severity-weighted score. Failed/warning/passed contribute proportionally
 * to their severity weight. not_applicable rows are excluded entirely
 * (you don't get credit OR a penalty for things that don't apply).
 *
 *   passed  → full points
 *   warning → 50 %
 *   failed  → 0
 *
 * Returns 0..100 (rounded integer).
 */
export function computeScore(findings: Finding[]): number {
  const weights: Record<Severity, number> = { low: 1, medium: 2, high: 4, critical: 8 };
  let earned = 0;
  let possible = 0;
  for (const f of findings) {
    if (f.verdict === 'not_applicable') continue;
    const w = weights[f.severity] ?? 2;
    possible += w;
    if      (f.verdict === 'passed')  earned += w;
    else if (f.verdict === 'warning') earned += w / 2;
  }
  if (possible === 0) return 100;
  return Math.round((earned / possible) * 100);
}
