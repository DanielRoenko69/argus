import unittest
from unittest.mock import patch
from policy import Blocked, declarations, requirement
from egress import target


class PolicyTests(unittest.TestCase):
    def test_regular_project_and_supplement_not_gem_specific(self):
        reqs, constraints = declarations({"pyproject.toml": '[project]\nname="anything"\ndependencies=["httpx>=0.27", "pydantic[email]>=2"]'},
                                        [{"requirement": "hypothesis>=6", "reason": "Independent property tests"}])
        self.assertIn("httpx>=0.27", reqs)
        self.assertIn("pydantic[email]>=2", reqs)
        self.assertIn("hypothesis>=6", reqs)
        self.assertEqual(constraints, [])

    def test_static_dynamic_requirements_and_constraints(self):
        reqs, cons = declarations({"pyproject.toml": '[project]\ndynamic=["dependencies"]',
                                  "requirements.txt": '-r requirements-base.txt\n-c requirements-constraints.txt\nnumpy>=1.26 # comment',
                                  "requirements-base.txt": 'packaging==25.0', "requirements-constraints.txt": 'numpy<3'}, [])
        self.assertIn("numpy>=1.26", reqs)
        self.assertEqual(cons, ["numpy<3"])

    def test_no_commands_urls_vcs_or_indexes(self):
        for value in ['-e .', '--index-url https://evil.invalid', 'git+https://github.com/a/b',
                      'x @ https://files.pythonhosted.org/a.whl', 'x @ file:///secret', 'x\n--extra-index-url abc', '../thing']:
            with self.subTest(value=value), self.assertRaises(Blocked):
                requirement(value)

    def test_include_cycles_escape_missing(self):
        for files in [{"requirements.txt": "-r requirements.txt"}, {"requirements.txt": "-r ../other.txt"},
                      {"requirements.txt": "-r absent.txt"}]:
            with self.assertRaises(Blocked):
                declarations(files, [])

    def test_cannot_ignore_lock_or_execute_backend(self):
        for files in [{"pyproject.toml": '[project]\ndynamic=["dependencies"]'},
                      {"requirements.txt": "packaging", "uv.lock": 'version=1'},
                      {"setup.py": 'import os; os.system("echo bad")'},
                      {"pyproject.toml": '[tool.poetry]\nname="legacy"'},
                      {"pyproject.toml": '[build-system]\nrequires=["setuptools"]', "setup.cfg": '[options]\ninstall_requires=anything'},
                      {"pyproject.toml": '[project]\nname="future"\nrequires-python=">=99"\ndependencies=[]'}]:
            with self.assertRaises(Blocked):
                declarations(files, [])

    def test_limits_and_unknown_fields(self):
        for supplements in [[{"requirement": "packaging", "reason": "need it", "command": "pip"}],
                            [{"requirement": "packaging", "reason": "x"}] * 13]:
            with self.assertRaises(Blocked):
                declarations({"requirements.txt": "packaging"}, supplements)
        with self.assertRaises(Blocked):
            declarations({"requirements.txt": "x" * 140000}, [])

    def test_pypi_gateway_denies_other_hosts_ports_and_private_dns(self):
        for host in ['mcp-server:3000', '127.0.0.1:443', 'pypi.org:80', 'pypi.org.evil:443', 'user@pypi.org:443']:
            with self.assertRaises(ValueError):
                target(host)
        with patch('socket.getaddrinfo', return_value=[(2, 1, 6, '', ('127.0.0.1', 443))]), self.assertRaises(ValueError):
            target('pypi.org:443')

    def test_pinned_pip_rejects_transitive_url_before_prepare(self):
        from download import protect
        from pip._internal.req.constructors import install_req_from_req_string, install_req_from_line
        from pip._internal.operations.prepare import RequirementPreparer
        from pip._internal.exceptions import InstallationError
        protect()
        self.assertEqual(install_req_from_req_string('packaging>=23').name, 'packaging')
        for value in ['x @ https://files.pythonhosted.org/x.tar.gz', 'x @ file:///tmp/x', 'x @ git+https://github.com/a/b']:
            with self.assertRaises(InstallationError):
                install_req_from_req_string(value)
        # A wheel-less candidate can never invoke source preparation/build hooks.
        candidate = install_req_from_line('https://files.pythonhosted.org/x-1.0.tar.gz')
        with self.assertRaises(InstallationError):
            RequirementPreparer.prepare_linked_requirement(None, candidate)


if __name__ == '__main__':
    unittest.main()
