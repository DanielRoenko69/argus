import http from 'node:http';

const port = Number(process.env.PORT || 4200);

const files = new Map([
  ['/workspace/ARGUS-E2E-LG-1/src/argus-e2e.ts', 'old\n'],
]);

// Repositories cloned through Core's Git broker (POST /git/remote), keyed by
// the grant-bound workspace root. Commits advance a deterministic 40-hex head.
const BASE_SHA = 'a'.repeat(40);
const repositories = new Map();

function repositoryFor(cwd) {
  const dir = String(cwd || '').replace(/\/+$/, '');
  for (const [root, repository] of repositories) {
    if (dir === root || dir.startsWith(`${root}/`)) return repository;
  }
  return undefined;
}

function nextSha(previous) {
  const digit = ((parseInt(previous[0], 16) + 1) % 16).toString(16);
  return digit.repeat(40);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function execResult(command, cwd) {
  const gitDir = /^test -d "([^"]+)\/\.git"/.exec(command);
  if (gitDir) {
    return { stdout: repositoryFor(gitDir[1]) ? 'OK\n' : 'NO\n', stderr: '', exit_code: 0 };
  }
  const repository = repositoryFor(cwd);
  if (command.startsWith('git remote get-url origin')) {
    return repository
      ? { stdout: `${repository.url}\n`, stderr: '', exit_code: 0 }
      : { stdout: '', stderr: 'fatal: not a git repository\n', exit_code: 128 };
  }
  if (repository && command === 'git rev-parse HEAD') {
    return { stdout: `${repository.head}\n`, stderr: '', exit_code: 0 };
  }
  if (repository && /(^|&&\s*|;\s*)git commit\b/.test(command)) {
    repository.head = nextSha(repository.head);
    return { stdout: `[${repository.branch} ${repository.head.slice(0, 7)}] Argus E2E change\n`, stderr: '', exit_code: 0 };
  }
  if (command.includes('[ -f package.json ]') || command.includes('printf node')) {
    return { stdout: 'node\n', stderr: '', exit_code: 0 };
  }
  if (command.includes('npm test') || command.includes('npm run test')) {
    return { stdout: 'ARGUS_E2E_WORKSPACE_OK\nTEST_VERDICT: PASS\n', stderr: '', exit_code: 0 };
  }
  if (command === 'git diff --name-status HEAD') {
    return { stdout: 'M\tsrc/argus-e2e.ts\n', stderr: '', exit_code: 0 };
  }
  if (command === 'git diff --numstat HEAD') {
    return { stdout: '1\t0\tsrc/argus-e2e.ts\n', stderr: '', exit_code: 0 };
  }
  if (command === 'git diff HEAD') {
    return {
      stdout: 'diff --git a/src/argus-e2e.ts b/src/argus-e2e.ts\n--- a/src/argus-e2e.ts\n+++ b/src/argus-e2e.ts\n@@ -1 +1 @@\n-old\n+ARGUS_E2E_LANGGRAPH_CHANGE\n',
      stderr: '',
      exit_code: 0,
    };
  }
  if (command.startsWith('git status --porcelain')) {
    const root = repository ? [...repositories.entries()].find(([, value]) => value === repository)?.[0] : undefined;
    const changed = [...files.entries()].some(([path, content]) => content !== 'old\n'
      && (!root || path.startsWith(`${root}/`)));
    return { stdout: changed ? ' M src/argus-e2e.ts\n' : '', stderr: '', exit_code: 0 };
  }
  if (command.includes('test -d')) {
    return { stdout: 'OK\n', stderr: '', exit_code: 0 };
  }
  if (command === 'git rev-parse HEAD') {
    return { stdout: 'abcdef1234567890\n', stderr: '', exit_code: 0 };
  }
  return { stdout: 'ARGUS_E2E_WORKSPACE_OK\n', stderr: '', exit_code: 0 };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = requestUrl.pathname;
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
  try {
    if (req.method === 'POST' && /^\/api\/v1\/repos\/[^/]+\/[^/]+\/pulls$/.test(path)) {
      return json(res, 201, {
        id: 42,
        number: 42,
        html_url: 'http://fake-workspace:4200/argus-e2e/argus-e2e-repo/pulls/42',
        url: 'http://fake-workspace:4200/api/v1/repos/argus-e2e/argus-e2e-repo/pulls/42',
      });
    }
    // Provider-owned CI retry fixture. Argus must call the provider's native
    // rerun endpoint after the human recovery approval; the next webhook is
    // sent by the E2E test against the returned run id.
    if (req.method === 'POST' && /^\/api\/v1\/repos\/[^/]+\/[^/]+\/actions\/runs\/[^/]+\/rerun$/.test(path)) {
      return json(res, 201, {
        id: 142,
        name: 'Argus E2E Recovery CI',
        status: 'queued',
        head_branch: 'feature/ARGUS-E2E-RECOVERY-1',
        head_sha: 'argus-e2e-recovery-sha',
        html_url: 'http://fake-workspace:4200/argus-e2e/argus-e2e-repo/actions/runs/142',
      });
    }
    if (req.method === 'GET' && path === '/ls') {
      const directory = requestUrl.searchParams.get('path') || '/workspace';
      const entries = [];
      if (/^\/workspace\/ARGUS-/.test(directory) && directory.endsWith('/src')) {
        entries.push({ name: 'argus-e2e.ts', type: 'file', size_bytes: 4, modified_iso: new Date(0).toISOString() });
      } else if (/^\/workspace\/ARGUS-/.test(directory)) {
        entries.push({ name: 'ARGUS_E2E_WORKSPACE_LIST', type: 'file', size_bytes: 1, modified_iso: new Date(0).toISOString() });
        entries.push({ name: 'src', type: 'directory', size_bytes: 0, modified_iso: new Date(0).toISOString() });
      }
      return json(res, 200, { path: directory, entries });
    }
    if (req.method === 'POST' && path === '/read') {
      const body = await readJson(req);
      const filePath = String(body.path || '');
      return json(res, 200, { path: filePath, content: `ARGUS_E2E_FILE_CONTENT\n${files.get(filePath) || ''}` });
    }
    if (req.method === 'POST' && path === '/write') {
      const body = await readJson(req);
      const filePath = String(body.path || '');
      const content = String(body.content || '');
      files.set(filePath, content);
      return json(res, 200, { path: filePath, size_bytes: Buffer.byteLength(content) });
    }
    // Core Git broker transport: clone/fetch/push/verify against the
    // grant-bound workspace root. Receipts carry a 40-hex commit like the
    // real agent-workspace; credentials in `authorization` are ignored.
    if (req.method === 'POST' && path === '/git/remote') {
      const body = await readJson(req);
      const root = String(body.workspaceRoot || '').replace(/\/+$/, '');
      if (!root.startsWith('/workspace/')) return json(res, 400, { error: 'workspace root required' });
      if (body.operation === 'clone') {
        repositories.set(root, { url: String(body.url || ''), branch: String(body.branch || 'master'), head: BASE_SHA });
      }
      const repository = repositories.get(root);
      if (!repository) return json(res, 200, { ok: false });
      if (body.operation === 'push') {
        return json(res, 200, { ok: body.commitSha === repository.head, commitSha: repository.head });
      }
      return json(res, 200, { ok: true, commitSha: repository.head });
    }
    if (req.method !== 'POST' || path !== '/exec') return json(res, 404, { error: 'not found' });
    const body = await readJson(req);
    const result = execResult(String(body.cmd || ''), String(body.cwd || ''));
    if (process.env.FAKE_WORKSPACE_TRACE === '1') {
      process.stdout.write(`exec ${body.cwd || ''} :: ${String(body.cmd || '').slice(0, 200).replace(/\s+/g, ' ')} -> ${result.exit_code}\n`);
    }
    return json(res, 200, result);
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, '0.0.0.0', () => process.stdout.write(`Argus E2E workspace fixture listening on ${port}\n`));
