import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TOOL = 'aiops_kubernetes_remediation_resources_scale';
const REVISION_TOOL = 'aiops_kubernetes_remediation_deployment_revision_rollback';
const CONFIRMATION = 'scale-and-restore-argus-demo';
const CALL_TIMEOUT_MS = 15_000;

function firstApiKey(): string {
  const key = (process.env['MCP_API_KEYS'] ?? '').split(',')[0]?.trim() ?? '';
  if (!key) throw new Error('MCP_API_KEYS must contain a key for remediation verification');
  return key;
}

function outputText(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (Array.isArray(result.content) ? result.content : [])
    .flatMap((part: unknown) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
      const value = part as Record<string, unknown>;
      return value['type'] === 'text' && typeof value['text'] === 'string' ? [value['text']] : [];
    })
    .join('\n');
}

function replicas(result: Awaited<ReturnType<Client['callTool']>>): number {
  const output = outputText(result);
  let jsonScale: unknown = null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    jsonScale = parsed['scale'];
  } catch { /* tolerate YAML and provider prose */ }
  const match = /\bspec:\s*\r?\n\s*replicas:\s*(\d{1,3})\b/i.exec(output)
    ?? /\b(?:scale|replicas)\s*[:=]\s*(\d{1,3})\b/i.exec(output);
  const value = Number.isSafeInteger(jsonScale) ? Number(jsonScale) : match ? Number(match[1]) : NaN;
  if (result.isError || !Number.isSafeInteger(value)) {
    throw new Error(`resources_scale did not return a usable replica count: ${output.slice(0, 500)}`);
  }
  return value;
}

async function callScale(
  client: Client,
  arguments_: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool(
    { name: TOOL, arguments: arguments_ },
    undefined,
    { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
  );
}

type RevisionSnapshot = {
  currentRevision: number;
  templateHash: string;
  availableRevisions: Array<{ revision: number; templateHash: string }>;
};

function revisionSnapshot(result: Awaited<ReturnType<Client['callTool']>>): RevisionSnapshot {
  const output = outputText(result);
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(output) as Record<string, unknown>; } catch { /* fail below */ }
  const currentRevision = Number(parsed?.['currentRevision']);
  const templateHash = parsed?.['templateHash'];
  const availableRevisions = Array.isArray(parsed?.['availableRevisions'])
    ? parsed['availableRevisions'] as Array<Record<string, unknown>> : [];
  const history = availableRevisions.flatMap(item => {
    const itemRevision = Number(item['revision']);
    const itemHash = item['templateHash'];
    return Number.isSafeInteger(itemRevision) && itemRevision > 0
      && typeof itemHash === 'string' && /^[a-f0-9]{64}$/.test(itemHash)
      ? [{ revision: itemRevision, templateHash: itemHash }] : [];
  });
  if (result.isError || !Number.isSafeInteger(currentRevision) || currentRevision < 1
    || typeof templateHash !== 'string' || !/^[a-f0-9]{64}$/.test(templateHash)
    || history.length === 0) {
    throw new Error(`deployment_revision_rollback returned invalid evidence: ${output.slice(0, 500)}`);
  }
  return { currentRevision, templateHash, availableRevisions: history };
}

async function callRevision(
  client: Client,
  arguments_: Record<string, unknown>,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  return client.callTool(
    { name: REVISION_TOOL, arguments: arguments_ },
    undefined,
    { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS },
  );
}

async function restoreRevision(
  client: Client,
  baseArguments: Record<string, unknown>,
  original: RevisionSnapshot,
  currentHash: string,
): Promise<void> {
  const restored = revisionSnapshot(await callRevision(client, {
    ...baseArguments,
    targetRevision: original.currentRevision,
    expectedCurrentTemplateHash: currentHash,
    targetTemplateHash: original.templateHash,
  }));
  if (restored.templateHash !== original.templateHash) {
    throw new Error('Revision restore did not return the original template fingerprint');
  }
  const verified = revisionSnapshot(await callRevision(client, baseArguments));
  if (verified.templateHash !== original.templateHash) {
    throw new Error('Revision restore verification did not observe the original template fingerprint');
  }
}

async function restoreWithRetry(
  client: Client,
  baseArguments: Record<string, unknown>,
  original: number,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // Refresh the provider's scale/resourceVersion immediately before the
      // update; the Deployment controller may concurrently update Scale status.
      await callScale(client, baseArguments);
      const restored = replicas(await callScale(client, { ...baseArguments, scale: original }));
      if (restored !== original) throw new Error(`Restore call returned ${restored}; expected ${original}`);
      const verified = replicas(await callScale(client, baseArguments));
      if (verified !== original) throw new Error(`Restore verification observed ${verified}; expected ${original}`);
      return;
    } catch (cause) {
      lastError = cause;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 400));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Restore retries were exhausted');
}

async function main(): Promise<void> {
  if (process.env['ARGUS_AIOPS_REMEDIATION_E2E_CONFIRM'] !== CONFIRMATION) {
    throw new Error(`Refusing provider mutation. Set ARGUS_AIOPS_REMEDIATION_E2E_CONFIRM=${CONFIRMATION}`);
  }
  const client = new Client(
    { name: 'argus-aiops-remediation-verifier', version: '1.0.0' },
    { capabilities: {} },
  );
  const url = new URL(process.env['ARGUS_AIOPS_REMEDIATION_MCP_URL']
    ?? 'http://127.0.0.1:3000/mcp/group/argus-aiops-remediate');
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${firstApiKey()}` } },
  });
  const baseArguments = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    name: 'checkout-api',
    namespace: 'argus-demo',
  };
  let original: number | null = null;
  let changed = false;
  let originalRevision: RevisionSnapshot | null = null;
  let revisionChangedToHash: string | null = null;

  try {
    await client.connect(transport);
    const catalog = await client.listTools();
    const remoteTools = catalog.tools.map(tool => tool.name)
      .filter(name => name.startsWith('aiops_kubernetes_remediation_'));
    if (remoteTools.length !== 2 || !remoteTools.includes(TOOL) || !remoteTools.includes(REVISION_TOOL)) {
      throw new Error(`Remediation Bundle escaped its selected-tool policy: ${remoteTools.join(', ') || '(none)'}`);
    }

    original = replicas(await callScale(client, baseArguments));
    const desired = original >= 50 ? original - 1 : original + 1;
    if (desired < 1) throw new Error(`No safe test replica count is available from ${original}`);

    const scaled = replicas(await callScale(client, { ...baseArguments, scale: desired }));
    changed = true;
    if (scaled !== desired) throw new Error(`Scale call returned ${scaled}; expected ${desired}`);

    const verified = replicas(await callScale(client, baseArguments));
    if (verified !== desired) throw new Error(`Scale verification observed ${verified}; expected ${desired}`);

    process.stdout.write(`[aiops-remediation] scaled checkout-api ${original} -> ${desired} and verified\n`);

    const revisionArguments = { name: 'checkout-api', namespace: 'argus-demo' };
    originalRevision = revisionSnapshot(await callRevision(client, revisionArguments));
    const targetRevision = originalRevision.availableRevisions.find(item => item.templateHash !== originalRevision!.templateHash);
    if (!targetRevision) throw new Error('Demo Deployment needs one retained revision with a different template fingerprint');
    const rolledBack = revisionSnapshot(await callRevision(client, {
      ...revisionArguments,
      targetRevision: targetRevision.revision,
      expectedCurrentTemplateHash: originalRevision.templateHash,
      targetTemplateHash: targetRevision.templateHash,
    }));
    revisionChangedToHash = targetRevision.templateHash;
    if (rolledBack.templateHash !== targetRevision.templateHash) {
      throw new Error(`Revision rollback returned ${rolledBack.templateHash}; expected ${targetRevision.templateHash}`);
    }
    const revisionVerified = revisionSnapshot(await callRevision(client, revisionArguments));
    if (revisionVerified.templateHash !== targetRevision.templateHash) {
      throw new Error('Revision rollback verification did not observe the target template fingerprint');
    }
    process.stdout.write(`[aiops-remediation] restored retained revision ${targetRevision.revision} and verified its template fingerprint\n`);
  } finally {
    let cleanupError: unknown = null;
    if (revisionChangedToHash && originalRevision) {
      try {
        await restoreRevision(client, { name: 'checkout-api', namespace: 'argus-demo' }, originalRevision, revisionChangedToHash);
        process.stdout.write(`[aiops-remediation] restored original revision template ${originalRevision.templateHash.slice(0, 12)} and verified\n`);
      } catch (cause) { cleanupError = cause; }
    }
    if (changed && original != null) {
      try {
        await restoreWithRetry(client, baseArguments, original);
        process.stdout.write(`[aiops-remediation] restored checkout-api to ${original} and verified\n`);
      } catch (cause) { cleanupError ??= cause; }
    }
    const close = client.close().catch(() => undefined);
    await Promise.race([close, new Promise(resolve => setTimeout(resolve, 2_000))]);
    await transport.close().catch(() => undefined);
    if (cleanupError) throw cleanupError;
  }
}

main().catch(cause => {
  process.stderr.write(`[aiops-remediation] verification failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
