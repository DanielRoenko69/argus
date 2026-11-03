import {
  safeVaultConfig,
  validateHydeConfig,
  validateK8sImpersonationConfig,
  validateOtelConfig,
  validateVaultConfig,
} from '../platformConfigValidation.js';

describe('platform configuration validation', () => {
  it('never exposes stored Vault credentials in the safe response', () => {
    expect(safeVaultConfig({
      type: 'hashicorp',
      hashicorpUrl: 'https://vault.internal',
      hashicorpToken: 'root-secret',
    })).toEqual(expect.objectContaining({
      hashicorpTokenConfigured: true,
      azureClientSecretConfigured: false,
    }));
    expect(safeVaultConfig({ type: 'hashicorp', hashicorpToken: 'root-secret' })).not.toHaveProperty('hashicorpToken');
  });

  it('preserves an existing Vault secret when the editor leaves it blank', () => {
    expect(validateVaultConfig({
      type: 'hashicorp',
      hashicorpUrl: 'https://vault.internal/',
      hashicorpMount: 'secret',
      mappings: { OPENAI_API_KEY: 'argus/openai' },
    }, {
      type: 'hashicorp',
      hashicorpToken: 'existing-token',
    })).toEqual(expect.objectContaining({
      hashicorpUrl: 'https://vault.internal',
      hashicorpToken: 'existing-token',
    }));
  });

  it('validates sampling, HyDE placeholders and custom impersonation headers', () => {
    expect(() => validateOtelConfig({ endpoint: '', sampling: 1.2, serviceName: 'argus', headers: {} })).toThrow('between 0 and 1');
    expect(() => validateHydeConfig({ model: 'gpt-4o-mini', maxTokens: 200, prompt: 'No placeholder' })).toThrow('{query}');
    expect(() => validateK8sImpersonationConfig({ enabled: true, userSource: 'custom', groupMap: {} })).toThrow('custom user header');
  });
});
