"""Unprivileged download broker. It has no checkout, runtime auth or Docker socket.

pip can only obtain wheels through the PyPI-only gateway. No dependency is
imported here. Repository code runs later in the existing offline QA sandbox.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import threading
import time
import zipfile
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name, parse_wheel_filename
from policy import Blocked, POLICY, POLICY_SHA, declarations

ROOT = Path(os.environ.get("ENVIRONMENT_STORE", "/cache"))
SECRET_FILE = Path("/run/secrets/environment_resolver")
MUTEX = threading.Lock()
RUNTIME = f"cpython-{platform.python_version()}-{sys.platform}-{platform.machine()}"
DIGEST = re.compile(r"[a-f0-9]{64}")


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def persist(file, value):
    with file.open("xb") as stream:
        stream.write(encoded(value))
        stream.flush()
        os.fsync(stream.fileno())
    # Include newly created namespace/job directory entries in the durability
    # boundary. A power loss must not erase intent and permit an implicit replay.
    directory = file.parent
    while directory == ROOT or ROOT in directory.parents:
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        directory = directory.parent


def validate(data):
    if not isinstance(data, dict) or set(data) != {"version", "runtime", "manifests", "supplements", "namespace"} or data["version"] != 1:
        raise Blocked("environment_request_invalid")
    if not isinstance(data["namespace"], str) or not DIGEST.fullmatch(data["namespace"]):
        raise Blocked("environment_request_invalid")
    if data["runtime"] != RUNTIME:
        raise Blocked("environment_runtime_mismatch")
    return declarations(data["manifests"], data["supplements"])


def cache_available():
    total, count = 0, 0
    for parent, dirs, files in os.walk(ROOT, followlinks=False):
        count += len(dirs) + len(files)
        if count > 20000:
            raise Blocked("environment_cache_full")
        for name in files:
            total += (Path(parent) / name).lstat().st_size
        if total + POLICY["maxDownloadBytes"] + 1048576 > POLICY["maxCacheBytes"]:
            raise Blocked("environment_cache_full")


def resolve(data, request_sha):
    requirements, constraints = validate(data)
    namespace = ROOT / data["namespace"]
    namespace.mkdir(mode=0o700, exist_ok=True)
    job = namespace / request_sha
    if job.exists():
        if (job / "result.json").is_file():
            return json.loads((job / "result.json").read_text())
        raise Blocked("environment_resolution_uncertain")
    cache_available()
    previous = []
    # First successful lock remains the version baseline for every later supplement.
    # One namespace is one workflow/QA basis, not a repository-global environment.
    lock = namespace / "baseline.json"
    if lock.exists():
        previous = json.loads(lock.read_text())["wheels"]
        constraints += [f"{w['name']}=={w['version']}" for w in previous]
    job.mkdir(mode=0o700)
    persist(job / "intent.json", {"requestSha256": request_sha, "policySha256": POLICY_SHA})
    wheels = job / "wheels"
    wheels.mkdir(mode=0o700)
    (job / "requirements.txt").write_text("\n".join(requirements) + "\n")
    (job / "constraints.txt").write_text("\n".join(constraints) + "\n")
    command = [sys.executable, "-I", "/service/download.py", "--isolated", "--disable-pip-version-check", "download",
               "--no-cache-dir", "--only-binary=:all:", "--index-url", POLICY["index"],
               "--proxy", "http://environment-egress:3128", "--timeout", "15", "--retries", "0",
               "--dest", str(wheels), "-r", str(job / "requirements.txt"), "-c", str(job / "constraints.txt")]
    reason = None
    with (job / "download.log").open("xb") as log:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 env={"PATH": "/usr/bin:/bin", "HOME": "/tmp", "LANG": "C.UTF-8"},
                                 cwd=job)
        deadline = time.monotonic() + POLICY["maxSeconds"]
        try:
            while child.poll() is None:
                entries = list(wheels.iterdir())
                if (len(entries) > POLICY["maxArtifacts"] or sum(f.stat().st_size for f in entries) > POLICY["maxDownloadBytes"]
                        or log.tell() > 65536 or (job / "download.log").stat().st_size > 65536):
                    reason = "environment_artifact_limit"
                    break
                if time.monotonic() > deadline:
                    reason = "environment_resolution_timeout"
                    break
                time.sleep(0.1)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
        if child.returncode and reason is None:
            reason = "environment_resolution_failed"
    if reason:
        result = {"status": "blocked", "reason": reason, "requestSha256": request_sha, "policySha256": POLICY_SHA}
        persist(job / "result.json", result)
        return result
    artifacts, size = [], 0
    for file in sorted(wheels.iterdir()):
        size += file.stat().st_size
        if (not file.is_file() or file.is_symlink() or file.stat().st_nlink != 1
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,220}\.whl", file.name)
                or size > POLICY["maxDownloadBytes"] or len(artifacts) >= POLICY["maxArtifacts"]):
            raise Blocked("environment_artifact_limit")
        name, version, _, _ = parse_wheel_filename(file.name)
        with zipfile.ZipFile(file) as archive:
            metadata = [entry for entry in archive.infolist() if entry.filename.endswith(".dist-info/METADATA")]
            if len(metadata) != 1 or metadata[0].file_size > 1048576:
                raise Blocked("environment_artifact_invalid")
            meta = BytesParser().parsebytes(archive.read(metadata[0]))
            if canonicalize_name(meta["Name"]) != name or meta["Version"] != str(version):
                raise Blocked("environment_artifact_invalid")
            # pip is network-confined; still reject direct-URL dependencies explicitly.
            if any(Requirement(v).url for v in meta.get_all("Requires-Dist", [])):
                raise Blocked("environment_source_not_allowed")
        artifacts.append({"file": file.name, "name": str(name), "version": str(version),
                          "sha256": hashlib.sha256(file.read_bytes()).hexdigest()})
    if len({a["name"] for a in artifacts}) != len(artifacts) or not {"pytest", "packaging"}.issubset({a["name"] for a in artifacts}):
        raise Blocked("environment_artifact_invalid")
    # Existing package bytes as well as versions are immutable within a run.
    if any(not any(a == old for a in artifacts) for old in previous):
        raise Blocked("environment_lock_changed")
    result = {"status": "ready", "requestSha256": request_sha, "policySha256": POLICY_SHA,
              "requirementsSha256": hashlib.sha256(encoded([requirements, constraints])).hexdigest(),
              "lockSha256": hashlib.sha256(encoded(artifacts)).hexdigest(), "wheels": artifacts}
    if not lock.exists():
        persist(lock, {"wheels": artifacts})
    persist(job / "result.json", result)
    return result


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    slots = threading.BoundedSemaphore(8)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)
    def log_message(self, *args):
        pass  # Never emit request headers, manifests, package output or credentials.

    def authorized(self):
        try:
            return hmac.compare_digest(self.headers.get("x-environment-secret", "").encode(), SECRET_FILE.read_bytes().strip())
        except OSError:
            return False

    def respond(self, code, value):
        body = encoded(value)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.connection.settimeout(220)
        if not self.authorized():
            self.respond(403, {"error": "environment_unauthorized"})
            return
        if self.path not in {"/plan", "/resolve"} or self.headers.get("Transfer-Encoding"):
            self.respond(400, {"error": "environment_request_invalid"})
            return
        if not MUTEX.acquire(blocking=False):
            self.respond(409, {"error": "environment_busy"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 650000:
                raise Blocked("environment_request_invalid")
            raw = self.rfile.read(length)
            data = json.loads(raw)
            validate(data)
            result = ({"status": "ready", "policySha256": POLICY_SHA, "runtime": RUNTIME}
                      if self.path == "/plan" else resolve(data, hashlib.sha256(raw).hexdigest()))
            self.respond(200, result)
        except Blocked as error:
            self.respond(409, {"error": str(error)})
        except Exception:
            self.respond(409, {"error": "environment_resolution_uncertain"})
        finally:
            MUTEX.release()

    def do_GET(self):
        if not self.authorized():
            self.respond(403, {"error": "environment_unauthorized"})
            return
        match = re.fullmatch(r"/wheels/([a-f0-9]{64})/([a-f0-9]{64})/([A-Za-z0-9][A-Za-z0-9_.+-]{0,220}\.whl)", self.path)
        if not match:
            self.respond(404, {"error": "environment_artifact_missing"})
            return
        try:
            job = ROOT / match[1] / match[2]
            result = json.loads((job / "result.json").read_text())
            if result["status"] != "ready" or not any(w["file"] == match[3] for w in result["wheels"]):
                raise ValueError()
            file = job / "wheels" / match[3]
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(file.stat().st_size))
            self.end_headers()
            with file.open("rb") as stream:
                while chunk := stream.read(65536):
                    self.wfile.write(chunk)
        except (OSError, ValueError, KeyError):
            self.respond(404, {"error": "environment_artifact_missing"})


if __name__ == "__main__":
    ROOT.mkdir(mode=0o700, exist_ok=True)
    BoundedServer(("0.0.0.0", 8092), Handler).serve_forever()
