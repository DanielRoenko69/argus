#!/usr/bin/env node
/**
 * Controlled service-restart/recovery gate.
 *
 * No command is executed unless ARGUS_CHAOS_RESTART_COMMAND_JSON explicitly
 * contains an argv array. Health URLs are status-only and are never copied to
 * the report, which keeps query-string credentials out of evidence artifacts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const reportPath = process.env.ARGUS_CHAOS_REPORT || 'test-results/chaos-recovery.json';
const healthUrls = (process.env.ARGUS_CHAOS_HEALTH_URLS || process.env.ARGUS_CHAOS_HEALTH_URL || '')
  .split(',').map(value => value.trim()).filter(Boolean);
const timeoutMs = Math.min(300_000, Math.max(5_000, Number(process.env.ARGUS_CHAOS_RECOVERY_TIMEOUT_MS || 90_000) || 90_000));
const pollMs = Math.min(10_000, Math.max(250, Number(process.env.ARGUS_CHAOS_POLL_MS || 1_000) || 1_000));
const required = process.env.ARGUS_CHAOS_REQUIRED === '1';

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 320) || 'unknown error';
}

function parseCommand() {
  const raw = process.env.ARGUS_CHAOS_RESTART_COMMAND_JSON?.trim();
  if (!raw) return null;
  let command;
  try { command = JSON.parse(raw); } catch { throw new Error('ARGUS_CHAOS_RESTART_COMMAND_JSON must be valid JSON'); }
  if (!Array.isArray(command) || command.length === 0 || command.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('ARGUS_CHAOS_RESTART_COMMAND_JSON must be a non-empty argv array');
  }
  return command.map(value => value.trim());
}

async function health(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    return { ok: response.ok, http_status: response.status, latency_ms: Date.now() - started };
  } catch (error) {
    return { ok: false, http_status: null, latency_ms: Date.now() - started, error: safeError(error) };
  }
}

async function allHealthy() {
  const checks = await Promise.all(healthUrls.map(health));
  return { ok: checks.every(check => check.ok), checks };
}

async function waitForRecovery() {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const result = await allHealthy();
    latest = result.checks;
    if (result.ok) return { ok: true, checks: latest, elapsed_ms: timeoutMs - Math.max(0, deadline - Date.now()) };
    await new Promise(resolveSleep => setTimeout(resolveSleep, pollMs));
  }
  return { ok: false, checks: latest, elapsed_ms: timeoutMs };
}

function runRestart(command) {
  return new Promise(resolveRun => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolveRun({ ok: false, exit_code: null, error: 'restart command timed out' }); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolveRun({ ok: false, exit_code: null, error: safeError(error) }); });
    child.on('close', code => { clearTimeout(timer); resolveRun({ ok: code === 0, exit_code: code }); });
  });
}

async function main() {
  const base = {
    generated_at: new Date().toISOString(),
    status: 'not_run',
    replica_count: healthUrls.length,
    checks: {},
  };
  if (!healthUrls.length) {
    base.reason = 'health URL not configured';
  } else {
    let command;
    try { command = parseCommand(); } catch (error) { base.status = 'failed'; base.reason = safeError(error); }
    if (!base.reason && !command) base.reason = 'restart command not configured';
    if (!base.reason) {
      const before = await allHealthy();
      base.checks.before_restart = before;
      if (!before.ok) {
        base.status = 'failed';
        base.reason = 'one or more replicas were unhealthy before restart';
      } else {
        const restart = await runRestart(command);
        base.checks.restart_command = restart;
        if (!restart.ok) {
          base.status = 'failed';
          base.reason = restart.error || 'restart command failed';
        } else {
          const recovery = await waitForRecovery();
          base.checks.after_restart = recovery;
          base.status = recovery.ok ? 'passed' : 'failed';
          if (!recovery.ok) base.reason = 'replicas did not recover within timeout';
        }
      }
    }
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(base, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(base, null, 2)}\n`);
  if (required && base.status !== 'passed') process.exitCode = 2;
  if (base.status === 'failed') process.exitCode = 2;
}

try { await main(); } catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 2;
}
