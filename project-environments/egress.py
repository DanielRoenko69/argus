"""CONNECT-only PyPI gateway. Deploy on a separate network from the resolver.

No configurable target, forwarding of plaintext HTTP, private IPs, credentials,
or access to any Argus backend. TLS is end-to-end and checked by pip.
"""
import ipaddress
import re
import select
import socket
import socketserver
import time
import threading

ALLOWED = {"pypi.org", "files.pythonhosted.org"}


def target(value, allowed=ALLOWED, domain_families=()):
    host, sep, port = value.rpartition(":")
    # Deliberately canonical ASCII DNS names only: no credentials, IP literals,
    # empty labels, trailing dots or suffix lookalikes. Each CONNECT is checked.
    valid_host = len(host) <= 253 and all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in host.split("."))
    permitted = host in allowed or any(host == domain or host.endswith("." + domain)
                                      for domain in domain_families)
    if not sep or port != "443" or not valid_host or not permitted:
        raise ValueError("target denied")
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    def public(address):
        ip = ipaddress.ip_address(address)
        return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_unspecified
                                    or ip.is_loopback or ip.is_link_local or getattr(ip, "scope_id", None))
    if not addresses or any(not public(a[4][0]) for a in addresses):
        raise ValueError("address denied")
    return addresses


class Proxy(socketserver.StreamRequestHandler):
    resolve_target = staticmethod(target)

    def handle(self):
        self.connection.settimeout(10)
        remote = None
        try:
            line = self.rfile.readline(4097)
            if len(line) > 4096:
                return
            method, authority, version = line.decode("ascii").strip().split(" ")
            if method != "CONNECT" or version not in {"HTTP/1.0", "HTTP/1.1"}:
                raise ValueError("method denied")
            consumed = 0
            while True:
                header = self.rfile.readline(4097)
                consumed += len(header)
                if consumed > 8192 or not header:
                    raise ValueError("headers invalid")
                if header in {b"\r\n", b"\n"}:
                    break
            family, kind, proto, _, address = self.resolve_target(authority)[0]
            remote = socket.socket(family, kind, proto)
            remote.settimeout(10)
            remote.connect(address)  # Use the validated IP; never resolve twice.
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            deadline, received = time.monotonic() + 190, 0
            while time.monotonic() < deadline:
                readable, _, _ = select.select([self.connection, remote], [], [], 10)
                if not readable:
                    break
                for source in readable:
                    data = source.recv(65536)
                    received += len(data)
                    if not data or received > 270000000:
                        return
                    (remote if source is self.connection else self.connection).sendall(data)
        except (ValueError, OSError, UnicodeError):
            try:
                self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            except OSError:
                pass
        finally:
            if remote:
                remote.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 8
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


if __name__ == "__main__":
    Server(("0.0.0.0", 3128), Proxy).serve_forever()
