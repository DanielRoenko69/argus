import { jest, describe, it, expect } from '@jest/globals';

// Break the transitive langfuse / agentRunner chain that executeRoutes pulls in
jest.mock('../../agents/agentRunner.js', () => ({
  runAgentChatSync: jest.fn(),
}));
jest.mock('../../agents/skillStore.js', () => ({
  getSkill: jest.fn(),
}));
jest.mock('../../agents/memory.js', () => ({
  retrieveMemories: jest.fn(),
  storeMemory: jest.fn(),
}));
jest.mock('../../agents/ragClient.js', () => ({
  searchAzureAISearch: jest.fn(),
  searchQdrantRag: jest.fn(),
  formatRagContext: jest.fn(),
}));
jest.mock('../../agents/ragSearch.js', () => ({
  searchRagIndex: jest.fn(),
}));

import { credRefBundleDenied } from '../executeRoutes.js';
import type { RbacUser } from '../rbacHelpers.js';

describe('credRefBundleDenied — bundle-overlap rule for cred_ref', () => {
  const admin: RbacUser = { allowed_bundles: null };
  const dev:   RbacUser = { allowed_bundles: [7, 9] };

  it('admin may use any bundle', () => {
    expect(credRefBundleDenied(admin, { bundle_id: 42 })).toBe(false);
  });

  it('dev may use a bundle in allowed_bundles', () => {
    expect(credRefBundleDenied(dev, { bundle_id: 7 })).toBe(false);
  });

  it('dev may NOT use a bundle outside allowed_bundles', () => {
    expect(credRefBundleDenied(dev, { bundle_id: 42 })).toBe(true);
  });

  it('no bundle_id in cred_ref → not denied (backend_cred_id-only handled at resolve time)', () => {
    expect(credRefBundleDenied(dev, { backend_cred_id: 3 })).toBe(false);
    expect(credRefBundleDenied(dev, {})).toBe(false);
  });
});
