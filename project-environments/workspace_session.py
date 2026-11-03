"""Run-private mutable workspaces; no Docker build, commit, host mounts or credentials.

The checkout in agent-workspace remains authoritative. Only its verified source
archive enters this worker. Installed tools and dependency directories survive
corrections; source files and processes do not. Receipts, not a mutable worker,
are the evidence. Interrupted operations are never automatically replayed.
"""
import base64
import json
import os
import re
from pathlib import Path

from stack_contract import digest, UUID
from codegen_contract import verify_inputs, export_outputs

MODE = 'workspace-session-v1'
SESSION_LABEL = 'io.argus.workspace-session'
MAX_SESSIONS = 4


def session_capacity(store, thread):
    """Read-only admission, called under the controller lock before any intent.

    Retained workers consume disk slots even when stopped. Changing the limit
    neither removes their evidence nor changes the single-operation lock.
    """
    value = os.environ.get('ARGUS_WORKSPACE_MAX_SESSIONS', str(MAX_SESSIONS))
    if not re.fullmatch(r'[1-9][0-9]?', value) or not 1 <= int(value) <= 32:
        raise ValueError('stack_session_capacity_config_invalid')
    markers = session_markers(store)
    if not any(m['threadId'] == thread for m in markers) and len(markers) >= int(value):
        raise ValueError('stack_session_capacity')

# No shell interpolation of source paths. Do not follow symlinks, including
# dependency-directory symlinks; those are removed rather than retained.
SYNC_SOURCE = '''import os, shutil, stat
root = '/repo'
if not stat.S_ISDIR(os.lstat(root).st_mode):
    raise RuntimeError('workspace source root is not a directory')
def clean(folder):
    for entry in os.scandir(folder):
        if entry.is_symlink():
            os.unlink(entry.path)
        elif entry.is_dir(follow_symlinks=False):
            if entry.name not in {'.venv', 'node_modules'}:
                clean(entry.path)
                if not os.listdir(entry.path):
                    os.rmdir(entry.path)
        else:
            os.unlink(entry.path)
clean(root)
'''


def session_markers(store):
    directory = Path(store) / 'workspace-sessions'
    if not directory.exists():
        return []
    values = []
    for marker in directory.glob('*.json'):
        value = json.loads(marker.read_text())
        if (not re.fullmatch(UUID, marker.stem) or value.get('threadId') != marker.stem
                or not re.fullmatch(r'[a-f0-9]{64}', value.get('containerId', ''))
                or not re.fullmatch(r'[a-f0-9]{64}', value.get('networkId', ''))):
            raise ValueError('stack_session_marker_invalid')
        values.append(value)
    return values


def retained_workers(store):
    return {v['containerId'] for v in session_markers(store)}


def stop_worker(container):
    from docker.errors import NotFound
    try:
        try:
            container.stop(timeout=2)
        except NotFound:
            return
        except Exception:
            container.kill()
        container.reload()
        if container.attrs.get('State', {}).get('Running') is not False:
            raise ValueError('stack_session_stop_unconfirmed')
    except NotFound:
        return
    except Exception:
        raise ValueError('stack_session_stop_unconfirmed') from None


def assert_stopped(runner, thread):
    marker = next((v for v in session_markers(runner.store) if v['threadId'] == thread), None)
    if marker:
        from docker.errors import NotFound
        try:
            container = runner.client.containers.get(marker['containerId'])
            container.reload()
            if container.attrs.get('State', {}).get('Running') is not False:
                raise ValueError('stack_session_stop_unconfirmed')
        except NotFound:
            return


def save_state(runner, value):
    from stack_runner import durable
    directory = runner.store / 'workspace-sessions'
    directory.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(runner.store, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    target = directory / (value['threadId'] + '.json')
    pending = directory / (value['threadId'] + '.pending')
    # An interrupted write is uncertainty, not permission to replace it.
    durable(pending, value)
    os.replace(pending, target)
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def worker(runner, request):
    from stack_runner import LABEL, OWNER, container_options
    from workspace_database import configured
    database = configured(runner)
    database_id = database.id if database else None
    marker = next((v for v in session_markers(runner.store) if v['threadId'] == request['threadId']), None)
    if marker:
        if marker.get('activeRequest') is not None:
            raise ValueError('stack_interrupted_no_replay')
        if marker['baseImage'] != runner.base or marker['baseCommitSha'] != request['baseCommitSha']:
            raise ValueError('stack_session_binding_changed')
        if marker.get('databaseContainerId') != database_id:
            raise ValueError('stack_database_binding_changed')
        container = runner.client.containers.get(marker['containerId'])
        container.reload()
        labels = container.attrs.get('Config', {}).get('Labels', {})
        if labels.get(SESSION_LABEL) != request['threadId'] or labels.get(LABEL) != OWNER:
            raise ValueError('stack_session_binding_changed')
        if container.attrs.get('State', {}).get('Running'):
            raise ValueError('stack_session_still_running')
        return container, marker
    if request.get('phase') == 'qa':
        raise ValueError('stack_session_missing')
    session_capacity(runner.store, request['threadId'])
    network = runner.client.networks.create('argus-workspace-' + request['threadId'], internal=True,
        labels={LABEL: OWNER, SESSION_LABEL: request['threadId']},
        options={'com.docker.network.bridge.gateway_mode_ipv4': 'isolated', 'com.docker.network.bridge.gateway_mode_ipv6': 'isolated'})
    options = container_options(runner.base, 'argus-workspace-' + request['threadId'], network.id)
    options['labels'][SESSION_LABEL] = request['threadId']
    container = runner.client.containers.create(**options)
    marker = {'version': 1, 'threadId': request['threadId'], 'containerId': container.id,
              'networkId': network.id, 'baseImage': runner.base, 'baseCommitSha': request['baseCommitSha'],
              'databaseContainerId': database_id, 'lastResult': None}
    save_state(runner, marker)
    return container, marker


def verify_qa_predecessor(runner, request, marker):
    key = request['preparedSession']
    if marker['lastResult'] != key:
        raise ValueError('stack_session_evidence_stale')
    result = json.loads((runner.store / key / 'result.json').read_text())
    if (result.get('executionMode') != MODE or result.get('phase') != 'project'
            or result.get('status') != 'completed' or result.get('exitCode') != 0
            or result.get('testStarted') is not True or result.get('preparedSession') != key
            or result.get('sourceSha256') != request['sourceSha256']
            or result.get('planSha256') != digest(request['plan'])
            or result.get('basisSha256') != request['basisSha256']
            or result.get('sessionId') != digest([request['threadId'], marker['containerId']])):
        raise ValueError('stack_session_evidence_stale')


def run(runner, request, generation=False):
    from stack_runner import (LOCK, CANCEL, LABEL, OWNER, SETUP_SECONDS, TEST_SECONDS,
                              archive, durable, execute)
    from stack_startup import execute_tests
    if os.environ.get('ARGUS_WORKSPACE_SESSIONS_ENABLED') != 'true':
        raise ValueError('stack_session_disabled')
    key = digest(['codegen-v1', request]) if generation else digest(request)
    if not LOCK.acquire(blocking=False):
        raise ValueError('stack_busy')
    container = network = lease = None
    try:
        runner.active_thread = request['threadId']
        CANCEL.clear()
        if (runner.store / (request['threadId'] + '.canceled.json')).exists():
            raise ValueError('stack_canceled')
        job = runner.store / key
        if job.exists():
            if not (job / 'result.json').exists():
                raise ValueError('stack_interrupted_no_replay')
            return json.loads((job / 'result.json').read_text())
        # A full retention pool has not accepted any execution. Do not poison
        # the request with an uncertain intent before rejecting admission.
        session_capacity(runner.store, request['threadId'])
        job.mkdir(mode=0o700)
        durable(job / 'intent.json', {'requestSha256': key, 'threadId': request['threadId'],
                                     'executionMode': MODE, 'planSha256': digest(request['plan'])})
        fd = os.open(runner.store, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        container, marker = worker(runner, request)
        setup_environment = {'ARGUS_WORKSPACE_DATABASE': 'none'}
        if marker.get('databaseContainerId'):
            from workspace_database import validate
            db_major = validate(runner, runner.client.containers.get(marker['databaseContainerId']))
            setup_environment = {'ARGUS_WORKSPACE_DATABASE': 'postgresql', 'TEST_POSTGRES_VERSION': str(db_major)}
        network = runner.client.networks.get(marker['networkId'])
        network.reload()
        if not network.attrs.get('Internal') or network.attrs.get('Labels', {}).get(SESSION_LABEL) != request['threadId']:
            raise ValueError('stack_session_binding_changed')
        qa = not generation and request['phase'] == 'qa'
        if qa:
            verify_qa_predecessor(runner, request, marker)
        # Invalidate prior readiness BEFORE any mutable work. This also blocks
        # using an older project receipt after a failed/interrupted operation.
        save_state(runner, {**marker, 'lastResult': None, 'activeRequest': key})
        container.put_archive('/tmp', archive([('argus-source-sync.py', SYNC_SOURCE.encode())]))
        container.start()
        cleaned = execute(runner.client, container, '/usr/bin/python3 /tmp/argus-source-sync.py', 60)
        container.stop(timeout=2)
        if cleaned['status'] != 'completed':
            raise ValueError('stack_session_sync_failed')
        container.put_archive('/', archive([('repo/' + f['path'], base64.b64decode(f['content'])) for f in request['source']]))
        verify_inputs(container, request['source'])
        result = {'version': 1, 'requestSha256': key, 'sourceSha256': request['sourceSha256'],
                  'basisSha256': request['basisSha256'], 'planSha256': digest(request['plan']),
                  'baseImage': runner.base, 'executionMode': MODE,
                  'sessionId': digest([request['threadId'], container.id]), 'phase': 'setup',
                  **({'outputs': []} if generation else {'preparedImage': None, 'preparedSession': request.get('preparedSession')})}
        if not qa:
            network.connect(runner.egress, aliases=['stack-egress'])
            container.start()
            # Idempotent manifest/lock reconciliation, not a frozen-image cache.
            # Existing tools, venvs and package caches remain available.
            result.update(execute(runner.client, container, request['plan']['setup'], SETUP_SECONDS, proxy=True, environment=setup_environment))
            container.stop(timeout=2)
            network.disconnect(runner.egress, force=True)
            if result['status'] != 'completed':
                durable(job / 'result.json', result)
                save_state(runner, {**marker, 'lastResult': key, 'activeRequest': None})
                return result
            verify_inputs(container, request['source'])
        if CANCEL.is_set():
            raise ValueError('stack_canceled')
        if marker.get('databaseContainerId'):
            from workspace_database import Lease
            lease = Lease(runner, runner.client.containers.get(marker['databaseContainerId']), marker)
            result['workspaceDatabase'] = lease.prepare()
        environment = lease.environment if lease else {'ARGUS_WORKSPACE_DATABASE': 'none'}
        container.start()
        if generation:
            result.update(execute(runner.client, container, request['plan']['start'] + '\n' + request['plan']['generate'], TEST_SECONDS, environment=environment))
            result['phase'] = 'generate'
        else:
            if qa:
                container.put_archive('/tmp', archive([('argus-qa.py', request['probe'].encode())]))
            command = request['plan']['python'] + ' -u /tmp/argus-qa.py' if qa else request['plan']['test']
            result.update(execute_tests(runner.client, container, request['plan']['start'], command, TEST_SECONDS, strict_output=qa, environment=environment))
            result['phase'] = request['phase']
        container.stop(timeout=2)
        if generation and result['status'] == 'completed':
            verify_inputs(container, request['source'], request['plan']['outputPaths'])
            result['outputs'] = export_outputs(container, request)
        if lease:
            lease.close()
            lease.redact(result)
        if not generation and not qa:
            result['preparedSession'] = key
        durable(job / 'result.json', result)
        save_state(runner, {**marker, 'lastResult': key, 'activeRequest': None})
        return result
    finally:
        # Retain only the stopped private filesystem. No services, installers,
        # egress or credential-bearing volumes live on between operations.
        stop_error = None
        if container is not None:
            try:
                stop_worker(container)
            except ValueError as error:
                stop_error = error
        if lease is not None:
            try:
                lease.close()
            except ValueError as error:
                stop_error = error
        if network is not None:
            try:
                network.disconnect(runner.egress, force=True)
            except Exception:
                pass
        runner.active_thread = None
        LOCK.release()
        if stop_error:
            raise stop_error
