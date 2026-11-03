/**
 * K8s resource pickers — provide live dropdown data for builder fields.
 *
 *   GET /api/workflows/k8s/namespaces            → list of namespace names
 *   GET /api/workflows/k8s/pods?namespace=foo    → pods in namespace
 *   GET /api/workflows/k8s/services?namespace=foo
 *
 * Internally calls the existing executeTool — no new K8s code needed.
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import type { Config } from '../config/env.js';
import { executeTool } from '../tools/toolRunner.js';

function parseListFromToolResult(text: string): string[] {
  // Tool outputs are commonly newline lists or JSON. Try both.
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) return j.map((x) => String(typeof x === 'object' ? (x as { name?: string }).name ?? x : x)).filter(Boolean);
    if (j && typeof j === 'object' && Array.isArray((j as { items?: unknown[] }).items)) {
      return (j as { items: Array<{ metadata?: { name?: string }; name?: string }> }).items.map((it) => it.metadata?.name ?? it.name ?? '').filter(Boolean);
    }
  } catch { /* not JSON */ }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export function registerK8sPickerRoutes(
  app: Express,
  pool: pg.Pool,
  config: Config,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  app.get('/api/workflows/k8s/namespaces', requireAuth, async (_req, res) => {
    try {
      const r = await executeTool('k8s_get_namespaces', {}, { config, pool });
      const text = r.content.map((c) => c.text).join('\n');
      res.json({ items: parseListFromToolResult(text) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'k8s namespaces fetch failed (returning empty)');
      res.json({ items: [], error: msg });
    }
  });

  app.get('/api/workflows/k8s/pods', requireAuth, async (req, res) => {
    const namespace = String(req.query['namespace'] ?? '');
    if (!namespace) { res.status(400).json({ error: 'namespace required' }); return; }
    try {
      const r = await executeTool('k8s_get_pods', { namespace }, { config, pool });
      const text = r.content.map((c) => c.text).join('\n');
      res.json({ items: parseListFromToolResult(text) });
    } catch (err) {
      res.json({ items: [], error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/workflows/k8s/services', requireAuth, async (req, res) => {
    const namespace = String(req.query['namespace'] ?? '');
    if (!namespace) { res.status(400).json({ error: 'namespace required' }); return; }
    try {
      const r = await executeTool('k8s_get_services', { namespace }, { config, pool });
      const text = r.content.map((c) => c.text).join('\n');
      res.json({ items: parseListFromToolResult(text) });
    } catch (err) {
      res.json({ items: [], error: err instanceof Error ? err.message : String(err) });
    }
  });
}
