import { describe } from '@jest/globals';

/**
 * Integration suites that need a real PostgreSQL (CI provides one through
 * POSTGRES_CONNECTION_URL). Without it they are reported as skipped instead
 * of failing with connection errors on contributor machines.
 */
export const describeLiveDb: (name: string, fn: () => void) => void =
  process.env['POSTGRES_CONNECTION_URL'] ? describe : describe.skip;
