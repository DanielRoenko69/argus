/**
 * Langfuse Watchdog — polls Langfuse for actionable signals and fans them
 * out to a webhook (Slack/Teams/Discord).
 *
 * Triggers on three signal types:
 *   1. ERROR-level traces (e.g. failed agent runs, tool exceptions)
 *   2. Sub-threshold compliance_score (compliance drift)
 *   3. Sub-threshold eval_overall (quality regression)
 *
 * Configuration (env):
 *   ALERTS_WEBHOOK_URL          — Slack/Teams/Discord incoming webhook (REQUIRED to enable)
 *   ALERTS_WEBHOOK_FORMAT       — 'slack' (default) | 'teams' | 'generic'
 *   ALERTS_POLL_INTERVAL_MS     — default 5 * 60_000 (5 min)
 *   ALERTS_LOOKBACK_MS          — default 10 * 60_000 (10 min)
 *   ALERTS_COMPLIANCE_THRESHOLD — default 70 (compliance_score below = alert)
 *   ALERTS_QUALITY_THRESHOLD    — default 0.7 (eval_overall below = alert)
 *
 * De-dup: keeps a 24h in-memory set of trace ids we've already alerted on,
 * so a long-lived stale ERROR doesn't get re-paged every poll.
 */

import { logger } from '../lib/logger.js';

interface LangfuseTrace {
  id: string;
  name: string;
  createdAt: string;
  sessionId?: string;
  tags?: string[];
  level?: string;
  scores?: Array<{ name: string; value: number; comment?: string }>;
  metadata?: Record<string, unknown>;
}

interface LangfuseScore {
  id: string;
  traceId: string;
  name: string;
  value: number;
  comment?: string;
  timestamp: string;
}

const LANGFUSE_HOST = (process.env['LANGFUSE_HOST'] ?? 'http://langfuse:3100').replace(/\/+$/, '');
const LANGFUSE_PUB  = process.env['LANGFUSE_PUBLIC_KEY'] ?? '';
const LANGFUSE_SEC  = process.env['LANGFUSE_SECRET_KEY'] ?? '';

const WEBHOOK_URL    = process.env['ALERTS_WEBHOOK_URL'] ?? '';
const WEBHOOK_FORMAT = (process.env['ALERTS_WEBHOOK_FORMAT'] ?? 'slack').toLowerCase() as 'slack' | 'teams' | 'generic';

const POLL_INTERVAL_MS     = parseInt(process.env['ALERTS_POLL_INTERVAL_MS']     ?? `${5 * 60_000}`,  10);
const LOOKBACK_MS          = parseInt(process.env['ALERTS_LOOKBACK_MS']          ?? `${10 * 60_000}`, 10);
const COMPLIANCE_THRESHOLD = parseFloat(process.env['ALERTS_COMPLIANCE_THRESHOLD'] ?? '70');
const QUALITY_THRESHOLD    = parseFloat(process.env['ALERTS_QUALITY_THRESHOLD']    ?? '0.7');

const DEDUP_TTL_MS = 24 * 60 * 60_000;
const alerted = new Map<string, number>();   // key → firstAlertedAt epoch ms

function pruneDedup(now: number): void {
  for (const [k, ts] of alerted) {
    if (now - ts > DEDUP_TTL_MS) alerted.delete(k);
  }
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${LANGFUSE_PUB}:${LANGFUSE_SEC}`).toString('base64');
}

async function lfFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${LANGFUSE_HOST}${path}`, {
    headers: { Authorization: authHeader() },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Langfuse ${path} → ${res.status}`);
  return await res.json() as T;
}

// ── Signal extractors ──────────────────────────────────────────────

async function fetchErrorTraces(lookbackMs: number): Promise<LangfuseTrace[]> {
  const from = new Date(Date.now() - lookbackMs).toISOString();
  const data = await lfFetch<{ data: LangfuseTrace[] }>(
    `/api/public/traces?limit=50&fromTimestamp=${encodeURIComponent(from)}`,
  );
  return data.data.filter((t) => {
    // Langfuse stores level on observations; trace-level error is signalled
    // when its output starts with "ERROR:" (our convention in withTrace).
    const output = (t as unknown as { output?: unknown }).output;
    return typeof output === 'string' && output.startsWith('ERROR:');
  });
}

async function fetchScoresInWindow(lookbackMs: number): Promise<LangfuseScore[]> {
  const from = new Date(Date.now() - lookbackMs).toISOString();
  const data = await lfFetch<{ data: LangfuseScore[] }>(
    `/api/public/scores?limit=100&fromTimestamp=${encodeURIComponent(from)}`,
  );
  return data.data;
}

// ── Webhook formatting ─────────────────────────────────────────────

interface AlertPayload {
  title: string;
  severity: 'error' | 'warning';
  description: string;
  fields: Array<{ name: string; value: string }>;
  traceUrl?: string;
}

function formatSlack(a: AlertPayload): Record<string, unknown> {
  const color = a.severity === 'error' ? '#dc2626' : '#f59e0b';
  return {
    text: `*${a.title}*`,
    attachments: [{
      color,
      fallback: a.title,
      text: a.description,
      fields: a.fields.map((f) => ({ title: f.name, value: f.value, short: true })),
      ...(a.traceUrl ? { actions: [{ type: 'button', text: 'Open in Langfuse', url: a.traceUrl }] } : {}),
    }],
  };
}

function formatTeams(a: AlertPayload): Record<string, unknown> {
  const themeColor = a.severity === 'error' ? 'dc2626' : 'f59e0b';
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor,
    summary: a.title,
    title: a.title,
    text: a.description,
    sections: [{
      facts: a.fields.map((f) => ({ name: f.name, value: f.value })),
    }],
    ...(a.traceUrl ? {
      potentialAction: [{
        '@type': 'OpenUri',
        name: 'Open in Langfuse',
        targets: [{ os: 'default', uri: a.traceUrl }],
      }],
    } : {}),
  };
}

function formatGeneric(a: AlertPayload): Record<string, unknown> {
  return {
    title:       a.title,
    severity:    a.severity,
    description: a.description,
    fields:      a.fields,
    trace_url:   a.traceUrl,
    timestamp:   new Date().toISOString(),
  };
}

async function postAlert(a: AlertPayload): Promise<void> {
  if (!WEBHOOK_URL) return;
  const payload = WEBHOOK_FORMAT === 'teams'   ? formatTeams(a)
                : WEBHOOK_FORMAT === 'generic' ? formatGeneric(a)
                : formatSlack(a);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, title: a.title }, 'Alerts webhook returned non-2xx');
    }
  } catch (err) {
    logger.warn({ err, title: a.title }, 'Alerts webhook POST failed');
  }
}

// ── Detection passes ───────────────────────────────────────────────

async function checkErrorTraces(): Promise<number> {
  const traces = await fetchErrorTraces(LOOKBACK_MS);
  let sent = 0;
  for (const t of traces) {
    const key = `err:${t.id}`;
    if (alerted.has(key)) continue;
    alerted.set(key, Date.now());
    const traceUrl = `${LANGFUSE_HOST}/trace/${t.id}`;
    const output = String((t as unknown as { output?: unknown }).output ?? '').slice(0, 200);
    await postAlert({
      title:       `🔴 Argus trace error: ${t.name}`,
      severity:    'error',
      description: output,
      fields: [
        { name: 'Trace',    value: t.name },
        { name: 'Session',  value: t.sessionId ?? '(none)' },
        { name: 'Tags',     value: (t.tags ?? []).slice(0, 6).join(', ') || '(none)' },
        { name: 'Time',     value: t.createdAt },
      ],
      traceUrl,
    });
    sent += 1;
  }
  return sent;
}

async function checkScoreThresholds(): Promise<number> {
  const scores = await fetchScoresInWindow(LOOKBACK_MS);
  let sent = 0;
  for (const s of scores) {
    let alertKey: string | null = null;
    let alert: AlertPayload | null = null;

    if (s.name === 'compliance_score' && s.value < COMPLIANCE_THRESHOLD) {
      alertKey = `compl:${s.traceId}`;
      alert = {
        title:       `🟠 Compliance score below threshold: ${s.value}`,
        severity:    'warning',
        description: s.comment ?? `${s.name} = ${s.value} (threshold: ${COMPLIANCE_THRESHOLD})`,
        fields: [
          { name: 'Score',     value: String(s.value) },
          { name: 'Threshold', value: String(COMPLIANCE_THRESHOLD) },
          { name: 'Trace',     value: s.traceId },
          { name: 'Time',      value: s.timestamp },
        ],
        traceUrl: `${LANGFUSE_HOST}/trace/${s.traceId}`,
      };
    } else if (s.name === 'eval_overall' && s.value < QUALITY_THRESHOLD) {
      alertKey = `qual:${s.traceId}`;
      alert = {
        title:       `🟠 Agent quality below threshold: ${s.value.toFixed(2)}`,
        severity:    'warning',
        description: `eval_overall = ${s.value.toFixed(2)} (threshold: ${QUALITY_THRESHOLD})`,
        fields: [
          { name: 'Score',     value: s.value.toFixed(2) },
          { name: 'Threshold', value: String(QUALITY_THRESHOLD) },
          { name: 'Trace',     value: s.traceId },
          { name: 'Time',      value: s.timestamp },
        ],
        traceUrl: `${LANGFUSE_HOST}/trace/${s.traceId}`,
      };
    }

    if (alertKey && alert && !alerted.has(alertKey)) {
      alerted.set(alertKey, Date.now());
      await postAlert(alert);
      sent += 1;
    }
  }
  return sent;
}

// ── Public entry point ─────────────────────────────────────────────

export async function runAlertCheck(): Promise<{ errors: number; thresholds: number }> {
  pruneDedup(Date.now());
  const [errors, thresholds] = await Promise.all([
    checkErrorTraces(),
    checkScoreThresholds(),
  ]);
  return { errors, thresholds };
}

export function startLangfuseAlerts(): NodeJS.Timeout | null {
  if (!WEBHOOK_URL) {
    logger.info('langfuse alerts: ALERTS_WEBHOOK_URL not set — alert dispatcher disabled');
    return null;
  }
  if (!LANGFUSE_PUB || !LANGFUSE_SEC) {
    logger.warn('langfuse alerts: LANGFUSE_PUBLIC_KEY/SECRET_KEY missing — cannot poll Langfuse');
    return null;
  }

  const interval = setInterval(() => {
    runAlertCheck()
      .then(({ errors, thresholds }) => {
        if (errors + thresholds > 0) {
          logger.info({ errors, thresholds }, 'langfuse alerts: alerts dispatched');
        }
      })
      .catch((err) => logger.warn({ err }, 'langfuse alerts: poll failed'));
  }, POLL_INTERVAL_MS);
  interval.unref();

  logger.info({
    interval_min:           POLL_INTERVAL_MS / 60_000,
    lookback_min:           LOOKBACK_MS / 60_000,
    compliance_threshold:   COMPLIANCE_THRESHOLD,
    quality_threshold:      QUALITY_THRESHOLD,
    webhook_format:         WEBHOOK_FORMAT,
  }, 'langfuse alert dispatcher started');
  return interval;
}
