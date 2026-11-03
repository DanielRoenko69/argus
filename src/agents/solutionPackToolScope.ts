import type { ToolDef } from './toolSearch.js';
import type { ExecutionResourceScope } from '../solutionPacks/executionTargets.js';

const IMPLEMENT_TICKET_TOOLS = new Set([
  'workspace_ls',
  'workspace_read',
  'workspace_write',
  'argus_code_search',
]);

const RUN_TESTS_TOOLS = new Set([
  'workspace_ls',
  'workspace_read',
  'workspace_exec',
  'argus_code_search',
]);

/**
 * Solution Pack grants can authorize a broad bundle while each worker turn
 * receives only the capabilities needed for its declared orchestration task.
 * This is both least privilege and a substantial context reduction for local
 * models, which otherwise see every MCP schema attached to the bundle.
 */
export function scopeSolutionPackWorkerTools(
  tools: ToolDef[],
  taskType: string | null | undefined,
): ToolDef[] | null {
  const allowed = taskType === 'implement_ticket'
    ? IMPLEMENT_TICKET_TOOLS
    : taskType === 'run_tests'
      ? RUN_TESTS_TOOLS
      : null;

  if (!allowed) return null;
  return tools.filter(tool => allowed.has(tool.function.name));
}

/**
 * Subscription/CLI runtimes do not all preserve native function-call frames.
 * Give signed Pack workers a compact copy of the exact post-policy catalog so
 * a text fallback can still emit calls that the existing fail-closed parser
 * recognizes. This is guidance only; authorization remains in Core.
 */
export function solutionPackToolCatalogPrompt(tools: ToolDef[]): string {
  if (tools.length === 0) {
    return 'SIGNED SOLUTION PACK TOOL CATALOG\nNo tools are authorized for this turn. Do not claim that any provider was queried.';
  }
  const rows = tools.map(tool => {
    const description = tool.function.description.replace(/\s+/g, ' ').trim().slice(0, 240);
    const parameters = Object.keys(tool.function.parameters.properties).join(', ') || 'none';
    return `- ${tool.function.name}(${parameters}): ${description}`;
  });
  return [
    'SIGNED SOLUTION PACK TOOL CATALOG',
    'Only the following exact tool names are authorized for this turn:',
    ...rows,
    'Use native function calling when available. If the runtime can only emit text, output a JSON object with exactly this shape:',
    '{"name":"EXACT_NAME_FROM_THE_LIST","arguments":{"parameter":"value"}}',
    'Never add prefixes, invent aliases, or claim a query succeeded until its tool result was returned.',
  ].join('\n');
}

/**
 * A signed runtime target is an argument-level boundary. Kubernetes tools may
 * only address the exact namespace Core resolved from the selected Fabric
 * connection and bundle; prompt instructions alone are not authorization.
 */
export function validateExecutionResourceScopeCall(
  toolName: string,
  args: Record<string, unknown>,
  scope?: ExecutionResourceScope,
): string | null {
  if (!scope || scope.kind !== 'kubernetes' || !/(?:^|_)(?:k8s|kubernetes)(?:_|$)/i.test(toolName)) return null;
  if (args['all_namespaces'] === true || args['allNamespaces'] === true) {
    return `Tool '${toolName}' cannot request all Kubernetes namespaces under this execution grant.`;
  }
  if (args['namespace'] !== scope.namespace) {
    return `Tool '${toolName}' must use the signed Kubernetes namespace '${scope.namespace}'.`;
  }
  return null;
}

/** Extract positive, repository-relative file targets from the ticket block. */
export function extractRequestedFileTargets(message: string): string[] {
  const ticketBlock = /Ticket request:\s*\n([\s\S]*?)\n\nPlan:/i.exec(message)?.[1] ?? message;
  const matches = ticketBlock.matchAll(
    /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),.:;])/g,
  );
  const targets = [...matches].flatMap(match => {
    const path = match[1]!;
    if (path.startsWith('/')) return [];
    const beforePath = ticketBlock.slice(0, match.index ?? 0);
    const clause = beforePath.split(/[.!?\n]/).at(-1)?.toLowerCase() ?? '';
    if (/\b(?:do not|don't|must not|never|without)\b/.test(clause)) return [];
    return [path];
  });
  return [...new Set(targets)].slice(0, 16);
}
