import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/dom';

// Large page-level integration tests lazy-load routes and resolve several
// independent queries. Leave enough headroom for resource-constrained local
// machines and CI workers without weakening any functional assertion.
configure({ asyncUtilTimeout: 5_000 });
