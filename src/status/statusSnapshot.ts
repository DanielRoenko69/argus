/**
 * Shares a short-lived status snapshot between Console requests. Health checks
 * may contact several external systems, so concurrent page loads must not each
 * initiate their own full probe cycle.
 */
export interface StatusSnapshotLoader<T> {
  load(): Promise<T>;
  warm(): void;
  invalidate(): void;
}

export function createStatusSnapshotLoader<T>(
  fetchStatus: () => Promise<T>,
  maxAgeMs = 15_000,
  now: () => number = () => Date.now(),
): StatusSnapshotLoader<T> {
  let cached: T | undefined;
  let cachedAt = 0;
  let inFlight: Promise<T> | null = null;
  let generation = 0;

  const isFresh = () => cached !== undefined && now() - cachedAt < maxAgeMs;

  const refresh = (): Promise<T> => {
    if (inFlight) return inFlight;

    const fetchGeneration = generation;
    let pending: Promise<T>;
    try {
      pending = fetchStatus();
    } catch (error) {
      pending = Promise.reject(error);
    }
    inFlight = pending;
    void pending.then(
      value => {
        if (generation === fetchGeneration) {
          cached = value;
          cachedAt = now();
        }
        if (inFlight === pending) inFlight = null;
      },
      () => {
        if (inFlight === pending) inFlight = null;
      },
    );
    return pending;
  };

  return {
    load: () => {
      if (isFresh()) return Promise.resolve(cached as T);

      // Health snapshots may probe several remote systems. Once a successful
      // snapshot exists, never make a page request wait for that remote I/O:
      // return the last known state and refresh it in the background instead.
      // Explicit invalidation still clears the snapshot, so callers that just
      // changed connection state wait for the following authoritative probe.
      if (cached !== undefined) {
        void refresh().catch(() => undefined);
        return Promise.resolve(cached);
      }

      return refresh();
    },
    warm: () => { void refresh().catch(() => undefined); },
    invalidate: () => {
      generation += 1;
      cached = undefined;
      cachedAt = 0;
      inFlight = null;
    },
  };
}
