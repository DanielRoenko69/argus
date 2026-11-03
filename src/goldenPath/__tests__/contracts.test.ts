import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GOLDEN_PATH_STAGE_IDS,
  goldenPathPreflightSchema,
  goldenPathRunSchema,
  type GoldenPathPreflight,
  type GoldenPathRun,
} from '../contracts.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/golden-path',
  name,
), 'utf8'));

const clone = <T>(value: T): T => structuredClone(value);

function sensitiveKeys(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => sensitiveKeys(item, `${path}[${index}]`));
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const current = `${path}.${key}`;
    const matches = /^(?:token|secret|password|authorization|apiKey|privateKey)$/i.test(key) ? [current] : [];
    return [...matches, ...sensitiveKeys(item, current)];
  });
}

describe('Golden Path v1 contracts', () => {
  const ready = (): GoldenPathPreflight => goldenPathPreflightSchema.parse(
    fixture('preflight-ready.v1.fixture.json'),
  );
  const waiting = (): GoldenPathRun => goldenPathRunSchema.parse(
    fixture('run-awaiting-approval.v1.fixture.json'),
  );

  it('keeps all Console-facing fixtures executable', () => {
    expect(ready()).toMatchObject({ mode: 'certification', state: 'ready' });
    expect(goldenPathPreflightSchema.parse(fixture('preflight-blocked.v1.fixture.json')))
      .toMatchObject({ mode: 'live_demo', state: 'blocked' });
    expect(waiting()).toMatchObject({ status: 'waiting_for_approval', approval: { state: 'pending' } });
    expect(goldenPathRunSchema.parse(fixture('run-completed.v1.fixture.json')))
      .toMatchObject({ status: 'completed', evidence: { state: 'complete', offlineVerifiable: true } });
  });

  it('keeps stages canonical and every stage reference resolvable', () => {
    const run = waiting();
    const refs = new Set(run.resourceRefs.map(ref => ref.refId));
    expect(run.stages.map(stage => stage.id)).toEqual(GOLDEN_PATH_STAGE_IDS);
    expect(run.stages.flatMap(stage => stage.resourceRefIds).every(ref => refs.has(ref))).toBe(true);
  });

  it('derives blocked preflight state from required checks', () => {
    const changed = clone(ready());
    changed.checks.find(check => check.id === 'runtime')!.state = 'blocked';
    expect(goldenPathPreflightSchema.safeParse(changed)).toMatchObject({ success: false });
    changed.state = 'blocked';
    expect(goldenPathPreflightSchema.safeParse(changed)).toMatchObject({ success: true });
  });

  it('keeps certification and live providers explicit instead of silently mocking', () => {
    const changed = clone(ready());
    changed.targets.git.provider = 'github';
    expect(goldenPathPreflightSchema.safeParse(changed)).toMatchObject({ success: false });
  });

  it('rejects inconsistent approval and write-policy state', () => {
    const changed = clone(waiting());
    changed.policy = {
      writeMode: 'read_only',
      approvalRequired: false,
      separationOfDutiesRequired: false,
      policySha256: 'f'.repeat(64),
      writes: [],
    };
    expect(goldenPathRunSchema.safeParse(changed)).toMatchObject({ success: false });
  });

  it('rejects unknown stage resource references and duplicate refs', () => {
    const changed = clone(waiting());
    changed.stages[0]!.resourceRefIds.push('missing-ref');
    changed.resourceRefs.push(clone(changed.resourceRefs[0]!));
    expect(goldenPathRunSchema.safeParse(changed)).toMatchObject({ success: false });
  });

  it('keeps fixture contracts free of raw credential-shaped keys', () => {
    const names = [
      'preflight-ready.v1.fixture.json',
      'preflight-blocked.v1.fixture.json',
      'run-awaiting-approval.v1.fixture.json',
      'run-completed.v1.fixture.json',
    ];
    expect(names.flatMap(name => sensitiveKeys(fixture(name)))).toEqual([]);
  });
});
