const tsJestTransformer = require.resolve('ts-jest');

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [tsJestTransformer, {
      tsconfig: 'tsconfig.test.json',
      diagnostics: {
        // MCP SDK causes TS2589 (type instantiation too deep) — suppress for tests
        ignoreCodes: ['TS2589'],
      },
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/__tests__/**',
    '!src/index.ts',
    '!src/server/mcpServer.ts',
    '!src/tools/prompts/index.ts',
  ],
  coverageReporters: ['text', 'lcov', 'clover'],
  coverageDirectory: 'coverage',
  moduleNameMapper: {
    // Strip .js extensions for CommonJS resolution in tests
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
