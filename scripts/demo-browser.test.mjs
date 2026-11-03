import assert from 'node:assert/strict';
import test from 'node:test';
import { launchDemoBrowser } from './lib/demo-browser.mjs';

function fakeBrowser(failures = 0) {
  const calls = [];
  const browser = { isolated: true };
  return { calls, browser, chromium: { async launch(options) {
    calls.push(options);
    if (calls.length <= failures) throw new Error('browser missing');
    return browser;
  } } };
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform} uses the pinned Chromium installed by bootstrap first`, async () => {
    const fake = fakeBrowser();
    assert.equal(await launchDemoBrowser(fake.chromium, { platform, channel: '' }), fake.browser);
    assert.deepEqual(fake.calls, [{ headless: true, args: ['--force-device-scale-factor=1'] }]);
  });
}

test('Windows retains Edge with Chrome and bundled Chromium startup fallbacks', async () => {
  const fake = fakeBrowser(2);
  await launchDemoBrowser(fake.chromium, { platform: 'win32', channel: '' });
  assert.deepEqual(fake.calls.map(c => c.channel), ['msedge', 'chrome', undefined]);
});

test('an explicit browser does not silently fall back', async () => {
  const fake = fakeBrowser(3);
  await assert.rejects(launchDemoBrowser(fake.chromium, { channel: 'msedge' }), /Demo browser unavailable/);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].channel, 'msedge');
});

test('explicit chromium uses the bundled executable on Windows too', async () => {
  const fake = fakeBrowser();
  await launchDemoBrowser(fake.chromium, { platform: 'win32', channel: 'chromium' });
  assert.equal(fake.calls[0].channel, undefined);
});

test('invalid browser configuration fails before launching anything', async () => {
  const fake = fakeBrowser();
  await assert.rejects(launchDemoBrowser(fake.chromium, { channel: 'unknown' }), /must be chromium/);
  assert.equal(fake.calls.length, 0);
});

test('all missing browsers produce an actionable error without raw launch output', async () => {
  const fake = fakeBrowser(3);
  await assert.rejects(launchDemoBrowser(fake.chromium, { platform: 'darwin', channel: '' }), /cli\.js install chromium/);
  assert.deepEqual(fake.calls.map(c => c.channel), [undefined, 'msedge', 'chrome']);
});
