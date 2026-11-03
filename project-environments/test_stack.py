import base64
import copy
import hashlib
import unittest
from unittest.mock import patch
from stack_contract import digest, parse_request, parse_plan
from stack_runner import container_options
import stack_egress


def request():
    source = "print('example')\n"
    manifest = [["example.py", hashlib.sha256(source.encode()).hexdigest()]]
    return {"version": 1, "threadId": "00000000-0000-4000-8000-000000000000", "basisSha256": "b" * 64,
            "sourceSha256": digest(["a" * 40, manifest]), "baseCommitSha": "a" * 40,
            "plan": {"version": 1, "summary": "fixture", "setup": "true", "start": "", "test": "python3 example.py", "python": "/usr/bin/python3"},
            "phase": "project", "source": [{"path": "example.py", "content": base64.b64encode(source.encode()).decode()}], "probe": "", "preparedImage": None}


class Contract(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(parse_request(request()), request())

    def test_authority_injection(self):
        for key in ("image", "mounts", "network", "privileged", "credentials", "environment", "dockerSocket"):
            value = request()
            value[key] = "untrusted"
            with self.assertRaises(ValueError):
                parse_request(value)

    def test_source_paths_and_binding(self):
        for name in ("../file", "/etc/passwd", ".env", "a/.git/config", "secrets/token", "a\\b", "a\nb", "node_modules/file"):
            value = request()
            value["source"][0]["path"] = name
            with self.assertRaises(ValueError):
                parse_request(value)
        value = request()
        value["source"][0]["content"] = "dGFtcGVyZWQ="
        with self.assertRaisesRegex(ValueError, "changed"):
            parse_request(value)

    def test_plan_commands_only_in_container(self):
        plan = request()["plan"]
        for path in ("python3", "/bin/python;curl", "/x/../python", "/bin/$(exec)"):
            with self.assertRaises(ValueError):
                parse_plan({**plan, "python": path})
        with self.assertRaises(ValueError):
            parse_plan({**plan, "setup": "a" * 24001})

    def test_container_boundary(self):
        options = container_options("sha256:" + "a" * 64, "fixture", "internal-fixture")
        for field in ("volumes", "mounts", "ports", "devices", "privileged", "pid_mode"):
            self.assertNotIn(field, options)
        self.assertEqual(options["cap_drop"], ["ALL"])
        self.assertNotIn("SYS_ADMIN", options["cap_add"])
        self.assertEqual(options["mem_limit"], options["memswap_limit"])
        self.assertEqual(options["security_opt"], ["no-new-privileges:true"])

    def test_qa_requires_pinned_prepared_image(self):
        value = request()
        value["phase"] = "qa"
        with self.assertRaises(ValueError):
            parse_request(value)
        value.update(preparedImage="sha256:" + "d" * 64, probe="pass")
        self.assertEqual(parse_request(value), value)

    def test_egress_private_and_unknown_blocked(self):
        for host in ("localhost:443", "host.docker.internal:443", "gitea:443", "example.org:443", "pypi.org:80"):
            with self.assertRaises(ValueError):
                stack_egress.target(host)
        with patch("egress.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(ValueError):
                stack_egress.target("pypi.org:443")

    def test_vendor_families_and_exact_cdn_hosts(self):
        addresses = [(2, 1, 6, "", ("151.101.2.52", 443))]
        with patch("egress.socket.getaddrinfo", return_value=addresses) as resolve:
            hosts = ["www.postgresql.org", "apt.postgresql.org", "releases.astral.sh",
                     "release-assets.githubusercontent.com", "playwright.download.prss.microsoft.com"]
            hosts += [host for root in stack_egress.DOMAIN_FAMILIES for host in (root, "new.downloads." + root)]
            for host in hosts:
                self.assertEqual(stack_egress.target(host + ":443"), addresses)
                resolve.assert_called_with(host, 443, type=stack_egress.egress.socket.SOCK_STREAM)
            for host in ("apt.postgresql.org.evil.test:443", "notastral.sh:443", "astral.sh.attacker.example:443",
                         "evil.github.com:443", "evil.githubusercontent.com:443", "evil.microsoft.com:443",
                         "evil.amazonaws.com:443", "evil.azureedge.net:443", "evil.google.com:443",
                         "apt.postgresql.org:80", "apt.postgresql.org:8443", "user@apt.postgresql.org:443",
                         "apt.postgresql.org.:443", "127.0.0.1:443", "[::1]:443", ".astral.sh:443",
                         "bad..astral.sh:443", "a/b.astral.sh:443", "a%00.astral.sh:443", "-bad.astral.sh:443"):
                with self.subTest(host=host), self.assertRaises(ValueError):
                    stack_egress.target(host)

    def test_base_pypi_policy_stays_strict_even_after_stack_import(self):
        addresses = [(2, 1, 6, "", ("151.101.2.52", 443))]
        with patch("egress.socket.getaddrinfo", return_value=addresses):
            self.assertEqual(stack_egress.egress.target("pypi.org:443"), addresses)
            for host in ("releases.astral.sh:443", "github.com:443", "sub.pypi.org:443", "www.postgresql.org:443"):
                with self.subTest(host=host), self.assertRaises(ValueError):
                    stack_egress.egress.target(host)

    def test_denied_names_do_not_resolve(self):
        with patch("egress.socket.getaddrinfo") as resolve:
            for host in ("astral.sh.attacker.example:443", "localhost:443", "host.docker.internal:443",
                         "mcp-server:443", "169.254.169.254:443", "example.org:443"):
                with self.subTest(host=host), self.assertRaises(ValueError):
                    stack_egress.target(host)
            resolve.assert_not_called()

    def test_postgresql_rejects_mixed_dns_and_private_reserved_addresses(self):
        public = (2, 1, 6, "", ("151.101.2.52", 443))
        for ip in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fc00::1",
                   "2001:db8::1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "ff02::1", "::ffff:127.0.0.1"):
            for host in ("www.postgresql.org:443", "releases.astral.sh:443", "new.downloads.astral.sh:443"):
                with self.subTest(ip=ip, host=host), patch("egress.socket.getaddrinfo", return_value=[public, (2, 1, 6, "", (ip, 443))]):
                    with self.assertRaisesRegex(ValueError, "address denied"):
                        stack_egress.target(host)

    def test_single_validated_dns_result_is_returned_without_reresolution(self):
        addresses = [(10, 1, 6, "", ("2606:4700:4700::1111", 443, 0, 0))]
        with patch("egress.socket.getaddrinfo", side_effect=[addresses, [(2, 1, 6, "", ("127.0.0.1", 443))]]) as resolve:
            self.assertEqual(stack_egress.target("releases.astral.sh:443"), addresses)
            self.assertEqual(resolve.call_count, 1)


if __name__ == "__main__":
    unittest.main()
