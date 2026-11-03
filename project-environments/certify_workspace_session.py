"""Real Docker lifecycle certification. No model, API token, image build or snapshot.

Run in a dedicated controller process with a unique ARGUS_STACK_INSTANCE,
existing pinned ARGUS_STACK_BASE_IMAGE and Docker socket. Only fixture-owned
workers/networks are removed; live stack instances and images are untouched.
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


def source(files):
    return [{'path': name, 'content': base64.b64encode(content.encode()).decode()} for name, content in sorted(files.items())]


def main():
    if not OWNER.startswith('workspace-cert-'):
        raise ValueError('fixture requires a unique workspace-cert instance')
    client = docker.from_env(timeout=30)
    base = os.environ['ARGUS_STACK_BASE_IMAGE']
    database_enabled = bool(os.environ.get('ARGUS_WORKSPACE_DATABASE_CONTAINER'))
    egress_network = client.networks.create(OWNER + '-egress', internal=not database_enabled, labels={'io.argus.workspace-cert': OWNER})
    options = container_options(base, OWNER + '-egress', egress_network.id)
    options['labels'] = {'io.argus.workspace-cert': OWNER}
    if database_enabled:
        options.update(image='argus-stack-egress:20260929-vendor-domains', command=['python3', '-u', 'stack_egress.py'], working_dir='/app', user='1000:1000')
    egress = client.containers.create(**options)
    egress.start()
    start = time.monotonic()
    try:
        with tempfile.TemporaryDirectory() as folder, patch('docker.models.containers.Container.commit', side_effect=AssertionError('snapshot forbidden')), patch('docker.models.images.ImageCollection.build', side_effect=AssertionError('build forbidden')):
            runner = Runner(client, folder, base, egress.id)
            thread = str(uuid.uuid4())
            common = {'version': 1, 'threadId': thread, 'basisSha256': 'b' * 64, 'baseCommitSha': 'a' * 40, 'executionMode': MODE}
            setup = "mkdir -p /opt/argus-fixture /repo/.venv /repo/frontend/node_modules\nif [ ! -f /opt/argus-fixture/tool ]; then printf installed > /opt/argus-fixture/tool; fi\nprintf dependency > /repo/.venv/fixture\nprintf dependency > /repo/frontend/node_modules/fixture"
            if database_enabled:
                setup += '\ntest -z "${PGPASSWORD:-}"\ntest "$ARGUS_WORKSPACE_DATABASE" = postgresql\ntest "$TEST_POSTGRES_VERSION" = 18\nif ! command -v psql >/dev/null; then apt-get update -qq && apt-get install -y --no-install-recommends postgresql-client; fi'
            hidden = {'.python-version': '3.14\n', '.config/project/test.json': '{}\n', '.env.example': 'FIXTURE=yes\n'}
            files = {**hidden, 'value.py': 'VALUE = 1\n', 'removed.py': 'old = True\n'}
            setup += '\ntest "$(cat /repo/.python-version)" = 3.14\ntest -f /repo/.config/project/test.json\ntest -f /repo/.env.example'
            def bound(plan, **extra):
                archive = source(files)
                manifest = [[f['path'], hashlib.sha256(base64.b64decode(f['content'])).hexdigest()] for f in archive]
                return {**common, 'plan': plan, 'source': archive, 'sourceSha256': digest([common['baseCommitSha'], manifest]), **extra}
            generator = {'version': 1, 'summary': 'Fixture repository generator', 'setup': setup, 'start': '',
                         'generate': "python3 -c \"from value import VALUE; open('client.txt', 'w').write(str(VALUE))\"", 'outputPaths': ['client.txt']}
            generated = runner.generate(bound(generator))
            assert generated['status'] == 'completed' and generated['phase'] == 'generate', generated
            assert base64.b64decode(generated['outputs'][0]['content']) == b'1'
            files['client.txt'] = '1'  # emulate verified import into canonical checkout
            plan = {'version': 1, 'summary': 'Fixture project and QA', 'setup': setup,
                    'start': 'export FIXTURE_READY=1\ntest -f /repo/.venv/fixture\ntest -f /repo/frontend/node_modules/fixture',
                    'test': "python3 -c \"import os; from value import VALUE; assert os.environ['FIXTURE_READY']=='1'; assert open('client.txt').read()==str(VALUE)\"\nprintf stale > /repo/test-output.txt",
                    'python': '/usr/bin/python3'}
            if database_enabled:
                plan['start'] += '\ntest "$ARGUS_WORKSPACE_DATABASE" = postgresql\npsql -X -q -v ON_ERROR_STOP=1 -c "CREATE TABLE fixture(value int); INSERT INTO fixture VALUES (1);" >/dev/null'
                plan['test'] += '\ntest "$(psql -XAtc \'SELECT value FROM fixture\')" = 1'
            project = runner.run(bound(plan, phase='project', probe='', preparedImage=None, preparedSession=None))
            assert project['status'] == 'completed' and project['testStarted'], project
            assert project['sessionId'] == generated['sessionId'] and project['preparedImage'] is None
            def qa_for(project):
                return bound(plan, phase='qa', probe="import sys, os\nsys.path.insert(0, '/repo')\nfrom value import VALUE\nassert os.environ['FIXTURE_READY']=='1'\nassert not os.path.exists('/repo/test-output.txt')\nassert open('/repo/client.txt').read()==str(VALUE)\nprint('independent fixture passed')\n",
                             preparedImage=None, preparedSession=project['preparedSession'])
            qa = runner.run(qa_for(project))
            assert qa['status'] == 'completed' and qa['testStarted'], qa
            assert runner.run(qa_for(project)) == qa  # idempotent evidence read
            # Another implementation revision and deletion, same installed worker.
            files = {**hidden, 'value.py': 'VALUE = 2\n'}
            next_generation = runner.generate(bound(generator))
            assert next_generation['status'] == 'completed', next_generation
            assert base64.b64decode(next_generation['outputs'][0]['content']) == b'2'
            files['client.txt'] = '2'
            plan = {**plan, 'start': plan['start'] + '\ntest ! -e /repo/removed.py'}
            next_project = runner.run(bound(plan, phase='project', probe='', preparedImage=None, preparedSession=None))
            assert next_project['status'] == 'completed', next_project
            next_qa = runner.run(qa_for(next_project))
            assert next_qa['status'] == 'completed', next_qa
            assert next_project['sessionId'] == project['sessionId'] == next_generation['sessionId']
            assert next_project['preparedSession'] != project['preparedSession']
            markers = session_markers(Path(folder))
            assert len(markers) == 1
            worker = client.containers.get(markers[0]['containerId'])
            assert not worker.attrs['State']['Running']
            assert not worker.attrs['Mounts']
            assert worker.attrs['HostConfig']['Privileged'] is False
            private = client.networks.get(markers[0]['networkId'])
            assert private.attrs['Internal'] is True
            assert set(private.attrs.get('Containers', {})) <= {worker.id}
            if database_enabled:
                from certify_workspace_database import verify_boundaries
                verify_boundaries(runner, worker, markers[0], project, qa)
            # A restart preserves the worker, never resumes commands by itself.
            restarted = Runner(client, folder, base, egress.id)
            assert restarted.run(qa_for(next_project)) == next_qa
            assert restarted.cancel(thread) == {'stopped': True}
            try:
                restarted.run(qa_for(next_project))
                raise AssertionError('canceled request executed')
            except ValueError as error:
                assert str(error) == 'stack_canceled'
            from workspace_retirement import operate
            preview = operate(restarted, {'threadId': thread})
            retired = operate(restarted, {'threadId': thread, 'expectedSha256': preview['expectedSha256']}, apply=True)
            assert retired['state'] == 'retired' and not session_markers(Path(folder))
            assert json.loads((Path(folder) / next_qa['requestSha256'] / 'result.json').read_text()) == next_qa
            assert operate(restarted, {'threadId': thread, 'expectedSha256': preview['expectedSha256']}, apply=True) == retired
            restarted = Runner(client, folder, base, egress.id)
            try:
                restarted.run(qa_for(next_project))
                raise AssertionError('retired request executed')
            except ValueError as error:
                assert str(error) == 'stack_canceled'
            print(json.dumps({'passed': True, 'phases': ['generate', 'project', 'qa', 'generate-revision', 'project-revision', 'qa-revision', 'restart', 'cancel', 'retire'],
                'hiddenProjectInputs': sorted(hidden), 'workersCreated': 1, 'imageBuilds': 0, 'imageSnapshots': 0, 'seconds': round(time.monotonic() - start, 2)}))
    finally:
        for container in client.containers.list(all=True, filters={'label': LABEL + '=' + OWNER}):
            container.remove(force=True)
        for network in client.networks.list(filters={'label': LABEL + '=' + OWNER}):
            try:
                network.disconnect(egress, force=True)
            except Exception:
                pass
            network.remove()
        egress.remove(force=True)
        egress_network.remove()


if __name__ == '__main__':
    main()
