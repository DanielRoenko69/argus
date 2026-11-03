/**
 * Express handlers for /api/admin/compliance/*.
 *
 * Endpoints:
 *   GET    /frameworks                       list catalogue
 *   GET    /runs                             list recent runs (with framework label)
 *   POST   /runs                             {framework_slug, target} — kicks off audit, returns 202
 *   GET    /runs/:id                         single run details
 *   GET    /runs/:id/findings                findings list for a run
 *   GET    /runs/:id/export.pdf              PDF report
 *   GET    /runs/:id/export.csv              CSV export
 *   DELETE /runs/:id                         remove a run (admin clean-up)
 *
 * POST /runs dispatches the audit via setImmediate. The UI polls
 * /runs/:id every ~2 s until status becomes 'completed' | 'failed'.
 */
import type { Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../../lib/logger.js';
import type { Config } from '../../config/env.js';
import {
  deleteRun, getFrameworkById, getFrameworkBySlug, getRun,
  listFindings, listFrameworks, listRuns, startRun,
} from './store.js';
import { executeAuditRun, resolveComplianceAuditorAgentId } from './runner.js';
import { exportCsv, exportPdf } from './export.js';
import { normalizeComplianceTarget, parseComplianceRunId } from './input.js';
import { writeAdminAudit } from '../../lib/adminAudit.js';

function userOf(req: Request): { id?: number; username?: string } {
  const u = (req as unknown as { user?: { id: number; username?: string; email?: string } }).user;
  if (!u) return {};
  return { id: u.id, username: u.username ?? u.email };
}

export function handleCompliance(pool: pg.Pool, config: Config) {
  return {
    listFrameworks: async (_req: Request, res: Response): Promise<void> => {
      try {
        const [data, auditorId] = await Promise.all([
          listFrameworks(pool),
          resolveComplianceAuditorAgentId(pool),
        ]);
        res.json({
          frameworks: data,
          auditor_agent_id: auditorId || null,
        });
      } catch (err) {
        logger.error({ err }, 'listFrameworks failed');
        res.status(500).json({ error: 'Failed to list frameworks' });
      }
    },

    listRuns: async (req: Request, res: Response): Promise<void> => {
      try {
        const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 100);
        const data = await listRuns(pool, limit);
        res.json({ runs: data });
      } catch (err) {
        logger.error({ err }, 'listRuns failed');
        res.status(500).json({ error: 'Failed to list runs' });
      }
    },

    startRun: async (req: Request, res: Response): Promise<void> => {
      try {
        const body = req.body as { framework_slug?: string; framework_id?: number; target?: string };
        let target: string;
        try { target = normalizeComplianceTarget(body.target); }
        catch (error) {
          res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid target' });
          return;
        }

        const framework = body.framework_id
          ? await getFrameworkById(pool, body.framework_id)
          : body.framework_slug
            ? await getFrameworkBySlug(pool, body.framework_slug)
            : null;
        if (!framework) {
          res.status(404).json({ error: 'Framework not found' });
          return;
        }
        if (!framework.enabled) {
          res.status(400).json({ error: `Framework ${framework.slug} is disabled` });
          return;
        }
        if (!framework.skill_id) {
          res.status(400).json({
            error: `Framework ${framework.slug} has no skill configured — author the checklist first`,
          });
          return;
        }

        const agentId = await resolveComplianceAuditorAgentId(pool);
        if (!agentId) {
          res.status(503).json({
            error:
              'No compliance auditor agent configured — apply migration ' +
              '066_compliance_auditor_agent.sql or set COMPLIANCE_AUDITOR_AGENT_ID',
          });
          return;
        }

        const user = userOf(req);
        const run = await startRun(pool, framework.id, target, user.username ?? null, agentId);
        writeAdminAudit(pool, req, 'started', 'mcp_compliance_runs', String(run.id), framework.label, null, {
          framework_id: framework.id,
          framework_slug: framework.slug,
          target,
          status: run.status,
        });

        // Detached execution — runner persists status + findings as it goes.
        setImmediate(() => {
          executeAuditRun(pool, run, config).catch((err) => {
            logger.error({ err, runId: run.id }, 'executeAuditRun threw unexpectedly');
          });
        });

        res.status(202).json({
          run_id: run.id,
          status: run.status,
          framework: framework.slug,
          target,
        });
      } catch (err) {
        logger.error({ err }, 'startRun failed');
        res.status(500).json({ error: 'Failed to start run' });
      }
    },

    getRun: async (req: Request, res: Response): Promise<void> => {
      try {
        const id = parseComplianceRunId(req.params['id']);
        if (!id) { res.status(400).json({ error: 'Invalid run id' }); return; }
        const run = await getRun(pool, id);
        if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
        res.json({ run });
      } catch (err) {
        logger.error({ err }, 'getRun failed');
        res.status(500).json({ error: 'Failed to get run' });
      }
    },

    listFindings: async (req: Request, res: Response): Promise<void> => {
      try {
        const id = parseComplianceRunId(req.params['id']);
        if (!id) { res.status(400).json({ error: 'Invalid run id' }); return; }
        const run = await getRun(pool, id);
        if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
        const findings = await listFindings(pool, id);
        res.json({ findings });
      } catch (err) {
        logger.error({ err }, 'listFindings failed');
        res.status(500).json({ error: 'Failed to list findings' });
      }
    },

    exportPdf: async (req: Request, res: Response): Promise<void> => {
      try {
        const id = parseComplianceRunId(req.params['id']);
        if (!id) { res.status(400).json({ error: 'Invalid run id' }); return; }
        const run = await getRun(pool, id);
        if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
        if (run.status !== 'completed') { res.status(409).json({ error: 'Only completed runs can be exported' }); return; }
        const framework = await getFrameworkById(pool, run.framework_id);
        if (!framework) { res.status(500).json({ error: 'Framework missing' }); return; }
        const findings = await listFindings(pool, id);
        const pdf = await exportPdf(framework, run, findings);
        writeAdminAudit(pool, req, 'exported_pdf', 'mcp_compliance_runs', String(id), framework.label, null, {
          framework_id: framework.id,
          finding_count: findings.length,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="compliance-run-${id}-${framework.slug}.pdf"`,
        );
        res.send(pdf);
      } catch (err) {
        logger.error({ err }, 'exportPdf failed');
        res.status(500).json({ error: 'Failed to render PDF' });
      }
    },

    exportCsv: async (req: Request, res: Response): Promise<void> => {
      try {
        const id = parseComplianceRunId(req.params['id']);
        if (!id) { res.status(400).json({ error: 'Invalid run id' }); return; }
        const run = await getRun(pool, id);
        if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
        if (run.status !== 'completed') { res.status(409).json({ error: 'Only completed runs can be exported' }); return; }
        const framework = await getFrameworkById(pool, run.framework_id);
        if (!framework) { res.status(500).json({ error: 'Framework missing' }); return; }
        const findings = await listFindings(pool, id);
        const csv = exportCsv(framework, run, findings);
        writeAdminAudit(pool, req, 'exported_csv', 'mcp_compliance_runs', String(id), framework.label, null, {
          framework_id: framework.id,
          finding_count: findings.length,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="compliance-run-${id}.csv"`,
        );
        res.send(csv);
      } catch (err) {
        logger.error({ err }, 'exportCsv failed');
        res.status(500).json({ error: 'Failed to render CSV' });
      }
    },

    deleteRun: async (req: Request, res: Response): Promise<void> => {
      try {
        const id = parseComplianceRunId(req.params['id']);
        if (!id) { res.status(400).json({ error: 'Invalid run id' }); return; }
        const run = await getRun(pool, id);
        if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
        if (run.status === 'queued' || run.status === 'running') {
          res.status(409).json({ error: 'Active compliance runs cannot be deleted' });
          return;
        }
        const ok = await deleteRun(pool, id);
        if (!ok) { res.status(404).json({ error: 'Run not found' }); return; }
        writeAdminAudit(pool, req, 'deleted', 'mcp_compliance_runs', String(id), run.framework_label ?? null, {
          framework_id: run.framework_id,
          target: run.target,
          status: run.status,
          score: run.score,
          finding_counts: {
            passed: run.passed_count,
            warning: run.warning_count,
            failed: run.failed_count,
            na: run.na_count,
          },
        }, null);
        res.json({ deleted: true });
      } catch (err) {
        logger.error({ err }, 'deleteRun failed');
        res.status(500).json({ error: 'Failed to delete run' });
      }
    },
  };
}
