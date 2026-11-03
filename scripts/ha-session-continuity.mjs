#!/usr/bin/env node
/**
 * Multi-replica session continuity gate for the HA Compose overlay.
 *
 * Login is performed against replica A, the same session cookie is then sent
 * to replica B and, optionally, rechecked after an explicit replica restart.
 * The cookie is kept in memory only and never appears in the report.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const primaryUrl = (process.env.ARGUS_HA_PRIMARY_URL || 'http://127.0.0.1:3111').replace(/\/+$/, '');
const secondaryUrl = (process.env.ARGUS_HA_SECONDARY_URL || 'http://127.0.0.1:3112').replace(/\/+$/, '');
const username = process.env.ARGUS_HA_USERNAME || 'e2e-ha-admin';
const password = process.env.ARGUS_HA_PASSWORD || 'ArgusHa42!';
const displayName = process.env.ARGUS_HA_DISPLAY_NAME || 'Argus HA Admin';
const reportPath = process.env.ARGUS_HA_REPORT || 'test-results/ha-session-continuity.json';
const required = process.env.ARGUS_HA_REQUIRED === '1';
const timeoutMs = Math.min(300_000, Math.max(10_000, Number(process.env.ARGUS_HA_TIMEOUT_MS || 90_000) || 90_000));

function safeError(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:password|secret|token|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 320) || 'unknown error';
}

function cookieFrom(response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie') || ''];
  const cookie = values.find(value => /^argus_session=[^;]+/.test(value));
  return cookie?.split(';', 1)[0] || null;
}

async function waitHealthy(url) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
      last = response.status;
      if (response.ok) return { ok: true, http_status: response.status };
    } catch (error) { last = safeError(error); }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 1_000));
  }
  return { ok: false, http_status: typeof last === 'number' ? last : null, error: 'health check timed out' };
}

async function formPost(url, path, values) {
  return fetch(`${url}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(10_000),
  });
}

async function authenticate() {
  const registration = await formPost(primaryUrl, '/auth/register', {
    username, password, password_confirm: password, display_name: displayName,
  });
  const registeredCookie = cookieFrom(registration);
  if (registeredCookie) return registeredCookie;
  const login = await formPost(primaryUrl, '/auth/login', { username, password });
  const loginCookie = cookieFrom(login);
  if (!loginCookie) throw new Error(`authentication failed with HTTP ${login.status}`);
  return loginCookie;
}

async function sessionWorks(url, cookie) {
  const response = await fetch(`${url}/api/me`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: response.ok, http_status: response.status };
}

function parseCommand() {
  const raw = process.env.ARGUS_HA_RESTART_COMMAND_JSON?.trim();
  if (!raw) return null;
  let command;
  try { command = JSON.parse(raw); } catch { throw new Error('ARGUS_HA_RESTART_COMMAND_JSON must be valid JSON'); }
  if (!Array.isArray(command) || command.length === 0 || command.some(value => typeof value !== 'string' || !value.trim())) {
    throw new Error('ARGUS_HA_RESTART_COMMAND_JSON must be a non-empty argv array');
  }
  return command.map(value => value.trim());
}

function runCommand(command) {
  return new Promise(resolveRun => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolveRun({ ok: false, error: 'restart command timed out' }); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolveRun({ ok: false, error: safeError(error) }); });
    child.on('close', code => { clearTimeout(timer); resolveRun({ ok: code === 0, exit_code: code }); });
  });
}

async function main() {
  const report = { generated_at: new Date().toISOString(), status: 'not_run', replica_count: 2, checks: {} };
  const explicitlyConfigured = Boolean(
    process.env.ARGUS_HA_PRIMARY_URL?.trim()
    || process.env.ARGUS_HA_SECONDARY_URL?.trim()
    || required,
  );
  if (!explicitlyConfigured) {
    report.reason = 'HA endpoints not configured';
    await mkdir(resolve(reportPath, '..'), { recursive: true });
    await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  try {
    const beforeHealth = await Promise.all([waitHealthy(primaryUrl), waitHealthy(secondaryUrl)]);
    report.checks.before_health = beforeHealth;
    if (!beforeHealth.every(check => check.ok)) {
      report.status = 'failed';
      report.reason = 'one or more replicas were unhealthy';
    } else {
      const cookie = await authenticate();
      report.checks.session_on_primary = await sessionWorks(primaryUrl, cookie);
      report.checks.session_on_secondary = await sessionWorks(secondaryUrl, cookie);
      if (!report.checks.session_on_primary.ok || !report.checks.session_on_secondary.ok) {
        report.status = 'failed';
        report.reason = 'shared session was not accepted by both replicas';
      } else {
        const restartCommand = parseCommand();
        if (restartCommand) {
          const restart = await runCommand(restartCommand);
          report.checks.restart_command = restart;
          if (!restart.ok) {
            report.status = 'failed';
            report.reason = restart.error || 'restart command failed';
          } else {
            report.checks.after_restart_health = await Promise.all([waitHealthy(primaryUrl), waitHealthy(secondaryUrl)]);
            report.checks.session_after_restart = await sessionWorks(secondaryUrl, cookie);
            report.status = report.checks.after_restart_health.every(check => check.ok)
              && report.checks.session_after_restart.ok ? 'passed' : 'failed';
            if (report.status === 'failed') report.reason = 'session or replica did not recover after restart';
          }
        } else {
          report.status = 'passed';
        }
      }
    }
  } catch (error) {
    report.status = 'failed';
    report.reason = safeError(error);
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (required && report.status !== 'passed') process.exitCode = 2;
  if (report.status === 'failed') process.exitCode = 2;
}

await main();
