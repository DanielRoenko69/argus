// Actual, disposable Gitea provider; never uses live users, repos or credentials.
// Requires built Core + Workspace. Passwords/codes/tokens stay in this process.
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readOAuthTokenResponse } from '../dist/lib/upstreamOAuthTransport.js';
import { runRemoteGit, parseRemoteGitInput } from '../agent-workspace/dist/routes/gitRemote.js';

const image = 'gitea/gitea:1.27.0';
const name = `argus-gitea-oauth-cert-${randomBytes(5).toString('hex')}`;
const password = randomBytes(32).toString('hex');
const temp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'argus-gitea-oauth-cert-')));
const checks = [];
let created = false, phase = 'container';
const docker = (args, input) => execFileSync('docker', args, {
  input, encoding: 'utf8', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], timeout: 60_000,
});
const check = name => { checks.push(name); process.stdout.write(`PASS ${name}\n`); };
try {
  docker(['run', '--detach', '--rm', '--name', name, '--label', 'io.argus.gitea-oauth-cert=true',
    '--memory', '512m', '--tmpfs', '/data:rw,size=256m', '-p', '127.0.0.1::3000',
    '-e', 'GITEA__database__DB_TYPE=sqlite3', '-e', 'GITEA__security__INSTALL_LOCK=true',
    '-e', 'GITEA__server__DISABLE_SSH=true', '-e', 'GITEA__actions__ENABLED=false',
    '-e', 'GITEA__service__DISABLE_REGISTRATION=true', '-e', 'GITEA__log__LEVEL=Error', image]);
  created = true;
  const port = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports['3000/tcp'][0].HostPort;
  const origin = `http://127.0.0.1:${port}`;
  const cookies = new Map();
  async function request(route, options = {}) {
    const res = await fetch(origin + route, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10_000),
      headers: { Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join('; '), Origin:origin, ...options.headers } });
    for (const c of res.headers.getSetCookie()) { const first = c.split(';')[0]; const i = first.indexOf('='); cookies.set(first.slice(0,i),first.slice(i+1)); }
    return res;
  }
  const deadline = Date.now() + 60_000;
  for (;;) { try { if ((await request('/api/v1/version')).ok) break; } catch {}
    if (Date.now() > deadline) throw Error('provider readiness timeout');
    await new Promise(r => setTimeout(r, 250)); }
  phase = 'fixture setup';
  docker(['exec', '-i', '--user', 'git', name, 'sh', '-c',
    'read -r fixture_password; gitea admin user create --username fixture --password "$fixture_password" --email fixture@example.invalid --admin --must-change-password=false --config /data/gitea/conf/app.ini'], password+'\n');
  const basic = 'Basic ' + Buffer.from(`fixture:${password}`).toString('base64');
  async function api(route, body, auth = basic, method = body ? 'POST' : 'GET') {
    return request('/api/v1' + route, { method, headers: { Authorization: auth, Cookie:'', 'Content-Type': 'application/json' },
      ...(body ? {body:JSON.stringify(body)} : {}) });
  }
  let res = await api('/user/repos', {name:'oauth-proof', private:true, auto_init:true, default_branch:'main'});
  phase = `fixture repository HTTP ${res.status}`;
  assert.equal(res.status,201);
  res = await api('/repos/fixture/oauth-proof/issues', {title:'Fixture issue',body:'Read this via scoped OAuth.'});
  phase = `fixture issue HTTP ${res.status}`;
  assert.equal(res.status,201);
  const callback = origin + '/oauth-fixture-callback';
  res = await api('/user/applications/oauth2', {name:'Disposable Argus OAuth certification',redirect_uris:[callback],confidential_client:true});
  phase = `fixture application HTTP ${res.status}`;
  assert.equal(res.status,201); const app = await res.json();
  // Gitea 1.27 uses Origin checks; retain an issued CSRF input on older forms.
  const csrf = text => text.match(/name="_csrf"[^>]*value="([^"]+)"/)?.[1] ?? '';
  cookies.clear();
  res = await request('/user/login');
  phase = `fixture login form HTTP ${res.status}`;
  const login = await res.text();
  res = await request('/user/login', {method:'POST',body:new URLSearchParams({_csrf:csrf(login),user_name:'fixture',password})});
  phase = `fixture login HTTP ${res.status}`;
  assert.equal(res.status,303);
  phase = 'provider consent';
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const scopes = 'write:repository read:issue';
  const authorize = '/login/oauth/authorize?' + new URLSearchParams({client_id:app.client_id,redirect_uri:callback,
    response_type:'code',scope:scopes,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  res = await request(authorize); assert.equal(res.status,200);
  const consent = await res.text();
  const hidden = Object.fromEntries([...consent.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map(([tag])=>[tag.match(/name="([^"]+)"/)?.[1],tag.match(/value="([^"]*)"/)?.[1]??'']).filter(([key])=>key));
  res = await request('/login/oauth/grant', {method:'POST',body:new URLSearchParams({...hidden,_csrf:csrf(consent),redirect_uri:callback,client_id:app.client_id,state,scope:scopes,granted:'true',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'})});
  assert.ok([302,303].includes(res.status),`consent HTTP ${res.status}`);
  const location = new URL(res.headers.get('location'), origin);
  assert.equal(location.origin,origin); assert.equal(location.pathname,'/oauth-fixture-callback'); assert.equal(location.searchParams.get('state'),state);
  const code = location.searchParams.get('code'); assert.ok(code);
  const tokenRequest = data => request('/login/oauth/access_token',{method:'POST',body:new URLSearchParams({client_id:app.client_id,client_secret:app.client_secret,...data})});
  res = await tokenRequest({grant_type:'authorization_code',code,redirect_uri:callback,code_verifier:'deliberately-wrong-pkce'});
  assert.equal(res.status,400); check('wrong_pkce_denied');
  const token = await readOAuthTokenResponse(await tokenRequest({grant_type:'authorization_code',code,redirect_uri:callback,code_verifier:verifier}));
  assert.ok(token.access_token && token.refresh_token && token.expires_in > 0);
  if (token.scope !== undefined) assert.deepEqual(token.scope.split(' ').sort(),scopes.split(' ').sort());
  check('authorization_code_pkce_and_scopes');
  // Discard browser cookies; subsequent resource calls prove bearer authority only.
  cookies.clear();
  phase = 'OAuth API';
  const bearer = 'Bearer ' + token.access_token;
  res = await api('/repos/fixture/oauth-proof/issues/1',undefined,bearer); assert.equal(res.status,200);
  check('private_issue_read_bearer');
  res = await api('/admin/users',undefined,bearer); assert.equal(res.status,403);
  check('unrequested_admin_scope_denied');
  phase = 'protected Workspace Git';
  const workspace = path.join(temp,'workspace'); await mkdir(workspace);
  const args = parseRemoteGitInput({operation:'clone',workspaceRoot:'/workspace/CERT',url:origin+'/fixture/oauth-proof.git',branch:'main',
    authorization:'Basic '+Buffer.from('oauth2:'+token.access_token).toString('base64')});
  assert.deepEqual(await runRemoteGit(args,workspace),{ok:true});
  const checkout = path.join(workspace,'CERT');
  const git = args => execFileSync('/usr/bin/git',args,{cwd:checkout,encoding:'utf8',stdio:['ignore','pipe','pipe'],
    env:{PATH:'/usr/bin:/bin',HOME:temp,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
  git(['checkout','main']);
  assert.deepEqual(await runRemoteGit({...args,operation:'fetch'},workspace),{ok:true});
  await writeFile(path.join(checkout,'proof.txt'),'Synthetic OAuth transport certification only.\n');
  git(['add','proof.txt']); git(['commit','-m','OAuth fixture change']);
  const sha = git(['rev-parse','HEAD']);
  assert.deepEqual(await runRemoteGit({...args,operation:'push',branch:'feature/OAUTH-CERT',commitSha:sha},workspace),{ok:true,commitSha:sha});
  assert.deepEqual(await runRemoteGit({...args,operation:'verify',branch:'feature/OAUTH-CERT',commitSha:sha},workspace),{ok:true,commitSha:sha});
  const config = await readFile(path.join(checkout,'.git/config'),'utf8');
  assert.ok(!config.includes(token.access_token) && !config.includes(args.authorization));
  check('private_git_clone_fetch_exact_sha_push_verify_no_persisted_token');
  phase = 'OAuth PR';
  res = await api('/repos/fixture/oauth-proof/pulls',{base:'main',head:'feature/OAUTH-CERT',title:'Disposable OAuth proof'},bearer);
  assert.equal(res.status,201); assert.equal((await res.json()).head.sha,sha);
  check('oauth_pull_request_exact_commit');
  phase = 'refresh';
  const refreshed = await readOAuthTokenResponse(await tokenRequest({grant_type:'refresh_token',refresh_token:token.refresh_token}));
  assert.ok(refreshed.access_token && refreshed.refresh_token);
  res = await api('/repos/fixture/oauth-proof/issues/1',undefined,'Bearer '+refreshed.access_token); assert.equal(res.status,200);
  check('provider_refresh_then_bearer_read');
  phase = 'revocation';
  res = await api('/user/applications/oauth2/'+app.id,undefined,basic,'DELETE'); phase=`revocation delete HTTP ${res.status}`; assert.equal(res.status,204);
  cookies.clear();
  res = await api('/repos/fixture/oauth-proof/issues/1',undefined,'Bearer '+refreshed.access_token); phase=`revoked API HTTP ${res.status}`; assert.ok([401,403,404].includes(res.status));
  res = await tokenRequest({grant_type:'refresh_token',refresh_token:refreshed.refresh_token}); phase=`revoked refresh HTTP ${res.status}`; assert.equal(res.status,400);
  phase = 'revoked Git';
  assert.deepEqual(await runRemoteGit({...args,operation:'fetch'},workspace),{ok:false});
  check('application_revocation_blocks_api_git_and_refresh');
  process.stdout.write(JSON.stringify({status:'passed',image,checks,scope:'Disposable real Gitea provider; not Alex consent, Core grants/DB lifecycle or live workflow'})+'\n');
} catch (error) {
  // Assertion payloads, HTTP bodies and command stderr may contain secrets. Never print them.
  process.stderr.write(`FAIL ${phase}: ${error.code === 'ERR_ASSERTION' ? 'assertion failed' : error.name ?? 'Error'}\n`);
  process.exitCode = 1;
} finally {
  if (created) docker(['rm','--force',name]);
  await rm(temp,{recursive:true,force:true});
}
