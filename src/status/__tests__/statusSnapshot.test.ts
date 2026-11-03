import { describe, expect, it, jest } from '@jest/globals';
import { createStatusSnapshotLoader } from '../statusSnapshot.js';

describe('createStatusSnapshotLoader', () => {
  it('shares a single in-flight health check and reuses its fresh result', async () => {
    let resolveStatus: ((value: { version: number }) => void) | undefined;
    const fetchStatus = jest.fn(() => new Promise<{ version: number }>(resolve => { resolveStatus = resolve; }));
    let clock = 1_000;
    const loader = createStatusSnapshotLoader(fetchStatus, 1_000, () => clock);

    const first = loader.load();
    const second = loader.load();
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    resolveStatus?.({ version: 1 });
    await expect(first).resolves.toEqual({ version: 1 });
    await expect(second).resolves.toEqual({ version: 1 });

    await expect(loader.load()).resolves.toEqual({ version: 1 });
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    clock += 1_001;
    const stale = loader.load();
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    await expect(stale).resolves.toEqual({ version: 1 });
    resolveStatus?.({ version: 2 });
    await Promise.resolve();
    await expect(loader.load()).resolves.toEqual({ version: 2 });
  });

  it('keeps serving the last successful snapshot when a background refresh fails', async () => {
    let clock = 1_000;
    const fetchStatus = jest.fn<() => Promise<{ version: number }>>()
      .mockResolvedValueOnce({ version: 1 })
      .mockRejectedValue(new Error('remote probe failed'));
    const loader = createStatusSnapshotLoader(fetchStatus, 1_000, () => clock);

    await expect(loader.load()).resolves.toEqual({ version: 1 });
    clock += 1_001;
    await expect(loader.load()).resolves.toEqual({ version: 1 });
    await Promise.resolve();
    await expect(loader.load()).resolves.toEqual({ version: 1 });
  });

  it('does not restore a stale in-flight result after invalidation', async () => {
    const pending: Array<(value: string) => void> = [];
    const fetchStatus = jest.fn(() => new Promise<string>(resolve => pending.push(resolve)));
    const loader = createStatusSnapshotLoader(fetchStatus);

    const stale = loader.load();
    loader.invalidate();
    const current = loader.load();
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    pending[0]?.('stale');
    pending[1]?.('current');
    await expect(stale).resolves.toBe('stale');
    await expect(current).resolves.toBe('current');
    await expect(loader.load()).resolves.toBe('current');
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });
});
