import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT ?? 8085);
const API_HOST = process.env.KUBERNETES_SERVICE_HOST;
const API_PORT = Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? 443);
const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const allowedNamespaces = new Set((process.env.EXECUTION_NAMESPACES ?? '')
  .split(',').map(value => value.trim()).filter(Boolean));
const allowedWorkloads = new Set((process.env.EXECUTION_WORKLOADS ?? '')
  .split(',').map(value => value.trim()).filter(Boolean));

if (!API_HOST || allowedNamespaces.size === 0 || allowedWorkloads.size === 0) {
  throw new Error('Kubernetes API host, EXECUTION_NAMESPACES and EXECUTION_WORKLOADS are required');
}

const agent = new https.Agent({ ca: readFileSync(CA_PATH), keepAlive: true, maxSockets: 4 });

function boundedName(value) {
  if (typeof value !== 'string' || value.length > 253
    || !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value)) throw new Error('invalid Kubernetes resource name');
  return value;
}

function boundedScope(namespace, name) {
  const safeNamespace = boundedName(namespace);
  const safeName = boundedName(name);
  if (!allowedNamespaces.has(safeNamespace) || !allowedWorkloads.has(safeName)) {
    throw new Error('requested workload is outside the connector execution boundary');
  }
  return { namespace: safeNamespace, name: safeName };
}

async function kubeRequest(method, path, body = null, contentType = 'application/json') {
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const encoded = body == null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: API_HOST,
      port: API_PORT,
      path,
      method,
      agent,
      timeout: 10_000,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(encoded == null ? {} : { 'content-type': contentType, 'content-length': String(encoded.length) }),
      },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2_000_000) request.destroy(new Error('Kubernetes response exceeded 2 MB'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* handled below */ }
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          const causes = Array.isArray(parsed?.details?.causes)
            ? parsed.details.causes.map(cause => cause?.message).filter(Boolean).join('; ') : '';
          const error = new Error(`Kubernetes API ${response.statusCode}: ${causes || parsed?.message || text.slice(0, 500)}`);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        if (parsed == null) reject(new Error('Kubernetes API returned invalid JSON'));
        else resolve(parsed);
      });
    });
    request.on('timeout', () => request.destroy(new Error('Kubernetes API request timed out')));
    request.on('error', reject);
    if (encoded != null) request.write(encoded);
    request.end();
  });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizedPodTemplate(value) {
  const template = structuredClone(value ?? {});
  if (template?.metadata?.labels && typeof template.metadata.labels === 'object') {
    delete template.metadata.labels['pod-template-hash'];
    if (Object.keys(template.metadata.labels).length === 0) delete template.metadata.labels;
  }
  return template;
}

export function podTemplateHash(value) {
  return createHash('sha256').update(canonical(normalizedPodTemplate(value))).digest('hex');
}

function revision(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000_000_000 ? parsed : null;
}

async function deploymentSnapshot(namespace, name) {
  const resource = encodeURIComponent(name);
  const scope = encodeURIComponent(namespace);
  const deployment = await kubeRequest('GET', `/apis/apps/v1/namespaces/${scope}/deployments/${resource}`);
  const replicas = await kubeRequest('GET', `/apis/apps/v1/namespaces/${scope}/replicasets?limit=500`);
  const uid = deployment?.metadata?.uid;
  const history = (Array.isArray(replicas?.items) ? replicas.items : []).flatMap(item => {
    const owned = Array.isArray(item?.metadata?.ownerReferences)
      && item.metadata.ownerReferences.some(owner => owner?.uid === uid && owner?.kind === 'Deployment');
    const itemRevision = revision(item?.metadata?.annotations?.['deployment.kubernetes.io/revision']);
    return owned && itemRevision != null && item?.spec?.template
      ? [{ revision: itemRevision, templateHash: podTemplateHash(item.spec.template), template: normalizedPodTemplate(item.spec.template) }]
      : [];
  }).sort((left, right) => right.revision - left.revision);
  const currentRevision = revision(deployment?.metadata?.annotations?.['deployment.kubernetes.io/revision']);
  if (!deployment?.metadata?.resourceVersion || !deployment?.spec?.template || currentRevision == null) {
    throw new Error('Deployment does not expose bounded revision evidence');
  }
  return {
    deployment,
    currentRevision,
    templateHash: podTemplateHash(deployment.spec.template),
    history,
  };
}

function publicSnapshot(snapshot, changed = false) {
  const revisions = new Map();
  for (const item of snapshot.history) {
    if (!revisions.has(item.revision)) revisions.set(item.revision, item.templateHash);
  }
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    namespace: snapshot.deployment.metadata.namespace,
    name: snapshot.deployment.metadata.name,
    currentRevision: snapshot.currentRevision,
    templateHash: snapshot.templateHash,
    availableRevisions: [...revisions].map(([itemRevision, templateHash]) => ({ revision: itemRevision, templateHash })),
    changed,
  };
}

async function scaleResource({ apiVersion, kind, name, namespace, scale }) {
  if (apiVersion !== 'apps/v1' || !['Deployment', 'StatefulSet'].includes(kind)) {
    throw new Error('only apps/v1 Deployment and StatefulSet scale resources are supported');
  }
  const bounded = boundedScope(namespace, name);
  const plural = kind === 'Deployment' ? 'deployments' : 'statefulsets';
  const path = `/apis/apps/v1/namespaces/${encodeURIComponent(bounded.namespace)}/${plural}/${encodeURIComponent(bounded.name)}/scale`;
  const current = await kubeRequest('GET', path);
  if (scale !== undefined) {
    if (!Number.isSafeInteger(scale) || scale < 1 || scale > 50) throw new Error('scale must be an integer from 1 to 50');
    await kubeRequest('PATCH', path, [
      { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
      { op: 'replace', path: '/spec/replicas', value: scale },
    ], 'application/json-patch+json');
  }
  const observed = scale === undefined ? current : await kubeRequest('GET', path);
  return { apiVersion, kind, namespace: bounded.namespace, name: bounded.name, scale: observed?.spec?.replicas };
}

async function rollbackDeployment({ name, namespace, targetRevision, expectedCurrentTemplateHash, targetTemplateHash }) {
  const bounded = boundedScope(namespace, name);
  const initial = await deploymentSnapshot(bounded.namespace, bounded.name);
  if (targetRevision === undefined) return publicSnapshot(initial);
  if (revision(targetRevision) == null || !/^[a-f0-9]{64}$/.test(expectedCurrentTemplateHash ?? '')
    || !/^[a-f0-9]{64}$/.test(targetTemplateHash ?? '')) {
    throw new Error('mutation requires a bounded targetRevision and two exact SHA-256 template fingerprints');
  }
  const path = `/apis/apps/v1/namespaces/${encodeURIComponent(bounded.namespace)}/deployments/${encodeURIComponent(bounded.name)}`;
  let lastConflict = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = attempt === 1 ? initial : await deploymentSnapshot(bounded.namespace, bounded.name);
    if (before.templateHash === targetTemplateHash) return publicSnapshot(before, attempt > 1);
    if (before.templateHash !== expectedCurrentTemplateHash) {
      throw new Error('current Deployment template changed after plan creation; refusing stale rollback');
    }
    const exactRevision = before.history.find(item => item.revision === targetRevision);
    const fingerprintMatches = before.history.filter(item => item.templateHash === targetTemplateHash);
    const target = exactRevision?.templateHash === targetTemplateHash
      ? exactRevision : fingerprintMatches.length === 1 ? fingerprintMatches[0] : null;
    if (!target) throw new Error('target revision is missing or its template fingerprint changed');
    try {
      await kubeRequest('PATCH', path, [
        { op: 'test', path: '/metadata/resourceVersion', value: before.deployment.metadata.resourceVersion },
        { op: 'replace', path: '/spec/template', value: target.template },
      ], 'application/json-patch+json');
      const after = await deploymentSnapshot(bounded.namespace, bounded.name);
      if (after.templateHash !== targetTemplateHash) throw new Error('patched Deployment did not expose the approved template fingerprint');
      return publicSnapshot(after, true);
    } catch (cause) {
      if (![409, 422].includes(Number(cause?.statusCode)) || attempt === 5) throw cause;
      lastConflict = cause;
      await new Promise(resolve => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastConflict ?? new Error('Deployment resourceVersion retries were exhausted');
}

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function createServer() {
  const server = new McpServer({ name: 'argus-aiops-kubernetes-remediation', version: '1.0.0' });
  server.registerTool('resources_scale', {
    description: 'Get or update the scale of one allowlisted apps/v1 Deployment or StatefulSet.',
    inputSchema: {
      apiVersion: z.literal('apps/v1'),
      kind: z.enum(['Deployment', 'StatefulSet']),
      name: z.string(),
      namespace: z.string(),
      scale: z.number().int().min(1).max(50).optional(),
    },
  }, async input => toolResult(await scaleResource(input)));
  server.registerTool('deployment_revision_rollback', {
    description: 'Inspect retained Deployment revisions or restore one exact template fingerprint using stale-plan preconditions.',
    inputSchema: {
      name: z.string(),
      namespace: z.string(),
      targetRevision: z.number().int().min(1).max(1_000_000_000).optional(),
      expectedCurrentTemplateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      targetTemplateHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    },
  }, async input => toolResult(await rollbackDeployment(input)));
  return server;
}

const app = createMcpExpressApp({
  host: '0.0.0.0',
  allowedHosts: [
    'argus-aiops-control-plane',
    'argus-kubernetes-remediation',
    'argus-kubernetes-remediation.argus-aiops-system',
    'argus-kubernetes-remediation.argus-aiops-system.svc',
  ],
});
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.post('/mcp', async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (cause) {
    if (!res.headersSent) res.status(500).json({
      jsonrpc: '2.0', id: null,
      error: { code: -32603, message: cause instanceof Error ? cause.message : 'Internal connector error' },
    });
  } finally {
    res.on('close', () => { void transport.close(); void server.close(); });
  }
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());

app.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[argus-aiops-remediation] listening on ${PORT}\n`);
});
