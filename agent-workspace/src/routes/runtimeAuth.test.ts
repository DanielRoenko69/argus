import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRuntimeAuthCode, parseRuntimeAuthOutput } from './runtimeAuth.js';

describe('runtime authentication output boundary', () => {
  it('extracts only the official Codex device URL and one-time display code', () => {
    const parsed = parseRuntimeAuthOutput('codex', [
      'Ignore https://evil.example/codex/device',
      '\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
      'Enter this one-time code: ABCD-12345',
    ].join('\n'));

    assert.equal(parsed.verificationUri, 'https://auth.openai.com/codex/device');
    assert.equal(parsed.userCode, 'ABCD-12345');
  });

  it('retains the allowlisted Claude OAuth URL without exposing raw output', () => {
    const uri = 'https://claude.com/cai/oauth/authorize?code=true&state=opaque-state';
    const parsed = parseRuntimeAuthOutput('claude-code', `If the browser did not open, visit: ${uri}\nPaste code here >`);

    assert.equal(parsed.verificationUri, uri);
    assert.equal(parsed.userCode, null);
  });

  it('does not accept provider URLs on an untrusted host or non-HTTPS scheme', () => {
    assert.equal(parseRuntimeAuthOutput('codex', 'https://example.com/codex/device').verificationUri, null);
    assert.equal(parseRuntimeAuthOutput('claude-code', 'http://claude.com/cai/oauth/authorize').verificationUri, null);
  });

  it('accepts one bounded printable callback code and rejects control characters', () => {
    assert.equal(normalizeRuntimeAuthCode('  callback-code#123  '), 'callback-code#123');
    assert.equal(normalizeRuntimeAuthCode('bad\ncode'), null);
    assert.equal(normalizeRuntimeAuthCode('abc'), null);
    assert.equal(normalizeRuntimeAuthCode('x'.repeat(4097)), null);
  });
});

