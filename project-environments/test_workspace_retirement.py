import json
import tempfile
import unittest
import http.client
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from docker.errors import NotFound
from stack_runner import LABEL, OWNER, LOCK, Handler
from workspace_session import SESSION_LABEL, session_markers
from workspace_retirement import operate


class Retirement(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.thread = '11111111-1111-4111-8111-111111111111'
        self.marker = {'version': 1, 'threadId': self.thread, 'containerId': 'c' * 64, 'networkId': 'd' * 64,
                       'databaseContainerId': None, 'baseImage': 'sha256:' + 'a' * 64,
                       'baseCommitSha': 'b' * 40, 'activeRequest': None, 'lastResult': 'e' * 64}
        self.path = self.root / 'workspace-sessions' / (self.thread + '.json')
        self.path.parent.mkdir()
        self.path.write_text(json.dumps(self.marker))
        self.tombstone = self.root / (self.thread + '.canceled.json')
        self.tombstone.write_text(json.dumps({'threadId': self.thread}))
        self.receipt = self.root / ('e' * 64) / 'result.json'
        self.receipt.parent.mkdir()
        self.receipt.write_text('{"historical":true}')
        labels = {LABEL: OWNER, SESSION_LABEL: self.thread}
        self.worker = Mock(id='c' * 64, attrs={'State': {'Running': False}, 'Config': {'Labels': labels}})
        self.network = Mock(id='d' * 64, attrs={'Internal': True, 'Labels': labels, 'Containers': {'c' * 64: {}}})
        self.runner = Mock(store=self.root, active_thread=None)
        self.runner.client.containers.get.return_value = self.worker
        self.runner.client.networks.get.return_value = self.network
        self.worker.remove.side_effect = lambda: setattr(self.runner.client.containers.get, 'side_effect', NotFound('gone'))
        self.network.remove.side_effect = lambda: setattr(self.runner.client.networks.get, 'side_effect', NotFound('gone'))

    def request(self):
        return {'threadId': self.thread}

    def apply(self):
        preview = operate(self.runner, self.request())
        return operate(self.runner, {**self.request(), 'expectedSha256': preview['expectedSha256']}, apply=True)

    def test_preview_is_read_only_and_requires_canceled_exact_thread(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = operate(self.runner, self.request())
        self.assertEqual(result['state'], 'retained')
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.worker.remove.assert_not_called()
        self.network.remove.assert_not_called()
        self.tombstone.unlink()
        with self.assertRaisesRegex(ValueError, 'stack_session_cancel_required'):
            operate(self.runner, self.request())
        with self.assertRaisesRegex(ValueError, 'stack_request_invalid'):
            operate(self.runner, {'threadId': '../other'})

    def test_lock_and_stale_preview_cannot_mutate(self):
        LOCK.acquire()
        try:
            with self.assertRaisesRegex(ValueError, 'stack_busy'):
                operate(self.runner, self.request())
        finally:
            LOCK.release()
        with self.assertRaisesRegex(ValueError, 'stack_session_binding_changed'):
            operate(self.runner, {**self.request(), 'expectedSha256': 'f' * 64}, apply=True)
        self.worker.remove.assert_not_called()

    def test_foreign_or_running_resources_and_pending_marker_fail_closed(self):
        for object, path, value in [(self.worker, 'State', {'Running': True}),
                                   (self.worker, 'Config', {'Labels': {LABEL: 'other'}}),
                                   (self.network, 'Containers', {'unexpected': {}})]:
            with self.subTest(value=value):
                previous = object.attrs[path]
                object.attrs[path] = value
                with self.assertRaises(ValueError):
                    self.apply()
                object.attrs[path] = previous
        self.path.with_suffix('.pending').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'stack_session_marker_invalid'):
            self.apply()
        self.worker.remove.assert_not_called()

    def test_retirement_preserves_evidence_frees_capacity_and_is_idempotent(self):
        with patch('workspace_database.recover') as recover:
            result = self.apply()
            recover.assert_called_once_with(self.runner, self.thread)
            self.assertEqual(result['state'], 'retired')
            self.assertEqual(self.apply(), result)
            recover.assert_called_once()
        self.worker.remove.assert_called_once_with()
        self.network.remove.assert_called_once_with()
        self.assertEqual(session_markers(self.root), [])
        self.assertEqual(self.receipt.read_text(), '{"historical":true}')
        self.assertTrue(self.tombstone.exists())
        self.assertEqual(json.loads((self.root / 'workspace-retirements' / (self.thread + '.marker.json')).read_text()), self.marker)

    def test_db_revocation_failure_keeps_worker_and_marker(self):
        with patch('workspace_database.recover', side_effect=ValueError('stack_database_stop_unconfirmed')):
            with self.assertRaisesRegex(ValueError, 'stack_database_stop_unconfirmed'):
                self.apply()
        self.worker.remove.assert_not_called()
        self.assertTrue(self.path.exists())

    def test_canceled_unknown_execution_is_disclosed_and_archived_never_replayed(self):
        self.marker['activeRequest'] = 'f' * 64
        self.path.write_text(json.dumps(self.marker))
        preview = operate(self.runner, self.request())
        self.assertTrue(preview['operationUncertain'])
        with patch('workspace_database.recover'):
            self.assertTrue(self.apply()['operationUncertain'])
        self.worker.start.assert_not_called()
        self.assertEqual(json.loads((self.root / 'workspace-retirements' / (self.thread + '.marker.json')).read_text()), self.marker)

    def test_interrupted_cleanup_finishes_without_replaying_execution(self):
        self.network.remove.side_effect = RuntimeError('engine unavailable')
        with patch('workspace_database.recover') as recover:
            with self.assertRaisesRegex(RuntimeError, 'engine unavailable'):
                self.apply()
            preview = operate(self.runner, self.request())
            self.assertEqual(preview['state'], 'cleanup_pending')
            self.network.remove.side_effect = lambda: setattr(self.runner.client.networks.get, 'side_effect', NotFound('gone'))
            result = self.apply()
            self.assertEqual(result['state'], 'retired')
            recover.assert_called_once()
        self.worker.start.assert_not_called()
        self.worker.remove.assert_called_once()


class RetirementHttp(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.secret = 'fixture-secret'
        self.server.runner = Mock()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, path, body='{}', secret='fixture-secret'):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            connection.request('POST', path, body, {'x-stack-secret': secret, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_private_auth_and_preview_apply_dispatch(self):
        with patch('workspace_retirement.operate', return_value={'fixture': True}) as operation:
            self.assertEqual(self.post('/workspace-retirement-preview', secret='wrong')[0], 403)
            operation.assert_not_called()
            self.assertEqual(self.post('/workspace-retirement-preview')[0], 200)
            operation.assert_called_with(self.server.runner, {}, apply=False)
            self.assertEqual(self.post('/workspace-retirement-apply')[0], 200)
            operation.assert_called_with(self.server.runner, {}, apply=True)
            self.server.runner.run.assert_not_called()

    def test_operator_body_is_bounded_and_errors_do_not_leak(self):
        with patch('workspace_retirement.operate', side_effect=RuntimeError('private-data')) as operation:
            status, result = self.post('/workspace-retirement-preview', body=' ' * 1025)
            self.assertEqual((status, result['error']), (409, 'stack_request_limit'))
            operation.assert_not_called()
            status, result = self.post('/workspace-retirement-preview')
            self.assertEqual((status, result['error']), (409, 'stack_unavailable_no_replay'))


if __name__ == '__main__':
    unittest.main()
