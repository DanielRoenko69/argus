jest.mock('../../../filters/toolFilters.js', () => ({ runFilters: jest.fn() }));

import { runFilters } from '../../../filters/toolFilters.js';
import { externalPolicyFilter } from '../builtin/externalPolicyFilter.js';
import type { HookContext } from '../types.js';

const mockRun = runFilters as jest.MockedFunction<typeof runFilters>;
const context: HookContext = {
  agentId: 0,
  agentName: 'workflow',
  sessionId: 'run-42',
  toolName: 'terraform_plan',
  toolArgs: { workspace: 'prod' },
  iteration: 1,
  agentDepth: 0,
  apiKeyPrefix: 'argus_e2e',
};

describe('external policy hook', () => {
  afterEach(() => jest.clearAllMocks());

  it('threads safe identity context and maps a denial to a hook block', async () => {
    mockRun.mockResolvedValue({ allowed: false, reason: 'maintenance freeze' });
    await expect(externalPolicyFilter.preToolUse!(context)).resolves.toEqual({ block: 'maintenance freeze' });
    expect(mockRun).toHaveBeenCalledWith('terraform_plan', context.toolArgs, {
      apiKeyPrefix: 'argus_e2e', sessionId: 'run-42',
    });
  });

  it('returns only actual argument transformations', async () => {
    mockRun.mockResolvedValueOnce({ allowed: true, args: context.toolArgs });
    await expect(externalPolicyFilter.preToolUse!(context)).resolves.toBeNull();
    mockRun.mockResolvedValueOnce({ allowed: true, args: { workspace: 'staging' } });
    await expect(externalPolicyFilter.preToolUse!(context)).resolves.toEqual({ modify: { workspace: 'staging' } });
  });
});
