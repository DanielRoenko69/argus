/** Trusted Core-only Git transport. Never accepts shell commands or returns raw
 * Git output. Tokens exist only in the HTTP handler / bounded Git child env,
 * not argv, repository config, workspace files, prompts or receipts.
 */
import { Router } from 'express';
import { lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { waitForChildProcess, terminateProcessTree } from './exec.js';

type Input = { operation: 'clone' | 'fetch' | 'push' | 'verify'; workspaceRoot: string;
  url: string; branch: string; commitSha?: string; expectedRemoteSha?: string; authorization: string };
type Receipt = { ok: boolean; commitSha?: string };
const branchValid = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(s)
  && !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.')
  && s.split('/').every(p => !p.startsWith('.') && !p.endsWith('.lock'));
export function parseRemoteGitInput(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['operation','workspaceRoot','url','branch','commitSha','expectedRemoteSha','authorization'].includes(k))
    || !['clone','fetch','push','verify'].includes(String(v.operation))
    || typeof v.workspaceRoot !== 'string' || !/^\/workspace\/[A-Za-z0-9-]{1,200}$/.test(v.workspaceRoot)
    || typeof v.url !== 'string' || v.url.length > 2000 || /[%\s\\]/.test(v.url)
    || typeof v.branch !== 'string' || !branchValid(v.branch)
    || typeof v.authorization !== 'string' || v.authorization.length > 48_000
    || !/^(Basic|Bearer) [A-Za-z0-9._~+\/-]+=*$/.test(v.authorization)
    || (v.commitSha !== undefined && (typeof v.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(v.commitSha)))
    || (v.expectedRemoteSha !== undefined && (v.operation !== 'push' || typeof v.expectedRemoteSha !== 'string'
      || !/^[a-f0-9]{40}$/.test(v.expectedRemoteSha)))
    || (['push','verify'].includes(String(v.operation)) && (!v.commitSha || !v.branch.startsWith('feature/')))) throw new Error('invalid');
  const url = new URL(v.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || url.pathname.includes('%') || !url.pathname.endsWith('.git')) throw new Error('invalid');
  return v as Input;
}

export function gitRemoteEnvironment(input: Input): NodeJS.ProcessEnv {
  const entries = [
    ['core.hooksPath','/dev/null'], ['credential.helper',''], ['http.extraHeader',''],
    [`http.${input.url}.extraHeader`, `Authorization: ${input.authorization}`],
    ['http.followRedirects','false'], ['http.proxy',''], ['http.sslVerify','true'],
    ['protocol.allow','never'], ['protocol.http.allow','always'], ['protocol.https.allow','always'],
    ['submodule.recurse','false'], ['fetch.recurseSubmodules','false'], ['push.recurseSubmodules','no'],
    ['transfer.fsckObjects','true'], ['fetch.fsckObjects','true'],
  ];
  const env: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  return env;
}

export function safeLocalGitConfig(output: string, expectedUrl: string): boolean {
  let origin = '';
  for (const entry of output.split('\0').filter(Boolean)) {
    const at = entry.indexOf('\n');
    if (at < 0) return false;
    const key = entry.slice(0, at).toLowerCase(); const value = entry.slice(at + 1);
    if (key === 'remote.origin.url') { if (origin) return false; origin = value; continue; }
    if (!/^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|user\.(name|email)|remote\.origin\.(fetch|tagopt)|branch\.[a-z0-9._/-]+\.(remote|merge))$/.test(key)) return false;
    if (key === 'core.bare' && value !== 'false') return false;
  }
  return origin === expectedUrl;
}

export async function runRemoteGit(input: Input, workspaceBase = '/workspace'): Promise<Receipt> {
  const root = path.join(workspaceBase, path.basename(input.workspaceRoot));
  const base = await realpath(workspaceBase);
  if (base !== path.resolve(workspaceBase)) throw new Error('unsafe workspace');
  const existing = await lstat(root).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (input.operation === 'clone') {
    // Never remove a previous checkout, partial clone or unrelated directory.
    if (existing) throw new Error('checkout already exists');
  } else {
    if (!existing?.isDirectory() || existing.isSymbolicLink() || await realpath(root) !== root) throw new Error('unsafe workspace');
    for (const name of ['.git', '.git/config']) {
      const stat = await lstat(path.join(root, name));
      if (stat.isSymbolicLink() || (name === '.git' ? !stat.isDirectory() : !stat.isFile())) throw new Error('unsafe git metadata');
    }
  }
  const env = gitRemoteEnvironment(input);
  const git = async (args: string[], cwd = root, authenticated = false) => {
    const childEnv = { ...env };
    // Metadata checks must not have an upstream credential in their environment.
    if (!authenticated) childEnv.GIT_CONFIG_VALUE_3 = '';
    const proc = spawn('/usr/bin/git', args, { cwd, env: childEnv, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    let output = ''; let size = 0; let limited = false;
    proc.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65_536) { limited = true; terminateProcessTree(proc); }
      else output += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65_536) { limited = true; terminateProcessTree(proc); } });
    const result = await waitForChildProcess(proc, authenticated ? 120_000 : 10_000);
    if (result.timedOut || limited) throw new Error('uncertain git operation');
    return { ok: result.exitCode === 0, output };
  };
  if (input.operation === 'clone') {
    const result = await git(['clone','--no-checkout','--no-tags','--single-branch','--branch',input.branch,'--',input.url,root], base, true);
    return { ok: result.ok };
  }
  const config = await git(['config','--no-includes','--null','--list','--file',path.join(root,'.git/config')]);
  if (!config.ok || !safeLocalGitConfig(config.output, input.url)) throw new Error('unsafe git configuration');
  if (input.operation === 'fetch') {
    // Explicit URL/refspec: no mutable remote.*, tags, submodules or prune policy.
    return { ok: (await git(['fetch','--no-tags','--',input.url,`refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`], root, true)).ok };
  }
  const head = await git(['rev-parse','HEAD']);
  if (!head.ok || head.output.trim() !== input.commitSha) throw new Error('local commit changed');
  if (input.operation === 'push') {
    let pushArgs = ['push','--porcelain','--',input.url,`${input.commitSha}:refs/heads/${input.branch}`];
    if (input.expectedRemoteSha) {
      const remoteBefore = await git(['ls-remote','--exit-code','--',input.url,`refs/heads/${input.branch}`], root, true);
      if (!remoteBefore.ok || remoteBefore.output.trim() !== `${input.expectedRemoteSha}\trefs/heads/${input.branch}`) {
        return { ok: false };
      }
      // The lease closes the race after ls-remote; the ancestry check prevents
      // the lease option from ever authorizing a history rewrite.
      const ancestor = await git(['merge-base','--is-ancestor',input.expectedRemoteSha,input.commitSha]);
      if (!ancestor.ok || input.expectedRemoteSha === input.commitSha) return { ok: false };
      pushArgs = ['push','--porcelain',`--force-with-lease=refs/heads/${input.branch}:${input.expectedRemoteSha}`,
        '--',input.url,`${input.commitSha}:refs/heads/${input.branch}`];
    }
    // Push the reviewed SHA, never a moving local ref or an unchecked rewrite.
    const pushed = await git(pushArgs, root, true);
    if (!pushed.ok) return { ok: false };
  }
  const remote = await git(['ls-remote','--exit-code','--',input.url,`refs/heads/${input.branch}`], root, true);
  const expected = `${input.commitSha}\trefs/heads/${input.branch}`;
  return remote.ok && remote.output.trim() === expected ? { ok: true, commitSha: input.commitSha } : { ok: false };
}

export const gitRemoteRouter = Router();
const busy = new Set<string>();
gitRemoteRouter.post('/remote', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  let input: Input;
  try { input = parseRemoteGitInput(req.body); }
  catch { res.status(400).json({ error: 'Invalid bounded Git operation' }); return; }
  if (busy.has(input.workspaceRoot)) { res.status(409).json({ error: 'Workspace Git operation already active' }); return; }
  busy.add(input.workspaceRoot);
  try { res.json(await runRemoteGit(input)); }
  catch { res.status(409).json({ error: 'Git operation unverified; no automatic retry' }); }
  finally { busy.delete(input.workspaceRoot); }
});
