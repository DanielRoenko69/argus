import { CanaryConfigurationError, normalizeCanaryConfig, normalizeCanaryRunAgentIds } from '../canaries.js';

describe('native synthetic Canary input', () => {
  it('normalizes an exact bounded runtime configuration', () => {
    expect(normalizeCanaryConfig({
      enabled: true,
      intervalMinutes: 15,
      timeoutSeconds: 45,
      retentionDays: 30,
      agentIds: [7, 3, 7],
    })).toEqual({
      enabled: true,
      intervalMinutes: 15,
      timeoutSeconds: 45,
      retentionDays: 30,
      agentIds: [7, 3],
    });
  });

  it.each([
    [{ enabled: 'true', intervalMinutes: 15, timeoutSeconds: 30, retentionDays: 30, agentIds: [] }, 'enabled'],
    [{ enabled: true, intervalMinutes: 4, timeoutSeconds: 30, retentionDays: 30, agentIds: [] }, 'intervalMinutes'],
    [{ enabled: true, intervalMinutes: 15, timeoutSeconds: 121, retentionDays: 30, agentIds: [] }, 'timeoutSeconds'],
    [{ enabled: true, intervalMinutes: 15, timeoutSeconds: 30, retentionDays: 0, agentIds: [] }, 'retentionDays'],
    [{ enabled: true, intervalMinutes: 15, timeoutSeconds: 30, retentionDays: 30, agentIds: ['7'] }, 'Agent ID'],
  ])('rejects unsafe or ambiguous configuration %#', (input, message) => {
    expect(() => normalizeCanaryConfig(input)).toThrow(message as string);
  });

  it('validates and de-duplicates optional manual targets', () => {
    expect(normalizeCanaryRunAgentIds(undefined)).toBeUndefined();
    expect(normalizeCanaryRunAgentIds([8, 3, 8])).toEqual([8, 3]);
    expect(() => normalizeCanaryRunAgentIds([0])).toThrow(CanaryConfigurationError);
    expect(() => normalizeCanaryRunAgentIds(['8'])).toThrow('Agent ID');
  });
});
