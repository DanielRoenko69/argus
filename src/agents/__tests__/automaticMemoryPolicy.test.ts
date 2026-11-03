import { describe, expect, it } from '@jest/globals';
import { isAutomaticAgentMemoryEnabled } from '../memory.js';

describe('automatic Agent Memory policy', () => {
  it('is fail-closed when no independent embedding capability was enabled', () => {
    expect(isAutomaticAgentMemoryEnabled({})).toBe(false);
  });

  it('does not treat unrelated provider configuration as an opt-in', () => {
    expect(isAutomaticAgentMemoryEnabled({
      OPENAI_BASE_URL: 'http://litellm:4000/v1',
      OPENAI_API_KEY: 'configured-but-unrelated',
      EMBEDDING_MODEL: 'argus-local-embedding',
    })).toBe(false);
  });

  it('enables automatic retrieval and extraction only through the explicit switch', () => {
    expect(isAutomaticAgentMemoryEnabled({
      ARGUS_AGENT_MEMORY_AUTO_ENABLED: 'true',
    })).toBe(true);
    expect(isAutomaticAgentMemoryEnabled({
      ARGUS_AGENT_MEMORY_AUTO_ENABLED: 'TRUE',
    })).toBe(false);
  });
});
