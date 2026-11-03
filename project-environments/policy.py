"""Static inputs only: never import the repository or execute a build backend."""
import hashlib
import json
import posixpath
import platform
import re
import tomllib

from packaging.requirements import InvalidRequirement, Requirement
from packaging.specifiers import SpecifierSet, InvalidSpecifier

POLICY = {"adapter": "python-public-wheels-v1", "version": 1,
          "index": "https://pypi.org/simple", "wheelsOnly": True,
          "maxRequirements": 128, "maxArtifacts": 128, "maxDownloadBytes": 268435456,
          "maxSeconds": 180, "maxCacheBytes": 1073741824,
          "baseline": ["pytest>=8,<10", "packaging==25.0"]}
POLICY_SHA = hashlib.sha256(json.dumps(POLICY, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Blocked(ValueError):
    pass


def requirement(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or "\n" in value or "\r" in value:
        raise Blocked("environment_requirement_invalid")
    try:
        parsed = Requirement(value)
    except InvalidRequirement:
        raise Blocked("environment_requirement_invalid") from None
    if parsed.url or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", parsed.name):
        raise Blocked("environment_source_not_allowed")
    return str(parsed)


def declarations(manifests, supplements):
    if not isinstance(manifests, dict) or not manifests or len(manifests) > 128:
        raise Blocked("environment_manifest_invalid")
    if sum(len(v.encode()) for v in manifests.values() if isinstance(v, str)) > 524288:
        raise Blocked("environment_manifest_limit")
    for name, value in manifests.items():
        if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_./-]{1,512}", name)
                or name.startswith("/") or ".." in name.split("/") or not isinstance(value, str)
                or len(value.encode()) > 131072):
            raise Blocked("environment_manifest_invalid")
    if not isinstance(supplements, list) or len(supplements) > 12:
        raise Blocked("environment_supplement_invalid")
    extra = []
    for item in supplements:
        if (not isinstance(item, dict) or set(item) != {"requirement", "reason"}
                or not isinstance(item["reason"], str) or not 1 <= len(item["reason"]) <= 1000):
            raise Blocked("environment_supplement_invalid")
        extra.append(requirement(item["requirement"]))
    # Lock formats require their own adapter. Never silently ignore a lock's versions.
    if any(posixpath.basename(p) in {"uv.lock", "poetry.lock", "Pipfile", "Pipfile.lock", "setup.py", "setup.cfg"}
           for p in manifests) and not any(posixpath.basename(p) in {"pyproject.toml", "requirements.txt"} for p in manifests):
        raise Blocked("environment_manifest_adapter_required")
    if any(posixpath.basename(p) in {"uv.lock", "poetry.lock", "Pipfile.lock"} for p in manifests):
        raise Blocked("environment_lock_adapter_required")
    result, constraints, visited = [], [], set()

    def requirements_file(name, constraint=False, stack=()):
        if name not in manifests or name in stack or len(stack) >= 8:
            raise Blocked("environment_requirements_include_invalid")
        visited.add(name)
        for line in manifests[name].splitlines():
            line = line.split(" #", 1)[0].strip()
            if not line or line.startswith("#"):
                continue
            match = re.fullmatch(r"(-r|--requirement|-c|--constraint)\s+([A-Za-z0-9_./-]+)", line)
            if match:
                rel = match[2]
                if rel.startswith("/") or ".." in rel.split("/"):
                    raise Blocked("environment_requirements_include_invalid")
                requirements_file(posixpath.join(posixpath.dirname(name), rel), constraint or match[1] in {"-c", "--constraint"}, (*stack, name))
            else:
                (constraints if constraint else result).append(requirement(line))

    for name in sorted(manifests):
        if posixpath.basename(name) == "pyproject.toml":
            try:
                data = tomllib.loads(manifests[name])
            except (ValueError, TypeError):
                raise Blocked("environment_manifest_invalid") from None
            project = data.get("project", {})
            if not isinstance(project, dict):
                raise Blocked("environment_manifest_invalid")
            if not project and posixpath.join(posixpath.dirname(name), "requirements.txt") not in manifests:
                raise Blocked("environment_manifest_adapter_required")
            try:
                python = project.get("requires-python", "")
                if not isinstance(python, str):
                    raise Blocked("environment_manifest_invalid")
                if not SpecifierSet(python).contains(platform.python_version(), prereleases=True):
                    raise Blocked("environment_runtime_mismatch")
            except InvalidSpecifier:
                raise Blocked("environment_manifest_invalid") from None
            if "dependencies" in project.get("dynamic", []):
                candidate = posixpath.join(posixpath.dirname(name), "requirements.txt")
                if candidate not in manifests:
                    raise Blocked("environment_dynamic_dependencies_unsupported")
                requirements_file(candidate)
            elif "dependencies" in project:
                if not isinstance(project["dependencies"], list):
                    raise Blocked("environment_manifest_invalid")
                result.extend(requirement(v) for v in project["dependencies"])
            elif "poetry" in data.get("tool", {}):
                raise Blocked("environment_manifest_adapter_required")
        elif posixpath.basename(name) == "requirements.txt" and name not in visited:
            requirements_file(name)
    if not result:
        # A dependency-free PEP 621 project is valid; setup.py-only is not.
        if not any(posixpath.basename(p) == "pyproject.toml" for p in manifests):
            raise Blocked("environment_project_unknown")
    result = sorted(set(POLICY["baseline"] + result + extra))
    constraints = sorted(set(constraints))
    if len(result) + len(constraints) > POLICY["maxRequirements"]:
        raise Blocked("environment_requirement_limit")
    return result, constraints
