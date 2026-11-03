import { describe, expect, it } from '@jest/globals';
import { issueNumber, issueSnapshot, parseIssueToolResponse } from '../repositoryIssue.js';
const target = { repository: 'team/repo', gitOrigin: 'http://gitea:3000', publicBase: 'http://localhost:3005', backendId: 7, toolName: 'gitea_demo_get_issue' };
const raw = { number: 42, title: 'Vectorized solver', body: 'Acceptance criteria', state: 'open', updated_at: '2026-09-27T12:00:00Z', html_url: 'http://localhost:3005/team/repo/issues/42' };
describe('repository issue identity and snapshot', () => {
  it('accepts the real custom-backend HTTP 200 envelope, rejects errors and truncation', () => {
    for (const text of [JSON.stringify(raw), `HTTP 200 OK\n\n${JSON.stringify(raw)}`]) {
      expect(parseIssueToolResponse({ content: [{ text }] })).toEqual(raw);
    }
    for (const text of ['HTTP 404 Not Found\n\n{}', 'HTTP 200 OK\n\n{"truncated":', 'x'.repeat(128_001)]) {
      expect(() => parseIssueToolResponse({ content: [{ text }] })).toThrow();
    }
    expect(() => parseIssueToolResponse({ isError: true, content: [{ text: '{}' }] })).toThrow();
    expect(() => parseIssueToolResponse({ isError: true, content: [{ text: '[hook:user-policy-gate] default-deny' }] })).toThrow(/blocked by tool policy/);
  });
  it.each(['42', '#42', raw.html_url, 'http://gitea:3000/team/repo/issues/42', `${raw.html_url}#issuecomment-3`])('accepts identifiers, never fetches the pasted URL: %s', ref => {
    expect(issueNumber(ref, target)).toBe(42);
  });
  it.each(['0', '-1', '1e3', '1/../42', 'http://evil/team/repo/issues/42', 'http://localhost:3005/other/repo/issues/42',
    'http://localhost:3005/team/repo/pulls/42', 'http://localhost:3005/team/repo/issues/42?token=secret',
    'http://x:y@localhost:3005/team/repo/issues/42', 'http://localhost:3005/team/repo/issues/%34%32',
    'file:///team/repo/issues/42', 'http://localhost:3005/team/repo/issues/42/extra'])('rejects ambiguous or out-of-scope references: %s', ref => {
    expect(() => issueNumber(ref, target)).toThrow();
  });
  it('hashes normalized redacted content and version, not fetch time', () => {
    const first = issueSnapshot(raw, target, 42, x => x.replace('criteria', '[redacted]'));
    expect(first.body).toBe('Acceptance [redacted]');
    expect(first.sha256).toBe(issueSnapshot(raw, target, 42, x => x.replace('criteria', '[redacted]')).sha256);
    expect(first.sha256).not.toBe(issueSnapshot({ ...raw, updated_at: '2026-09-27T13:00:00Z' }, target, 42, x => x).sha256);
    expect(first.url).toBe(raw.html_url);
  });
  it.each([{ number: 99 }, { pull_request: {} }, { body: 'x'.repeat(40_001) }, { title: '' }, { body: {} },
    { updated_at: 'invalid' }, { html_url: 'http://localhost:3005/other/repo/issues/42' }])('rejects malformed, wrong-repository and oversized provider data', delta => {
    expect(() => issueSnapshot({ ...raw, ...delta }, target, 42, x => x)).toThrow();
  });
});
