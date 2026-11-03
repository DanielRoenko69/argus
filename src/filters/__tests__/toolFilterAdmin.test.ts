import { normalizeToolFilterMutation, normalizeToolFilterTest } from '../toolFilterAdmin.js';

describe('runtime policy admin validation', () => {
  it('defaults new policies to enabled, fail-closed and signed when a secret is supplied', () => {
    expect(normalizeToolFilterMutation({
      name: 'prod_policy',
      webhookUrl: 'https://policy.example.test/decide',
      hmacSecret: 'shared-secret',
    }, true)).toMatchObject({
      name: 'prod_policy', enabled: true, onFailure: 'deny', timeoutMs: 3000,
      secretAction: 'replace', hmacSecret: 'shared-secret', toolPatterns: [],
    });
  });

  it('keeps the existing secret by default on update and rejects name changes', () => {
    expect(normalizeToolFilterMutation({ enabled: false }, false)).toEqual({
      enabled: false, secretAction: 'keep',
    });
    expect(() => normalizeToolFilterMutation({ name: 'renamed' }, false)).toThrow(/immutable/i);
  });

  it('rejects unsafe URLs, excessive wildcards and invalid limits', () => {
    expect(() => normalizeToolFilterMutation({ name: 'x', webhookUrl: 'http://169.254.169.254/latest' }, true)).toThrow(/URL nicht erlaubt/i);
    expect(() => normalizeToolFilterMutation({ name: 'x', webhookUrl: 'https://policy.example.test', toolPatterns: ['*********'] }, true)).toThrow(/at most 8/i);
    expect(() => normalizeToolFilterMutation({ name: 'x', webhookUrl: 'https://policy.example.test', timeoutMs: 99 }, true)).toThrow(/between 100/i);
  });

  it('bounds and validates policy dry-run payloads', () => {
    expect(normalizeToolFilterTest({ toolName: 'workspace_read_file', args: { path: 'README.md' } })).toEqual({
      toolName: 'workspace_read_file', args: { path: 'README.md' },
    });
    expect(() => normalizeToolFilterTest({ toolName: 'bad tool', args: {} })).toThrow(/unsupported/i);
    expect(() => normalizeToolFilterTest({ toolName: 'safe', args: [] })).toThrow(/JSON object/i);
  });
});
