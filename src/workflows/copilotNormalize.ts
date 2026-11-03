/** Canvas block shape shared by Copilot generation and its normalizer. */
export interface CopilotBlock {
  id?: string;
  type: string;
  position?: { x: number; y: number };
  data: Record<string, unknown>;
}

/** Metadata stays flat; every other generated field belongs in data.args. */
const RESERVED_DATA_KEYS = new Set([
  'label',
  'tool',
  'agent_id',
  'agent_role',
  'skill_id',
  'condition',
  'on_error',
  'operation',
  'cron_expr',
  'webhook_path',
  'webhook_secret_env',
  'schedule_static_inputs',
  'index_name',
  'function_code',
  'cred_ref',
  'integration_id',
  'tool_binding',
  'args',
]);

/** Normalize Copilot output to the canvas shape consumed by the serializer. */
export function normalizeNodeArgs(block: CopilotBlock): CopilotBlock {
  if (!block.data || typeof block.data !== 'object') return block;

  const data = block.data as Record<string, unknown>;
  const existingArgs = data['args'] !== null
    && typeof data['args'] === 'object'
    && !Array.isArray(data['args'])
    ? { ...(data['args'] as Record<string, unknown>) }
    : {};

  // Older prompts told the model to put every "argument" below data.args,
  // which occasionally included the Agent binding itself. Agent bindings are
  // step metadata, not runtime prompt args. Repair that shape here so the
  // validator, canvas serializer and executor all observe the same contract.
  const promotedAgentMetadata: Record<string, unknown> = {};
  if (block.type === 'argus.agent') {
    const nestedRole = existingArgs['agent_role'];
    const nestedId = existingArgs['agent_id'];
    if (data['agent_role'] === undefined && typeof nestedRole === 'string' && nestedRole.trim()) {
      promotedAgentMetadata['agent_role'] = nestedRole.trim().toLowerCase();
    }
    if (data['agent_id'] === undefined && typeof nestedId === 'number' && Number.isSafeInteger(nestedId) && nestedId > 0) {
      promotedAgentMetadata['agent_id'] = nestedId;
    }
    delete existingArgs['agent_role'];
    delete existingArgs['agent_id'];
  }

  const flatArgs: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (!RESERVED_DATA_KEYS.has(key)) flatArgs[key] = data[key];
  }
  if (Object.keys(flatArgs).length === 0 && Object.keys(promotedAgentMetadata).length === 0) return block;

  const normalizedData: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (RESERVED_DATA_KEYS.has(key) && key !== 'args') normalizedData[key] = data[key];
  }
  Object.assign(normalizedData, promotedAgentMetadata);
  // Explicit nested args are canonical on conflicts.
  normalizedData['args'] = { ...flatArgs, ...existingArgs };
  return { ...block, data: normalizedData };
}
