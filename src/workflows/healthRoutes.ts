/**
 * Health-Check Matrix — pings every configured backend in parallel,
 * returns latency + status. Used by an admin /admin/health UI plus by
 * external uptime probes.
 *
 *   GET /api/admin/health/backends
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { checkRemoteMcp } from '../backends/remoteMcpClients.js';
import { checkCustomBackend, type CustomBackendRow } from '../backends/customBackends.js';

interface HealthResult {
  name: string;
  kind: 'mcp_backend' | 'internal';
  url: string | null;
  status: 'ok' | 'down' | 'unknown';
  http_status?: number;
  latency_ms: number;
  error?: string;
}

function integrationEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

async function pingUrl(url: string, timeoutMs = 3000): Promise<{ ok: boolean; status?: number; ms: number; err?: string }> {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'GET', signal: ac.signal });
    return { ok: r.ok, status: r.status, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, err: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealthRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  app.get('/api/admin/health/backends', requireAuth, async (_req, res) => {
    const results: HealthResult[] = [];

    // Built-in / always-checked
    const intrinsic: Array<{ name: string; url: string }> = [];
    if (integrationEnabled(process.env['GRAFANA_ENABLED']) && process.env['GRAFANA_URL']) {
      intrinsic.push({ name: 'grafana', url: `${process.env['GRAFANA_URL'].replace(/\/$/, '')}/api/health` });
    }
    if (integrationEnabled(process.env['OPENSEARCH_ENABLED']) && process.env['OPENSEARCH_URL']) {
      intrinsic.push({ name: 'opensearch', url: `${process.env['OPENSEARCH_URL'].replace(/\/$/, '')}/_cluster/health` });
    }

    // DB self
    const dbT0 = Date.now();
    let dbOk = false;
    try { await pool.query('SELECT 1'); dbOk = true; } catch { /* ignore */ }
    results.push({
      name: 'postgres', kind: 'internal', url: null,
      status: dbOk ? 'ok' : 'down', latency_ms: Date.now() - dbT0,
    });

    // Argus's own /health (transitively checks Redis etc.)
    const selfPing = await pingUrl('http://localhost:3000/health', 2000);
    results.push({
      name: 'argus-self', kind: 'internal', url: '/health',
      status: selfPing.ok ? 'ok' : 'down', latency_ms: selfPing.ms,
      ...(selfPing.status !== undefined ? { http_status: selfPing.status } : {}),
      ...(selfPing.err ? { error: selfPing.err } : {}),
    });

    // Configured backends from mcp_backends
    const { rows: backends } = await pool.query<CustomBackendRow>(
      `SELECT b.*,
         COALESCE((SELECT array_agg(bb.bundle_id) FROM mcp_backend_bundles bb WHERE bb.backend_id = b.id), '{}') AS bundle_ids
       FROM mcp_backends b WHERE b.enabled = true`
    ).catch(() => ({ rows: [] as CustomBackendRow[] }));

    const backendPings = await Promise.all(backends.map(async (b) => {
      if (b.backend_type === 'builtin' || b.base_url.startsWith('argus://')) {
        return {
          name: b.name,
          kind: 'internal' as const,
          url: b.base_url,
          status: 'ok' as const,
          latency_ms: 0,
        };
      }
      if (b.backend_type === 'mcp') {
        const ping = await checkRemoteMcp(b.id);
        return {
          name: b.name,
          kind: 'mcp_backend' as const,
          url: `${b.base_url.replace(/\/$/, '')}${b.mcp_endpoint || '/mcp'}`,
          status: ping.reachable ? 'ok' as const : 'down' as const,
          latency_ms: ping.latencyMs ?? 0,
          ...(ping.error ? { error: ping.error } : {}),
        };
      }
      const url = `${b.base_url.replace(/\/$/, '')}${b.health_path || ''}`;
      const ping = await checkCustomBackend(b);
      return {
        name: b.name, kind: 'mcp_backend' as const, url,
        status: ping.reachable ? 'ok' as const : 'down' as const,
        latency_ms: ping.latencyMs ?? 0,
        ...(ping.error ? { error: ping.error } : {}),
      };
    }));
    results.push(...backendPings);

    // Intrinsic (env-configured)
    const envPings = await Promise.all(intrinsic.map(async (i) => {
      const ping = await pingUrl(i.url, 3000);
      return {
        name: i.name, kind: 'internal' as const, url: i.url,
        status: ping.ok ? 'ok' as const : 'down' as const,
        latency_ms: ping.ms,
        ...(ping.status !== undefined ? { http_status: ping.status } : {}),
        ...(ping.err ? { error: ping.err } : {}),
      };
    }));
    results.push(...envPings);

    res.json({
      timestamp: new Date().toISOString(),
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      down: results.filter((r) => r.status === 'down').length,
      results,
    });
  });

  // Plain HTML page for quick check
  app.get('/admin/health', requireAuth, (_req, res) => {
    res.type('html').send(HEALTH_PAGE_HTML);
  });
}

const HEALTH_PAGE_HTML = `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><title>Argus — Health Matrix</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0a;color:#e8e8e8;margin:0;padding:24px;}
h1{font-size:1.2rem;margin:0 0 16px;}
table{width:100%;border-collapse:collapse;font-size:13px;}
th,td{padding:8px 12px;border-bottom:1px solid #1f1f1f;text-align:left;}
th{color:#888;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.5px;background:#141414;}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;}
.ok{background:#3fb950;} .down{background:#f85149;} .unknown{background:#888;}
.lat{color:#888;}
.refresh{padding:6px 12px;background:#7c3aed;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:12px;margin-left:auto;}
.header{display:flex;align-items:center;gap:12px;margin-bottom:16px;}
.stat{color:#888;font-size:12px;}
.stat strong{color:#e8e8e8;}
.url{color:#666;font-family:ui-monospace,monospace;font-size:11px;}
</style></head><body>
<div class="header">
  <h1>Health Matrix</h1>
  <span id="stats" class="stat"></span>
  <button class="refresh" onclick="load()">↻ Refresh</button>
</div>
<table><thead><tr><th>Status</th><th>Name</th><th>Kind</th><th>URL</th><th>Latency</th><th>HTTP</th><th>Error</th></tr></thead>
<tbody id="rows"><tr><td colspan="7">Lade…</td></tr></tbody></table>
<script>
async function load(){
  const r = await fetch('/api/admin/health/backends',{credentials:'include'});
  if(!r.ok){document.getElementById('rows').innerHTML='<tr><td colspan="7">Fehler '+r.status+'</td></tr>';return;}
  const j = await r.json();
  document.getElementById('stats').innerHTML = '<strong>'+j.ok+'</strong>/'+j.total+' ok · <strong>'+j.down+'</strong> down · '+new Date(j.timestamp).toLocaleTimeString();
  document.getElementById('rows').innerHTML = j.results.map(r=>'<tr>'+
    '<td><span class="dot '+r.status+'"></span>'+r.status+'</td>'+
    '<td>'+r.name+'</td>'+
    '<td class="stat">'+r.kind+'</td>'+
    '<td class="url">'+(r.url||'')+'</td>'+
    '<td class="lat">'+r.latency_ms+'ms</td>'+
    '<td class="stat">'+(r.http_status||'-')+'</td>'+
    '<td class="stat">'+(r.error||'')+'</td>'+
  '</tr>').join('');
}
load(); setInterval(load, 30000);
</script>
</body></html>`;
