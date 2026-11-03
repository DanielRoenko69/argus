"""Operator-only retirement of one canceled reusable worker, never a test retry.

The private controller owns the lock. A preview is read-only. An explicit apply
preserves receipts, cancellation and the full session marker; only the stopped
worker and its private network are removed. Revoked DB data is retained. A crash
after archiving can finish cleanup, but can never replay execution.
"""
import json
import os
from pathlib import Path
import re

from docker.errors import NotFound
from stack_contract import UUID, digest


def flush(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def target(runner, request):
    from stack_runner import OWNER, LABEL
    from workspace_session import SESSION_LABEL
    if (not isinstance(request, dict) or set(request) - {'threadId', 'expectedSha256'}
            or not isinstance(request.get('threadId'), str) or not re.fullmatch(UUID, request['threadId'])):
        raise ValueError('stack_request_invalid')
    thread = request['threadId']
    if runner.active_thread == thread:
        raise ValueError('stack_session_still_running')
    if not (runner.store / (thread + '.canceled.json')).is_file():
        raise ValueError('stack_session_cancel_required')
    active = runner.store / 'workspace-sessions' / (thread + '.json')
    directory = runner.store / 'workspace-retirements'
    archived = directory / (thread + '.marker.json')
    intent = directory / (thread + '.intent.json')
    if active.with_suffix('.pending').exists() or (active.exists() and archived.exists()):
        raise ValueError('stack_session_marker_invalid')
    marker_file = archived if archived.exists() else active
    if not marker_file.is_file():
        raise ValueError('stack_session_missing')
    marker = json.loads(marker_file.read_text())
    if (marker.get('version') != 1 or marker.get('threadId') != thread
            or any(not isinstance(marker.get(k), str) or not re.fullmatch('[a-f0-9]{64}', marker[k]) for k in ('containerId', 'networkId'))):
        raise ValueError('stack_session_marker_invalid')
    proof = {'version': 1, 'owner': OWNER, 'marker': marker}
    if intent.exists() and json.loads(intent.read_text()) != proof:
        raise ValueError('stack_session_binding_changed')
    if archived.exists() and not intent.exists():
        raise ValueError('stack_session_marker_invalid')
    resources = []
    for kind, key in [('containers', 'containerId'), ('networks', 'networkId')]:
        try:
            resource = getattr(runner.client, kind).get(marker[key])
            resource.reload()
        except NotFound:
            if not archived.exists():
                raise ValueError('stack_session_binding_changed') from None
            resources.append(None)
            continue
        attrs = resource.attrs
        labels = attrs.get('Config', {}).get('Labels', {}) if kind == 'containers' else attrs.get('Labels', {})
        if resource.id != marker[key] or labels.get(LABEL) != OWNER or labels.get(SESSION_LABEL) != thread:
            raise ValueError('stack_session_binding_changed')
        if kind == 'containers':
            if attrs.get('State', {}).get('Running') is not False or attrs.get('State', {}).get('Paused'):
                raise ValueError('stack_session_stop_unconfirmed')
        elif not attrs.get('Internal') or set(attrs.get('Containers', {})) - {marker['containerId']}:
            raise ValueError('stack_session_stop_unconfirmed')
        resources.append(resource)
    return marker, proof, directory, active, archived, intent, resources


def operate(runner, request, apply=False):
    from stack_runner import LOCK, durable
    if not LOCK.acquire(blocking=False):
        raise ValueError('stack_busy')
    try:
        marker, proof, directory, active, archived, intent, (container, network) = target(runner, request)
        key = digest(proof)
        completed = directory / (marker['threadId'] + '.completed.json')
        result = {'version': 1, 'threadId': marker['threadId'], 'containerId': marker['containerId'],
                  'networkId': marker['networkId'], 'expectedSha256': key,
                  'state': 'retired' if completed.exists() else 'cleanup_pending' if archived.exists() else 'retained',
                  'receiptsPreserved': True, 'checkoutPreserved': True,
                  'operationUncertain': bool(marker.get('activeRequest')),
                  'databaseDataRetained': bool(marker.get('databaseContainerId')),
                  'executionWillResume': False}
        if not apply:
            return result
        if request.get('expectedSha256') != key:
            raise ValueError('stack_session_binding_changed')
        if completed.exists():
            if json.loads(completed.read_text()) != {**result, 'state': 'retired'}:
                raise ValueError('stack_session_binding_changed')
            return result
        directory.mkdir(mode=0o700, exist_ok=True)
        flush(runner.store)
        if not intent.exists():
            durable(intent, proof)
        if not archived.exists():
            # The active marker is kept until revocation is proven. Once archived,
            # startup may safely collect the orphan; the canceled thread stays dead.
            from workspace_database import recover
            recover(runner, marker['threadId'])
            os.replace(active, archived)
            flush(directory)
            flush(active.parent)
        if container is not None:
            container.remove()  # deliberately not force=True
        if network is not None:
            network.remove()  # Docker refuses any unexpected attached endpoint
        result['state'] = 'retired'
        durable(completed, result)
        return result
    finally:
        LOCK.release()


if __name__ == '__main__':
    import argparse
    import sys
    import urllib.error
    import urllib.request
    parser = argparse.ArgumentParser(description='Preview/retire one canceled workspace. Deletes its installed tools/cache, not evidence or DB data.')
    parser.add_argument('--thread', required=True)
    parser.add_argument('--retire', action='store_true')
    parser.add_argument('--expected-sha256')
    args = parser.parse_args()
    value = {'threadId': args.thread}
    if args.retire:
        if not args.expected_sha256:
            parser.error('--retire requires the exact --expected-sha256 from preview')
        value['expectedSha256'] = args.expected_sha256
    try:
        request = urllib.request.Request('http://127.0.0.1:8093/workspace-retirement' + ('-apply' if args.retire else '-preview'),
            data=json.dumps(value).encode(), headers={'Content-Type': 'application/json',
            'x-stack-secret': Path('/run/secrets/stack_runner').read_text().strip()})
        with urllib.request.urlopen(request, timeout=60) as response:
            print(response.read().decode())
    except urllib.error.HTTPError as error:
        print(json.dumps({'error': json.loads(error.read()).get('error', 'stack_unavailable_no_replay')}))
        sys.exit(1)
    except Exception:
        print(json.dumps({'error': 'stack_unavailable_no_replay'}))
        sys.exit(1)
