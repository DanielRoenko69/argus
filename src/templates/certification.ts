import type { ServiceTemplate, TemplateToolDefinition } from './serviceTemplates.js';

export type ToolContractStatus = 'certified' | 'failed';

export interface ToolContractFinding {
  code: string;
  message: string;
}

export interface CertifiedTemplateTool {
  templateId: string;
  toolName: string;
  status: ToolContractStatus;
  findings: ToolContractFinding[];
}

const TOKEN_PATTERN = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

function tokens(value: string): string[] {
  return [...value.matchAll(TOKEN_PATTERN)].map(match => match[1]!);
}

function certifyTool(template: ServiceTemplate, tool: TemplateToolDefinition): CertifiedTemplateTool {
  const findings: ToolContractFinding[] = [];
  const [method = '', target = ''] = tool.queryTemplate.trim().split(/\s+/, 2);
  const databaseContract = tool.backend === 'postgresql';
  const parameters = new Map(tool.parameters.map(parameter => [parameter.name, parameter]));
  const fields = new Set(template.fields.map(field => field.name));
  const availableTokens = new Set(['prefix', ...fields, ...parameters.keys()]);

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(tool.nameSuffix)) {
    findings.push({ code: 'invalid_name', message: 'Tool suffix must be a stable lowercase identifier.' });
  }
  if (!tool.description.trim()) {
    findings.push({ code: 'missing_description', message: 'Tool description is required.' });
  }
  if (databaseContract) {
    if (!tool.queryTemplate.trim()) {
      findings.push({ code: 'invalid_query', message: 'Database tool query must not be empty.' });
    }
  } else {
    if (!METHODS.has(method.toUpperCase())) {
      findings.push({ code: 'invalid_method', message: `Unsupported HTTP method “${method || 'missing'}”.` });
    }
    if (!target.startsWith('/')) {
      findings.push({ code: 'invalid_target', message: 'Tool target must be relative to the governed connection.' });
    }
  }

  const unknownTokens = tokens(tool.queryTemplate).filter(token => !availableTokens.has(token));
  for (const token of new Set(unknownTokens)) {
    findings.push({ code: 'unknown_token', message: `Template token “${token}” has no field or tool parameter.` });
  }

  const duplicateParameters = tool.parameters
    .map(parameter => parameter.name)
    .filter((name, index, values) => values.indexOf(name) !== index);
  for (const name of new Set(duplicateParameters)) {
    findings.push({ code: 'duplicate_parameter', message: `Parameter “${name}” is declared more than once.` });
  }

  for (const parameter of tool.parameters) {
    if (!/^[a-z][a-z0-9_]*$/.test(parameter.name)) {
      findings.push({ code: 'invalid_parameter', message: `Parameter “${parameter.name}” is not a stable identifier.` });
    }
    if (!parameter.description.trim()) {
      findings.push({ code: 'missing_parameter_description', message: `Parameter “${parameter.name}” needs a description.` });
    }
    if (parameter.required && !tokens(tool.queryTemplate).includes(parameter.name)) {
      findings.push({ code: 'unused_required_parameter', message: `Required parameter “${parameter.name}” is not used by the request.` });
    }
  }

  return {
    templateId: template.id,
    toolName: `${template.id}_${tool.nameSuffix}`,
    status: findings.length === 0 ? 'certified' : 'failed',
    findings,
  };
}

/**
 * Deterministic contract gate for every native connector tool. It validates
 * names, request shape and interpolation before a connector can reach live
 * smoke certification with provider credentials.
 */
export function certifyServiceTemplateTools(templates: readonly ServiceTemplate[]): CertifiedTemplateTool[] {
  return templates.flatMap(template => template.tools.map(tool => certifyTool(template, tool)));
}
