import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_REPORT_BYTES = 500 * 1024;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--contract') options.contract = argv[++index];
    else if (argument === '--report') options.report = argv[++index];
    else if (argument === '--core-url') options.coreUrl = argv[++index];
    else if (argument === '--api-key-file') options.apiKeyFile = argv[++index];
    else if (argument === '--backend-id') options.backendId = argv[++index];
    else if (argument === '--certifier') options.certifier = argv[++index];
    else if (argument === '--in-cluster') options.inCluster = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  options.contract ??= process.env.ARGUS_CERTIFICATION_CONTRACT;
  options.report ??= process.env.ARGUS_CERTIFICATION_REPORT ?? '/tmp/kubernetes-certification.json';
  options.coreUrl ??= process.env.ARGUS_CORE_URL;
  options.apiKeyFile ??= process.env.ARGUS_CERTIFICATION_API_KEY_FILE;
  options.backendId ??= process.env.ARGUS_CERTIFICATION_BACKEND_ID;
  options.certifier ??= resolve(root, 'scripts/certify-kubernetes-connector.mjs');
  if (!options.contract) throw new Error('--contract or ARGUS_CERTIFICATION_CONTRACT is required');
  if (!options.coreUrl) throw new Error('--core-url or ARGUS_CORE_URL is required');
  if (!options.apiKeyFile) throw new Error('--api-key-file or ARGUS_CERTIFICATION_API_KEY_FILE is required');
  return options;
}

function absolute(value) {
  return isAbsolute(value) ? value : resolve(root, value);
}

function safeDetail(value) {
  return String(value || 'connector certification process did not produce a report')
    .replace(/(Bearer\s+|api[_-]?key[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500) || 'connector certification process failed';
}

function syntheticFailureReport(contract, contractSource, detail) {
  return {
    apiVersion: 'certification.argus.eu/v1alpha1',
    kind: 'KubernetesConnectorCertificationReport',
    targetId: contract.metadata?.targetId,
    platform: contract.spec?.platform,
    profile: contract.spec?.profile,
    overall: 'failed',
    checks: [{ id: 'runner.execution', status: 'failed', detail: safeDetail(detail) }],
    generatedAt: new Date().toISOString(),
    contractSha256: createHash('sha256').update(contractSource).digest('hex'),
  };
}

async function loadReport(reportPath, contract, contractSource, processResult) {
  if (existsSync(reportPath)) {
    const source = await readFile(reportPath, 'utf8');
    if (Buffer.byteLength(source) > MAX_REPORT_BYTES) throw new Error('Certification report exceeds 500 KB');
    return JSON.parse(source);
  }
  const processError = processResult.error?.message || processResult.stderr || processResult.stdout;
  return syntheticFailureReport(contract, contractSource, processError);
}

function normalizedCoreUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('ARGUS_CORE_URL must be an HTTP(S) origin without credentials or fragments');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  return url;
}

async function uploadReport(options, apiKey, report) {
  const url = normalizedCoreUrl(options.coreUrl);
  url.pathname = `${url.pathname}/api/certifications/kubernetes`.replace(/\/{2,}/g, '/');
  const body = { report };
  if (options.backendId !== undefined && options.backendId !== '') {
    const backendId = Number(options.backendId);
    if (!Number.isSafeInteger(backendId) || backendId < 1) throw new Error('--backend-id must be a positive integer');
    body.backendId = backendId;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const responseText = (await response.text()).slice(0, 2_000);
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const payload = JSON.parse(responseText);
      if (typeof payload?.error === 'string') reason += `: ${safeDetail(payload.error)}`;
    } catch { /* keep the bounded status-only error */ }
    throw new Error(`Argus Core rejected the certification report (${reason})`);
  }
  return JSON.parse(responseText);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const contractPath = absolute(options.contract);
  const reportPath = absolute(options.report);
  const certifierPath = absolute(options.certifier);
  const contractSource = await readFile(contractPath, 'utf8');
  const contract = JSON.parse(contractSource);
  const apiKey = (await readFile(absolute(options.apiKeyFile), 'utf8')).trim();
  if (!apiKey || apiKey.length > 512) throw new Error('Certification API key file is empty or invalid');

  const certifierArgs = [certifierPath, '--contract', contractPath, '--report', reportPath];
  if (options.inCluster) certifierArgs.push('--in-cluster');
  const processResult = spawnSync(process.execPath, certifierArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
  const report = await loadReport(reportPath, contract, contractSource, processResult);
  const imported = await uploadReport(options, apiKey, report);
  process.stdout.write(`${JSON.stringify({
    targetId: report.targetId,
    overall: report.overall,
    generatedAt: report.generatedAt,
    imported: true,
    backendId: imported.certification?.backendId ?? null,
    reportSha256: imported.certification?.reportSha256 ?? null,
  })}\n`);
  if (report.overall !== 'passed' || processResult.status !== 0) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${safeDetail(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs, safeDetail, syntheticFailureReport };
