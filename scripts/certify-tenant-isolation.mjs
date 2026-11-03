#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const reportPath = process.env.ARGUS_TENANT_ISOLATION_REPORT
  || 'test-results/tenant-isolation-certification.json';

function run(label, args) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(), encoding: 'utf8', shell: false, windowsHide: true,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return {
    label,
    status: result.status === 0 && !result.error ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    outputSha256: createHash('sha256').update(output).digest('hex'),
    error: result.status === 0 && !result.error ? null : (result.error?.message ?? output.slice(-1200)),
  };
}

const checks = [run('typescript-build', ['node_modules/typescript/bin/tsc'])];
if (checks[0].status === 'passed') {
  checks.push(run('server-authorized-scope-contracts', [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config', 'jest.config.cjs',
    '--runInBand',
    'src/auth/__tests__/userLifecycle.test.ts',
    'src/auth/__tests__/workspaceScope.test.ts',
    'src/auth/__tests__/sessionAssurance.test.ts',
    'src/goldenPath/__tests__/routes.test.ts',
    'src/goldenPath/__tests__/runStore.test.ts',
    'src/audit/__tests__/evidenceRoutes.test.ts',
    'src/audit/__tests__/reportRoutes.test.ts',
    'src/compliance/__tests__/aiSystemRoutes.test.ts',
    'src/compliance/__tests__/aiSystemControlRoutes.test.ts',
    'src/compliance/__tests__/aiComplianceDossierRoutes.test.ts',
    'src/runs/__tests__/routes.test.ts',
    'src/runs/__tests__/store.test.ts',
    'src/observability/__tests__/telemetryStore.test.ts',
    'src/observability/__tests__/logRoutes.test.ts',
    'src/lib/__tests__/logStoreCorrelation.test.ts',
    'src/console/__tests__/consoleWorkspaceScope.test.ts',
    'src/console/__tests__/globalSearch.test.ts',
    'src/console/__tests__/globalSearchRoutes.test.ts',
    'src/workflows/__tests__/workflowStoreScope.test.ts',
    'src/workflows/__tests__/workflowRouteScope.test.ts',
    'src/workflows/__tests__/workflowApprovalLifecycle.test.ts',
    'src/approvals/__tests__/runtimeApprovalStore.test.ts',
    'src/approvals/__tests__/runtimeApprovalDecision.test.ts',
    'src/auth/__tests__/executionGrantMiddleware.test.ts',
    'src/auth/__tests__/apiKeyLifecycle.test.ts',
    'src/auth/__tests__/apiKeyManagement.test.ts',
    'src/auth/__tests__/apiKeyRbacLifecycle.test.ts',
    'src/solutionPacks/__tests__/executionGrant.test.ts',
    'src/solutionPacks/__tests__/runtimeMcpLeases.test.ts',
    'src/solutionPacks/__tests__/managedRuntimeCoordinator.test.ts',
    'src/solutionPacks/__tests__/hermesDevBridge.test.ts',
    'src/solutionPacks/__tests__/hermesDevConnections.test.ts',
    'src/solutionPacks/__tests__/routes.test.ts',
  ]));
}

const report = {
  schemaVersion: 1,
  kind: 'argus.tenant-isolation-certification',
  status: checks.every(check => check.status === 'passed') ? 'passed' : 'failed',
  generatedAt: new Date().toISOString(),
  boundary: 'interactive-session membership administration, Audit/Evidence/Reports, AI-system Compliance, Golden Path, workflow definitions/executions/retries/approvals, Runs, native trace/analytics, structured Logs, global workspace search read surfaces and technical runtime identities for execution grants, leases and Hermes/A2A ingress',
  guarantees: [
    'tenant and workspace selectors are resolved against server-authenticated session memberships',
    'platform-admin membership updates require one default, reject duplicates and commit with the managed-user transaction',
    'unknown, partial and malformed selectors fail closed with one opaque response',
    'same-named workspaces in two tenants resolve to distinct scopes',
    'Golden Path run lookup is scoped before persistence is queried',
    'audit evidence reads receive only authenticated memberships',
    'audit report reads, writes and exports use the selected authenticated membership',
    'AI-system registry, control assessments and compliance dossiers use the selected authenticated membership',
    'legacy global workflow-to-AI-system bindings fail closed outside the default/default scope',
    'the Runs v2 collection resolves one authenticated scope before querying workflow, telemetry or process-local run sources',
    'legacy global Runs and traces remain visible only in default/default while explicitly scoped records require an exact match',
    'console Run, native trace/span, trace-family and telemetry-analytics reads carry the selected authenticated scope into SQL',
    'workflow definitions, visual saves, versions, template clones, executions, retries and workflow/runtime approval decisions require exact tenant/workspace ownership',
    'scheduled and webhook-triggered executions copy the immutable scope from their owning workflow',
    'public webhook paths fail closed when more than one tenant has the same path',
    'structured log writes persist validated scope and log counts, searches and correlated trace probes require the selected authenticated membership',
    'global search binds scoped workflows to the selected membership and hides legacy global catalogs outside default/default',
    'new execution grants freeze an explicit tenant/workspace scope and reject cross-workspace replay',
    'runtime MCP leases require the signed grant, calling principal and persisted binding to agree on tenant, workspace and Bundle scope',
    'Hermes connections, bridge tasks and managed-runtime lifecycle operations remain inside the authenticated workspace membership',
    'legacy technical credentials without stored scope are contained in default/default for migration compatibility',
    'raw idempotency keys remain outside persisted Golden Path rows',
  ],
  exclusions: [
    'This focused gate does not claim that every legacy unscoped Argus resource table is multi-tenant.',
    'Non-telemetry observability stores remain in the ordered migration inventory.',
    'Agent, Knowledge and MCP Fabric resource registries themselves remain in the ordered P1 ownership migration.',
    'Kubernetes namespace and network-policy isolation require the later deployment certification.',
  ],
  checks,
};

await mkdir(dirname(resolve(reportPath)), { recursive: true });
await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath, checks }, null, 2)}\n`);
if (report.status !== 'passed') process.exitCode = 2;
