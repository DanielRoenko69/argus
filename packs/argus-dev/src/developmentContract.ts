import { developmentOutcomeV2, type DevelopmentFinding } from './developmentDecisions.js';
/** Legacy runs retain the original contract; new runs explicitly opt into v2. */
export type DevelopmentOutcome = { status: 'ready' | 'blocked'; summary: string; blockers: string[]; findings?: DevelopmentFinding[] };
export const DEVELOPMENT_OUTCOME_INSTRUCTION = `Return only a JSON object: {"status":"ready"|"blocked","summary":"your plan, test design or implementation evidence","blockers":["specific missing prerequisite"]}. Use blocked if required scope, authorization or inputs are missing. Never invent permission, treat a blocker as permission to write, or change acceptance criteria to make tests pass. A blocked outcome requires at least one actionable blocker; ready requires none.`;

export function parseDevelopmentOutcome(output: string, version = 1): DevelopmentOutcome {
  const text = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (version === 2) {
    const value = developmentOutcomeV2.parse(JSON.parse(text));
    return { status: value.status, summary: value.summary, blockers: value.blockers.map(f => f.summary), findings: value.blockers };
  }
  const value = JSON.parse(text) as DevelopmentOutcome;
  if (!value || !['ready', 'blocked'].includes(value.status) || typeof value.summary !== 'string'
    || !value.summary.trim() || value.summary.length > 30_000 || !Array.isArray(value.blockers)
    || value.blockers.length > 12 || value.blockers.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000)
    || (value.status === 'blocked') !== (value.blockers.length > 0)) throw new Error('Invalid development outcome; no automatic implementation retry.');
  return { status: value.status, summary: value.summary, blockers: value.blockers };
}

export function parseFileScope(value: string): string[] {
  const paths = value.split(/[\n,]/).map(path => path.trim()).filter(Boolean);
  if (paths.length > 64 || paths.some(path => !/^[A-Za-z0-9_./-]+$/.test(path) || path.startsWith('/')
    || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))) {
    throw new Error('Use at most 64 exact repository-relative file paths, one per line (no globs or parent paths).');
  }
  return [...new Set(paths)];
}

export function missingHandoffPlaceholder(text: string): boolean {
  return /<[^>]*(?:hier|insert|paste)[^>]*(?:plan|handoff|übergabe|auftrag)[^>]*>/i.test(text);
}

export function validateRequirementsReply(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Requirements text is required, not an approval.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => key !== 'requirements') || typeof data.requirements !== 'string'
    || !data.requirements.trim() || data.requirements.length > 12_000) throw new Error('Supply 1–12000 characters of requirements; this is not a code approval.');
  return data.requirements.trim();
}

export function validateDevelopmentResume(requirementsStage: boolean, value: unknown): void {
  if (requirementsStage) { validateRequirementsReply(value); return; }
  if (value && typeof value === 'object' && 'requirements' in value) {
    throw new Error('Requirements cannot resume an approval or provider gate.');
  }
}

/** Infrastructure failures cannot be repaired by making the Coder change product code. */
export function testInfrastructureBlocker(output: string): string | null {
  if (/TOOLCHAIN_UNAVAILABLE|WORKSPACE_DIFF_CHECK_FAILED|Test runner error:|No module named pytest|command not found|pytest: not found/.test(output)) {
    return 'The test environment is unavailable. Correct the toolchain and explain the resolution before resuming; product code must not be changed to compensate.';
  }
  return null;
}
