export type RiskLevel = 'medium' | 'high' | 'critical';
export type RiskFactorCategory = 'action' | 'environment' | 'scope' | 'data' | 'execution' | 'policy';

export interface RiskFactor {
  id: string;
  label: string;
  category: RiskFactorCategory;
  weight: number;
  evidence: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  factors: RiskFactor[];
  summary: string;
  model: 'argus-risk-v1';
}

export interface ToolRiskInput {
  toolName: string;
  args: Record<string, unknown>;
  isWrite?: boolean;
  humanOversight?: boolean;
  subjectType?: 'agent' | 'workflow';
}

const DESTRUCTIVE_ACTION = /(?:^|_)(?:delete|destroy|drop|purge|merge|rollback|uninstall|terminate|revoke)(?:_|$)/i;
const CHANGE_ACTION = /(?:^|_)(?:create|update|write|apply|deploy|patch|scale|transition|trigger|close|comment|approve)(?:_|$)/i;
const INFRA_TOOL = /(?:k8s|kubernetes|helm|terraform|cluster|database|postgres|jenkins|pipeline)/i;
const EXEC_TOOL = /(?:^|_)(?:exec|execute|shell|command|script)(?:_|$)/i;
const ENVIRONMENT_KEY = /(?:environment|env|namespace|cluster|context|stage|target|endpoint|url)/i;
const SCOPE_KEY = /(?:scope|namespace|resource|project|repository|repo|target|selector|pattern|names|ids)/i;
const FORCE_KEY = /(?:force|override|bypass|recursive|cascade)/i;
const SENSITIVE_KEY = /(?:secret|token|password|credential|private.?key|api.?key|authorization)/i;
const SENSITIVE_VALUE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b)/i;

function flattenArgs(
  value: unknown,
  path = '',
  out: Array<{ path: string; value: unknown }> = [],
  depth = 0,
): Array<{ path: string; value: unknown }> {
  if (depth > 5 || out.length >= 200) return out;
  if (Array.isArray(value)) {
    out.push({ path, value });
    for (let index = 0; index < Math.min(value.length, 25); index++) {
      flattenArgs(value[index], `${path}[${index}]`, out, depth + 1);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nestedPath = path ? `${path}.${key}` : key;
      out.push({ path: nestedPath, value: nested });
      flattenArgs(nested, nestedPath, out, depth + 1);
    }
  }
  return out;
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function addFactor(factors: Map<string, RiskFactor>, factor: RiskFactor): void {
  const existing = factors.get(factor.id);
  if (!existing || factor.weight > existing.weight) factors.set(factor.id, factor);
}

export function assessToolRisk(input: ToolRiskInput): RiskAssessment {
  const factors = new Map<string, RiskFactor>();
  const entries = flattenArgs(input.args);
  const toolName = input.toolName.toLowerCase();

  addFactor(factors, {
    id: 'runtime-mutation',
    label: 'Runtime mutation',
    category: 'action',
    weight: 30,
    evidence: 'The action changes or can trigger changes in an external system.',
  });

  if (input.isWrite || CHANGE_ACTION.test(toolName) || DESTRUCTIVE_ACTION.test(toolName)) {
    addFactor(factors, {
      id: 'write-action',
      label: 'Write action',
      category: 'action',
      weight: 15,
      evidence: 'Tool metadata or action semantics classify this operation as a write.',
    });
  }

  if (DESTRUCTIVE_ACTION.test(toolName)) {
    addFactor(factors, {
      id: 'destructive-operation',
      label: 'Destructive operation',
      category: 'action',
      weight: 25,
      evidence: 'The tool can delete, destroy, merge, roll back, or revoke state.',
    });
  } else if (/(?:deploy|apply|transition|trigger|scale|patch)/i.test(toolName)) {
    addFactor(factors, {
      id: 'change-operation',
      label: 'Change operation',
      category: 'action',
      weight: 15,
      evidence: 'The tool initiates a deployment or operational state transition.',
    });
  }

  if (INFRA_TOOL.test(toolName)) {
    addFactor(factors, {
      id: 'infrastructure-control',
      label: 'Infrastructure control',
      category: 'execution',
      weight: 10,
      evidence: 'The action targets infrastructure, delivery, or database control planes.',
    });
  }

  if (EXEC_TOOL.test(toolName) || entries.some(entry => /(?:cmd|command|script)$/i.test(entry.path))) {
    addFactor(factors, {
      id: 'arbitrary-execution',
      label: 'Command execution',
      category: 'execution',
      weight: 15,
      evidence: 'Arguments contain a command or script execution surface.',
    });
  }

  const productionTarget = entries.some(entry => {
    if (!ENVIRONMENT_KEY.test(entry.path)) return false;
    const value = stringValue(entry.value).toLowerCase();
    return /(?:^|[^a-z])prod(?:uction)?(?:[^a-z]|$)/.test(value);
  });
  if (productionTarget) {
    addFactor(factors, {
      id: 'production-target',
      label: 'Production target',
      category: 'environment',
      weight: 30,
      evidence: 'Environment, namespace, cluster, context, or endpoint identifies production.',
    });
  }

  const broadScope = entries.some(entry => {
    if (Array.isArray(entry.value) && entry.value.length > 10) return true;
    if (!SCOPE_KEY.test(entry.path)) return false;
    const value = stringValue(entry.value).trim().toLowerCase();
    return value === '*' || value === 'all' || value === 'all-resources' || value === 'cluster-wide';
  });
  if (broadScope) {
    addFactor(factors, {
      id: 'broad-scope',
      label: 'Broad scope',
      category: 'scope',
      weight: 15,
      evidence: 'The action targets a wildcard, all resources, or a large explicit set.',
    });
  }

  const forced = entries.some(entry =>
    FORCE_KEY.test(entry.path) && (
      entry.value === true
      || ['true', 'yes', '1', 'force'].includes(stringValue(entry.value).toLowerCase())
    ));
  if (forced) {
    addFactor(factors, {
      id: 'safety-override',
      label: 'Safety override',
      category: 'policy',
      weight: 15,
      evidence: 'Force, override, bypass, recursive, or cascade behavior is enabled.',
    });
  }

  const sensitiveMaterial = entries.some(entry =>
    (SENSITIVE_KEY.test(entry.path) && entry.value != null && entry.value !== '')
    || SENSITIVE_VALUE.test(stringValue(entry.value)));
  if (sensitiveMaterial) {
    addFactor(factors, {
      id: 'sensitive-material',
      label: 'Sensitive material',
      category: 'data',
      weight: 15,
      evidence: 'A secret-bearing field or credential-shaped value is present; values are not retained in the assessment.',
    });
  }

  if (input.humanOversight) {
    addFactor(factors, {
      id: 'oversight-policy',
      label: 'Human oversight policy',
      category: 'policy',
      weight: 5,
      evidence: `${input.subjectType ?? 'runtime'} policy explicitly requires a human decision.`,
    });
  }

  const sortedFactors = [...factors.values()].sort((left, right) =>
    right.weight - left.weight || left.label.localeCompare(right.label));
  const score = Math.min(100, sortedFactors.reduce((total, factor) => total + factor.weight, 0));
  const level: RiskLevel = score >= 85 ? 'critical' : score >= 60 ? 'high' : 'medium';
  return {
    level,
    score,
    factors: sortedFactors,
    summary: `${level} risk (${score}/100): ${sortedFactors.map(factor => factor.label).join(', ')}`,
    model: 'argus-risk-v1',
  };
}
