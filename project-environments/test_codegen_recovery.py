import json
from unittest.mock import patch
from test_workspace_session import WorkspaceSession, session_request
from workspace_session import session_markers, save_state
from codegen_recovery import completed_result
from stack_contract import digest
from stack_runner import LOCK


class CodegenRecovery(WorkspaceSession):
    def fixture(self):
        r = session_request()
        r = {k: r[k] for k in ('version', 'threadId', 'basisSha256', 'sourceSha256', 'baseCommitSha', 'source', 'executionMode')}
        r['plan'] = {'version': 1, 'summary': 'fixture', 'setup': 'true', 'start': '', 'generate': 'fixture', 'outputPaths': ['client.ts']}
        with patch('stack_runner.execute', return_value=self.result), patch('workspace_session.verify_inputs'), patch('workspace_session.export_outputs', return_value=[]):
            result = self.runner.generate(r)
        self.container.reset_mock()
        self.client.containers.create.reset_mock()
        return r, result

    def test_completed_lookup_does_not_start_install_or_create_any_worker(self):
        r, result = self.fixture()
        self.assertEqual(completed_result(self.runner, r), result)
        self.container.start.assert_not_called()
        self.container.put_archive.assert_not_called()
        self.client.containers.create.assert_not_called()
        self.container.commit.assert_not_called()
        self.assertEqual(completed_result(self.runner, r), result)

    def test_drift_running_unknown_canceled_and_consumed_session_are_denied(self):
        r, result = self.fixture()
        path = self.root / digest(['codegen-v1', r]) / 'result.json'
        for delta in [{'status': 'failed'}, {'exitCode': 1}, {'phase': 'setup'}, {'sourceSha256': 'e' * 64}, {'basisSha256': 'e' * 64}, {'sessionId': 'e' * 64}]:
            path.write_text(json.dumps({**result, **delta}))
            with self.assertRaises(ValueError):
                completed_result(self.runner, r)
        path.write_text(json.dumps(result))
        self.container.attrs['State']['Running'] = True
        with self.assertRaises(ValueError): completed_result(self.runner, r)
        self.container.attrs['State']['Running'] = False
        LOCK.acquire()
        try:
            with self.assertRaises(ValueError): completed_result(self.runner, r)
        finally: LOCK.release()
        marker = session_markers(self.root)[0]
        for delta in [{'activeRequest': 'a' * 64}, {'lastResult': 'a' * 64}]:
            save_state(self.runner, {**marker, **delta})
            with self.assertRaises(ValueError): completed_result(self.runner, r)
        save_state(self.runner, marker)
        (self.root / (r['threadId'] + '.canceled.json')).write_text('{}')
        with self.assertRaises(ValueError): completed_result(self.runner, r)
