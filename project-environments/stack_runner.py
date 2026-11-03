"""Trusted Docker controller. Never expose this service/socket to agent code.

Only data crosses the boundary; no host paths or environment are forwarded.
Durable intents prevent repeating an uncertain execution after process loss.
"""
import base64
import hmac
import io
import json
import os
import re
from pathlib import Path
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from stack_contract import digest, parse_request, MAX_OUTPUT, UUID
from stack_output import OutputCapture
from codegen_contract import parse_codegen_request, verify_inputs, export_outputs

LABEL = "io.argus.disposable-stack"
OWNER = os.environ.get("ARGUS_STACK_INSTANCE", "local")
if not re.fullmatch(r"[a-z0-9-]{1,64}", OWNER):
    raise ValueError("stack_instance_invalid")
SETUP_SECONDS, TEST_SECONDS = 900, 600
SNAPSHOT_SECONDS = 900
MAX_LAYER = 8 * 1024 ** 3  # watchdog, NOT a filesystem quota
LOCK = threading.Lock()
UPLOAD = threading.BoundedSemaphore(1)
CANCEL = threading.Event()


def durable(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, separators=(",", ":"), ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def archive(files):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w") as tar:
        for name, content in files:
            item = tarfile.TarInfo(name)
            item.size, item.mode, item.uid, item.gid = len(content), 0o644, 0, 0
            tar.addfile(item, io.BytesIO(content))
    return result.getvalue()


class SnapshotError(ValueError):
    """An uncertain Docker snapshot must not trigger another export or deletion."""


def snapshot_image(client, container, job, binding):
    # The caller stopped the worker and verified source bytes. No installer can
    # race the export, and Docker need not freeze a live container for minutes.
    container.reload()
    if container.attrs.get("State", {}).get("Running") is not False:
        raise ValueError("stack_snapshot_worker_not_stopped")
    started = time.monotonic()
    meta = {"version": 1, **binding, "containerId": container.id, "timeoutSeconds": SNAPSHOT_SECONDS}
    durable(job / "snapshot-started.json", meta)
    old_timeout = client.api.timeout
    try:
        client.api.timeout = SNAPSHOT_SECONDS
        image = container.commit(pause=False, conf={"Labels": {LABEL: OWNER, "io.argus.thread": binding["threadId"]}})
        durable(job / "snapshot-completed.json", {**meta, "imageId": image.id,
                "durationMs": round((time.monotonic() - started) * 1000)})
        return image
    except Exception as error:
        # Never persist exception text: Docker errors may contain paths/config.
        from requests.exceptions import Timeout
        code = "stack_snapshot_timeout_no_replay" if isinstance(error, (Timeout, TimeoutError)) else "stack_snapshot_unavailable_no_replay"
        try:
            durable(job / "snapshot-failure.json", {**meta, "code": code,
                    "durationMs": round((time.monotonic() - started) * 1000)})
        finally:
            # Even a full evidence disk must not turn uncertainty into deletion.
            raise SnapshotError(code) from None
    finally:
        client.api.timeout = old_timeout


def retained_snapshot_workers(store):
    retained = set()
    for marker in store.glob("*/snapshot-started.json"):
        if not (marker.parent / "result.json").exists():
            value = json.loads(marker.read_text())
            worker = value.get("containerId", "")
            if re.fullmatch(r"[a-f0-9]{64}", worker):
                retained.add(worker)
    return retained


def container_options(image, name, network):
    # Fixed security policy, never merged with model/request arguments.
    return dict(image=image, name=name, command=["/bin/sleep", "infinity"],
                entrypoint=[], detach=True, network=network, working_dir="/repo",
                labels={LABEL: OWNER}, hostname="argus-test", user="0:0",
                cap_drop=["ALL"], cap_add=["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
                security_opt=["no-new-privileges:true"], mem_limit="4g", memswap_limit="4g",
                nano_cpus=2_000_000_000, pids_limit=256, shm_size="256m",
                environment={"HOME": "/root", "LANG": "C.UTF-8", "CI": "true", "DEBIAN_FRONTEND": "noninteractive"},
                log_config={"Type": "none"}, auto_remove=False)


def execute(client, container, script, seconds, proxy=False, strict_output=False, environment=None):
    env = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/root/.local/bin:/root/.bun/bin",
           "PYTHONDONTWRITEBYTECODE=1", "PYTEST_DISABLE_PLUGIN_AUTOLOAD=1"]
    if proxy:
        env += ["HTTPS_PROXY=http://stack-egress:3128", "https_proxy=http://stack-egress:3128",
                "HTTP_PROXY=http://stack-egress:3128", "http_proxy=http://stack-egress:3128", "NO_PROXY=localhost,127.0.0.1"]
    # Trusted per-phase test credentials only; never merged from request data.
    env += [key + '=' + value for key, value in (environment or {}).items()]
    execution = client.api.exec_create(container.id, ["/bin/bash", "-euo", "pipefail", "-c", script],
                                       environment=env, workdir="/repo")
    chunks, sizes, stopped, done = [bytearray(), bytearray()], [0], [None], threading.Event()
    captures = [OutputCapture(), OutputCapture()]
    stream_sizes = [0, 0]

    def read():
        try:
            for out, err in client.api.exec_start(execution["Id"], stream=True, demux=True):
                for i, data in enumerate((out, err)):
                    if data:
                        stream_sizes[i] += len(data)
                        if strict_output:
                            keep = max(0, MAX_OUTPUT - sizes[0])
                            chunks[i].extend(data[:keep])
                        else:
                            captures[i].append(data)
                        sizes[0] += len(data)
                        # QA stdout is a machine protocol, not a log preview.
                        # Never accept a clipped protocol as passing evidence.
                        if strict_output and sizes[0] > MAX_OUTPUT:
                            stopped[0] = "output_limit"
                            container.kill()
                            return
        except Exception:
            stopped[0] = stopped[0] or "interrupted"
        finally:
            done.set()

    threading.Thread(target=read, daemon=True).start()
    started = time.monotonic()
    last_size_check = started
    while not done.wait(1):
        if CANCEL.is_set():
            stopped[0] = "canceled"
            container.kill()
            break
        if time.monotonic() - started > seconds:
            stopped[0] = "timeout"
            container.kill()
            break
        if time.monotonic() - last_size_check >= 5:
            try:
                matches = client.api.containers(all=True, filters={"id": container.id}, size=True)
                details = next((item for item in matches if item["Id"] == container.id), None)
                if details is None or "SizeRw" not in details:
                    raise ValueError("stack_storage_check_unavailable")
                last_size_check = time.monotonic()
                if details["SizeRw"] > MAX_LAYER:
                    stopped[0] = "disk_limit"
                    container.kill()
                    break
            except Exception as error:
                # Docker Desktop's usage walk can race a dpkg file rename.
                # Retry only the read-only sample, never the install; stop if
                # no successful measurement is available for 15 seconds.
                if "snapshotter.Usage failed" not in str(error) or time.monotonic() - last_size_check >= 15:
                    raise ValueError("stack_storage_check_unavailable") from None
    done.wait(5)
    code = client.api.exec_inspect(execution["Id"]).get("ExitCode")
    if strict_output:
        output = [bytes(c).decode("utf-8", "replace").encode("utf-8")[:MAX_OUTPUT].decode("utf-8", "ignore") for c in chunks]
        truncated = [stream_sizes[i] > len(chunks[i]) for i in range(2)]
    else:
        rendered = [c.render() for c in captures]
        output, truncated = [r[0] for r in rendered], [r[1] for r in rendered]
    return {"status": stopped[0] or ("completed" if code == 0 else "failed"), "exitCode": code,
            "stdout": output[0], "stderr": output[1],
            "outputCapture": {"version": 1, "stdoutBytes": stream_sizes[0], "stderrBytes": stream_sizes[1],
                              "stdoutTruncated": truncated[0], "stderrTruncated": truncated[1]},
            "durationMs": round((time.monotonic() - started) * 1000)}


class Runner:
    def __init__(self, client, store, base_image, egress_container):
        self.client, self.store, self.base, self.egress = client, Path(store), base_image, egress_container
        self.store.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Pin to an immutable locally installed ID, never pull an agent image.
        if not base_image.startswith("sha256:") or len(base_image) != 71:
            raise ValueError("stack_base_image_must_be_pinned")
        client.images.get(base_image)
        # Recovery never removes a worker whose Docker export may still be in
        # flight. It was stopped before the durable snapshot marker was written.
        retained = retained_snapshot_workers(self.store)
        from workspace_session import retained_workers, session_markers, stop_worker
        sessions = retained_workers(self.store)
        session_networks = {v['networkId'] for v in session_markers(self.store)}
        retained |= sessions
        protected = []
        for container in client.containers.list(all=True, filters={"label": LABEL + "=" + OWNER}):
            if container.id in retained:
                if container.id in sessions:
                    stop_worker(container)
                protected.append(container)
            else:
                container.remove(force=True)
        for network in client.networks.list(filters={"label": LABEL + "=" + OWNER}):
            try:
                network.disconnect(self.egress, force=True)
            except Exception:
                pass
            if network.id in session_networks:
                continue
            for container in protected:
                try:
                    network.disconnect(container, force=True)
                except Exception:
                    pass
            network.remove()
        self.active_thread = None
        from workspace_database import recover
        recover(self)

    def cancel(self, thread):
        if not isinstance(thread, str) or not re.fullmatch(UUID, thread):
            raise ValueError("stack_request_invalid")
        tombstone = self.store / (thread + ".canceled.json")
        if not tombstone.exists():
            try:
                durable(tombstone, {"threadId": thread})
            except FileExistsError:
                pass
        if self.active_thread == thread:
            CANCEL.set()
            deadline = time.monotonic() + 45
            while self.active_thread == thread and time.monotonic() < deadline:
                time.sleep(0.1)
            if self.active_thread == thread:
                raise ValueError("stack_stop_unconfirmed")
        from workspace_session import assert_stopped
        assert_stopped(self, thread)
        from workspace_database import recover
        recover(self, thread)
        return {"stopped": True}

    def run(self, request):
        request = parse_request(request)
        if request.get('executionMode') == 'workspace-session-v1':
            from workspace_session import run
            return run(self, request)
        key, plan_hash = digest(request), digest(request["plan"])
        if not LOCK.acquire(blocking=False):
            raise ValueError("stack_busy")
        network = container = None
        retain_snapshot_worker = False
        try:
            self.active_thread = request["threadId"]
            CANCEL.clear()
            if (self.store / (request["threadId"] + ".canceled.json")).exists():
                raise ValueError("stack_canceled")
            job = self.store / key
            if job.exists():
                if not (job / "result.json").exists():
                    if (job / 'recovery-snapshot-completed.json').exists():
                        from stack_recovery import execute_recovered
                        return execute_recovered(self, request)
                    failure = job / "snapshot-failure.json"
                    if failure.exists():
                        code = json.loads(failure.read_text()).get("code")
                        if code in {"stack_snapshot_timeout_no_replay", "stack_snapshot_unavailable_no_replay"}:
                            raise SnapshotError(code)
                    raise ValueError("stack_interrupted_no_replay")
                return json.loads((job / "result.json").read_text())
            retained = retained_snapshot_workers(self.store)
            if retained and any(c.id in retained for c in self.client.containers.list(
                    all=True, filters={"label": LABEL + "=" + OWNER})):
                raise ValueError("stack_snapshot_reconciliation_required")
            job.mkdir(mode=0o700)
            durable(job / "intent.json", {"requestSha256": key, "threadId": request["threadId"], "planSha256": plan_hash})
            fd = os.open(self.store, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            prepared = request["preparedImage"]
            prepared_meta = self.store / (digest([request["threadId"], plan_hash, request["sourceSha256"]]) + ".image.json")
            if prepared:
                meta = json.loads(prepared_meta.read_text())
                if meta["image"] != prepared or meta["sourceSha256"] != request["sourceSha256"]:
                    raise ValueError("stack_prepared_image_changed")
            # Conservative retained-image cap; do not silently evict evidence
            # needed by another run. Operator cleanup is scoped by this label.
            images = self.client.images.list(filters={"label": LABEL + "=" + OWNER})
            if not prepared and (len(images) >= 8 or sum(i.attrs.get("Size", 0) for i in images) >= 16 * 1024 ** 3):
                raise ValueError("stack_storage_capacity")
            network = self.client.networks.create("argus-stack-" + key[:24], internal=True, labels={LABEL: OWNER},
                options={"com.docker.network.bridge.gateway_mode_ipv4": "isolated", "com.docker.network.bridge.gateway_mode_ipv6": "isolated"})
            container = self.client.containers.create(**container_options(prepared or self.base, "argus-stack-" + key[:24], "none" if prepared else network.id))
            if not prepared:
                source = [("repo/" + f["path"], base64.b64decode(f["content"])) for f in request["source"]]
                container.put_archive("/", archive(source))
            container.start()
            result = {"version": 1, "requestSha256": key, "sourceSha256": request["sourceSha256"],
                      "planSha256": plan_hash, "baseImage": self.base, "preparedImage": prepared, "phase": "setup"}
            if not prepared:
                network.connect(self.egress, aliases=["stack-egress"])
                setup = execute(self.client, container, request["plan"]["setup"], SETUP_SECONDS, proxy=True)
                network.disconnect(self.egress, force=True)
                result.update(setup)
                if setup["status"] != "completed":
                    durable(job / "result.json", result)
                    return result
                # End every installer/background process before verification and
                # export; the test stage always starts a fresh container anyway.
                container.stop(timeout=2)
                # Dependency installation is not authority to modify application
                # inputs. Verify bytes through the Docker archive API, not a
                # hashing executable supplied by the prepared environment.
                for file in request["source"]:
                    if CANCEL.is_set():
                        raise ValueError("stack_canceled")
                    stream, stat = container.get_archive("/repo/" + file["path"])
                    payload = bytearray()
                    for chunk in stream:
                        payload.extend(chunk)
                        if len(payload) > 17 * 1024 * 1024:
                            raise ValueError("stack_setup_modified_source")
                    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as tar:
                        members = tar.getmembers()
                        if len(members) != 1 or not members[0].isfile() or tar.extractfile(members[0]).read() != base64.b64decode(file["content"]):
                            raise ValueError("stack_setup_modified_source")
                # Snapshot the exact installed environment. No floating reinstall
                # between ordinary tests and independent QA on this source.
                try:
                    if CANCEL.is_set():
                        raise ValueError("stack_canceled")
                    image = snapshot_image(self.client, container, job, {
                        "threadId": request["threadId"], "requestSha256": key,
                        "sourceSha256": request["sourceSha256"], "planSha256": plan_hash})
                except SnapshotError:
                    # A timed-out SDK call may still be exporting in Docker.
                    # Removing its source corrupts that export. Retain only this
                    # stopped worker for explicit operator reconciliation.
                    retain_snapshot_worker = True
                    raise
                prepared = image.id
                if prepared_meta.exists():
                    raise ValueError("stack_plan_already_prepared_for_other_source")
                durable(prepared_meta, {"image": prepared, "sourceSha256": request["sourceSha256"]})
                result["preparedImage"] = prepared
                container.remove(force=True)
                container = self.client.containers.create(**container_options(prepared, "argus-stack-" + key[:24], "none"))
                container.start()
            # Fresh container resets background processes and all post-install state.
            if CANCEL.is_set():
                raise ValueError("stack_canceled")
            if request["phase"] == "qa":
                container.put_archive("/tmp", archive([("argus-qa.py", request["probe"].encode())]))
                command = request["plan"]["python"] + " -u /tmp/argus-qa.py"
            else:
                command = request["plan"]["test"]
            from stack_startup import execute_tests
            result.update(execute_tests(self.client, container, request["plan"]["start"], command, TEST_SECONDS,
                                        strict_output=request["phase"] == "qa"))
            result["phase"] = request["phase"]
            durable(job / "result.json", result)
            return result
        finally:
            if container is not None and not retain_snapshot_worker:
                try:
                    container.remove(force=True)
                except Exception:
                    pass
            if network is not None:
                if retain_snapshot_worker:
                    try:
                        network.disconnect(container, force=True)
                    except Exception:
                        pass
                try:
                    network.disconnect(self.egress, force=True)
                except Exception:
                    pass
                try:
                    network.remove()
                except Exception:
                    pass
            self.active_thread = None
            LOCK.release()

    def generate(self, request):
        request = parse_codegen_request(request)
        if request.get('executionMode') == 'workspace-session-v1':
            from workspace_session import run
            return run(self, request, generation=True)
        key, plan_hash = digest(['codegen-v1', request]), digest(request['plan'])
        if not LOCK.acquire(blocking=False):
            raise ValueError('codegen_busy')
        network = container = None
        try:
            self.active_thread = request['threadId']
            CANCEL.clear()
            if (self.store / (request['threadId'] + '.canceled.json')).exists():
                raise ValueError('codegen_canceled')
            job = self.store / key
            if job.exists():
                if not (job / 'result.json').exists():
                    raise ValueError('codegen_interrupted_no_replay')
                return json.loads((job / 'result.json').read_text())
            job.mkdir(mode=0o700)
            durable(job / 'intent.json', {'requestSha256': key, 'threadId': request['threadId'], 'planSha256': plan_hash})
            fd = os.open(self.store, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            network = self.client.networks.create('argus-codegen-' + key[:24], internal=True, labels={LABEL: OWNER},
                options={'com.docker.network.bridge.gateway_mode_ipv4': 'isolated', 'com.docker.network.bridge.gateway_mode_ipv6': 'isolated'})
            container = self.client.containers.create(**container_options(self.base, 'argus-codegen-' + key[:24], network.id))
            container.put_archive('/', archive([('repo/' + f['path'], base64.b64decode(f['content'])) for f in request['source']]))
            container.start()
            network.connect(self.egress, aliases=['stack-egress'])
            result = {'version': 1, 'requestSha256': key, 'sourceSha256': request['sourceSha256'],
                      'planSha256': plan_hash, 'baseImage': self.base, 'phase': 'setup', 'outputs': []}
            result.update(execute(self.client, container, request['plan']['setup'], SETUP_SECONDS, proxy=True))
            network.disconnect(self.egress, force=True)
            # Stop all installer processes; generation has neither a proxy nor live setup processes.
            container.stop(timeout=2)
            if result['status'] == 'completed':
                verify_inputs(container, request['source'])
                if CANCEL.is_set():
                    raise ValueError('codegen_canceled')
                container.start()
                result.update(execute(self.client, container, request['plan']['start'] + '\n' + request['plan']['generate'], TEST_SECONDS))
                result['phase'] = 'generate'
                container.stop(timeout=2)
                if result['status'] == 'completed':
                    if CANCEL.is_set():
                        raise ValueError('codegen_canceled')
                    verify_inputs(container, request['source'], request['plan']['outputPaths'])
                    result['outputs'] = export_outputs(container, request)
            durable(job / 'result.json', result)
            return result
        finally:
            if container is not None:
                try:
                    container.remove(force=True)
                except Exception:
                    pass
            if network is not None:
                try:
                    network.disconnect(self.egress, force=True)
                except Exception:
                    pass
                try:
                    network.remove()
                except Exception:
                    pass
            self.active_thread = None
            LOCK.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_json(self, status, value):
        data = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get("x-stack-secret", ""), self.server.secret):
            return self.send_json(403, {"error": "stack_forbidden"})
        if self.path not in {"/run", "/cancel", "/generate", "/generate-result", "/recovery-preview", "/reconcile-snapshot", "/workspace-retirement-preview", "/workspace-retirement-apply"}:
            return self.send_json(404, {"error": "stack_not_found"})
        admitted = self.path == "/cancel" or UPLOAD.acquire(blocking=False)
        if not admitted:
            return self.send_json(409, {"error": "stack_busy"})
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= (1024 if self.path == "/cancel" or self.path.startswith('/workspace-retirement-') else 180 * 1024 * 1024):
                raise ValueError("stack_request_limit")
            self.connection.settimeout(45)
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("stack_request_invalid")
            value = json.loads(body)
            del body
            if self.path == '/generate-result':
                from codegen_recovery import completed_result
                return self.send_json(200, completed_result(self.server.runner, value))
            if self.path.startswith('/workspace-retirement-'):
                from workspace_retirement import operate
                return self.send_json(200, operate(self.server.runner, value, apply=self.path.endswith('-apply')))
            if self.path == '/reconcile-snapshot':
                from stack_recovery import reconcile
                return self.send_json(200, reconcile(self.server.runner, value))
            if self.path == '/recovery-preview':
                if not LOCK.acquire(blocking=False):
                    raise ValueError('stack_busy')
                try:
                    from stack_recovery import preview
                    return self.send_json(200, preview(self.server.runner, value))
                finally:
                    LOCK.release()
            execute_request = self.server.runner.generate if self.path == '/generate' else self.server.runner.run
            self.send_json(200, self.server.runner.cancel(value.get("threadId")) if self.path == "/cancel" else execute_request(value))
        except Exception as error:
            message = str(error)
            safe = message if message.startswith(("stack_", "codegen_")) and len(message) < 100 and all(c.islower() or c == "_" for c in message) else "stack_unavailable_no_replay"
            self.send_json(409, {"error": safe})
        finally:
            if self.path != "/cancel":
                UPLOAD.release()


if __name__ == "__main__":
    import docker
    secret = Path("/run/secrets/stack_runner").read_text().strip()
    if len(secret) != 64:
        raise ValueError("stack_secret_invalid")
    server = ThreadingHTTPServer(("0.0.0.0", 8093), Handler)
    server.secret = secret
    server.runner = Runner(docker.from_env(timeout=30), "/receipts", os.environ["ARGUS_STACK_BASE_IMAGE"], os.environ["ARGUS_STACK_EGRESS_CONTAINER"])
    server.serve_forever()
