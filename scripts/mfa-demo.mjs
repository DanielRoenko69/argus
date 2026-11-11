import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  decodeJwtPayload,
  generateTotp,
  LOCAL_MFA_ALEX,
  LOCAL_MFA_DEMO,
} from './lib/localMfaDemo.mjs';

const root = resolve(import.meta.dirname, '..');
const action = process.argv[2] ?? 'up';
if (!['up', 'stop', 'verify'].includes(action)) {
  throw new Error('Usage: node scripts/mfa-demo.mjs <up|stop|verify>');
}
if (!existsSync(resolve(root, '.env'))) {
  throw new Error('Missing .env. Complete the normal Argus Docker installation first.');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

const baseCompose = ['compose', '--env-file', '.env'];
if (existsSync(resolve(root, '.env.worm-demo.local'))) {
  baseCompose.push(
    '--env-file', '.env.worm-demo.local',
    '-f', 'docker-compose.yml',
    '-f', 'deploy/compose/options/compose.audit-evidence.yml',
    '-f', 'deploy/compose/demo/compose.worm-demo.yml',
  );
} else {
  baseCompose.push('-f', 'docker-compose.yml');
}
const mfaCompose = [...baseCompose, '-f', 'deploy/compose/demo/compose.mfa-demo.yml'];
const port = process.env.ARGUS_MFA_DEMO_PORT ?? '8180';
const argusPort = process.env.PORT ?? '3000';
const issuer = `http://localhost:${port}/realms/${LOCAL_MFA_DEMO.realm}`;

async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return response;
    } catch { /* Service is still starting. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`${label} did not become ready within ${timeoutMs / 1_000} seconds`);
}

async function requestDemoToken(identity = LOCAL_MFA_DEMO) {
  const endpoint = `${issuer}/protocol/openid-connect/token`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: LOCAL_MFA_DEMO.clientId,
      client_secret: LOCAL_MFA_DEMO.clientSecret,
      username: identity.username,
      password: identity.password,
      totp: generateTotp({
        secret: identity.totpSecret,
        algorithm: identity.totpAlgorithm,
        digits: identity.totpDigits,
        periodSeconds: identity.totpPeriodSeconds,
      }),
      scope: 'openid profile email',
    });
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = await response.json();
    if (response.ok && result.id_token) return result.id_token;
    if (attempt === 0) await new Promise(resolveWait => setTimeout(resolveWait, 1_500));
    else throw new Error(`Keycloak rejected the TOTP certification: ${result.error_description ?? result.error ?? response.status}`);
  }
  throw new Error('Keycloak token certification did not complete');
}

async function verify() {
  await waitFor(`${issuer}/.well-known/openid-configuration`, 'Keycloak MFA demo');
  await waitFor(`http://localhost:${argusPort}/health`, 'Argus');
  const idToken = await requestDemoToken();
  const claims = decodeJwtPayload(idToken);
  const alexClaims = decodeJwtPayload(await requestDemoToken(LOCAL_MFA_ALEX));
  const login = await fetch(`http://localhost:${argusPort}/auth/oidc/login`, { redirect: 'manual' });
  const location = login.headers.get('location') ?? '';
  const checks = {
    keycloakIssuer: claims.iss === issuer,
    audience: claims.aud === LOCAL_MFA_DEMO.clientId
      || (Array.isArray(claims.aud) && claims.aud.includes(LOCAL_MFA_DEMO.clientId)),
    freshTokenIssuedAt: Number.isInteger(claims.iat)
      && Math.abs(Math.floor(Date.now() / 1_000) - claims.iat) <= 60,
    providerAssurance: claims.acr === '1'
      || (Array.isArray(claims.amr) && claims.amr.includes('otp')),
    platformAdminGroup: Array.isArray(claims.groups) && claims.groups.includes('argus-platform-admins'),
    alexProviderIdentity: alexClaims.sub === '2d0dd753-0b25-4ff4-99ac-b426b92e863c'
      && alexClaims.preferred_username === LOCAL_MFA_ALEX.username,
    alexPlatformAdminGroup: Array.isArray(alexClaims.groups)
      && alexClaims.groups.includes('argus-platform-admins'),
    argusPkceRedirect: login.status === 302
      && location.startsWith(`${issuer}/protocol/openid-connect/auth?`)
      && location.includes('code_challenge_method=S256')
      && location.includes('nonce='),
  };
  const passed = Object.values(checks).every(Boolean);
  const report = {
    schema: 'argus.local-mfa-demo-certification.v1',
    generatedAt: new Date().toISOString(),
    scope: 'provider-and-argus-preflight',
    passed,
    issuer,
    subject: claims.sub,
    alexSubject: alexClaims.sub,
    assurance: { acr: claims.acr ?? null, amr: claims.amr ?? [] },
    checks,
  };
  const outputDirectory = resolve(root, 'test-results');
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, 'local-mfa-demo-certification.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!passed) throw new Error('Local MFA demo preflight failed');
}

if (action === 'stop') {
  run('docker', [...mfaCompose, 'rm', '-f', '-s', 'keycloak-mfa']);
  run('docker', [...baseCompose, 'up', '-d', '--force-recreate', '--no-deps', 'mcp-server']);
  process.stdout.write('MFA demo stopped; Argus was restored to the normal local auth configuration.\n');
  process.exit(0);
}

if (action === 'up') {
  run('docker', [...mfaCompose, 'config', '--quiet']);
  // The demo realm is declarative and disposable. Recreate Keycloak so group,
  // user and MFA-policy changes in the checked-in realm are always imported.
  run('docker', [...mfaCompose, 'up', '-d', '--force-recreate', 'keycloak-mfa']);
  run('docker', [...mfaCompose, 'up', '-d', '--force-recreate', '--no-deps', 'mcp-server']);
}
await verify();
process.stdout.write([
  '',
  `MFA demo ready: http://localhost:${argusPort}`,
  `SSO provider: http://localhost:${port}`,
  `User: ${LOCAL_MFA_DEMO.username}`,
  `Password: ${LOCAL_MFA_DEMO.password}`,
  'Admin TOTP: npm run demo:mfa:code -- admin',
  'Developer TOTP: npm run demo:mfa:code -- developer',
  'Alex linking TOTP: npm run demo:mfa:code -- alex',
  'Sign out of the local Argus account, then choose “Argus MFA Demo”.',
  '',
].join('\n'));
