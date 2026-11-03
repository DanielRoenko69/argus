"""Exercise the Dev recipe helper with the installed controller, offline.

Synthetic probes verify shell/timeout/startup boundaries, NOT FastAPI acceptance
or that an LLM always emits the requested checks. No live Runner/DB/receipts.
"""
import base64
import inspect
import json
import os
import uuid
import docker
from stack_runner import container_options
from stack_startup import execute_tests

assert os.environ['ARGUS_STACK_INSTANCE'].startswith('preflight-cert-')
image = os.environ['PREFLIGHT_CERT_IMAGE']
assert image.startswith('sha256:')
helper = base64.b64decode(os.environ['PREFLIGHT_CERT_SHELL']).decode()
assert 'argus_preflight()' in helper
client = docker.from_env(timeout=30)
cases = [
    ('toolchain', 'argus_missing_bunx_fixture', False, 127),
    ('configuration', "bash -c 'printf synthetic-secret >&2; exit 7'", False, 7),
    ('database', "bash -c 'test 16 = 18'", False, 1),
    ('service', "bash -c 'exit 22'", False, 22),
    ('configuration', "bash -c 'test \"$FIXTURE_CONFIG\" = valid'", True, 0),
    ('service', 'sleep 40', False, 124),
]
results = []
for category, probe, ok, code in cases:
    worker = client.containers.create(**container_options(
        image, 'argus-preflight-cert-' + uuid.uuid4().hex[:12], 'none'))
    try:
        worker.start()
        worker.reload()
        assert not worker.attrs['Mounts']
        assert worker.attrs['HostConfig']['NetworkMode'] == 'none'
        result = execute_tests(client, worker,
            helper + '\nexport FIXTURE_CONFIG=valid\nargus_preflight ' + category + ' ' + probe,
            'test "$FIXTURE_CONFIG" = valid; printf \'{"fixture":"tests-started"}\\n\'', 30)
        assert result['testStarted'] is ok, result
        assert (result['status'] == 'completed') is ok, result
        assert result['exitCode'] == code, result
        assert ('tests-started' in result['stdout']) is ok, result
        assert 'synthetic-secret' not in result['stdout'] + result['stderr'], result
        assert '[environment preflight]' not in result['stdout'], result
        results.append({'category': category, 'exitCode': code, 'testStarted': ok,
                        'status': result['status']})
    finally:
        # Remove only this fixture-owned worker; no live-container enumeration.
        worker.remove(force=True)
print(json.dumps({'passed': True, 'installedHelper': inspect.getfile(execute_tests),
                  'offline': True, 'liveRunTouched': False, 'cases': results}))
