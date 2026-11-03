import type { WorkflowInputParam, WorkflowStep } from './types.js';

export interface InlineCredentialIssue {
  stepId: string;
  path: string;
  issue: string;
}

const CREDENTIAL_FIELD_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'apikey',
  'xapikey',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'clientsecret',
  'clientcredential',
  'privatekey',
  'password',
  'token',
  'secret',
]);

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function isInlineCredentialField(value: string): boolean {
  return CREDENTIAL_FIELD_NAMES.has(normalizedName(value));
}

function addIssue(issues: InlineCredentialIssue[], stepId: string, path: string): void {
  if (issues.some(issue => issue.stepId === stepId && issue.path === path)) return;
  issues.push({
    stepId,
    path,
    issue: `inline credential field '${path}' is not allowed; store authentication in MCP Fabric and reference only the governed tool or bundle`,
  });
}

function inspectValue(
  value: unknown,
  path: string,
  stepId: string,
  issues: InlineCredentialIssue[],
  visited: Set<object>,
): void {
  if (typeof value === 'string') {
    const inputRefs = value.matchAll(/\{\{\s*input\.([a-zA-Z0-9_.-]+)\s*\}\}/g);
    for (const match of inputRefs) {
      const inputName = match[1];
      if (inputName && isInlineCredentialField(inputName)) addIssue(issues, stepId, `${path} -> input.${inputName}`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectValue(entry, `${path}[${index}]`, stepId, issues, visited));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const entryPath = path ? `${path}.${key}` : key;
    if (isInlineCredentialField(key)) addIssue(issues, stepId, entryPath);
    inspectValue(entry, entryPath, stepId, issues, visited);
  }
}

/**
 * Workflows may persist references to Fabric-managed identities (`cred_ref`),
 * but never provider secrets in step arguments or user-supplied inputs.
 */
export function findInlineWorkflowCredentials(
  steps: WorkflowStep[] | unknown[],
  blockDefinitions: unknown[] = [],
  inputParams: WorkflowInputParam[] | unknown[] = [],
): InlineCredentialIssue[] {
  const issues: InlineCredentialIssue[] = [];
  for (const [index, rawStep] of steps.entries()) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) continue;
    const step = rawStep as Record<string, unknown>;
    const stepId = typeof step['id'] === 'string' ? step['id'] : `step:${index}`;
    inspectValue(step['args'], 'args', stepId, issues, new Set());
  }
  for (const [index, rawBlock] of blockDefinitions.entries()) {
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) continue;
    const block = rawBlock as Record<string, unknown>;
    const blockId = typeof block['id'] === 'string' ? block['id'] : `block:${index}`;
    const data = block['data'];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      inspectValue((data as Record<string, unknown>)['args'], 'canvas.data.args', blockId, issues, new Set());
    }
  }
  for (const [index, rawInput] of inputParams.entries()) {
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) continue;
    const name = (rawInput as Record<string, unknown>)['name'];
    if (typeof name === 'string' && isInlineCredentialField(name)) {
      addIssue(issues, `input:${index}`, `input_params.${name}`);
    }
  }
  return issues;
}
