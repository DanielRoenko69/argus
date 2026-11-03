import {
  generateTotp,
  LOCAL_MFA_ALEX,
  LOCAL_MFA_DEMO,
  LOCAL_MFA_DEVELOPER,
} from './lib/localMfaDemo.mjs';

const identityName = (process.argv[2] ?? 'admin').toLowerCase();
const identity = identityName === 'admin'
  ? LOCAL_MFA_DEMO
  : identityName === 'developer'
    ? LOCAL_MFA_DEVELOPER
    : identityName === 'alex'
      ? LOCAL_MFA_ALEX
      : null;
if (!identity) throw new Error('Usage: npm run demo:mfa:code -- <admin|developer|alex>');

const code = generateTotp({
  secret: identity.totpSecret,
  algorithm: identity.totpAlgorithm,
  digits: identity.totpDigits,
  periodSeconds: identity.totpPeriodSeconds,
});
const remaining = identity.totpPeriodSeconds
  - (Math.floor(Date.now() / 1_000) % identity.totpPeriodSeconds);
process.stdout.write(`${identityName}: ${code} (${remaining}s remaining)\n`);
