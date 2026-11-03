"""Code generation is a separate purpose, never test-setup source mutation."""
import base64
import hashlib
import io
import re
import tarfile
from stack_contract import parse_request, valid_path

MAX_FILE = 1024 * 1024
MAX_TOTAL = 4 * 1024 * 1024
PROTECTED = re.compile(r'(^|/)(\.[^/]+|AGENTS\.md|CLAUDE\.md|GEMINI\.md|Jenkinsfile[^/]*|Dockerfile[^/]*|docker-compose[^/]*|compose[^/]*\.ya?ml|Makefile|setup\.(py|cfg)|pyproject\.toml|pytest\.ini|tox\.ini|conftest\.py|requirements[^/]*|constraints[^/]*|package[^/]*\.json|[^/]*lock[^/]*|pom\.xml|build\.gradle[^/]*|Cargo\.toml|go\.mod|[^/]*\.(pem|key|p12|pfx))($|/)', re.I)


def parse_codegen_request(value):
    fields = {'version', 'threadId', 'basisSha256', 'sourceSha256', 'baseCommitSha', 'plan', 'source'}
    session = isinstance(value, dict) and value.get('executionMode') == 'workspace-session-v1'
    if session:
        fields.add('executionMode')
    if not isinstance(value, dict) or set(value) != fields or value['version'] != 1:
        raise ValueError('codegen_request_invalid')
    plan = value['plan']
    if not isinstance(plan, dict) or set(plan) != {'version', 'summary', 'setup', 'start', 'generate', 'outputPaths'}:
        raise ValueError('codegen_plan_invalid')
    outputs = plan['outputPaths']
    if not isinstance(outputs, list) or not 1 <= len(outputs) <= 64 or any(
            not valid_path(p) or len(p) > 240 or not re.fullmatch(r'[A-Za-z0-9_./-]+', p) or PROTECTED.search(p) for p in outputs):
        raise ValueError('codegen_outputs_invalid')
    if len(set(outputs)) != len(outputs) or outputs != sorted(outputs):
        raise ValueError('codegen_outputs_invalid')
    parse_request({**value, 'phase': 'project', 'probe': '', 'preparedImage': None,
                   **({'preparedSession': None} if session else {}),
                   'plan': {'version': plan['version'], 'summary': plan['summary'], 'setup': plan['setup'],
                            'start': plan['start'], 'test': plan['generate'], 'python': '/usr/bin/python3'}})
    return value


def read_regular(container, name, limit):
    stream, stat = container.get_archive('/repo/' + name)
    if stat.get('linkTarget') or stat.get('size', limit + 1) > limit:
        raise ValueError('codegen_unsafe_output')
    data = bytearray()
    for chunk in stream:
        data.extend(chunk)
        if len(data) > limit + 32768:
            raise ValueError('codegen_output_limit')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as tar:
        members = tar.getmembers()
        if len(members) != 1 or not members[0].isfile() or members[0].size > limit:
            raise ValueError('codegen_unsafe_output')
        return tar.extractfile(members[0]).read()


def verify_inputs(container, source, allowed=()):
    for file in source:
        if file['path'] not in allowed and read_regular(container, file['path'], 16 * 1024 * 1024) != base64.b64decode(file['content'], validate=True):
            raise ValueError('codegen_modified_input')


def export_outputs(container, request):
    originals = {f['path']: base64.b64decode(f['content'], validate=True) for f in request['source']}
    files, total = [], 0
    for name in request['plan']['outputPaths']:
        content = read_regular(container, name, MAX_FILE)
        content.decode('utf-8', errors='strict')
        total += len(content)
        if b'\x00' in content or total > MAX_TOTAL:
            raise ValueError('codegen_output_limit')
        files.append({'path': name, 'beforeSha256': hashlib.sha256(originals[name]).hexdigest() if name in originals else None,
                      'sha256': hashlib.sha256(content).hexdigest(), 'content': base64.b64encode(content).decode()})
    return files
