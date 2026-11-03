"""Keep startup and tests in one shell, but record the boundary separately.

The marker is diagnostic evidence, not an authorization or proof of assertions.
It never appears in stdout (independent QA uses that stream as a protocol).
Exports, functions, background services and EXIT traps must survive into tests.
"""
import io
import tarfile
import uuid
from docker.errors import NotFound


def execute_tests(client, container, start, tests, seconds, strict_output=False, environment=None):
    from stack_runner import execute
    marker = '/tmp/.argus-test-started-' + uuid.uuid4().hex
    script = start + "\nprintf '1\\n' > " + marker + '\n' + tests
    result = execute(client, container, script, seconds, strict_output=strict_output,
                     **({'environment': environment} if environment else {}))
    try:
        stream, _ = container.get_archive(marker)
    except NotFound:
        return {**result, 'testStarted': False}
    payload = bytearray()
    for chunk in stream:
        payload.extend(chunk)
        if len(payload) > 16384:
            raise ValueError('stack_startup_evidence_invalid')
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:*') as tar:
        members = tar.getmembers()
        if len(members) != 1 or not members[0].isfile() or members[0].size != 2 or tar.extractfile(members[0]).read() != b'1\n':
            raise ValueError('stack_startup_evidence_invalid')
    return {**result, 'testStarted': True}
