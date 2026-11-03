"""Read-only lookup of a completed generator operation. Never dispatch a worker."""
import json
from codegen_contract import parse_codegen_request
from stack_contract import digest


def completed_result(runner, value):
    from stack_runner import LOCK, LABEL, OWNER
    from workspace_session import MODE, SESSION_LABEL, session_markers
    request = parse_codegen_request(value)
    if request.get('executionMode') != MODE or not LOCK.acquire(blocking=False):
        raise ValueError('codegen_recovery_unavailable')
    try:
        thread = request['threadId']
        key = digest(['codegen-v1', request])
        if (runner.store / (thread + '.canceled.json')).exists():
            raise ValueError('codegen_canceled')
        marker = next((m for m in session_markers(runner.store) if m['threadId'] == thread), None)
        if (not marker or marker.get('activeRequest') is not None or marker.get('lastResult') != key
                or marker.get('baseCommitSha') != request['baseCommitSha']
                or marker.get('baseImage') != runner.base
                or (runner.store / 'workspace-sessions' / (thread + '.pending')).exists()):
            raise ValueError('codegen_recovery_unavailable')
        container = runner.client.containers.get(marker['containerId'])
        container.reload()
        labels = container.attrs.get('Config', {}).get('Labels', {})
        if (container.attrs.get('State', {}).get('Running') is not False
                or labels.get(SESSION_LABEL) != thread or labels.get(LABEL) != OWNER):
            raise ValueError('codegen_recovery_unavailable')
        job = runner.store / key
        intent = json.loads((job / 'intent.json').read_text())
        result = json.loads((job / 'result.json').read_text())
        if (intent.get('threadId') != thread or intent.get('requestSha256') != key
                or intent.get('planSha256') != digest(request['plan'])
                or result.get('requestSha256') != key or result.get('status') != 'completed'
                or result.get('exitCode') != 0 or result.get('phase') != 'generate'
                or result.get('sourceSha256') != request['sourceSha256']
                or result.get('basisSha256') != request['basisSha256']
                or result.get('planSha256') != digest(request['plan'])
                or result.get('executionMode') != MODE or result.get('baseImage') != runner.base
                or result.get('sessionId') != digest([thread, container.id])):
            raise ValueError('codegen_recovery_unavailable')
        return result
    finally:
        LOCK.release()
