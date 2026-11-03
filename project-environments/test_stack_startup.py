import io
import os
import subprocess
import tarfile
import unittest
from unittest.mock import Mock, patch
from docker.errors import APIError, NotFound
from stack_startup import execute_tests


class StartupBoundaryTest(unittest.TestCase):
    def run_script(self, start, tests, environment=None):
        markers = []
        def archive(path):
            markers.append(path)
            if not os.path.isfile(path):
                raise NotFound('absent')
            out = io.BytesIO()
            with tarfile.open(fileobj=out, mode='w') as tar:
                tar.add(path, arcname=os.path.basename(path))
            return iter([out.getvalue()]), {}
        def execute(client, container, script, seconds, strict_output=False, environment=None):
            r = subprocess.run(['bash', '-euo', 'pipefail', '-c', script], capture_output=True, text=True, timeout=5,
                               env={**os.environ, **(environment or {})})
            return {'status': 'completed' if r.returncode == 0 else 'failed', 'stdout': r.stdout, 'stderr': r.stderr}
        try:
            with patch('stack_runner.execute', side_effect=execute):
                return execute_tests(None, Mock(get_archive=archive), start, tests, 5, strict_output=True,
                                     environment=environment)
        finally:
            for marker in markers:
                if os.path.exists(marker):
                    os.unlink(marker)

    def test_failed_start_does_not_execute_tests(self):
        r = self.run_script('echo startup-error >&2; false', 'echo TESTS_RAN')
        self.assertFalse(r['testStarted'])
        self.assertEqual(r['status'], 'failed')
        self.assertNotIn('TESTS_RAN', r['stdout'])

    def test_early_successful_exit_is_not_test_execution(self):
        self.assertFalse(self.run_script('exit 0', 'echo TESTS_RAN')['testStarted'])

    def test_same_shell_and_clean_protocol(self):
        r = self.run_script('export SERVICE_READY=yes; ready() { test "$SERVICE_READY" = yes; }; trap "echo cleanup >&2" EXIT',
                            'ready; printf "{\"passed\":true}\\n"')
        self.assertTrue(r['testStarted'])
        self.assertEqual(r['status'], 'completed')
        self.assertIn('cleanup', r['stderr'])
        self.assertNotIn('argus-test-started', r['stdout'])

    def test_assertion_failure_is_test_execution(self):
        r = self.run_script('true', 'echo assertion-failed >&2; false')
        self.assertTrue(r['testStarted'])
        self.assertEqual(r['status'], 'failed')

    def test_workspace_environment_reaches_startup_and_tests(self):
        r = self.run_script('test "$ARGUS_STARTUP_FIXTURE" = isolated; export START_CHECKED=yes',
                            'test "$ARGUS_STARTUP_FIXTURE" = isolated; test "$START_CHECKED" = yes',
                            environment={'ARGUS_STARTUP_FIXTURE': 'isolated'})
        self.assertTrue(r['testStarted'])
        self.assertEqual(r['status'], 'completed')

    def test_environment_does_not_bypass_failed_startup(self):
        r = self.run_script('test "$ARGUS_STARTUP_FIXTURE" = isolated; false', 'echo TESTS_RAN',
                            environment={'ARGUS_STARTUP_FIXTURE': 'isolated'})
        self.assertFalse(r['testStarted'])
        self.assertEqual(r['status'], 'failed')
        self.assertNotIn('TESTS_RAN', r['stdout'])

    def test_bad_archive_and_engine_error_fail_closed(self):
        with patch('stack_runner.execute', return_value={'status': 'failed'}):
            for chunks in [[b'x' * 16385], [b'not a tar']]:
                with self.assertRaises((ValueError, tarfile.TarError)):
                    execute_tests(None, Mock(get_archive=Mock(return_value=(iter(chunks), {}))), '', '', 5)
            with self.assertRaises(APIError):
                execute_tests(None, Mock(get_archive=Mock(side_effect=APIError('offline'))), '', '', 5)


if __name__ == '__main__':
    unittest.main()
