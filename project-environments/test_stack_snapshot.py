import base64
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from requests.exceptions import ReadTimeout
from stack_runner import Runner, SnapshotError, snapshot_image, SNAPSHOT_SECONDS, CANCEL, archive
from stack_contract import digest
from test_stack import request


class Snapshot(unittest.TestCase):
    def setUp(self):
        CANCEL.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.job = Path(self.temp.name)
        self.client = Mock()
        self.client.api.timeout = 30
        self.container = Mock(id='c' * 64, attrs={'State': {'Running': False}})
        self.container.commit.return_value = SimpleNamespace(id='sha256:' + 'd' * 64)
        self.binding = {'threadId': request()['threadId'], 'requestSha256': 'a' * 64,
                        'sourceSha256': 'b' * 64, 'planSha256': 'e' * 64}

    def test_stopped_snapshot_has_own_budget_and_durable_evidence(self):
        def commit(**kwargs):
            self.assertEqual(self.client.api.timeout, 900)
            self.assertFalse(kwargs['pause'])
            self.assertTrue((self.job / 'snapshot-started.json').exists())
            return SimpleNamespace(id='sha256:' + 'd' * 64)
        self.container.commit.side_effect = commit
        image = snapshot_image(self.client, self.container, self.job, self.binding)
        self.assertEqual(SNAPSHOT_SECONDS, 900)
        self.assertEqual(self.client.api.timeout, 30)
        self.assertEqual(json.loads((self.job / 'snapshot-completed.json').read_text())['imageId'], image.id)
        self.container.commit.assert_called_once()

    def test_running_worker_cannot_be_snapshotted(self):
        for state in ({'Running': True}, {}):
            self.container.attrs = {'State': state}
            with self.assertRaisesRegex(ValueError, 'stack_snapshot_worker_not_stopped'):
                snapshot_image(self.client, self.container, self.job, self.binding)
        self.container.commit.assert_not_called()

    def test_timeout_is_persisted_redacted_and_not_retried(self):
        self.container.commit.side_effect = ReadTimeout('SECRET Docker path/config')
        with self.assertRaisesRegex(SnapshotError, '^stack_snapshot_timeout_no_replay$'):
            snapshot_image(self.client, self.container, self.job, self.binding)
        failure = (self.job / 'snapshot-failure.json').read_text()
        self.assertNotIn('SECRET', failure)
        self.assertEqual(json.loads(failure)['code'], 'stack_snapshot_timeout_no_replay')
        self.assertEqual(self.client.api.timeout, 30)
        self.container.commit.assert_called_once()
        self.container.remove.assert_not_called()

    def test_non_timeout_is_distinct_and_journal_failure_still_retains_worker(self):
        self.container.commit.side_effect = RuntimeError('SECRET')
        from stack_runner import durable
        def write(file, value):
            if file.name == 'snapshot-failure.json':
                raise OSError('disk full')
            durable(file, value)
        with patch('stack_runner.durable', side_effect=write), self.assertRaisesRegex(SnapshotError, '^stack_snapshot_unavailable_no_replay$'):
            snapshot_image(self.client, self.container, self.job, self.binding)
        self.assertEqual(self.client.api.timeout, 30)
        self.assertTrue((self.job / 'snapshot-started.json').exists())

    def runner(self):
        self.client.images.list.return_value = []
        self.client.containers.list.return_value = []
        self.client.networks.list.return_value = []
        self.client.networks.create.return_value = Mock(id='network')
        self.test_container = Mock(id='f' * 64)
        self.test_container.get_archive.return_value = ([archive([('marker', b'1\n')])], {})
        self.container.attrs['State']['Running'] = True
        self.container.stop.side_effect = lambda **_: self.container.attrs['State'].update(Running=False)
        content = base64.b64decode(request()['source'][0]['content'])
        self.container.get_archive.return_value = ([archive([('example.py', content)])], {})
        self.client.containers.create.side_effect = [self.container, self.test_container]
        return Runner(self.client, self.job, 'sha256:' + 'b' * 64, 'fixture-egress')

    def test_full_runner_stops_before_snapshot_then_uses_exact_image_and_cached_receipt(self):
        runner = self.runner()
        def commit(**kwargs):
            self.container.stop.assert_called_once_with(timeout=2)
            self.assertFalse(self.container.attrs['State']['Running'])
            self.assertFalse(kwargs['pause'])
            return SimpleNamespace(id='sha256:' + 'd' * 64)
        self.container.commit.side_effect = commit
        result = {'status': 'completed', 'exitCode': 0, 'stdout': '', 'stderr': '', 'durationMs': 1}
        with patch('stack_runner.execute', return_value=result) as execute:
            receipt = runner.run(request())
            self.assertEqual(receipt['preparedImage'], 'sha256:' + 'd' * 64)
            self.assertEqual(receipt['phase'], 'project')
            self.assertEqual(runner.run(request()), receipt)
            self.assertEqual(execute.call_count, 2)
            self.assertTrue(receipt['testStarted'])
            self.assertTrue(execute.call_args.args[2].endswith('\n' + request()['plan']['test']))
            self.assertIn('/tmp/.argus-test-started-', execute.call_args.args[2])
        self.assertEqual(self.client.containers.create.call_args.kwargs['network'], 'none')
        self.assertEqual(self.client.containers.create.call_args.kwargs['image'], receipt['preparedImage'])

    def test_uncertain_export_retained_on_failure_repeat_and_controller_restart(self):
        runner = self.runner()
        self.container.commit.side_effect = ReadTimeout('SECRET')
        with patch('stack_runner.execute', return_value={'status': 'completed'}) as execute:
            for _ in range(2):
                with self.assertRaisesRegex(SnapshotError, 'stack_snapshot_timeout_no_replay'):
                    runner.run(request())
            execute.assert_called_once()  # no test, no re-install, no replay
        self.container.remove.assert_not_called()
        self.container.commit.assert_called_once()
        self.client.networks.create.return_value.disconnect.assert_any_call(self.container, force=True)
        self.assertFalse((self.job / digest(request()) / 'result.json').exists())
        self.client.containers.list.return_value = [self.container]
        Runner(self.client, self.job, 'sha256:' + 'b' * 64, 'fixture-egress')
        self.container.remove.assert_not_called()
        other = {**request(), 'threadId': '00000000-0000-4000-8000-000000000001'}
        with self.assertRaisesRegex(ValueError, 'stack_snapshot_reconciliation_required'):
            runner.run(other)
        self.assertFalse((self.job / digest(other)).exists())

    def test_cancellation_during_export_never_dispatches_tests(self):
        runner = self.runner()
        def commit(**kwargs):
            CANCEL.set()
            return SimpleNamespace(id='sha256:' + 'd' * 64)
        self.container.commit.side_effect = commit
        with patch('stack_runner.execute', return_value={'status': 'completed'}) as execute:
            with self.assertRaisesRegex(ValueError, '^stack_canceled$'):
                runner.run(request())
            execute.assert_called_once()
        CANCEL.clear()


if __name__ == '__main__':
    unittest.main()
