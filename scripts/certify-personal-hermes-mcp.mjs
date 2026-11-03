import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_TEMPLATE = join(ROOT, 'demo', 'argus-dev', 'personal-hermes', 'config.yaml');
const HERMES_PACKAGE = process.env.ARGUS_HERMES_PACKAGE?.trim() || 'hermes-agent[mcp]==0.18.2';
const HERMES_MCP_URL = process.env.ARGUS_HERMES_DEV_MCP_URL?.trim()
  || 'http://127.0.0.1:3000/mcp/hermes-dev';
const POSTGRES_USER = process.env.ARGUS_POSTGRES_USER?.trim() || 'aiops';
const POSTGRES_DB = process.env.ARGUS_POSTGRES_DB?.trim() || 'aiops';
const BUNDLE_IDS = positiveIntegerList(
  'ARGUS_HERMES_DEV_BUNDLE_IDS',
  [positiveInteger('ARGUS_HERMES_DEV_BUNDLE_ID', 3)],
);
const USER_ID = positiveInteger('ARGUS_HERMES_DEV_USER_ID', 1);
const AGENT_PROBE = process.argv.includes('--agent');
const LIFECYCLE_PROBE = process.argv.includes('--lifecycle');
const AGENT_MODEL = process.env.ARGUS_HERMES_AGENT_MODEL?.trim() || 'gpt-5.6-terra';
const EXPECTED_TOOLS = [
  'argus_dev_cancel_run',
  'argus_dev_capabilities',
  'argus_dev_get_result',
  'argus_dev_get_run',
  'argus_dev_get_workspace_evidence',
  'argus_dev_preflight',
  'argus_dev_start_workflow',
];

function positiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function positiveIntegerList(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const values = [...new Set(raw.split(',').map(value => Number(value.trim())))];
  if (values.length === 0 || values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} must be a comma-separated list of positive integers`);
  }
  return values;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  }).trim();
}

function psql(sql) {
  return run('docker', [
    'compose', 'exec', '-T', 'postgres',
    'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
    '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-c', sql,
  ]);
}

async function waitForCore(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:3000/health');
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Argus Core did not become healthy: ${lastError}`);
}

async function restartCore() {
  run('docker', ['compose', 'restart', 'mcp-server']);
  await waitForCore();
}

function boundedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(0, 12_000);
}

async function main() {
  const rawKey = `ak_${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 8);
  const keySuffix = rawKey.slice(-4);
  const certificationId = randomUUID();
  const label = `Temporary personal Hermes MCP certification ${certificationId}`;
  const hermesHome = await mkdtemp(join(tmpdir(), 'argus-personal-hermes-'));
  const codexHome = join(hermesHome, 'codex');
  let keyId = null;
  let ruleId = null;
  let connectionId = null;
  let revocationDenied = false;
  let lifecycleEvidence = null;

  try {
    await copyFile(CONFIG_TEMPLATE, join(hermesHome, 'config.yaml'));
    if (AGENT_PROBE) {
      const baseConfig = await readFile(join(hermesHome, 'config.yaml'), 'utf8');
      await writeFile(join(hermesHome, 'config.yaml'), [
        'model:',
        `  default: "${AGENT_MODEL}"`,
        '  provider: openai-codex',
        '  openai_runtime: codex_app_server',
        '  reasoning_effort: xhigh',
        '',
        baseConfig,
      ].join('\n'), 'utf8');
      const sourceCodexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
      await mkdir(codexHome, { recursive: true });
      await copyFile(join(sourceCodexHome, 'auth.json'), join(codexHome, 'auth.json'));
      await writeFile(join(codexHome, 'config.toml'), [
        'default_permissions = ":read-only"',
        `model = "${AGENT_MODEL}"`,
        'model_reasoning_effort = "xhigh"',
        '',
        '# Hermes 0.18.2 exposes only a fixed callback-tool catalog through its',
        '# Codex App Server runtime. Register the bounded Argus read surface with',
        '# Codex as well so the real Hermes -> Codex -> Argus path can be certified.',
        '[mcp_servers.argus_dev]',
        `url = ${JSON.stringify(HERMES_MCP_URL)}`,
        'bearer_token_env_var = "ARGUS_HERMES_DEV_MCP_KEY"',
        'enabled_tools = ["argus_dev_capabilities", "argus_dev_preflight"]',
        'default_tools_approval_mode = "approve"',
        'required = true',
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 900',
        '',
      ].join('\n'), 'utf8');

      const authImport = spawnSync('uvx', [
        '--from', HERMES_PACKAGE,
        'hermes', 'auth', 'add', 'openai-codex',
        '--label', 'Argus isolated certification',
      ], {
        cwd: ROOT,
        windowsHide: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          HERMES_HOME: hermesHome,
          HERMES_CONFIG: join(hermesHome, 'config.yaml'),
          CODEX_HOME: codexHome,
        },
      });
      if (authImport.error) throw authImport.error;
      if (authImport.status !== 0) {
        throw new Error(`Hermes could not authenticate the isolated Codex session (exit ${authImport.status})`);
      }
    }

    const bundleIdsSql = BUNDLE_IDS.join(',');
    const bundleExists = psql(`SELECT count(*)=${BUNDLE_IDS.length} FROM mcp_service_bundles WHERE id=ANY(ARRAY[${bundleIdsSql}]::integer[]);`);
    const userExists = psql(`SELECT EXISTS(SELECT 1 FROM mcp_users WHERE id=${USER_ID} AND enabled=true);`);
    if (bundleExists !== 't') throw new Error(`One or more Argus Dev Bundles do not exist: ${BUNDLE_IDS.join(', ')}`);
    if (userExists !== 't') throw new Error(`Enabled Argus user ${USER_ID} does not exist`);

    const inserted = psql(`
      WITH inserted_key AS (
        INSERT INTO mcp_api_keys (
          key_prefix, label, allowed_tools, denied_tools, allowed_bundles,
          key_hash, key_suffix, max_requests_per_minute, enabled, scope,
          user_id, acting_as_user_id, expires_at, metadata
        ) VALUES (
          '${keyPrefix}', '${label}', ARRAY['argus_dev_*']::text[], ARRAY[]::text[], ARRAY[${bundleIdsSql}]::integer[],
          '${keyHash}', '${keySuffix}', 60, true, 'mcp',
          ${USER_ID}, ${USER_ID}, now() + interval '20 minutes',
          '{"certification":"personal-hermes-mcp","temporary":true}'::jsonb
        ) RETURNING id
      ), inserted_rule AS (
        INSERT INTO mcp_user_tool_rules (
          user_id, tool_pattern, effect, reason, expires_at, created_by
        ) VALUES (
          ${USER_ID}, 'argus_dev_*', 'allow', '${label}', now() + interval '20 minutes', ${USER_ID}
        ) RETURNING id
      ), inserted_connection AS (
        INSERT INTO mcp_hermes_dev_connections (
          label, api_key_id, user_id, user_tool_rule_id, bundle_ids
        ) VALUES (
          '${label}', (SELECT id FROM inserted_key), ${USER_ID},
          (SELECT id FROM inserted_rule), ARRAY[${bundleIdsSql}]::integer[]
        ) RETURNING id
      )
      SELECT (SELECT id FROM inserted_key) || '|' || (SELECT id FROM inserted_rule)
        || '|' || (SELECT id FROM inserted_connection);
    `);
    [keyId, ruleId, connectionId] = inserted.split('|').map(value => Number(value));
    if (!Number.isSafeInteger(keyId) || !Number.isSafeInteger(ruleId) || !Number.isSafeInteger(connectionId)) {
      throw new Error(`Could not identify temporary Argus credentials: ${inserted}`);
    }

    await restartCore();

    const result = spawnSync('uvx', [
      '--from', HERMES_PACKAGE,
      'hermes', 'mcp', 'test', 'argus_dev',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        HERMES_CONFIG: join(hermesHome, 'config.yaml'),
        ARGUS_HERMES_DEV_MCP_URL: HERMES_MCP_URL,
        ARGUS_HERMES_DEV_MCP_KEY: rawKey,
      },
    });
    const output = boundedOutput(result);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Hermes MCP test exited with ${result.status}: ${output}`);
    }
    const missingTools = EXPECTED_TOOLS.filter(tool => !output.includes(tool));
    if (missingTools.length > 0) {
      throw new Error(`Hermes did not discover the bounded bridge catalog (${missingTools.join(', ')} missing): ${output}`);
    }

    let agentEvidence = null;
    if (AGENT_PROBE) {
      const prompt = [
        'This is a read-only Argus integration certification.',
        'Use the Argus Dev MCP server and call argus_dev_capabilities and argus_dev_preflight exactly once each.',
        'Do not call argus_dev_start_workflow, do not edit files, and do not run shell commands.',
        'After both calls, respond with exactly these five evidence lines, replacing values only from tool results:',
        'ARGUS_HERMES_AGENT_PROBE_OK',
        'workflow_id=<workflow id>',
        'agent_id=<agent id>',
        'preflight_state=<state>',
        'writing_workflow_started=false',
      ].join(' ');
      const agentResult = spawnSync('uvx', [
        '--from', HERMES_PACKAGE,
        'hermes', 'chat',
        '--query', prompt,
        '--provider', 'openai-codex',
        '--model', AGENT_MODEL,
        '--max-turns', '8',
        '--source', 'tool',
        '--ignore-rules',
        '--quiet',
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10 * 60_000,
        env: {
          ...process.env,
          HERMES_HOME: hermesHome,
          HERMES_CONFIG: join(hermesHome, 'config.yaml'),
          CODEX_HOME: codexHome,
          ARGUS_HERMES_DEV_MCP_URL: HERMES_MCP_URL,
          ARGUS_HERMES_DEV_MCP_KEY: rawKey,
        },
      });
      const agentOutput = boundedOutput(agentResult);
      if (agentResult.error) throw agentResult.error;
      if (agentResult.status !== 0) {
        throw new Error(`Hermes agent probe exited with ${agentResult.status}: ${agentOutput}`);
      }
      for (const evidence of [
        'ARGUS_HERMES_AGENT_PROBE_OK',
        'workflow_id=ticket-to-pull-request',
        'agent_id=coding-orchestrator',
        'preflight_state=TASK_STATE_COMPLETED',
        'writing_workflow_started=false',
      ]) {
        if (!agentOutput.includes(evidence)) {
          throw new Error(`Hermes agent response omitted ${evidence}: ${agentOutput}`);
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      const auditRows = psql(`
        SELECT tool || '|' || is_error
        FROM mcp_audit_log
        WHERE api_key_prefix='${keyPrefix}'
        ORDER BY timestamp, id;
      `).split(/\r?\n/).filter(Boolean);
      const successfulTools = auditRows
        .filter(row => /\|(f|false)$/.test(row))
        .map(row => row.slice(0, row.lastIndexOf('|')));
      for (const tool of ['argus_dev_capabilities', 'argus_dev_preflight']) {
        if (!successfulTools.includes(tool)) {
          throw new Error(`Argus audit did not prove Hermes called ${tool}: ${auditRows.join(', ') || '(empty)'}`);
        }
      }
      if (auditRows.some(row => row.startsWith('argus_dev_start_workflow|'))) {
        throw new Error('Hermes agent probe attempted to start a writing workflow');
      }
      agentEvidence = {
        model: AGENT_MODEL,
        runtime: 'codex_app_server',
        reasoningEffort: 'xhigh',
        auditedToolCalls: successfulTools,
        response: agentOutput.split(/\r?\n/).filter(Boolean).slice(-5),
      };
    }

    if (LIFECYCLE_PROBE) {
      const lifecycleResult = spawnSync(process.execPath, [
        join(ROOT, 'scripts', 'certify-hermes-dev-lifecycle.mjs'),
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
        timeout: positiveInteger('ARGUS_HERMES_DEV_TIMEOUT_MS', 15 * 60_000) + 60_000,
        env: {
          ...process.env,
          ARGUS_HERMES_DEV_MCP_URL: HERMES_MCP_URL,
          ARGUS_HERMES_DEV_MCP_KEY: rawKey,
        },
      });
      const lifecycleOutput = boundedOutput(lifecycleResult);
      if (lifecycleResult.error) throw lifecycleResult.error;
      if (lifecycleResult.status !== 0) {
        throw new Error(`Hermes Dev lifecycle probe exited with ${lifecycleResult.status}: ${lifecycleOutput}`);
      }
      for (const evidence of [
        '"approvalGateReached": true',
        '"workspaceEvidenceBounded": true',
        '"testsPassed": true',
        '"reviewPassed": true',
        '"prematureResultBlocked": true',
        '"finalState": "TASK_STATE_CANCELED"',
      ]) {
        if (!lifecycleOutput.includes(evidence)) {
          throw new Error(`Hermes Dev lifecycle omitted ${evidence}: ${lifecycleOutput}`);
        }
      }
      const traceIds = [...lifecycleOutput.matchAll(/"rootTraceId"\s*:\s*"([^"]+)"/g)];
      lifecycleEvidence = {
        approvalGateReached: true,
        workspaceEvidenceBounded: true,
        testsPassed: true,
        reviewPassed: true,
        prematureResultBlocked: true,
        finalState: 'TASK_STATE_CANCELED',
        rootTraceId: traceIds.at(-1)?.[1] ?? null,
      };
    }

    psql(`
      BEGIN;
      UPDATE mcp_api_keys SET enabled=false, deleted_at=now() WHERE id=${keyId};
      DELETE FROM mcp_user_tool_rules WHERE id=${ruleId};
      UPDATE mcp_hermes_dev_connections
         SET revoked_at=now(), updated_at=now(), user_tool_rule_id=NULL
       WHERE id=${connectionId};
      COMMIT;
    `);
    ruleId = null;
    await restartCore();

    const revokedResult = spawnSync('uvx', [
      '--from', HERMES_PACKAGE,
      'hermes', 'mcp', 'test', 'argus_dev',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        HERMES_CONFIG: join(hermesHome, 'config.yaml'),
        ARGUS_HERMES_DEV_MCP_URL: HERMES_MCP_URL,
        ARGUS_HERMES_DEV_MCP_KEY: rawKey,
      },
    });
    if (revokedResult.error) throw revokedResult.error;
    const revokedOutput = boundedOutput(revokedResult);
    revocationDenied = revokedResult.status !== 0
      || /connection failed|403 forbidden|delegation_inactive/i.test(revokedOutput);
    if (!revocationDenied) {
      throw new Error(`Revoked Hermes credential remained usable: ${revokedOutput}`);
    }

    process.stdout.write(`${JSON.stringify({
      ok: true,
      hermesPackage: HERMES_PACKAGE,
      endpoint: HERMES_MCP_URL,
      tools: EXPECTED_TOOLS,
      bundleId: BUNDLE_IDS.length === 1 ? BUNDLE_IDS[0] : null,
      bundleIds: BUNDLE_IDS,
      userId: USER_ID,
      agentProbe: agentEvidence,
      lifecycleProbe: lifecycleEvidence,
      writingWorkflowStarted: LIFECYCLE_PROBE,
      connectorLifecycleRecorded: true,
      revokedCredentialDenied: revocationDenied,
      temporaryCredentialRemoved: true,
    }, null, 2)}\n`);
  } finally {
    if (connectionId != null || keyId != null || ruleId != null) {
      try {
        if (connectionId != null) psql(`DELETE FROM mcp_hermes_dev_connections WHERE id=${connectionId} AND label='${label}';`);
        if (ruleId != null) psql(`DELETE FROM mcp_user_tool_rules WHERE id=${ruleId} AND reason='${label}';`);
        if (keyId != null) psql(`DELETE FROM mcp_api_keys WHERE id=${keyId} AND label='${label}';`);
        await restartCore();
      } catch (cleanupError) {
        process.stderr.write(`Temporary Hermes credential cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
        process.exitCode = 1;
      }
    }
    await rm(hermesHome, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
