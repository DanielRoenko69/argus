import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const reportDir = path.join(root, 'test-results');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const gates = [];

function compactOutput(value, maxLines = 24) {
  const lines = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

function runCommandGate({ id, label, cwd = root, command = npmCommand, args, commands, evidence }) {
  const startedAt = Date.now();
  const invocations = commands ?? [{ command, args, cwd }];
  const results = [];
  for (const invocation of invocations) {
    const usesWindowsCommandShim = process.platform === 'win32' && invocation.command.toLowerCase().endsWith('.cmd');
    const executable = usesWindowsCommandShim ? (process.env.ComSpec ?? 'cmd.exe') : invocation.command;
    const executableArgs = usesWindowsCommandShim
      ? ['/d', '/s', '/c', [invocation.command, ...invocation.args].join(' ')]
      : invocation.args;
    const result = spawnSync(executable, executableArgs, {
      cwd: invocation.cwd ?? cwd,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0' },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    results.push({ invocation, result });
    if (result.status !== 0 || result.error) break;
  }
  const output = results.flatMap(({ result }) => [result.stdout, result.stderr]).filter(Boolean).join('\n');
  const failedResult = results.find(({ result }) => result.status !== 0 || result.error)?.result;
  const gate = {
    id,
    label,
    status: failedResult ? 'failed' : 'passed',
    durationMs: Date.now() - startedAt,
    command: invocations.map(invocation => `${path.basename(invocation.command)} ${invocation.args.join(' ')}`).join(' && '),
    evidence,
    outputTail: compactOutput(output),
  };
  if (failedResult?.error) gate.error = failedResult.error.message;
  gates.push(gate);
  process.stdout.write(`[${gate.status.toUpperCase()}] ${label} (${gate.durationMs} ms)\n`);
  return gate;
}

async function runHttpGate() {
  const startedAt = Date.now();
  const builderIndex = await readFile(path.join(root, 'dist', 'builder', 'index.html'), 'utf8');
  const builderAsset = builderIndex.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  const checks = [
    { name: 'Argus health', url: 'http://127.0.0.1:3000/health', expectedStatus: 200, content: '"status":"ok"' },
    { name: 'Workflow Studio auth boundary', url: 'http://127.0.0.1:3000/build/workflows/studio/167', expectedStatus: 302, location: '/login' },
    ...(builderAsset ? [{
      name: 'Compiled Workflow Builder asset',
      url: new URL(builderAsset, 'http://127.0.0.1:3000').toString(),
      expectedStatus: 200,
    }] : []),
  ];
  const results = [];
  let error;
  for (const check of checks) {
    try {
      const response = await fetch(check.url, { redirect: 'manual' });
      const body = await response.text();
      const location = response.headers.get('location');
      results.push({
        name: check.name,
        url: check.url,
        status: response.status,
        location,
        passed: response.status === check.expectedStatus
          && (!check.content || body.toLowerCase().includes(check.content.toLowerCase()))
          && (!check.location || location === check.location),
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      results.push({ name: check.name, url: check.url, status: 0, passed: false });
    }
  }
  const gate = {
    id: 'live-http',
    label: 'Live Docker health and Workflow Studio delivery',
    status: results.every(result => result.passed) ? 'passed' : 'failed',
    durationMs: Date.now() - startedAt,
    command: 'HTTP GET /health + /build/workflows/studio/167',
    evidence: 'The running container is healthy and serves the compiled Visual Workflow Studio.',
    checks: results,
    ...(error ? { error } : {}),
  };
  gates.push(gate);
  process.stdout.write(`[${gate.status.toUpperCase()}] ${gate.label} (${gate.durationMs} ms)\n`);
}

const capabilities = [
  {
    id: 'manual', label: 'Manual trigger',
    criteria: 'A saved workflow starts with explicit inputs and persists ordered step results.',
    gateIds: ['backend-flow-engine', 'live-data-transform', 'builder-run-ux'],
  },
  {
    id: 'webhook', label: 'Webhook trigger',
    criteria: 'Webhook configuration, signature/replay controls, local testing and runtime runner wiring are verified.',
    gateIds: ['trigger-ingress', 'builder-trigger-ux', 'live-http'],
  },
  {
    id: 'schedule', label: 'Schedule trigger',
    criteria: 'Cron configuration and triggered agent/tool runner wiring use the same governed runtime as manual runs.',
    gateIds: ['trigger-ingress', 'builder-trigger-ux'],
  },
  {
    id: 'condition', label: 'Condition and routing',
    criteria: 'Only the selected branch executes and unselected branches are persisted as skipped.',
    gateIds: ['backend-flow-engine', 'builder-trigger-ux'],
  },
  {
    id: 'parallel', label: 'Parallel fan-out',
    criteria: 'Independent branch steps execute after the fan-out boundary and retain deterministic evidence.',
    gateIds: ['backend-flow-engine', 'builder-trigger-ux'],
  },
  {
    id: 'for-each', label: 'For Each',
    criteria: 'Ordered fan-out, concurrency, retries and continue/stop error policies are verified and persisted.',
    gateIds: ['fanout-recovery', 'live-for-each', 'builder-run-ux'],
  },
  {
    id: 'subworkflow', label: 'Subworkflow',
    criteria: 'Nested executions receive isolated inputs and first-class parent/step/item lineage.',
    gateIds: ['fanout-recovery', 'live-child-runs', 'builder-run-ux'],
  },
  {
    id: 'mcp-read-write', label: 'MCP read/write',
    criteria: 'Portable tool bindings, credentials, structured outputs and governed write/approval behavior are verified.',
    gateIds: ['tool-governance', 'builder-run-ux'],
  },
  {
    id: 'recovery', label: 'Recovery',
    criteria: 'Whole-run checkpoint retry and targeted failed-child retry preserve immutable source evidence.',
    gateIds: ['fanout-recovery', 'live-child-runs', 'builder-run-ux'],
  },
  {
    id: 'copilot', label: 'Workflow Copilot',
    criteria: 'Natural-language proposals use the complete canvas topology and accessible MCP palette, then validate and persist as one undoable draft.',
    gateIds: ['copilot-generation', 'builder-copilot-ux'],
  },
  {
    id: 'observability', label: 'Run logs and traces',
    criteria: 'Persisted run state, child attempts, trace links and live/terminal refresh behavior remain inspectable.',
    gateIds: ['builder-run-ux', 'live-child-runs', 'live-http'],
  },
];

function buildReport() {
  const evaluatedCapabilities = capabilities.map(capability => {
    const evidence = capability.gateIds.map(id => gates.find(gate => gate.id === id)).filter(Boolean);
    return {
      ...capability,
      status: evidence.length === capability.gateIds.length && evidence.every(gate => gate.status === 'passed')
        ? 'passed'
        : 'failed',
      evidence: evidence.map(gate => ({ id: gate.id, label: gate.label, status: gate.status })),
    };
  });
  const passed = evaluatedCapabilities.filter(capability => capability.status === 'passed').length;
  const allGatesPassed = gates.every(gate => gate.status === 'passed');
  return {
    schemaVersion: 'argus.workflow-prototype-acceptance/v1',
    generatedAt: new Date().toISOString(),
    verdict: passed === evaluatedCapabilities.length && allGatesPassed ? 'prototype-ready' : 'not-ready',
    summary: {
      passedCapabilities: passed,
      totalCapabilities: evaluatedCapabilities.length,
      passedGates: gates.filter(gate => gate.status === 'passed').length,
      totalGates: gates.length,
    },
    capabilities: evaluatedCapabilities,
    gates,
  };
}

function markdownReport(report) {
  const capabilityRows = report.capabilities.map(capability =>
    `| ${capability.status === 'passed' ? 'PASS' : 'FAIL'} | ${capability.label} | ${capability.criteria} | ${capability.evidence.map(item => item.id).join(', ')} |`,
  ).join('\n');
  const gateRows = report.gates.map(gate =>
    `| ${gate.status === 'passed' ? 'PASS' : 'FAIL'} | ${gate.id} | ${gate.label} | ${gate.durationMs} ms |`,
  ).join('\n');
  return `# Visual Workflow Prototype Acceptance\n\n` +
    `Generated: ${report.generatedAt}\n\n` +
    `Verdict: **${report.verdict}** - ${report.summary.passedCapabilities}/${report.summary.totalCapabilities} capabilities, ` +
    `${report.summary.passedGates}/${report.summary.totalGates} gates passed.\n\n` +
    `## Capability matrix\n\n| Result | Capability | Acceptance criterion | Evidence gates |\n|---|---|---|---|\n${capabilityRows}\n\n` +
    `## Executed gates\n\n| Result | Gate | Scope | Duration |\n|---|---|---|---:|\n${gateRows}\n`;
}

async function main() {
  runCommandGate({
    id: 'root-build', label: 'Argus Core TypeScript build', args: ['run', 'build'],
    evidence: 'All backend and shared workflow types compile.',
  });
  runCommandGate({
    id: 'builder-build', label: 'Visual Workflow Builder production build',
    commands: [
      { command: process.execPath, args: [path.join(root, 'workflow-builder/node_modules/typescript/bin/tsc'), '-b'], cwd: path.join(root, 'workflow-builder') },
      { command: process.execPath, args: [path.join(root, 'workflow-builder/node_modules/vite/bin/vite.js'), 'build'], cwd: path.join(root, 'workflow-builder') },
    ],
    evidence: 'The standalone builder compiles and produces deployable Vite assets.',
  });
  runCommandGate({
    id: 'console-build', label: 'Argus Console production build',
    commands: [
      { command: process.execPath, args: [path.join(root, 'argus-console/node_modules/typescript/bin/tsc'), '--noEmit'], cwd: path.join(root, 'argus-console') },
      { command: process.execPath, args: [path.join(root, 'argus-console/node_modules/vite/bin/vite.js'), 'build'], cwd: path.join(root, 'argus-console') },
    ],
    evidence: 'The console host and Workflow Studio bridge compile together.',
  });
  runCommandGate({
    id: 'backend-flow-engine', label: 'Condition, routing, parallel and transformation engine',
    args: ['test', '--', 'src/workflows/__tests__/executorBranching.test.ts', 'src/workflows/__tests__/executorDataTransforms.test.ts', '--runInBand', '--silent'],
    evidence: 'Jest exercises branching, skipped branches, parallel fan-out and deterministic data transformations.',
  });
  runCommandGate({
    id: 'trigger-ingress', label: 'Webhook and schedule ingress security/runtime',
    args: ['test', '--', 'src/workflows/__tests__/triggeredRunners.test.ts', 'src/workflows/__tests__/webhookTriggerSecurity.test.ts', 'src/workflows/__tests__/triggerLifecycleGate.test.ts', '--runInBand', '--silent'],
    evidence: 'Jest exercises signatures, replay defense, trigger lifecycle and shared agent runner wiring.',
  });
  runCommandGate({
    id: 'tool-governance', label: 'MCP bindings, structured results, credentials and approvals',
    args: ['test', '--', 'src/workflows/__tests__/toolBindings.test.ts', 'src/workflows/__tests__/executorApprovalResume.test.ts', 'src/workflows/__tests__/executorCredRef.test.ts', 'src/workflows/__tests__/resourcePreflight.test.ts', 'src/__tests__/customBackendStructured.test.ts', '--runInBand', '--silent'],
    evidence: 'Jest proves portable MCP resolution, structured read/write results, credential refs, preflight and human-gated writes.',
  });
  runCommandGate({
    id: 'fanout-recovery', label: 'For Each, subworkflow and recovery semantics',
    args: ['test', '--', 'src/workflows/__tests__/executorForEach.test.ts', 'src/workflows/__tests__/executionRetry.test.ts', 'src/workflows/__tests__/childExecutionRetry.test.ts', 'src/workflows/__tests__/builderChildExecutionEvidence.test.ts', '--runInBand', '--silent'],
    evidence: 'Jest proves fan-out ordering, nested evidence, immutable checkpoint recovery and item-only retries.',
  });
  runCommandGate({
    id: 'copilot-generation', label: 'Governed prompt-to-workflow generation',
    args: ['test', '--', 'src/workflows/__tests__/copilotRoutes.test.ts', 'src/workflows/__tests__/copilotSelfValidate.test.ts', 'src/workflows/__tests__/copilotRequiredArgs.test.ts', 'src/workflows/__tests__/copilotGraphValidation.test.ts', '--runInBand', '--silent'],
    evidence: 'Jest proves topology-aware prompting, RBAC-filtered MCP selection, JSON repair, required arguments and graph validation.',
  });
  runCommandGate({
    id: 'builder-trigger-ux', label: 'Builder trigger and logic authoring UX',
    cwd: path.join(root, 'workflow-builder'),
    command: process.execPath,
    args: [path.join(root, 'workflow-builder/node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', 'src/api/__tests__/deriveTriggerConfig.test.ts', 'src/properties/__tests__/WebhookLocalTestSection.test.tsx', 'src/nodes/__tests__/logic.test.ts', 'src/nodes/__tests__/forEach.test.ts', '--silent', '--reporter=dot'],
    evidence: 'Vitest verifies trigger serialization/local test UX and the condition, parallel and For Each node contracts.',
  });
  runCommandGate({
    id: 'builder-run-ux', label: 'Builder execution, logs, replay and recovery UX',
    cwd: path.join(root, 'workflow-builder'),
    command: process.execPath,
    args: [path.join(root, 'workflow-builder/node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', 'src/execution/ExecutionLog.test.tsx', 'src/execution/RunModal.test.tsx', 'src/canvas/__tests__/ReplayRunControls.test.tsx', 'src/__tests__/recovery-wiring.test.tsx', 'src/api/__tests__/workflowArgsSerialization.test.ts', '--silent', '--reporter=dot'],
    evidence: 'Vitest verifies execution inputs, live/persisted logs, trace links, replay, checkpoint retry and targeted child recovery.',
  });
  runCommandGate({
    id: 'builder-copilot-ux', label: 'Copilot preview, validation and draft persistence UX',
    cwd: path.join(root, 'workflow-builder'),
    command: process.execPath,
    args: [path.join(root, 'workflow-builder/node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.config.ts', 'src/copilot/CopilotPanel.test.tsx', 'src/copilot/graphPatch.test.ts', 'src/stores/__tests__/builderStore.test.ts', '--silent', '--reporter=dot'],
    evidence: 'Vitest proves full-topology context, integration/risk preview, independent validation, persistence and one-action undo.',
  });
  runCommandGate({
    id: 'console-studio-ux', label: 'Console Workflow Studio integration',
    cwd: path.join(root, 'argus-console'),
    command: process.execPath,
    args: [path.join(root, 'argus-console/node_modules/vitest/vitest.mjs'), 'run', 'src/pages/WorkflowStudioPage.test.tsx', 'src/pages/WorkflowsPage.test.tsx', '--silent', '--reporter=dot'],
    evidence: 'Vitest verifies the console entry points and embedded studio lifecycle.',
  });
  runCommandGate({
    id: 'live-data-transform', label: 'Live PostgreSQL data-transformation workflow',
    command: process.execPath, args: ['dist/scripts/verifyWorkflowDataTransforms.js'],
    evidence: 'A real persisted template execution validates manual input and deterministic table/function output.',
  });
  runCommandGate({
    id: 'live-for-each', label: 'Live PostgreSQL For Each workflow',
    command: process.execPath, args: ['dist/scripts/verifyWorkflowForEach.js'],
    evidence: 'A real persisted fan-out proves ordered results and counters.',
  });
  runCommandGate({
    id: 'live-child-runs', label: 'Live nested execution and targeted retry lineage',
    command: process.execPath, args: ['dist/scripts/verifyWorkflowChildRuns.js'],
    evidence: 'The real HTTP retry route and PostgreSQL prove parent/child/item/retry lineage with an immutable parent.',
  });
  await runHttpGate();

  const report = buildReport();
  await mkdir(reportDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(reportDir, 'visual-workflow-prototype-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(path.join(reportDir, 'visual-workflow-prototype-acceptance.md'), markdownReport(report), 'utf8'),
  ]);
  process.stdout.write(`\n${report.verdict}: ${report.summary.passedCapabilities}/${report.summary.totalCapabilities} capabilities passed.\n`);
  process.stdout.write(`Reports: test-results/visual-workflow-prototype-acceptance.{json,md}\n`);
  if (report.verdict !== 'prototype-ready') process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
