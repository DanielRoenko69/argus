import { beforeAll, afterAll, beforeEach, describe, it, expect, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { createDevGitRouter } from '../devGitRoutes.js';
import { bindGitReference } from '../devGitBroker.js';
import { signExecutionGrant, type ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';
import { createExecutionGrantMiddleware } from '../../auth/executionGrantMiddleware.js';
import { getCurrentCallingUser } from '../../lib/requestContext.js';
import { BackendAuthenticationError } from '../../backends/backendAuthentication.js';
import type { CustomBackendRow } from '../../backends/customBackends.js';

const secret = 'core-git-test-signing-secret-at-least-32';
const workspaceSecret = 'workspace-test-secret-32-characters';
const backend = { id: 5, name: 'gitea', base_url: 'http://gitea:3000', auth_mode: 'strict', enabled: true,
  config: { kind: 'gitea', owner: 'alex', repo: 'demo', target_branch: 'main' } } as unknown as CustomBackendRow;
const ciBackend = { id: 6, name: 'jenkins-dev', base_url: 'http://jenkins:8080', auth_mode: 'service-account',
  enabled: true, backend_type: 'http', tls_skip_verify: false,
  config: { kind: 'jenkins', dev_ci: { version: 1, credential_source: 'argus-dev-dispatcher',
    repository: 'alex/demo', git_origin: 'http://gitea:3000', job: 'demo-dev', branch_prefix: 'feature/DEMO-' } },
} as unknown as CustomBackendRow;
const claims = (): ExecutionGrantClaims => ({ v:1, jti:'20aa002a-4c1b-43d9-88ab-ded481979599', iss:'argus.core', aud:'argus.dev',
  agent:'coding-orchestrator', sub:'user:3', principalKind:'user', principalId:'3', bundleIds:[50], coreAgentIds:[2],
  messageId:'test', rootTraceId:'506eadfe-cf34-41da-88e5-110cf3f2b171', workspaceRoot:'/workspace/DEMO', policy:'mcp-bundle-v1',
  executionSurface:'agent', iat:Math.floor(Date.now()/1000)-1, exp:Math.floor(Date.now()/1000)+600 });

describe('Dev Git HTTP broker', () => {
  let server: Server; let base: string;
  let active = true; let permitted = true; let enabled = true; let credential = true;
  let current = backend;
  let ciRows = [ciBackend];
  const query = jest.fn<(sql: string) => Promise<{ rows: unknown[] }>>(async sql => {
    if (sql.includes('argus_execution_grants')) return { rows: active ? [{ status:'active' }] : [] };
    if (sql.includes('mcp_users')) return { rows: permitted ? [{ id:3, allowed_bundles:[50] }] : [] };
    if (sql.includes("config->'dev_ci'")) return { rows: ciRows };
    if (sql.includes('mcp_backends')) return { rows:[current] };
    throw new Error('unexpected query');
  });
  const pool = { query } as unknown as pg.Pool;
  const transport = jest.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/git/remote')) {
      const body = JSON.parse(String(init?.body));
      expect(body.authorization).toBe('Basic private-workspace-credential');
      expect(body.workspaceRoot).toBe('/workspace/DEMO');
      return new Response(JSON.stringify({ ok:true, ...(body.commitSha ? { commitSha:body.commitSha } : {}) }));
    }
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string,string>).authorization).toBe('Bearer private-provider-token');
    return new Response(JSON.stringify({ number:7, html_url:'https://attacker.invalid/secret' }));
  });
  const auth = jest.fn(async () => {
    expect(getCurrentCallingUser()?.id).toBe(3);
    if (!credential) throw new BackendAuthenticationError('connection_required', 5);
    return { evidence:{ backendId:5, mode:'user-oauth' as const, userId:3 }, gitHeader:'Basic private-workspace-credential', apiHeader:'Bearer private-provider-token' };
  });
  beforeAll(async () => {
    const app = express(); app.use(express.json()); app.use(createExecutionGrantMiddleware(pool, secret));
    app.use(createDevGitRouter(pool, secret, { enabled:()=>enabled, workspaceSecret:()=>workspaceSecret,
      fetchFn:transport, checkUrl:async()=>{}, authentication:auth, auditIdentity:()=>{}, auditCi:()=>{}, writeOnce:async(_p,_g,_i,_e,fn)=>fn() }));
    await new Promise<void>(resolve => { server = app.listen(0,'127.0.0.1',()=>resolve()); });
    base = `http://127.0.0.1:${(server.address() as { port:number }).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve=>server.close(()=>resolve())); });
  beforeEach(() => { active=true; permitted=true; enabled=true; credential=true; current=backend; ciRows=[ciBackend]; query.mockClear(); auth.mockClear(); transport.mockClear(); });
  const headers = (grant=claims()) => ({ 'content-type':'application/json', authorization:`Bearer ${signExecutionGrant(secret,grant)}`,
    'x-workspace-secret':workspaceSecret, 'x-argus-root-trace-id':grant.rootTraceId });
  const input = (grant=claims()) => ({ reference:bindGitReference(secret,grant,50,backend), operation:'clone', branch:'main' });
  const operate = (body: unknown=input(), requestHeaders=headers()) => fetch(`${base}/api/internal/dev-git/operate`, { method:'POST',headers:requestHeaders,body:JSON.stringify(body) });
  const ciInput = (grant=claims()) => ({ reference: bindGitReference(secret,grant,50,backend), job:'demo-dev', apiOrigin:'http://jenkins:8080', phase:'prepare' });
  const authorizeCi = (body: unknown=ciInput(), requestHeaders=headers()) => fetch(`${base}/api/internal/dev-git/ci-authorization`, { method:'POST', headers:requestHeaders, body:JSON.stringify(body) });

  it('freezes the CI target without credentials or provider I/O and validates dispatch approval', async () => {
    const prepared=await authorizeCi(); expect(prepared.status).toBe(200);
    const { ciReference }=await prepared.json() as any;
    expect(ciReference).toMatchObject({ backendId:6, bundleId:50, job:'demo-dev', authMode:'service-account' });
    const dispatch={...ciInput(), phase:'dispatch',ciReference, branch:'feature/DEMO-1',commitSha:'a'.repeat(40),baseSha:'b'.repeat(40),codeApproved:true,testsPassed:true,reviewPassed:true};
    expect((await authorizeCi(dispatch)).status).toBe(200);
    expect((await authorizeCi({...dispatch, codeApproved:undefined})).status).toBe(400);
    expect((await authorizeCi({...dispatch, commitSha:dispatch.baseSha})).status).toBe(400);
    expect((await authorizeCi({...dispatch, branch:'feature/OTHER-1'})).status).toBe(403);
    expect((await authorizeCi({...dispatch, ciReference:{...ciReference,binding:'c'.repeat(64)}})).status).toBe(409);
    expect(auth).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
    const sql=query.mock.calls.find(([sql])=>sql.includes("config->'dev_ci'"))![0];
    expect(sql).toContain('bb.bundle_id=$1'); expect(sql).toContain('b.enabled=true'); expect(sql).toContain("dev_ci'->>'job'=$2");
  });
  it('limits review-only Git and CI writes to the signed image workflow and matching Jenkins policy', async () => {
    const imageGrant = { ...claims(), runtimeSelection: { source:'argus.core' as const, kind:'runtime-selection' as const,
      requestedMode:'default' as const, effectiveMode:'default' as const, reason:'explicit_default' as const,
      workflowId:'ticket-to-image-pull-request' } };
    const normalGrant = { ...imageGrant, runtimeSelection: { ...imageGrant.runtimeSelection, workflowId:'ticket-to-pull-request' } };
    const push = (grant: ExecutionGrantClaims) => ({ ...input(grant), operation:'push', branch:'feature/DEMO-1',
      commitSha:'a'.repeat(40), codeApproved:true, reviewPassed:true, verificationMode:'review-only-image' });
    expect((await operate(push(normalGrant), headers(normalGrant))).status).toBe(403);
    expect((await operate(push(imageGrant), headers(imageGrant))).status).toBe(200);
    ciRows = [{ ...ciBackend, config: { ...(ciBackend.config as object), dev_ci: {
      ...((ciBackend.config as any).dev_ci), verification_mode:'review-only-image' } } } as CustomBackendRow];
    expect((await authorizeCi({ ...ciInput(normalGrant), verificationMode:'review-only-image' }, headers(normalGrant))).status).toBe(403);
    expect((await authorizeCi(ciInput(imageGrant), headers(imageGrant))).status).toBe(403);
    const prepared = await authorizeCi({ ...ciInput(imageGrant), verificationMode:'review-only-image' }, headers(imageGrant));
    expect(prepared.status).toBe(200);
    const { ciReference } = await prepared.json() as any;
    expect((await authorizeCi({ ...ciInput(imageGrant), phase:'dispatch', ciReference, branch:'feature/DEMO-1',
      commitSha:'a'.repeat(40), baseSha:'b'.repeat(40), codeApproved:true, reviewPassed:true,
      verificationMode:'review-only-image' }, headers(imageGrant))).status).toBe(200);
  });
  it('pins follow-up branch updates and accepts only an open PR at the expected head', async () => {
    const followUpGrant = { ...claims(), runtimeSelection: { source:'argus.core' as const, kind:'runtime-selection' as const,
      requestedMode:'default' as const, effectiveMode:'default' as const, reason:'explicit_default' as const,
      workflowId:'ticket-follow-up-image-pull-request' } };
    const normalGrant = { ...followUpGrant, runtimeSelection: { ...followUpGrant.runtimeSelection, workflowId:'ticket-to-image-pull-request' } };
    const push = { ...input(followUpGrant), operation:'push', branch:'feature/DEMO-1',
      commitSha:'b'.repeat(40), expectedRemoteSha:'a'.repeat(40), codeApproved:true, reviewPassed:true,
      verificationMode:'review-only-image' };
    expect((await operate({ ...push, expectedRemoteSha:undefined }, headers(followUpGrant))).status).toBe(403);
    expect((await operate({ ...push, reference:input(normalGrant).reference }, headers(normalGrant))).status).toBe(403);
    expect((await operate(push, headers(followUpGrant))).status).toBe(200);
    expect(transport).toHaveBeenCalledWith(expect.stringContaining('/git/remote'), expect.objectContaining({
      body: expect.stringContaining('"expectedRemoteSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'),
    }));
    const inspect = { ...input(followUpGrant), operation:'inspect-pr', branch:'feature/DEMO-1',
      commitSha:'b'.repeat(40), pullRequestNumber:2 };
    transport.mockImplementationOnce(async () => new Response(JSON.stringify({ state:'open', merged:false,
      head:{ ref:'feature/DEMO-1', sha:'b'.repeat(40) }, base:{ ref:'main' } })));
    const response = await operate(inspect, headers(followUpGrant));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok:true, commitSha:'b'.repeat(40), prUrl:'http://gitea:3000/alex/demo/pulls/2' });
    transport.mockImplementationOnce(async () => new Response(JSON.stringify({ state:'closed', merged:false,
      head:{ ref:'feature/DEMO-1', sha:'b'.repeat(40) }, base:{ ref:'main' } })));
    expect(await (await operate(inspect, headers(followUpGrant))).json()).toMatchObject({ ok:false, code:'git_pr_changed' });
  });
  it('CI requires the original user, live grant and workspace-only caller', async () => {
    expect((await authorizeCi(ciInput(),{...headers(),'x-workspace-secret':''})).status).toBe(401);
    const runtime={...claims(),executionSurface:'runtime_mcp' as const};
    expect((await authorizeCi(ciInput(runtime),headers(runtime))).status).toBe(403);
    const other={...claims(),workspaceRoot:'/workspace/OTHER'};
    expect((await authorizeCi(ciInput(),headers(other))).status).toBe(409);
    active=false; expect((await authorizeCi()).status).toBe(401);
    active=true; permitted=false; expect((await authorizeCi()).status).toBe(403);
    expect(auth).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it('CI denies missing, ambiguous, wrong-origin, wrong-repository and changed bindings', async () => {
    for (const rows of [[],[ciBackend,ciBackend]]) { ciRows=rows; expect((await authorizeCi()).status).toBe(403); }
    for (const patch of [{auth_mode:'strict'},{base_url:'http://other:8080'},{tls_skip_verify:true},
      {config:{...ciBackend.config,dev_ci:{...(ciBackend.config as any).dev_ci,repository:'other/repo'}}}]) {
      ciRows=[{...ciBackend,...patch} as CustomBackendRow]; expect((await authorizeCi()).status).toBe(403);
    }
    ciRows=[ciBackend]; const {ciReference}=await (await authorizeCi()).json() as any;
    ciRows=[{...ciBackend,id:7}];
    expect((await authorizeCi({...ciInput(),phase:'dispatch',ciReference,branch:'feature/DEMO-1',commitSha:'a'.repeat(40),baseSha:'b'.repeat(40),codeApproved:true,testsPassed:true,reviewPassed:true})).status).toBe(409);
    expect(auth).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it('discovers metadata without reading or refreshing credentials', async () => {
    const response=await fetch(`${base}/api/internal/dev-git/50/reference`,{headers:headers()});
    const result=await response.json() as any;
    expect(response.status).toBe(200); expect(result.token).toBeNull(); expect(result.reference.backendId).toBe(5);
    expect(auth).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it('dispatches current user auth but returns only evidence', async () => {
    const response=await operate(); const body=await response.text();
    expect(response.status).toBe(200); expect(body).toContain('user-oauth'); expect(body).not.toContain('private-');
  });
  it('requires both orchestrator secret and agent-surface grant', async () => {
    expect((await operate(input(),{...headers(),'x-workspace-secret':''})).status).toBe(401);
    expect((await operate(input(),{...headers(),authorization:''})).status).toBe(401);
    const runtime={...claims(),executionSurface:'runtime_mcp' as const};
    expect((await operate(input(runtime),headers(runtime))).status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
  });
  it('rejects expiry, revocation, disabled users and Bundle drift before transport', async () => {
    const expired={...claims(),iat:Math.floor(Date.now()/1000)-600,exp:Math.floor(Date.now()/1000)-1};
    expect((await operate(input(expired),headers(expired))).status).toBe(401);
    active=false; expect((await operate()).status).toBe(401);
    active=true; permitted=false; expect((await operate()).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
  });
  it('does not substitute service identity or use stale reference', async () => {
    credential=false; expect((await operate()).status).toBe(409); expect(transport).not.toHaveBeenCalled();
    credential=true; current={...backend,auth_mode:'service-account'};
    expect((await operate()).status).toBe(409); expect(transport).not.toHaveBeenCalled();
  });
  it('requires approvals and verifies remote SHA before one PR POST', async () => {
    const request={...input(),operation:'pull-request',branch:'feature/DEMO',commitSha:'a'.repeat(40),
      codeApproved:true,testsPassed:true,reviewPassed:true,prApproved:true,ciPassed:true,title:'Demo',description:'Reviewed'};
    expect((await operate({...request,prApproved:undefined})).status).toBe(400);
    const response=await operate(request); const body=await response.json() as any;
    expect(body.prUrl).toBe('http://gitea:3000/alex/demo/pulls/7');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).operation).toBe('verify');
  });
  it('fails closed when disabled, with no legacy endpoint fallback', async () => {
    enabled=false; expect((await operate()).status).toBe(503); expect(transport).not.toHaveBeenCalled();
  });
});
