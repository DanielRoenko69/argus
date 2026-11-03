// Vitest global setup — extends expect() with jest-dom matchers and
// installs a jsdom-compatible matchMedia stub used by some Radix components.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
