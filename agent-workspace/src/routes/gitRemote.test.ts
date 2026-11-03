import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { parseRemoteGitInput, safeLocalGitConfig, gitRemoteEnvironment, runRemoteGit } from './gitRemote.js';

const input = { operation:'clone',workspaceRoot:'/workspace/DEMO',url:'http://gitea:3000/alex/demo.git',branch:'main',authorization:'Basic ZGVtbzp0b2tlbg==' };
test('bounded Git input excludes shell, path traversal, credentials in URLs and unapproved refs', () => {
  assert.doesNotThrow(()=>parseRemoteGitInput(input));
  for (const change of [{cmd:'env'}, {workspaceRoot:'/workspace/../etc'}, {branch:'main;env'}, {url:'http://user:secret@host/repo.git'},
    {url:'file:///repo.git'}, {authorization:'Bearer x\nX-Leak: x'}, {operation:'push',branch:'main',commitSha:'a'.repeat(40)}, {operation:'push',branch:'feature/D'},
    {operation:'fetch',expectedRemoteSha:'a'.repeat(40)}, {operation:'push',branch:'feature/D',commitSha:'b'.repeat(40),expectedRemoteSha:'invalid'}]) {
    assert.throws(()=>parseRemoteGitInput({...input,...change}));
  }
});
test('child receives scoped auth without inheriting runtime secrets, hooks or redirect permissions', () => {
  process.env['GIT_TEST_PARENT_SECRET']='must-not-inherit';
  const env=gitRemoteEnvironment(parseRemoteGitInput(input));
  delete process.env['GIT_TEST_PARENT_SECRET'];
  assert.equal(env.GIT_TEST_PARENT_SECRET,undefined); assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');
  assert.equal(env.GIT_CONFIG_VALUE_4,'false'); assert.equal(env.GIT_CONFIG_VALUE_0,'/dev/null');
  assert.equal(env.GIT_CONFIG_KEY_3,`http.${input.url}.extraHeader`);
});
test('rejects local Git credential helpers, rewrites, includes, filters and wrong origin', () => {
  const config=`core.bare\nfalse\0remote.origin.url\n${input.url}\0`;
  assert.equal(safeLocalGitConfig(config,input.url),true);
  for(const entry of ['credential.helper\n!leak','include.path\n/tmp/evil','url.http://attacker/.insteadof\nhttp://gitea/',
    'filter.lfs.smudge\nleak','core.hookspath\n/tmp/hooks','remote.origin.pushurl\nhttp://attacker']) {
    assert.equal(safeLocalGitConfig(config+entry+'\0',input.url),false);
  }
  assert.equal(safeLocalGitConfig(config,'http://different/repo.git'),false);
});

test('real smart-HTTP clone/fetch/push/verify leaves no token in checkout and rejects drift', async () => {
  const temp=await realpath(await mkdtemp(path.join(os.tmpdir(),'argus-git-transport-')));
  const project=path.join(temp,'http'); const workspace=path.join(temp,'workspace'); const seed=path.join(temp,'seed');
  await mkdir(project); await mkdir(workspace); await mkdir(seed);
  const git=(args:string[],cwd=seed)=>execFileSync('/usr/bin/git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],
    env:{PATH:'/usr/bin:/bin',HOME:temp,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'}}).trim();
  git(['init','--initial-branch=main']); await writeFile(path.join(seed,'README.md'),'Initial\n'); git(['add','README.md']); git(['commit','-m','initial']);
  git(['clone','--bare',seed,path.join(project,'demo.git')]); git(['config','http.receivepack','true'],path.join(project,'demo.git'));
  const header='Basic '+Buffer.from('oauth2:private-test-oauth-token').toString('base64'); let requests=0;
  let competing=''; let raceOnReceive=false; let raced=false;
  const server=createServer((req,res)=>{
    if(req.headers.authorization!==header){res.writeHead(401,{'www-authenticate':'Basic realm="test"'});res.end();return;}
    requests++;
    const url=new URL(req.url!,'http://localhost');
    if(raceOnReceive && req.method==='POST' && url.pathname.endsWith('/git-receive-pack')){
      raceOnReceive=false;raced=true;
      git(['push','origin','feature/DEMO'],competing);
    }
    const child=spawn('/usr/bin/git',['http-backend'],{env:{PATH:'/usr/bin:/bin',GIT_PROJECT_ROOT:project,GIT_HTTP_EXPORT_ALL:'1',
      PATH_INFO:url.pathname,QUERY_STRING:url.search.slice(1),REQUEST_METHOD:req.method,CONTENT_TYPE:req.headers['content-type']??'',
      CONTENT_LENGTH:req.headers['content-length']??'',REMOTE_USER:'oauth2'},stdio:['pipe','pipe','ignore']});
    req.pipe(child.stdin); const chunks:Buffer[]=[]; child.stdout.on('data',c=>chunks.push(c));
    child.on('close',()=>{
      const body=Buffer.concat(chunks); const end=body.indexOf('\r\n\r\n');
      if(end<0){res.writeHead(502);res.end();return;}
      let status=200;const headers:Record<string,string>={};
      for(const line of body.subarray(0,end).toString().split('\r\n')){const i=line.indexOf(':');const k=line.slice(0,i);const v=line.slice(i+1).trim();if(k.toLowerCase()==='status')status=Number(v.split(' ')[0]);else headers[k]=v;}
      res.writeHead(status,headers);res.end(body.subarray(end+4));
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/demo.git`;
  const args=parseRemoteGitInput({...input,url,authorization:header});
  try {
    assert.deepEqual(await runRemoteGit(args,workspace),{ok:true});
    const checkout=path.join(workspace,'DEMO'); git(['checkout','main'],checkout);
    assert.deepEqual(await runRemoteGit({...args,operation:'fetch'},workspace),{ok:true});
    await writeFile(path.join(checkout,'README.md'),'Implemented\n');git(['add','README.md'],checkout);git(['commit','-m','change'],checkout);
    const sha=git(['rev-parse','HEAD'],checkout);
    assert.deepEqual(await runRemoteGit({...args,operation:'push',branch:'feature/DEMO',commitSha:sha},workspace),{ok:true,commitSha:sha});
    assert.deepEqual(await runRemoteGit({...args,operation:'verify',branch:'feature/DEMO',commitSha:sha},workspace),{ok:true,commitSha:sha});
    assert.equal(git(['rev-parse','refs/heads/feature/DEMO'],path.join(project,'demo.git')),sha);
    await writeFile(path.join(checkout,'README.md'),'Follow-up\n');git(['add','README.md'],checkout);git(['commit','-m','follow-up'],checkout);
    const nextSha=git(['rev-parse','HEAD'],checkout);
    assert.deepEqual(await runRemoteGit({...args,operation:'push',branch:'feature/DEMO',commitSha:nextSha,expectedRemoteSha:sha},workspace),
      {ok:true,commitSha:nextSha});
    assert.equal(git(['rev-parse','refs/heads/feature/DEMO'],path.join(project,'demo.git')),nextSha);
    // A different actor advances the reviewed PR branch after the human gate.
    // The stale local checkout must not overwrite or rebase that external work.
    competing=path.join(temp,'competing');
    git(['clone','--branch','feature/DEMO',path.join(project,'demo.git'),competing]);
    await writeFile(path.join(competing,'README.md'),'External change\n');
    git(['add','README.md'],competing);git(['commit','-m','external change'],competing);
    const competingSha=git(['rev-parse','HEAD'],competing);
    await writeFile(path.join(checkout,'README.md'),'Stale follow-up\n');git(['add','README.md'],checkout);git(['commit','-m','stale'],checkout);
    const staleSha=git(['rev-parse','HEAD'],checkout);
    raceOnReceive=true;
    assert.deepEqual(await runRemoteGit({...args,operation:'push',branch:'feature/DEMO',commitSha:staleSha,expectedRemoteSha:nextSha},workspace),
      {ok:false});
    assert.equal(raced,true,'an independent actor advanced the remote during receive-pack');
    assert.equal(git(['rev-parse','refs/heads/feature/DEMO'],path.join(project,'demo.git')),competingSha);
    const config=await readFile(path.join(checkout,'.git/config'),'utf8');assert.ok(!config.includes(header));assert.ok(!config.includes('private-test'));
    const before=requests; git(['config','credential.helper','!echo leaked'],checkout);
    await assert.rejects(runRemoteGit({...args,operation:'fetch'},workspace),/unsafe git configuration/);assert.equal(requests,before);
    await assert.rejects(runRemoteGit(args,workspace),/already exists/);
  } finally { await new Promise<void>(r=>server.close(()=>r())); await rm(temp,{recursive:true,force:true}); }
});
