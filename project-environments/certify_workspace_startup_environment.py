"""Test the actual installed startup helper with an offline disposable worker.

Run from the candidate controller's /app, not a source-directory PYTHONPATH.
No Runner instance, live receipts, source, database or credentials are used.
"""
import inspect
import json
import os
import uuid
import docker
from stack_runner import container_options
from stack_startup import execute_tests

assert 'environment' in inspect.signature(execute_tests).parameters
assert os.environ['ARGUS_STACK_INSTANCE'].startswith('startup-env-cert-')
image = os.environ['STARTUP_CERT_IMAGE']
assert image.startswith('sha256:')
client = docker.from_env(timeout=30)
results = []
for startup_ok in [False, True]:
    worker = client.containers.create(**container_options(
        image, 'argus-startup-env-cert-' + uuid.uuid4().hex[:12], 'none'))
    try:
        worker.start()
        worker.reload()
        assert not worker.attrs['Mounts']
        assert worker.attrs['HostConfig']['NetworkMode'] == 'none'
        start = 'test "$ARGUS_STARTUP_FIXTURE" = synthetic; export START_CHECKED=yes'
        if not startup_ok:
            start += '; false'
        tests = 'test "$ARGUS_STARTUP_FIXTURE" = synthetic; test "$START_CHECKED" = yes; echo fixture-pass'
        result = execute_tests(client, worker, start, tests, 15,
                               environment={'ARGUS_STARTUP_FIXTURE': 'synthetic'})
        assert result['testStarted'] is startup_ok
        assert (result['status'] == 'completed') is startup_ok
        assert ('fixture-pass' in result['stdout']) is startup_ok
        results.append({'startupOk': startup_ok, 'testsStarted': result['testStarted'], 'status': result['status']})
    finally:
        # Only the exact worker created above; never scan/delete other workers.
        worker.remove(force=True)
print(json.dumps({'passed': True, 'installedHelper': inspect.getfile(execute_tests),
                  'offline': True, 'liveRunTouched': False, 'cases': results}))
