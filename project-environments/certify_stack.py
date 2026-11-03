"""Disposable live fixture: real install/network/process isolation, no model/project run."""
import base64
import hashlib
import json
import os
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import docker
from stack_contract import digest
from stack_runner import Runner, LABEL, OWNER, execute, container_options, snapshot_image


def snapshot_http_check():
    """Actual pinned Docker SDK over HTTP; no daemon mutation or model call.

    Deliberately exceed the former 180-second deadline. The real-container
    snapshot certificate separately proves image creation and offline reuse.
    """
    calls = []
    worker, image = 'a' * 64, 'sha256:' + 'b' * 64
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def respond(self, payload):
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_GET(self):
            if '/containers/' in self.path:
                self.respond({'Id': worker, 'State': {'Running': False}})
            elif '/images/' in self.path:
                self.respond({'Id': image})
            else:
                self.send_error(404)
        def do_POST(self):
            if '/commit?' not in self.path:
                self.send_error(404)
                return
            self.rfile.read(int(self.headers['Content-Length']))
            calls.append(self.path)
            time.sleep(185)
            self.respond({'Id': image})
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    sdk = docker.DockerClient(base_url='http://127.0.0.1:' + str(server.server_port), version='1.45', timeout=30)
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory() as store:
            value = snapshot_image(sdk, sdk.containers.get(worker), Path(store), {'threadId': str(uuid.uuid4())})
            assert value.id == image and len(calls) == 1 and 'pause=False' in calls[0]
            assert sdk.api.timeout == 30
            assert time.monotonic() - started >= 185
        print(json.dumps({'status': 'passed', 'checks': ['real SDK delayed 185-second HTTP response', 'one commit only', 'no live pause', 'control timeout restored']}))
    finally:
        sdk.close()
        server.shutdown()
        server.server_close()


def output_checks(client, base):
    checks = [
        ('verbose-success', "python3 -c \"import sys; print('HEAD'); print('x'*4000000); print('TAIL'); sys.stderr.write('y'*4000000+'STDERR-END')\"", 30, False, 'completed', 0),
        ('verbose-failure', "python3 -c \"print('x'*1000000); print('REAL-FAILURE'); raise SystemExit(23)\"", 30, False, 'failed', 23),
        ('qa-protocol-limit', "python3 -c \"print('x'*1000000)\"", 30, True, 'output_limit', None),
        ('verbose-timeout', "python3 -u -c \"import time; print('x'*1000000); time.sleep(30)\"", 1, False, 'timeout', None),
    ]
    for name, script, seconds, strict, expected, code in checks:
        container = client.containers.create(**container_options(base, OWNER + '-' + name, 'none'))
        try:
            container.start()
            result = execute(client, container, script, seconds, strict_output=strict)
            assert result['status'] == expected, (name, result['status'])
            if code is not None:
                assert result['exitCode'] == code
            assert len((result['stdout'] + result['stderr']).encode()) <= 32768
            assert result['outputCapture']['stdoutTruncated']
            if name == 'verbose-success':
                assert result['stdout'].startswith('HEAD') and result['stdout'].endswith('TAIL\n')
                assert result['stderr'].endswith('STDERR-END')
            if name == 'verbose-failure':
                assert result['stdout'].endswith('REAL-FAILURE\n')
        finally:
            container.remove(force=True)
    print(json.dumps({'status': 'passed', 'checks': [c[0] for c in checks]}))


def lifecycle(runner, client, request):
    """Real cancellation and source-drift failures, never an application run."""
    source_guard = {**request, "threadId": str(uuid.uuid4()), "plan": {
        **request["plan"], "setup": "printf tampered > app.py", "start": "", "test": "true", "python": "/usr/bin/python3"}}
    for expected in ("stack_setup_modified_source", "stack_interrupted_no_replay"):
        try:
            runner.run(source_guard)
            raise AssertionError("source modification accepted")
        except ValueError as error:
            assert str(error) == expected, str(error)
    canceled = {**source_guard, "threadId": str(uuid.uuid4()), "plan": {
        **source_guard["plan"], "setup": "touch /tmp/cancel-ready\nsleep 120"}}
    outcome, errors = [], []

    def dispatch():
        try:
            outcome.append(runner.run(canceled))
        except Exception as error:
            errors.append(error)

    worker = threading.Thread(target=dispatch)
    worker.start()
    ready = False
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and worker.is_alive():
        for container in client.containers.list(filters={"label": LABEL + "=" + OWNER}):
            ready = container.exec_run(["/usr/bin/test", "-f", "/tmp/cancel-ready"]).exit_code == 0
            if ready:
                break
        if ready:
            break
        time.sleep(0.2)
    assert ready, "setup did not start before cancellation"
    assert runner.cancel(canceled["threadId"]) == {"stopped": True}
    worker.join(10)
    assert not worker.is_alive() and not errors, errors
    assert outcome and outcome[0]["status"] == "canceled", outcome
    assert not client.containers.list(all=True, filters={"label": LABEL + "=" + OWNER}), "canceled worker retained"
    try:
        runner.run(canceled)
        raise AssertionError("canceled setup restarted")
    except ValueError as error:
        assert str(error) == "stack_canceled"
    print(json.dumps({"status": "passed", "checks": ["source drift blocked", "uncertain execution not replayed", "active setup canceled", "worker removed", "late dispatch blocked"]}))


def main():
    if not OWNER.startswith("cert-"):
        raise RuntimeError("certification requires a disposable instance")
    if os.environ.get('ARGUS_STACK_CERT_SNAPSHOT_HTTP') == 'true':
        snapshot_http_check()
        return
    client = docker.from_env(timeout=30)
    base = client.images.get(os.environ["ARGUS_STACK_BASE_IMAGE"]).id
    egress = os.environ["ARGUS_STACK_EGRESS_CONTAINER"]
    with tempfile.TemporaryDirectory() as store:
        runner = Runner(client, store, base, egress)
        thread = str(uuid.uuid4())
        source = "def add(a, b): return a + b\n"
        plan = {"version": 1, "summary": "Install a public Python dependency and Node, then test both offline",
                "setup": "python3 -m venv /opt/test-env\n/opt/test-env/bin/pip -q install packaging==24.2 pytest==8.3.5\napt-get update -qq\napt-get install -y -qq --no-install-recommends nodejs >/tmp/apt.log 2>&1\nnode --version",
                "start": "export PATH=/opt/test-env/bin:$PATH",
                "test": "python -c 'import packaging; assert packaging.__version__ == \"24.2\"'\nnode -e 'if (2+2!==4) process.exit(1)'\npython - <<'PY'\nimport socket, os\nassert not os.path.exists('/var/run/docker.sock')\nassert not os.path.exists('/run/secrets')\ns=socket.socket(); s.settimeout(1); assert s.connect_ex(('1.1.1.1',443)) != 0\nassert not any(k in os.environ for k in ['WORKSPACE_SECRET','GITEA_TOKEN','ARGUS_API_KEY'])\nPY",
                "python": "/opt/test-env/bin/python"}
        r = {"version": 1, "threadId": thread, "basisSha256": "b" * 64, "baseCommitSha": "a" * 40,
             "sourceSha256": digest(["a" * 40, [["app.py", hashlib.sha256(source.encode()).hexdigest()]]]),
             "plan": plan, "phase": "project", "source": [{"path": "app.py", "content": base64.b64encode(source.encode()).decode()}],
             "probe": "", "preparedImage": None}
        if os.environ.get('ARGUS_STACK_CERT_SNAPSHOT') == 'true':
            plan.update(summary='Synthetic stopped-worker snapshot with immutable offline QA reuse',
                setup="mkdir -p /opt/fixture\nhead -c 33554432 /dev/urandom > /opt/fixture/payload\nnohup sleep 120 >/tmp/background.log 2>&1 &",
                start='', test="python3 -c \"import os; assert os.path.getsize('/opt/fixture/payload') == 33554432; from app import add; assert add(2,3) == 5\"",
                python='/usr/bin/python3')
        if os.environ.get("ARGUS_STACK_CERT_EXTENDED") == "true":
            plan.update(summary="Synthetic Python 3.14, uv, Bun and Chromium stack",
                setup="""python3 -m venv /opt/bootstrap
/opt/bootstrap/bin/pip -q install uv==0.9.26
/opt/bootstrap/bin/uv python install 3.14.0
/opt/bootstrap/bin/uv venv --python 3.14.0 /opt/test-env
/opt/bootstrap/bin/uv pip install --python /opt/test-env/bin/python pytest playwright
case "$(uname -m)" in x86_64) bun_arch=x64-baseline ;; aarch64) bun_arch=aarch64 ;; *) exit 19 ;; esac
curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-${bun_arch}.zip" -o /tmp/bun.zip
unzip -q /tmp/bun.zip -d /opt/bun
cp "/opt/bun/bun-linux-${bun_arch}/bun" /usr/local/bin/bun
if ! /opt/test-env/bin/python -m playwright install --with-deps chromium >/tmp/browser-install.log 2>&1; then tail -c 5000 /tmp/browser-install.log; exit 20; fi
/opt/test-env/bin/python --version
/opt/bootstrap/bin/uv --version
bun --version""",
                test="""python - <<'PY'
import sys, subprocess, socket
from playwright.sync_api import sync_playwright
assert sys.version_info[:2] == (3,14)
assert subprocess.check_output(['bun','-e','console.log(2+2)']).strip() == b'4'
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page()
 page.set_content('<h1>Isolated browser fixture</h1>')
 assert page.locator('h1').inner_text() == 'Isolated browser fixture'
 browser.close()
s=socket.socket(); s.settimeout(1); assert s.connect_ex(('1.1.1.1',443)) != 0
print('Python 3.14 + Bun + real Chromium passed offline')
PY""")
        try:
            if os.environ.get("ARGUS_STACK_CERT_OUTPUT") == "true":
                output_checks(client, base)
                return
            if os.environ.get("ARGUS_STACK_CERT_LIFECYCLE") == "true":
                lifecycle(runner, client, r)
                return
            result = runner.run(r)
            assert result["status"] == "completed", json.dumps(result)
            assert runner.run(r) == result, "execution replay must be cached"
            qa = {**r, "phase": "qa", "preparedImage": result["preparedImage"], "probe": "import subprocess\nimport packaging\nassert packaging.__version__ == '24.2'\nassert subprocess.check_output(['node','-e','console.log(2+2)']).strip() == b'4'\nprint('independent fixture passed')"}
            if os.environ.get('ARGUS_STACK_CERT_SNAPSHOT') == 'true':
                qa['probe'] = "import os\nassert os.path.getsize('/opt/fixture/payload') == 33554432\nprint('independent immutable snapshot passed')"
            if os.environ.get("ARGUS_STACK_CERT_EXTENDED") == "true":
                qa["probe"] = "import sys, subprocess\nfrom playwright.sync_api import sync_playwright\nassert sys.version_info[:2] == (3,14)\nassert subprocess.check_output(['bun','-e','console.log(3*3)']).strip() == b'9'\nwith sync_playwright() as p:\n b=p.chromium.launch(headless=True)\n page=b.new_page()\n page.set_content('<button>QA</button>')\n assert page.get_by_role('button').inner_text() == 'QA'\n b.close()\nprint('independent browser fixture passed')"
            verified = runner.run(qa)
            assert verified["status"] == "completed", json.dumps(verified)
            assert verified["preparedImage"] == result["preparedImage"]
            assert runner.cancel(thread) == {"stopped": True}
            try:
                runner.run({**qa, "probe": "print('must not run')"})
                raise AssertionError("canceled run restarted")
            except ValueError as error:
                assert str(error) == "stack_canceled"
            print(json.dumps({"status": "passed", "extended": os.environ.get("ARGUS_STACK_CERT_EXTENDED") == "true",
                              "checks": (["stopped-worker Docker snapshot", "32 MiB installed fixture retained", "same immutable QA environment", "offline runtime tests", "cached duplicate", "cancel blocks late dispatch"]
                                         if os.environ.get('ARGUS_STACK_CERT_SNAPSHOT') == 'true' else
                                         ["public toolchain installation", "offline runtime tests", "same immutable QA environment", "no direct public egress", "cached duplicate", "cancel blocks late dispatch"])}))
        finally:
            for container in client.containers.list(all=True, filters={"label": LABEL + "=" + OWNER}):
                container.remove(force=True)
            for image in client.images.list(filters={"label": LABEL + "=" + OWNER}):
                client.images.remove(image.id, force=True)


if __name__ == "__main__":
    main()
