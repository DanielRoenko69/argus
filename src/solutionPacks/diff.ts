import type { SolutionPackManifest } from './manifest.js';

export interface SolutionPackManifestChange {
  path: string;
  before: unknown;
  after: unknown;
  kind: 'added' | 'removed' | 'changed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function collectChanges(before: unknown, after: unknown, path: string, changes: SolutionPackManifestChange[]): void {
  if (Object.is(before, after)) return;
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const child = path ? `${path}.${key}` : key;
      collectChanges(before[key], after[key], child, changes);
    }
    return;
  }
  if (before === undefined) {
    changes.push({ path, before: null, after, kind: 'added' });
  } else if (after === undefined) {
    changes.push({ path, before, after: null, kind: 'removed' });
  } else {
    changes.push({ path, before, after, kind: 'changed' });
  }
}

export function diffSolutionPackManifests(
  previous: SolutionPackManifest | undefined,
  current: SolutionPackManifest | undefined,
): SolutionPackManifestChange[] {
  if (!previous && !current) return [];
  const changes: SolutionPackManifestChange[] = [];
  collectChanges(previous ?? undefined, current ?? undefined, '', changes);
  return changes.slice(0, 500);
}
