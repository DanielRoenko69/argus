import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { projectSnapshotPathAllowed, assertProjectSnapshotContent } from './projectSnapshot.js';
import { qaSnapshot, type QaRequest } from './qaTests.js';
import { sourceNow } from './codeGeneration.js';
const cases = JSON.parse(readFileSync(new URL('../../../project-environments/project_snapshot_cases.json', import.meta.url), 'utf8'));
test('workspace and controller share explicit hidden project/credential cases', () => {
  for (const p of cases.allowed) assert.equal(projectSnapshotPathAllowed(p), true, p);
  for (const p of cases.denied) assert.equal(projectSnapshotPathAllowed(p), false, p);
  assert.equal(projectSnapshotPathAllowed('.python-version', '120000'), false);
  for (const x of cases.contentAllowed) assert.doesNotThrow(() => assertProjectSnapshotContent(x.path, Buffer.from(x.text)));
  for (const x of cases.contentDenied) assert.throws(() => assertProjectSnapshotContent(x.path, Buffer.from(x.text)), /sensitive_content/);
});
test('real Git snapshots bind hidden inputs consistently; legacy, credentials and ignored dependencies stay unchanged', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'argus-project-snapshot-')));
  const git = (...args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null',...args], {cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try {
    git('init'); mkdirSync(path.join(dir,'.github/workflows'),{recursive:true});
    for (const [name,text] of Object.entries({'.python-version':'3.14\n','.github/workflows/test.yml':'name: fixture\n','.gitignore':'.venv/\n','app.py':'pass\n','.env':'fixture-only\n','.npmrc':'registry=https://registry.npmjs.org/\n'})) writeFileSync(path.join(dir,name),text);
    git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','fixture');
    mkdirSync(path.join(dir,'.venv'));writeFileSync(path.join(dir,'.venv/ignored'),'ignored');
    const r:QaRequest={action:'inspect',threadId:randomUUID(),workspaceRoot:dir,baseCommitSha:git('rev-parse','HEAD'),basisSha256:'a'.repeat(64)};
    const legacy=await qaSnapshot(r), collected={projectFiles:true,sourceFiles:[] as Array<{path:string;content:string}>};
    const current=await qaSnapshot(r,undefined,collected);
    assert.deepEqual(collected.sourceFiles.map(f=>f.path),['.github/workflows/test.yml','.gitignore','.npmrc','.python-version','app.py']);
    assert.equal(sourceNow({...r,executionMode:'workspace-session-v1'}),current.sourceSha256);assert.equal(sourceNow(r),legacy.sourceSha256);
    writeFileSync(path.join(dir,'.python-version'),'3.15\n');
    assert.notEqual((await qaSnapshot(r,undefined,{projectFiles:true})).sourceSha256,current.sourceSha256);
    assert.equal((await qaSnapshot(r)).sourceSha256,legacy.sourceSha256);
    writeFileSync(path.join(dir,'.npmrc'),'_authToken=fixture-only\n');
    await assert.rejects(qaSnapshot(r,undefined,{projectFiles:true}),/sensitive_content/);
    assert.throws(()=>sourceNow({...r,executionMode:'workspace-session-v1'}),/sensitive_content/);
    writeFileSync(path.join(dir,'.npmrc'),'');
    const beforeLinks=await qaSnapshot(r,undefined,{projectFiles:true});
    symlinkSync('app.py',path.join(dir,'.linked'));
    mkdirSync(path.join(dir,'.agents/skills'),{recursive:true});
    symlinkSync('../../.venv/ignored',path.join(dir,'.agents/skills/framework'));
    symlinkSync('/not-a-readable-fixture-file',path.join(dir,'link.py'));
    const withoutLinks={projectFiles:true,sourceFiles:[] as Array<{path:string;content:string}>};
    const linked=await qaSnapshot(r,undefined,withoutLinks);
    assert.equal(linked.sourceSha256,beforeLinks.sourceSha256);
    assert.equal(sourceNow({...r,executionMode:'workspace-session-v1'}),linked.sourceSha256);
    assert.ok(!withoutLinks.sourceFiles.some(f=>['.linked','.agents/skills/framework','link.py'].includes(f.path)));
    await assert.rejects(qaSnapshot(r),/unsafe_source/); // legacy non-hidden link remains fail-closed
    assert.throws(()=>sourceNow(r),/unsafe_source/);
    linkSync(path.join(dir,'app.py'),path.join(dir,'.hardlink'));
    await assert.rejects(qaSnapshot(r,undefined,{projectFiles:true}),/unsafe_source/);
    assert.throws(()=>sourceNow({...r,executionMode:'workspace-session-v1'}),/unsafe_source/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
