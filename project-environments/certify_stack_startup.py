"""Real offline disposable PostgreSQL fixture; no live source or credentials."""
import json
import os
import uuid
import docker
from stack_runner import container_options
from stack_startup import execute_tests

client = docker.from_env(timeout=30)
image = os.environ['STARTUP_CERT_IMAGE']
owner = os.environ['ARGUS_STACK_INSTANCE']
assert owner.startswith('startup-cert-')
assert image.startswith('sha256:')
results = []
for repaired in [False, True]:
    container = client.containers.create(**container_options(image, 'argus-startup-cert-' + uuid.uuid4().hex[:12], 'none'))
    try:
        container.start()
        start = '''
pg_bin=$(dirname "$(find /usr/lib/postgresql -name pg_ctl -type f | head -1)")
test -x "$pg_bin/pg_ctl"
install -d -m 0700 -o postgres -g postgres /tmp/startup-cert-data
install -d -m 0750 /tmp/argus-postgres-logs
runuser -u postgres -- "$pg_bin/initdb" -D /tmp/startup-cert-data --auth=trust >/dev/null
'''
        if repaired:
            start += '''
install -d -m 0750 -o postgres -g postgres /tmp/argus-postgres-logs
runuser -u postgres -- test -w /tmp/argus-postgres-logs
'''
        start += '''
runuser -u postgres -- "$pg_bin/pg_ctl" -D /tmp/startup-cert-data -l /tmp/argus-postgres-logs/postgres.log -o '-F -p 55432 -h 127.0.0.1 -k /tmp' -w start >/dev/null
'''
        tests = '''test "$(runuser -u postgres -- "$pg_bin/psql" -h 127.0.0.1 -p 55432 -d postgres -Atqc 'SELECT 1')" = 1; printf 'fixture-test-passed\n' '''
        result = execute_tests(client, container, start, tests, 60)
        assert result['testStarted'] is repaired, result['status']
        assert (result['status'] == 'completed') is repaired
        assert ('fixture-test-passed' in result['stdout']) is repaired
        if not repaired:
            assert 'Permission denied' in result['stderr']
        results.append({'repaired': repaired, 'testStarted': result['testStarted'], 'status': result['status']})
    finally:
        container.remove(force=True)
print(json.dumps({'passed': True, 'network': 'none', 'hostMounts': False, 'liveSourceTouched': False, 'cases': results}))
