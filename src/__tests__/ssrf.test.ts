import { assertSsrfSafe } from '../backends/customBackends.js';

describe('assertSsrfSafe — SSRF denylist', () => {
  // ── Blocked: private/internal addresses ──────────────────────
  const blocked = [
    'http://localhost/api',
    'http://localhost:3000/mcp',
    'https://localhost:443/',
    'http://127.0.0.1/admin',
    'http://127.0.0.1:8080/',
    'http://0.0.0.0/anything',
    'http://10.0.0.1/internal',
    'http://10.255.255.255/secret',
    'http://172.16.0.1/internal',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://192.168.100.200/api',
    'http://169.254.169.254/latest/meta-data/',  // AWS metadata
    'http://169.254.0.1/',
    'http://[::1]/admin',
    'http://[::1]:8080/',
    'http://[fc00::1]/internal',
    'http://kubernetes.default/api',
    'http://kubernetes.default.svc/api',
    'http://kubernetes.default.svc.cluster.local/api',
  ];

  test.each(blocked)('blocks %s', (url) => {
    expect(() => assertSsrfSafe(url)).toThrow('URL nicht erlaubt');
  });

  // ── Allowed: public addresses ─────────────────────────────────
  const allowed = [
    'https://api.github.com/repos',
    'https://registry.npmjs.org/-/ping',
    'http://203.0.113.10:8080/api',   // TEST-NET-3, routable
    'https://example.com/webhook',
    'http://8.8.8.8/health',
  ];

  test.each(allowed)('allows %s', (url) => {
    expect(() => assertSsrfSafe(url)).not.toThrow();
  });
});
