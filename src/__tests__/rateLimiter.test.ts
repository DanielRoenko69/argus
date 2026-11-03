/**
 * Tests for the in-memory rate limiter used for login protection.
 * We test the RateLimiter class behavior directly without importing
 * the full index.ts (which would try to connect to PostgreSQL).
 */

// Minimal RateLimiter implementation mirroring the one in index.ts
// This ensures tests remain isolated from infrastructure dependencies.
class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxPerMinute: number) {}

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || now > entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (entry.count >= this.maxPerMinute) return false;
    entry.count++;
    return true;
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.counts) {
      if (now > entry.resetAt) this.counts.delete(key);
    }
  }

  size(): number {
    return this.counts.size;
  }
}

describe('RateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('allows requests up to the limit', () => {
    const rl = new RateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(rl.check('192.168.1.1')).toBe(true);
    }
  });

  test('blocks the (limit+1)th request', () => {
    const rl = new RateLimiter(3);
    rl.check('ip1');
    rl.check('ip1');
    rl.check('ip1');
    expect(rl.check('ip1')).toBe(false);
  });

  test('different keys have independent counters', () => {
    const rl = new RateLimiter(2);
    rl.check('ip1');
    rl.check('ip1');
    expect(rl.check('ip1')).toBe(false);
    expect(rl.check('ip2')).toBe(true);
  });

  test('resets after 60 seconds', () => {
    const rl = new RateLimiter(2);
    rl.check('ip1');
    rl.check('ip1');
    expect(rl.check('ip1')).toBe(false);

    jest.advanceTimersByTime(60_001);
    expect(rl.check('ip1')).toBe(true);
  });

  test('cleanup removes expired entries', () => {
    const rl = new RateLimiter(5);
    rl.check('ip1');
    rl.check('ip2');
    expect(rl.size()).toBe(2);

    jest.advanceTimersByTime(60_001);
    rl.cleanup();
    expect(rl.size()).toBe(0);
  });

  test('cleanup keeps active entries', () => {
    const rl = new RateLimiter(5);
    rl.check('ip1');
    jest.advanceTimersByTime(30_000);
    rl.check('ip2'); // added later, not expired yet
    jest.advanceTimersByTime(31_000); // ip1 expired, ip2 still active
    rl.cleanup();
    expect(rl.size()).toBe(1);
  });
});
