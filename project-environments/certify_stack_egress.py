"""Bounded public HTTPS reads through a running stack gateway; no installs.

Run inside the gateway via: docker exec -i <gateway> python3 - < this_file
No direct-connect fallback, credentials, repository input or workflow mutation.
"""
import hashlib
import http.client
import json
import socket
import ssl
from urllib.parse import urljoin, urlsplit


def fetch(host, path, marker):
    connection = http.client.HTTPSConnection("127.0.0.1", 3128, timeout=20,
                                             context=ssl.create_default_context())
    connection.set_tunnel(host, 443)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        assert response.status == 200, (host, response.status)
        body = response.read(512001)
        assert 0 < len(body) <= 512000, "response size"
        assert marker in body, "unexpected public artifact"
        return {"host": host, "status": response.status, "bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest()}
    finally:
        connection.close()


def denied(request):
    with socket.create_connection(("127.0.0.1", 3128), timeout=10) as connection:
        connection.sendall(request.encode("ascii") + b"\r\n\r\n")
        status = connection.recv(4096).split(b"\r\n", 1)[0]
        assert status == b"HTTP/1.1 403 Forbidden", status


def installer(url, marker):
    chain = []
    for _ in range(6):
        parsed = urlsplit(url)
        assert parsed.scheme == "https" and parsed.port in (None, 443) and not parsed.username and not parsed.password
        connection = http.client.HTTPSConnection("127.0.0.1", 3128, timeout=20,
                                                 context=ssl.create_default_context())
        connection.set_tunnel(parsed.hostname, 443)
        try:
            path = parsed.path + (("?" + parsed.query) if parsed.query else "")
            connection.request("GET", path, headers={"User-Agent": "curl/8.5.0"})
            response = connection.getresponse()
            chain.append({"host": parsed.hostname, "status": response.status})
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                assert location, "redirect location missing"
                url = urljoin(url, location)
                continue
            assert response.status == 200, (parsed.hostname, response.status)
            body = response.read(512001)
            assert 0 < len(body) <= 512000 and marker in body, "unexpected installer"
            return {"chain": chain, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        finally:
            connection.close()
    raise AssertionError("redirect limit")


if __name__ == "__main__":
    results = [
        fetch("www.postgresql.org", "/media/keys/ACCC4CF8.asc", b"BEGIN PGP PUBLIC KEY BLOCK"),
        fetch("apt.postgresql.org", "/pub/repos/apt/ACCC4CF8.asc", b"BEGIN PGP PUBLIC KEY BLOCK"),
        fetch("apt.postgresql.org", "/pub/repos/apt/dists/noble-pgdg/InRelease", b"BEGIN PGP SIGNED MESSAGE"),
    ]
    assert results[0]["sha256"] == results[1]["sha256"], "key endpoints disagree"
    downloads = [installer("https://astral.sh/uv/install.sh", b"UV_UNMANAGED_INSTALL"),
                 installer("https://bun.sh/install", b"BUN_INSTALL")]
    results += [fetch("pypi.org", "/pypi/packaging/json", b'"packaging"'),
                fetch("registry.npmjs.org", "/typescript/latest", b'"name":"typescript"')]
    negatives = ("CONNECT example.org:443 HTTP/1.1", "CONNECT apt.postgresql.org:80 HTTP/1.1",
                    "CONNECT 127.0.0.1:443 HTTP/1.1", "CONNECT 169.254.169.254:443 HTTP/1.1",
                    "CONNECT localhost:443 HTTP/1.1", "CONNECT host.docker.internal:443 HTTP/1.1",
                    "CONNECT mcp-server:443 HTTP/1.1", "CONNECT gitea:443 HTTP/1.1",
                    "CONNECT astral.sh.attacker.example:443 HTTP/1.1", "CONNECT notastral.sh:443 HTTP/1.1",
                    "CONNECT user@releases.astral.sh:443 HTTP/1.1", "CONNECT releases.astral.sh:8443 HTTP/1.1",
                    "CONNECT arbitrary.amazonaws.com:443 HTTP/1.1", "GET http://apt.postgresql.org/ HTTP/1.1")
    for request in negatives:
        denied(request)
    print(json.dumps({"passed": True, "publicReads": results, "installerReads": downloads, "negativeChecks": len(negatives),
                      "installs": 0, "workflowStarted": False}))
