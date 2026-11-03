import { describe, expect, it, jest } from '@jest/globals';
import {
  attachSolutionPackTokenFiles,
  discoverSolutionPack,
  isCoreVersionCompatible,
  normalizeSolutionPackEndpoint,
  parseSolutionPackEndpoints,
  SOLUTION_PACK_MANIFEST_PATH,
  SolutionPackEndpointConfigError,
  SolutionPackRegistry,
} from '../discovery.js';

function manifest(id = 'argus.dev', core = '>=1.0.0'): string {
  return JSON.stringify({
    apiVersion: 'argus.eu/v1alpha1',
    kind: 'SolutionPack',
    metadata: { id, version: '0.1.0', displayName: 'Argus Dev' },
    spec: {
      delivery: { type: 'container', protocol: 'argus-pack-v1alpha1' },
      requires: { core },
      components: {},
      readiness: { smokeTests: ['pack-health'] },
    },
  });
}

describe('Solution Pack endpoint configuration', () => {
  it('parses operator-controlled Compose and HTTPS endpoints deterministically', () => {
    expect(parseSolutionPackEndpoints(
      'argus.dev=http://argus-dev:8080, argus.aiops=https://packs.example.test',
    )).toEqual([
      { packId: 'argus.dev', endpoint: 'http://argus-dev:8080' },
      { packId: 'argus.aiops', endpoint: 'https://packs.example.test' },
    ]);
  });

  it('rejects credentials, public plain HTTP, metadata targets, paths and duplicate ids', () => {
    expect(() => normalizeSolutionPackEndpoint('http://user:pass@argus-dev:8080')).toThrow('credentials');
    expect(() => normalizeSolutionPackEndpoint('http://packs.example.test')).toThrow('plain HTTP');
    expect(() => normalizeSolutionPackEndpoint('http://169.254.169.254')).toThrow('forbidden infrastructure');
    expect(() => normalizeSolutionPackEndpoint('https://packs.example.test/admin')).toThrow('must not contain a path');
    expect(() => parseSolutionPackEndpoints('argus.dev=http://dev:1,argus.dev=http://dev:2'))
      .toThrow("duplicate solution pack id 'argus.dev'");
  });

  it('attaches only absolute token files for configured packs', () => {
    const endpoints = parseSolutionPackEndpoints('argus.dev=http://argus-dev:8080');
    expect(attachSolutionPackTokenFiles(endpoints, 'argus.dev=/run/secrets/dev-token'))
      .toEqual([{ packId: 'argus.dev', endpoint: 'http://argus-dev:8080', tokenFile: '/run/secrets/dev-token' }]);
    expect(() => attachSolutionPackTokenFiles(endpoints, 'argus.dev=relative-token'))
      .toThrow(SolutionPackEndpointConfigError);
    expect(() => attachSolutionPackTokenFiles(endpoints, 'argus.aiops=/run/secrets/token'))
      .toThrow('unknown solution pack');
  });

  it('supports the explicit v1alpha1 exact/minimum Core compatibility contract', () => {
    expect(isCoreVersionCompatible('>=1.0.0', '1.2.0')).toBe(true);
    expect(isCoreVersionCompatible('>=1.2.0', '1.1.9')).toBe(false);
    expect(isCoreVersionCompatible('1.2.0', '1.2.0')).toBe(true);
    expect(isCoreVersionCompatible('1.2.0', '1.2.1')).toBe(false);
    expect(isCoreVersionCompatible('>=1.0.0', 'development')).toBe(false);
  });
});

describe('Solution Pack discovery', () => {
  it('loads an authenticated manifest and certifies health plus readiness', async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      requests.push({ url, authorization: headers?.authorization });
      if (url.endsWith(SOLUTION_PACK_MANIFEST_PATH)) return new Response(manifest(), { status: 200 });
      return new Response('', { status: 200 });
    };

    const result = await discoverSolutionPack({
      packId: 'argus.dev',
      endpoint: 'http://argus-dev:8080',
      tokenFile: '/run/secrets/dev-token',
    }, {
      coreVersion: '1.0.0',
      fetchFn,
      readTokenFile: async () => 'secret-token',
    });

    expect(result.state).toBe('ready');
    expect(result.manifest?.metadata.id).toBe('argus.dev');
    expect(result.health?.ok).toBe(true);
    expect(result.readiness?.ok).toBe(true);
    expect(requests.map(request => request.url)).toEqual([
      'http://argus-dev:8080/.well-known/argus-solution-pack.yaml',
      'http://argus-dev:8080/healthz',
      'http://argus-dev:8080/readyz',
    ]);
    expect(requests.every(request => request.authorization === 'Bearer secret-token')).toBe(true);
  });

  it('fails closed on identity or Core incompatibility before probing service paths', async () => {
    const fetchFn = jest.fn<typeof fetch>(async () => new Response(manifest('argus.other'), { status: 200 }));
    const mismatch = await discoverSolutionPack(
      { packId: 'argus.dev', endpoint: 'http://argus-dev:8080' },
      { coreVersion: '1.0.0', fetchFn },
    );
    expect(mismatch.state).toBe('incompatible');
    expect(mismatch.error).toContain('does not match configured id');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const incompatibleFetch = jest.fn<typeof fetch>(async () => new Response(manifest('argus.dev', '>=2.0.0'), { status: 200 }));
    const incompatible = await discoverSolutionPack(
      { packId: 'argus.dev', endpoint: 'http://argus-dev:8080' },
      { coreVersion: '1.9.0', fetchFn: incompatibleFetch },
    );
    expect(incompatible.state).toBe('incompatible');
    expect(incompatible.error).toContain('requires Core >=2.0.0');
    expect(incompatibleFetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes invalid manifests, unavailable credentials and degraded readiness', async () => {
    const invalid = await discoverSolutionPack(
      { packId: 'argus.dev', endpoint: 'http://argus-dev:8080' },
      { coreVersion: '1.0.0', fetchFn: async () => new Response('{broken', { status: 200 }) },
    );
    expect(invalid.state).toBe('invalid');

    const credentialFailure = await discoverSolutionPack(
      { packId: 'argus.dev', endpoint: 'http://argus-dev:8080', tokenFile: '/missing' },
      { coreVersion: '1.0.0', readTokenFile: async () => { throw new Error('not mounted'); } },
    );
    expect(credentialFailure.state).toBe('unreachable');
    expect(credentialFailure.error).toContain('service credential unavailable');

    const degraded = await discoverSolutionPack(
      { packId: 'argus.dev', endpoint: 'http://argus-dev:8080' },
      {
        coreVersion: '1.0.0',
        fetchFn: async input => {
          const url = String(input);
          if (url.endsWith(SOLUTION_PACK_MANIFEST_PATH)) return new Response(manifest(), { status: 200 });
          return new Response('', { status: url.endsWith('/readyz') ? 503 : 200 });
        },
      },
    );
    expect(degraded.state).toBe('degraded');
    expect(degraded.health?.ok).toBe(true);
    expect(degraded.readiness?.status).toBe(503);
  });

  it('keeps a sorted not-checked registry and coalesces concurrent refreshes', async () => {
    let releaseManifest: (() => void) | undefined;
    const manifestGate = new Promise<void>(resolve => { releaseManifest = resolve; });
    const fetchFn = jest.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith(SOLUTION_PACK_MANIFEST_PATH)) await manifestGate;
      return url.endsWith(SOLUTION_PACK_MANIFEST_PATH)
        ? new Response(manifest(), { status: 200 })
        : new Response('', { status: 200 });
    });
    const registry = new SolutionPackRegistry(
      [{ packId: 'argus.dev', endpoint: 'http://argus-dev:8080' }],
      { coreVersion: '1.0.0', fetchFn },
    );
    expect(registry.list()[0]?.state).toBe('not_checked');

    const first = registry.refresh();
    const second = registry.refresh();
    expect(first).toBe(second);
    releaseManifest?.();
    await expect(first).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ state: 'ready' })]));
  });

  it('refreshes one runtime Pack immediately and coalesces concurrent request-time probes', async () => {
    let online = true;
    const fetchFn = jest.fn<typeof fetch>(async input => {
      if (!online) throw new Error('connector offline');
      return String(input).endsWith(SOLUTION_PACK_MANIFEST_PATH)
        ? new Response(manifest('argus.hermes'), { status: 200 })
        : new Response('', { status: 200 });
    });
    const registry = new SolutionPackRegistry(
      [{ packId: 'argus.hermes', endpoint: 'http://argus-hermes:2040' }],
      { coreVersion: '1.0.0', fetchFn },
    );
    await registry.refresh();
    expect(registry.get('argus.hermes')?.state).toBe('ready');

    online = false;
    const first = registry.refreshPack('argus.hermes');
    const second = registry.refreshPack('argus.hermes');
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ configuredId: 'argus.hermes', state: 'unreachable' });
    expect(registry.get('argus.hermes')?.state).toBe('unreachable');
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await expect(registry.refreshPack('not-configured')).resolves.toBeUndefined();
  });
});
