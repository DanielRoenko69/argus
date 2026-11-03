"""Versioned, credential-free contract for the general disposable stack runner.

The model may propose shell *inside* a container. It may never choose Docker
arguments, mounts, images, networks, credentials or resource limits.
"""
import base64
import hashlib
import json
import re
from project_snapshot import project_path, check_project_content

MAX_SOURCE = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_OUTPUT = 32768
UUID = r"[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"
HASH = r"[a-f0-9]{64}"


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def valid_path(name):
    return isinstance(name, str) and 0 < len(name) <= 400 and "\\" not in name and all(
        p and not p.startswith(".") and p not in {"node_modules", "secrets", "__pycache__", "graphify-out"}
        for p in name.split("/")) and not re.search(r"[\x00-\x1f\x7f]", name)


def parse_plan(plan):
    if not isinstance(plan, dict) or set(plan) != {"version", "summary", "setup", "start", "test", "python"} or plan["version"] != 1:
        raise ValueError("stack_plan_invalid")
    for key in ("summary", "setup", "start", "test", "python"):
        value = plan[key]
        if not isinstance(value, str) or "\0" in value or len(value.encode()) > (2000 if key == "summary" else 24000):
            raise ValueError("stack_plan_invalid")
    if not all(plan[k].strip() for k in ("summary", "setup", "test")) or not re.fullmatch(r"/(?:[A-Za-z0-9_.+-]+/)*[A-Za-z0-9_.+-]+", plan["python"]) or ".." in plan["python"].split("/"):
        raise ValueError("stack_plan_invalid")
    return plan


def parse_request(value):
    fields = {"version", "threadId", "basisSha256", "sourceSha256", "baseCommitSha", "plan", "phase", "source", "probe", "preparedImage"}
    session = isinstance(value, dict) and value.get('executionMode') == 'workspace-session-v1'
    if session:
        fields |= {'executionMode', 'preparedSession'}
    if not isinstance(value, dict) or set(value) != fields or value["version"] != 1 or value["phase"] not in {"project", "qa"}:
        raise ValueError("stack_request_invalid")
    for key, regex in (("threadId", UUID), ("basisSha256", HASH), ("sourceSha256", HASH), ("baseCommitSha", r"[a-f0-9]{40}")):
        if not isinstance(value[key], str) or not re.fullmatch(regex, value[key]):
            raise ValueError("stack_request_invalid")
    parse_plan(value["plan"])
    if not isinstance(value["probe"], str) or len(value["probe"].encode()) > 120000 or "\0" in value["probe"]:
        raise ValueError("stack_request_invalid")
    if value["preparedImage"] is not None and not re.fullmatch(r"sha256:" + HASH, str(value["preparedImage"])):
        raise ValueError("stack_image_invalid")
    if session and (value['preparedImage'] is not None or (value['preparedSession'] is not None
            and not re.fullmatch(HASH, str(value['preparedSession'])))):
        raise ValueError('stack_session_invalid')
    prepared = value['preparedSession'] if session else value['preparedImage']
    if (value["phase"] == "qa") != bool(prepared and value["probe"]):
        raise ValueError("stack_request_invalid")
    if session and value['phase'] == 'project' and (prepared is not None or value['probe']):
        raise ValueError('stack_request_invalid')
    files = value["source"]
    if not isinstance(files, list) or not 1 <= len(files) <= 3000:
        raise ValueError("stack_source_invalid")
    manifest, total, names = [], 0, set()
    for file in files:
        if not isinstance(file, dict) or set(file) != {"path", "content"} or not (project_path if session else valid_path)(file["path"]) or file["path"] in names or not isinstance(file["content"], str):
            raise ValueError("stack_source_invalid")
        content = base64.b64decode(file["content"], validate=True)
        total += len(content)
        if len(content) > MAX_FILE or total > MAX_SOURCE:
            raise ValueError("stack_source_limit")
        if session:
            check_project_content(file['path'], content)
        names.add(file["path"])
        manifest.append([file["path"], hashlib.sha256(content).hexdigest()])
    if manifest != sorted(manifest) or digest([value["baseCommitSha"], manifest]) != value["sourceSha256"]:
        raise ValueError("stack_source_changed")
    return value
