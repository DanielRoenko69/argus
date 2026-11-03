import { describe, it, expect } from '@jest/globals';
import { assertSsrfSafeResolved, isPrivateOrInternalIp } from '../backends/customBackends.js';

// Injectable fake resolver — avoids real DNS + jest ESM module-mock fragility.
const fakeLookup = (addrs: string[]) =>
  async () => addrs.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));

describe('isPrivateOrInternalIp', () => {
  it('flags RFC-1918 + loopback + link-local + IMDS + unspecified', () => {
    for (const ip of ['10.0.0.5', '127.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0']) {
      expect(isPrivateOrInternalIp(ip)).toBe(true);
    }
  });
  it('passes public IPs', () => {
    for (const ip of ['8.8.8.8', '203.0.113.10', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateOrInternalIp(ip)).toBe(false);
    }
  });
  it('flags private IPv6 literals in every textual form', () => {
    for (const ip of [
      '::ffff:10.0.0.1', '::ffff:a00:1', '[::ffff:10.0.0.1]', 'fc01::1', 'fd12:3456::1', 'fe80::1%eth0',
      '::1', '::', '::ffff:169.254.169.254', '64:ff9b::a00:1', '2002:a00:1::1', 'fec0::1',
    ]) {
      expect(isPrivateOrInternalIp(ip)).toBe(true);
    }
  });
});

describe('assertSsrfSafe — IPv6 literal URLs (personal model-provider onboarding)', () => {
  it('rejects mapped and unique-local IPv6 targets without any DNS lookup', async () => {
    let called = false;
    const spyLookup = async () => { called = true; return [{ address: '93.184.216.34' }]; };
    for (const url of ['http://[::ffff:10.0.0.1]:8000/v1', 'http://[fc01::1]:8000/v1', 'http://[::ffff:7f00:1]/v1']) {
      await expect(assertSsrfSafeResolved(url, spyLookup, { failClosedOnDnsError: true }))
        .rejects.toThrow('URL nicht erlaubt');
    }
    expect(called).toBe(false);
  });
  it('rejects a hostname that resolves to a mapped private IPv6 address', async () => {
    await expect(assertSsrfSafeResolved('https://rebind.evil.example/x', fakeLookup(['::ffff:10.0.0.1'])))
      .rejects.toThrow('URL nicht erlaubt');
  });
});

describe('assertSsrfSafeResolved — DNS-rebinding defence', () => {
  it('throws when a public-looking hostname resolves to a private IP', async () => {
    await expect(
      assertSsrfSafeResolved('https://rebind.evil.example/x', fakeLookup(['10.0.0.5'])),
    ).rejects.toThrow('URL nicht erlaubt');
  });

  it('passes when the hostname resolves to a public IP', async () => {
    await expect(
      assertSsrfSafeResolved('https://example.com/x', fakeLookup(['93.184.216.34'])),
    ).resolves.toBeUndefined();
  });

  it('still blocks literal private URLs (sync layer) without a DNS call', async () => {
    let called = false;
    const spyLookup = async () => { called = true; return []; };
    await expect(
      assertSsrfSafeResolved('http://169.254.169.254/latest/', spyLookup),
    ).rejects.toThrow('URL nicht erlaubt');
    expect(called).toBe(false);
  });
});
