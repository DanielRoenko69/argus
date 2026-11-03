"""Explicit operator reconciliation of a stopped pre-test snapshot after VM reboot.

Only the private controller operator endpoint accepts reconciliation; it is not
exposed through the Agent/Core bridge. The CLI supplies the exact original request.
The old uncertain export/receipt is never overwritten or replayed. A separately
journalled export is allowed once, only after a later kernel boot proves the old
export cannot still run. Installation is never repeated; tests remain pending.
"""
import base64
import io
import json
from pathlib import Path
import tarfile
import time

from stack_contract import digest, parse_request


def boot_time():
    return next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines() if line.startswith('btime '))


def verify_source(container, request):
    for file in request['source']:
        stream, _ = container.get_archive('/repo/' + file['path'])
        payload = bytearray()
        for chunk in stream:
            payload.extend(chunk)
            if len(payload) > 17 * 1024 ** 2:
                raise ValueError('stack_recovery_source_changed')
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:*') as tar:
            members = tar.getmembers()
            if len(members) != 1 or not members[0].isfile() or tar.extractfile(members[0]).read() != base64.b64decode(file['content']):
                raise ValueError('stack_recovery_source_changed')


def original(runner, request):
    from stack_runner import LABEL, OWNER
    request = parse_request(request)
    if request['phase'] != 'project' or request['preparedImage'] is not None or request['probe']:
        raise ValueError('stack_recovery_project_only')
    key = digest(request)
    job = runner.store / key
    intent = json.loads((job / 'intent.json').read_text())
    meta = json.loads((job / 'snapshot-started.json').read_text())
    expected = {'requestSha256': key, 'threadId': request['threadId'], 'planSha256': digest(request['plan'])}
    if any(intent.get(k) != v or meta.get(k) != v for k, v in expected.items()) or meta.get('sourceSha256') != request['sourceSha256']:
        raise ValueError('stack_recovery_binding_changed')
    if (job / 'result.json').exists() or (runner.store / (request['threadId'] + '.canceled.json')).exists():
        raise ValueError('stack_recovery_terminal')
    container = runner.client.containers.get(meta['containerId'])
    container.reload()
    attrs = container.attrs
    if container.id != meta['containerId'] or attrs.get('State', {}).get('Running') is not False or attrs.get('State', {}).get('Paused'):
        raise ValueError('stack_recovery_worker_not_stopped')
    networks = attrs.get('NetworkSettings', {}).get('Networks', {})
    if attrs.get('Mounts') or set(networks) - {'none'} or attrs.get('Image') != runner.base:
        raise ValueError('stack_recovery_worker_changed')
    if attrs.get('Config', {}).get('Labels', {}).get(LABEL) != OWNER:
        raise ValueError('stack_recovery_worker_changed')
    return request, key, job, meta, container


def preview(runner, request):
    from stack_runner import LABEL, OWNER
    request, key, job, meta, container = original(runner, request)
    if (job / 'recovery-tests-started.json').exists():
        raise ValueError('stack_recovery_already_consumed')
    receipt = json.loads((job / 'recovery-snapshot-completed.json').read_text())
    if any(receipt.get(k) != meta.get(k) for k in ('threadId', 'requestSha256', 'planSha256', 'sourceSha256', 'containerId')):
        raise ValueError('stack_recovery_binding_changed')
    image = runner.client.images.get(receipt['imageId'])
    labels = image.attrs.get('Config', {}).get('Labels', {})
    if image.id != receipt['imageId'] or labels.get(LABEL) != OWNER or labels.get('io.argus.recovery') != key:
        raise ValueError('stack_recovery_image_changed')
    verify_source(container, request)
    return {'version': 1, 'requestSha256': key, 'sourceSha256': request['sourceSha256'],
            'planSha256': digest(request['plan']), 'preparedImage': image.id,
            'containerId': container.id, 'recoverySha256': digest(receipt), 'testsStarted': False}


def reconcile(runner, request):
    from stack_runner import durable, LABEL, OWNER, SNAPSHOT_SECONDS, LOCK
    if not LOCK.acquire(blocking=False):
        raise ValueError('stack_busy')
    try:
        request, key, job, meta, container = original(runner, request)
        if (job / 'recovery-snapshot-completed.json').exists():
            return preview(runner, request)
        if (job / 'snapshot-completed.json').exists():
            raise ValueError('stack_recovery_existing_export_requires_review')
        # A mere stopped process or empty worker registry is NOT this proof.
        boot = boot_time()
        if boot <= (job / 'snapshot-started.json').stat().st_mtime:
            raise ValueError('stack_recovery_engine_reboot_required')
        if (job / 'recovery-snapshot-started.json').exists():
            raise ValueError('stack_recovery_uncertain_no_replay')
        images = runner.client.images.list(filters={'label': LABEL + '=' + OWNER})
        if len(images) >= 8 or sum(i.attrs.get('Size', 0) for i in images) >= 16 * 1024 ** 3:
            raise ValueError('stack_storage_capacity')
        verify_source(container, request)
        intent = {**meta, 'engineBootTime': boot, 'reconciledAt': int(time.time())}
        durable(job / 'recovery-snapshot-started.json', intent)
        timeout = runner.client.api.timeout
        try:
            runner.client.api.timeout = SNAPSHOT_SECONDS
            image = container.commit(pause=False, conf={'Labels': {LABEL: OWNER, 'io.argus.thread': request['threadId'], 'io.argus.recovery': key}})
            durable(job / 'recovery-snapshot-completed.json', {**intent, 'imageId': image.id})
        except Exception:
            raise ValueError('stack_recovery_uncertain_no_replay') from None
        finally:
            runner.client.api.timeout = timeout
        return preview(runner, request)
    finally:
        LOCK.release()


def execute_recovered(runner, request):
    # Called with Runner.run's lock held and the normal authenticated request.
    from stack_runner import durable, container_options, TEST_SECONDS, CANCEL
    from stack_startup import execute_tests
    proof = preview(runner, request)
    job = runner.store / proof['requestSha256']
    durable(job / 'recovery-tests-started.json', proof)
    image_meta = runner.store / (digest([request['threadId'], proof['planSha256'], request['sourceSha256']]) + '.image.json')
    expected = {'image': proof['preparedImage'], 'sourceSha256': request['sourceSha256']}
    if image_meta.exists():
        if json.loads(image_meta.read_text()) != expected:
            raise ValueError('stack_recovery_image_changed')
    else:
        durable(image_meta, expected)
    container = None
    try:
        if CANCEL.is_set():
            raise ValueError('stack_canceled')
        container = runner.client.containers.create(**container_options(proof['preparedImage'], 'argus-recovered-' + proof['requestSha256'][:24], 'none'))
        container.start()
        result = {'version': 1, 'requestSha256': proof['requestSha256'], 'sourceSha256': request['sourceSha256'],
                  'planSha256': proof['planSha256'], 'baseImage': runner.base, 'preparedImage': proof['preparedImage'], 'phase': 'project'}
        result.update(execute_tests(runner.client, container, request['plan']['start'], request['plan']['test'], TEST_SECONDS))
        durable(job / 'result.json', result)
        return result
    finally:
        if container is not None:
            container.remove(force=True)


if __name__ == '__main__':
    import sys
    import urllib.request
    import urllib.error
    # Dispatch in the server process so ordinary jobs, preview and reconciliation
    # share the same lock. No separate Docker client races its cleanup/execution.
    try:
        request = urllib.request.Request('http://127.0.0.1:8093/reconcile-snapshot',
            data=json.dumps(parse_request(json.load(sys.stdin))).encode(),
            headers={'Content-Type':'application/json','x-stack-secret':Path('/run/secrets/stack_runner').read_text().strip()})
        with urllib.request.urlopen(request, timeout=960) as response:
            print(response.read().decode())
    except urllib.error.HTTPError as error:
        value = json.loads(error.read())
        print(json.dumps({'error':value.get('error','stack_recovery_unavailable')}))
        sys.exit(1)
    except Exception as error:
        code = str(error)
        print(json.dumps({'error': code if code.startswith('stack_') and code.replace('_', '').isalpha() else 'stack_recovery_unavailable'}))
        sys.exit(1)
