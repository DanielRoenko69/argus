// Separate headless demo contexts only; never use a person's browser profile.
// The Mac bootstrap installs Playwright Chromium, not Microsoft Edge.
export async function launchDemoBrowser(chromium, {
  platform = process.platform,
  channel = process.env.ARGUS_DEMO_BROWSER_CHANNEL,
} = {}) {
  if (channel && !['chromium', 'msedge', 'chrome'].includes(channel)) {
    throw new Error('ARGUS_DEMO_BROWSER_CHANNEL must be chromium, msedge or chrome');
  }
  const channels = channel
    ? [channel === 'chromium' ? undefined : channel]
    : platform === 'win32' ? ['msedge', 'chrome', undefined] : [undefined, 'msedge', 'chrome'];
  for (const candidate of channels) {
    try {
      return await chromium.launch({
        ...(candidate ? { channel: candidate } : {}),
        headless: true,
        args: ['--force-device-scale-factor=1'],
      });
    } catch {
      // Browser startup only: no application login or model request is retried.
    }
  }
  throw new Error('Demo browser unavailable. Run node e2e/node_modules/@playwright/test/cli.js install chromium, or install the explicitly selected browser.');
}
