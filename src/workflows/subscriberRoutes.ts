/**
 * Workflow subscriber routes + post-execution notifier.
 *
 *   GET  /api/workflows/:id/subscribers              → list subscribers
 *   POST /api/workflows/:id/subscribers              → add/update {channel, on_success, on_failure, channel_target}
 *   DELETE /api/workflows/:id/subscribers/:userId    → unsubscribe
 *
 * notifySubscribers(pool, wfId, status, executionId): fires on workflow done.
 * Each subscriber gets one Slack message (or PagerDuty for failures).
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getRbacUser } from './rbacHelpers.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';

interface SubscriberRow {
  user_id: number;
  username?: string;
  workflow_id: number;
  channel: string;
  channel_target: string | null;
  on_success: boolean;
  on_failure: boolean;
  created_at: string;
}

export async function notifySubscribers(
  pool: pg.Pool,
  workflowId: number,
  status: 'completed' | 'failed',
  executionId: number,
  errorMessage?: string | null,
): Promise<void> {
  try {
    const { rows: subs } = await pool.query<SubscriberRow>(
      `SELECT s.user_id, u.username, s.workflow_id, s.channel, s.channel_target, s.on_success, s.on_failure
       FROM mcp_workflow_subscribers s
       LEFT JOIN mcp_users u ON u.id = s.user_id
       WHERE s.workflow_id = $1`,
      [workflowId]
    );
    const { rows: wfRows } = await pool.query<{ name: string; pagerduty_key: string | null }>(
      `SELECT name, pagerduty_key FROM mcp_workflows WHERE id = $1`,
      [workflowId]
    );
    const wf = wfRows[0];
    if (!wf) return;

    for (const sub of subs) {
      const want = status === 'completed' ? sub.on_success : sub.on_failure;
      if (!want) continue;
      const emoji = status === 'completed' ? '✅' : '❌';
      const text = `${emoji} Argus-Workflow "${wf.name}" — ${status} (run #${executionId})${errorMessage ? `: ${errorMessage.slice(0, 200)}` : ''}`;

      if (sub.channel === 'slack') {
        const url = process.env['SLACK_WEBHOOK_URL'];
        if (url) {
          await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, channel: sub.channel_target || undefined }),
          }).catch((e) => logger.warn({ err: String(e) }, 'slack post failed'));
        }
      }
      // Future: 'email', 'teams' channels
    }

    // PagerDuty: per-workflow integration key on failures only
    if (status === 'failed' && wf.pagerduty_key) {
      await fetch('https://events.pagerduty.com/v2/enqueue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing_key: wf.pagerduty_key,
          event_action: 'trigger',
          payload: {
            summary: `Argus-Workflow "${wf.name}" failed`,
            severity: 'error',
            source: 'argus-workflow-builder',
            custom_details: { workflow_id: workflowId, execution_id: executionId, error: errorMessage },
          },
        }),
      }).catch((e) => logger.warn({ err: String(e) }, 'pagerduty post failed'));
    }
  } catch (err) {
    logger.warn({ err: String(err), workflowId }, 'notifySubscribers failed');
  }
}

export function registerSubscriberRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  const requestScope = (req: Request, res: Response) => {
    try {
      return resolveAuthorizedWorkspaceScope(req, (req as AuthenticatedRequest).user!);
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(404).json({ error: 'workflow not found' });
        return null;
      }
      throw error;
    }
  };

  app.get('/api/workflows/:id/subscribers', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const scope = requestScope(req, res);
    if (!scope) return;
    const { rows } = await pool.query(
      `SELECT s.user_id, u.username, s.channel, s.channel_target, s.on_success, s.on_failure, s.created_at
       FROM mcp_workflow_subscribers s
       LEFT JOIN mcp_users u ON u.id = s.user_id
       JOIN mcp_workflows workflow ON workflow.id = s.workflow_id
       WHERE s.workflow_id = $1 AND workflow.tenant_key = $2 AND workflow.workspace_key = $3`,
      [wfId, scope.tenantKey, scope.workspaceKey]
    );
    res.json({ subscribers: rows });
  });

  app.post('/api/workflows/:id/subscribers', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const scope = requestScope(req, res);
    if (!scope) return;
    const user = getRbacUser(req);
    if (!user.id) { res.status(401).json({ error: 'no user id' }); return; }
    const body = req.body as { channel?: string; channel_target?: string; on_success?: boolean; on_failure?: boolean };
    const channel = String(body.channel ?? 'slack');
    const visible = await pool.query(
      `SELECT id FROM mcp_workflows WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
      [wfId, scope.tenantKey, scope.workspaceKey],
    );
    if (!visible.rows[0]) { res.status(404).json({ error: 'workflow not found' }); return; }
    await pool.query(
      `INSERT INTO mcp_workflow_subscribers (user_id, workflow_id, channel, channel_target, on_success, on_failure)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, workflow_id, channel) DO UPDATE
         SET channel_target = EXCLUDED.channel_target,
             on_success = EXCLUDED.on_success,
             on_failure = EXCLUDED.on_failure`,
      [user.id, wfId, channel, body.channel_target ?? null,
       body.on_success ?? false, body.on_failure ?? true]
    );
    res.json({ ok: true });
  });

  app.delete('/api/workflows/:id/subscribers/:userId', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const userId = Number(req.params['userId']);
    const scope = requestScope(req, res);
    if (!scope) return;
    await pool.query(
      `DELETE FROM mcp_workflow_subscribers subscriber
       USING mcp_workflows workflow
       WHERE subscriber.workflow_id = workflow.id
         AND subscriber.workflow_id = $1 AND subscriber.user_id = $2
         AND workflow.tenant_key = $3 AND workflow.workspace_key = $4`,
      [wfId, userId, scope.tenantKey, scope.workspaceKey]
    );
    res.json({ ok: true });
  });

  // Runbook export as Markdown — IT-Ops can paste into Confluence runbook page.
  app.get('/api/workflows/:id/runbook', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    if (!wfId) { res.status(400).json({ error: 'invalid id' }); return; }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows } = await pool.query<{
        name: string; description: string; steps: unknown[]; tags: string[];
        lifecycle_status: string; trigger_config: { type?: string; cron_expr?: string; webhook_path?: string };
        maintenance_window: { days?: string[]; from?: string; to?: string };
      }>(
        `SELECT name, description, steps, tags, lifecycle_status, trigger_config, maintenance_window
         FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
        [wfId, scope.tenantKey, scope.workspaceKey]
      );
      const w = rows[0];
      if (!w) { res.status(404).json({ error: 'not found' }); return; }
      res.type('text/markdown').send(renderRunbook(wfId, w));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

interface RunbookData {
  name: string;
  description: string;
  steps: unknown[];
  tags: string[];
  lifecycle_status: string;
  trigger_config: { type?: string; cron_expr?: string; webhook_path?: string };
  maintenance_window: { days?: string[]; from?: string; to?: string };
}

function renderRunbook(id: number, w: RunbookData): string {
  const steps = (w.steps as Array<{
    id: string; label: string; type?: string; tool?: string; agent_id?: number;
    skill_id?: number; depends_on?: string[]; condition?: string;
  }>) ?? [];
  const tagsLine = (w.tags ?? []).length > 0 ? `**Tags:** ${(w.tags ?? []).join(', ')}` : '';
  const trig = w.trigger_config?.type ?? 'manual';
  const trigDetail = trig === 'cron' ? ` (\`${w.trigger_config?.cron_expr}\`)`
                  : trig === 'webhook' ? ` (\`POST /webhooks/wf${w.trigger_config?.webhook_path}\`)`
                  : '';
  const mw = w.maintenance_window;
  const mwLine = mw?.days?.length ? `**Maintenance-Window:** ${mw.days.join(', ')} ${mw.from ?? ''}–${mw.to ?? ''}` : '';

  const stepsList = steps.map((s, i) => {
    const dep = s.depends_on?.length ? ` (nach ${s.depends_on.join(', ')})` : '';
    const ref = s.tool ? `tool=\`${s.tool}\``
             : s.agent_id ? `agent=#${s.agent_id}`
             : s.skill_id ? `skill=#${s.skill_id}`
             : s.type;
    const cond = s.condition ? `\n   - **Bedingung:** \`${s.condition}\`` : '';
    return `${i + 1}. **${s.label}** \`${s.id}\` — _${s.type}_${dep}\n   - ${ref}${cond}`;
  }).join('\n');

  return `# Runbook: ${w.name}

> Argus Workflow #${id} · Status: **${w.lifecycle_status}**
${tagsLine}
${mwLine}

## Beschreibung
${w.description || '_keine_'}

## Trigger
**${trig}**${trigDetail}

## Ablauf (${steps.length} Schritte)

${stepsList || '_keine Schritte_'}

## Manuelle Ausführung
\`\`\`bash
curl -X POST "$ARGUS/api/workflows/${id}/execute" \\
  -H "Authorization: Bearer $ARGUS_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {}}'
\`\`\`

## Builder-Ansicht
[Im Browser öffnen](${process.env['ARGUS_PUBLIC_URL'] ?? 'http://localhost:3000'}/build/workflows/studio/${id})

---
_Generiert von Argus Workflow Builder am ${new Date().toLocaleString('de-DE')}_
`;
}
