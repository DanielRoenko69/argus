"""Real FastAPI checkout acceptance on the candidate session controller.

No model or live checkout writes. Install inside one fixture-owned worker,
execute the unchanged repository generator/tests, then discard fixture resources.
PostgreSQL 18 matches the repository's Compose contract. This is not a
substitute for frozen workflow QA/SSO/CI.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import uuid
from unittest.mock import patch

import docker
from stack_contract import digest
from stack_runner import Runner, LABEL, OWNER, container_options
from workspace_session import MODE, session_markers
from workspace_retirement import operate


SETUP = r'''
test "$ARGUS_WORKSPACE_DATABASE" = postgresql
test "$TEST_POSTGRES_VERSION" = 18
if ! command -v uv >/dev/null; then curl -fsSL https://astral.sh/uv/install.sh | sh; fi
if ! command -v bun >/dev/null; then curl -fsSL https://bun.sh/install | bash; fi
if ! command -v node >/dev/null; then
  case "$(uname -m)" in aarch64) arch=arm64;; x86_64) arch=x64;; *) exit 2;; esac
  curl -fsSL "https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-$arch.tar.gz" -o /tmp/node.tar.gz
  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1
  rm /tmp/node.tar.gz
fi
uv sync --locked --all-packages
bun install --frozen-lockfile
cd frontend
if [ ! -f /opt/argus-fastapi-browser-ready ]; then
  bunx playwright install --with-deps --only-shell chromium
  touch /opt/argus-fastapi-browser-ready
fi
uv --version; bun --version; node --version
/repo/.venv/bin/python --version
'''

ENVIRONMENT = r'''
export PROJECT_NAME=ArgusWorkspaceAcceptance
export SECRET_KEY=disposable-fixture-secret-never-used-outside-test
export FIRST_SUPERUSER=admin@example.com
export FIRST_SUPERUSER_PASSWORD=Disposable-Only-Password-2026
export EMAILS_FROM_EMAIL=ci@example.com
export FASTAPI_ENV=development
export VITE_API_URL=http://localhost:8000
export FRONTEND_HOST=http://localhost:5173
export UV_OFFLINE=1
/repo/.venv/bin/python --version
uv --version; bun --version; node --version
'''

# These are the repository's unchanged OpenAPI export + openapi-ts commands.
# Its wrapper additionally runs a global auto-fixing lint; that is not a
# generated-client write and intentionally stays outside this narrow grant.
GENERATE = r'''
cd backend
FASTAPI_ENV=development uv run python -c "import app.main; import json; print(json.dumps(app.main.app.openapi()))" > ../openapi.json
cd ..
mv openapi.json frontend/
bun run --filter frontend generate-client
'''

START = ENVIRONMENT + r'''
cd /repo/backend
/repo/.venv/bin/alembic upgrade head
/repo/.venv/bin/python app/initial_data.py
/repo/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 >/tmp/fastapi-server.log 2>&1 &
for attempt in $(seq 1 60); do
  if curl -fsS http://localhost:8000/api/v1/utils/health-check/ >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://localhost:8000/api/v1/utils/health-check/
cd /repo
'''

TEST = r'''
cd /repo/backend
/repo/.venv/bin/python -m pytest tests/api/routes/test_items.py -q
# The repository's session fixture deletes ALL users during teardown. Re-seed
# the browser suite with the repository initializer, without changing a test.
/repo/.venv/bin/python app/initial_data.py
cd /repo/frontend
bun run build
bunx playwright test tests/items.spec.ts --project=chromium --workers=1 --retries=0 --reporter=line
'''


def main():
    if not OWNER.startswith('workspace-cert-') or not os.environ.get('ARGUS_WORKSPACE_DATABASE_CONTAINER'):
        raise ValueError('isolated fixture database and owner required')
    data = json.loads(Path('/fixture/source.json').read_text())
    client = docker.from_env(timeout=30)
    base = os.environ['ARGUS_STACK_BASE_IMAGE']
    network = client.networks.create(OWNER + '-egress', labels={'io.argus.workspace-cert': OWNER})
    options = container_options(base, OWNER + '-egress', network.id)
    options.update(image='argus-stack-egress:20260929-vendor-domains', command=['python3', '-u', 'stack_egress.py'],
                   working_dir='/app', user='1000:1000', labels={'io.argus.workspace-cert': OWNER})
    egress = client.containers.create(**options)
    egress.start()
    start = time.monotonic()
    try:
        with tempfile.TemporaryDirectory() as folder, patch('docker.models.containers.Container.commit', side_effect=AssertionError('snapshot forbidden')), patch('docker.models.images.ImageCollection.build', side_effect=AssertionError('build forbidden')):
            runner = Runner(client, folder, base, egress.id)
            thread = str(uuid.uuid4())
            def bound(plan, **extra):
                manifest = [[f['path'], hashlib.sha256(base64.b64decode(f['content'])).hexdigest()] for f in data['source']]
                return {'version': 1, 'threadId': thread, 'basisSha256': 'b' * 64, 'baseCommitSha': data['baseCommitSha'],
                        'executionMode': MODE, 'plan': plan, 'source': data['source'],
                        'sourceSha256': digest([data['baseCommitSha'], manifest]), **extra}
            def check(label, result):
                print(json.dumps({'phase': label, 'status': result.get('status'), 'actualPhase': result.get('phase'),
                    'durationMs': result.get('durationMs'), 'testStarted': result.get('testStarted'),
                    'workspaceDatabase': result.get('workspaceDatabase'),
                    'stdout': result.get('stdout', '')[-18000:], 'stderr': result.get('stderr', '')[-8000:]}), flush=True)
                if result.get('status') != 'completed':
                    raise RuntimeError('FastAPI fixture phase failed: ' + label)
            outputs = sorted(f['path'] for f in data['source'] if f['path'].startswith('frontend/src/client/') and f['path'].endswith('.ts'))
            generator = {'version': 1, 'summary': 'Real repository generator in reusable workspace', 'setup': SETUP,
                         'start': ENVIRONMENT, 'generate': GENERATE, 'outputPaths': outputs}
            print(json.dumps({'phase': 'generator-start', 'threadId': thread, 'baseCommitSha': data['baseCommitSha']}), flush=True)
            generated = runner.generate(bound(generator))
            check('generator', generated)
            imported = {f['path']: f for f in generated['outputs']}
            data['source'] = [{'path': f['path'], 'content': imported.get(f['path'], f)['content']} for f in data['source']]
            plan = {'version': 1, 'summary': 'Real FastAPI item backend and Chromium suite', 'setup': SETUP,
                    'start': START, 'test': TEST, 'python': '/repo/.venv/bin/python'}
            print(json.dumps({'phase': 'project-start', 'sameWorker': True}), flush=True)
            project = runner.run(bound(plan, phase='project', probe='', preparedImage=None, preparedSession=None))
            check('project', project)
            assert project['sessionId'] == generated['sessionId']
            # A separately executed offline acceptance smoke, not a claim that
            # the real workflow's independent QA artifacts were exercised here.
            probe = "import urllib.request,json\nv=json.load(urllib.request.urlopen('http://localhost:8000/openapi.json'))\nassert any(p['name']=='q' for p in v['paths']['/api/v1/items/']['get']['parameters'])\nprint('OpenAPI search parameter present after fresh DB/start')\n"
            qa = runner.run(bound(plan, phase='qa', probe=probe, preparedImage=None, preparedSession=project['preparedSession']))
            check('separate-smoke', qa)
            assert qa['workspaceDatabase'] == project['workspaceDatabase']
            assert len(session_markers(Path(folder))) == 1
            runner.cancel(thread)
            preview = operate(runner, {'threadId': thread})
            operate(runner, {'threadId': thread, 'expectedSha256': preview['expectedSha256']}, apply=True)
            print(json.dumps({'passed': True, 'checkoutChanged': False, 'workersCreated': 1, 'imageBuilds': 0,
                             'imageSnapshots': 0, 'postgresMajor': 18, 'seconds': round(time.monotonic() - start, 2)}), flush=True)
    finally:
        for worker in client.containers.list(all=True, filters={'label': LABEL + '=' + OWNER}):
            worker.remove(force=True)
        for private in client.networks.list(filters={'label': LABEL + '=' + OWNER}):
            for endpoint in (egress.id, os.environ['ARGUS_WORKSPACE_DATABASE_CONTAINER']):
                try:
                    private.disconnect(endpoint, force=True)
                except Exception:
                    pass
            private.remove()
        egress.remove(force=True)
        network.remove()


if __name__ == '__main__':
    main()
