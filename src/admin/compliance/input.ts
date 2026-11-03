export interface ComplianceRunInput {
  frameworkId: number;
  target: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Compliance targets are human-readable scope identifiers, never commands.
 * Keeping them single-line also prevents the target from escaping its data
 * boundary inside the auditor prompt.
 */
export function normalizeComplianceTarget(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Audit scope is required');
  const target = value.trim();
  if (!target) throw new Error('Audit scope is required');
  if (target.length > 512) throw new Error('Audit scope must not exceed 512 characters');
  if (CONTROL_CHARACTERS.test(target)) throw new Error('Audit scope must be a single printable line');
  return target;
}

export function normalizeComplianceRunInput(value: unknown): ComplianceRunInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Compliance run data is required');
  }
  const body = value as Record<string, unknown>;
  const frameworkId = Number(body['frameworkId'] ?? body['framework_id']);
  if (!Number.isSafeInteger(frameworkId) || frameworkId < 1) {
    throw new Error('A valid framework is required');
  }
  return { frameworkId, target: normalizeComplianceTarget(body['target']) };
}

export function parseComplianceRunId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
