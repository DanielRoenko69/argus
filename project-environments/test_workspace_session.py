import base64
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from stack_contract import digest, parse_request
from stack_runner import Runner, CANCEL, OWNER, LABEL
from workspace_session import MODE, SESSION_LABEL, SYNC_SOURCE, verify_qa_predecessor, session_markers, session_capacity
from codegen_contract import parse_codegen_request
from test_stack import request


def session_request():
    return {**request(), 'executionMode': MODE, 'preparedSession': None}


class WorkspaceSession(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.client = Mock()
        self.client.containers.list.return_value = []
        self.client.networks.list.return_value = []
        self.network = Mock(id='d' * 64, attrs={'Internal': True, 'Labels': {SESSION_LABEL: request()['threadId']}})
        self.client.networks.create.return_value = self.network
        self.client.networks.get.return_value = self.network
        self.container = Mock(id='c' * 64, attrs={'State': {'Running': False},
            'Config': {'Labels': {LABEL: OWNER, SESSION_LABEL: request()['threadId']}}})
        self.container.start.side_effect = lambda: self.container.attrs['State'].update(Running=True)
        self.container.stop.side_effect = lambda **_: self.container.attrs['State'].update(Running=False)
        self.client.containers.create.return_value = self.container
        self.client.containers.get.return_value = self.container
        self.runner = Runner(self.client, self.root, 'sha256:' + 'b' * 64, 'fixture-egress')
        self.env = patch.dict(os.environ, ARGUS_WORKSPACE_SESSIONS_ENABLED='true')
        self.env.start()
        self.addCleanup(self.env.stop)
        CANCEL.clear()
        self.result = {'status': 'completed', 'exitCode': 0, 'stdout': 'ok', 'stderr': '', 'durationMs': 1, 'testStarted': True}

    def test_contract_is_explicit_and_cannot_smuggle_images_or_scope(self):
        r = session_request()
        self.assertEqual(parse_request(r), r)
        for delta in ({'preparedImage': 'sha256:' + 'a' * 64}, {'executionMode': 'other'},
                      {'preparedSession': 'a' * 64}, {'probe': 'unexpected'}, {'mounts': ['/']}):
            with self.assertRaises(ValueError):
                parse_request({**r, **delta})
        with self.assertRaises(ValueError):
            parse_request({**r, 'phase': 'qa', 'probe': 'tests'})
        generation = {k: r[k] for k in ('version', 'threadId', 'basisSha256', 'sourceSha256', 'baseCommitSha', 'source', 'executionMode')}
        generation['plan'] = {'version': 1, 'summary': 'generate', 'setup': 'true', 'start': '', 'generate': 'generator', 'outputPaths': ['client.ts']}
        self.assertEqual(parse_codegen_request(generation), generation)

    def test_no_build_or_commit_reuses_worker_but_not_changed_source_receipts(self):
        with patch('stack_runner.execute', return_value=self.result) as execute, patch('workspace_session.verify_inputs'), patch('stack_startup.execute_tests', return_value=self.result) as tests:
            first = self.runner.run(session_request())
            self.assertIsNone(first['preparedImage'])
            self.assertEqual(first['preparedSession'], digest(session_request()))
            self.assertEqual(self.runner.run(session_request()), first)
            self.assertEqual(tests.call_count, 1)
            newer = {**session_request(), 'plan': {**request()['plan'], 'setup': 'changed recipe'}}
            second = self.runner.run(newer)
            self.assertNotEqual(first['preparedSession'], second['preparedSession'])
            self.assertEqual(first['sessionId'], second['sessionId'])
            self.assertEqual(tests.call_count, 2)
            self.assertEqual(execute.call_count, 4)  # sync + idempotent setup per project
        self.client.containers.create.assert_called_once()
        self.client.images.build.assert_not_called()
        self.container.commit.assert_not_called()
        self.container.remove.assert_not_called()
        self.assertFalse(self.container.attrs['State']['Running'])
        options = self.client.containers.create.call_args.kwargs
        self.assertNotIn('volumes', options)
        self.assertNotIn('privileged', options)
        self.assertEqual(options['network'], self.network.id)
        self.assertTrue(self.client.networks.create.call_args.kwargs['internal'])
        self.network.remove.assert_not_called()

    def test_qa_uses_exact_project_predecessor_and_does_not_reinstall(self):
        with patch('stack_runner.execute', return_value=self.result) as execute, patch('workspace_session.verify_inputs'), patch('stack_startup.execute_tests', return_value=self.result) as tests:
            project = self.runner.run(session_request())
            qa = {**session_request(), 'phase': 'qa', 'probe': 'print("QA")', 'preparedSession': project['preparedSession']}
            actual = self.runner.run(qa)
            self.assertEqual(execute.call_count, 3)  # 2 source syncs, only 1 setup
            self.assertEqual(actual['phase'], 'qa')
            self.assertEqual(actual['preparedSession'], project['preparedSession'])
            self.assertTrue(tests.call_args.kwargs['strict_output'])
            self.assertEqual(self.runner.run(qa), actual)
            with self.assertRaisesRegex(ValueError, 'stack_session_evidence_stale'):
                self.runner.run({**qa, 'probe': 'different tests'})

    def test_failed_setup_never_starts_tests_and_invalidates_qa(self):
        failed = {**self.result, 'status': 'failed', 'exitCode': 1}
        with patch('stack_runner.execute', side_effect=[self.result, failed]), patch('workspace_session.verify_inputs'), patch('stack_startup.execute_tests') as tests:
            r = self.runner.run(session_request())
            self.assertEqual(r['phase'], 'setup')
            self.assertIsNone(r['preparedSession'])
            tests.assert_not_called()

    def test_unknown_operation_is_not_replayed_even_after_controller_restart(self):
        with patch('stack_runner.execute', return_value=self.result), patch('workspace_session.verify_inputs'), patch('stack_startup.execute_tests', side_effect=RuntimeError('uncertain')) as tests:
            with self.assertRaises(RuntimeError):
                self.runner.run(session_request())
            self.client.containers.list.return_value = [self.container]
            restarted = Runner(self.client, self.root, self.runner.base, 'fixture-egress')
            self.container.remove.assert_not_called()
            with self.assertRaisesRegex(ValueError, 'stack_interrupted_no_replay'):
                restarted.run(session_request())
            # A changed recipe must not reuse an environment with unknown state.
            with self.assertRaisesRegex(ValueError, 'stack_interrupted_no_replay'):
                restarted.run({**session_request(), 'plan': {**request()['plan'], 'setup': 'different'}})
            tests.assert_called_once()

    def test_disabled_or_canceled_never_executes(self):
        with patch.dict(os.environ, ARGUS_WORKSPACE_SESSIONS_ENABLED='false'), self.assertRaisesRegex(ValueError, 'stack_session_disabled'):
            self.runner.run(session_request())
        self.runner.cancel(request()['threadId'])
        with self.assertRaisesRegex(ValueError, 'stack_canceled'):
            self.runner.run(session_request())
        self.client.containers.create.assert_not_called()

    def test_capacity_rejection_precedes_intent_and_all_docker_mutations(self):
        directory = self.root / 'workspace-sessions'
        directory.mkdir()
        for n in range(4):
            thread = f'11111111-1111-4111-8111-{n:012d}'
            (directory / (thread + '.json')).write_text(json.dumps({
                'threadId': thread, 'containerId': 'c' * 64, 'networkId': 'd' * 64}))
        r = session_request()
        generation = {k: r[k] for k in ('version', 'threadId', 'basisSha256', 'sourceSha256', 'baseCommitSha', 'source', 'executionMode')}
        generation['plan'] = {'version': 1, 'summary': 'generate', 'setup': 'true', 'start': '', 'generate': 'generator', 'outputPaths': ['client.ts']}
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.dict(os.environ, ARGUS_WORKSPACE_MAX_SESSIONS='4'):
            for operation, value in [(self.runner.run, r), (self.runner.generate, generation)]:
                with self.assertRaisesRegex(ValueError, '^stack_session_capacity$'):
                    operation(value)
            # Existing sessions can still be used at capacity.
            session_capacity(self.root, thread)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})
        self.assertFalse((self.root / digest(r)).exists())
        self.assertFalse((self.root / digest(['codegen-v1', generation])).exists())
        self.client.containers.create.assert_not_called()
        self.client.networks.create.assert_not_called()
        # Raising the operator limit admits a fresh request; it never consumes
        # an old uncertain intent and never deletes the retained sessions.
        with patch.dict(os.environ, ARGUS_WORKSPACE_MAX_SESSIONS='5'), \
                patch('stack_runner.execute', return_value=self.result), \
                patch('workspace_session.verify_inputs'), \
                patch('stack_startup.execute_tests', return_value=self.result):
            self.assertEqual(self.runner.run(r)['status'], 'completed')
        self.assertEqual(len(session_markers(self.root)), 5)
        self.container.remove.assert_not_called()

    def test_invalid_capacity_never_creates_an_intent(self):
        for value in ['', '0', '-1', '33', '1.5', '04', 'many', ' 4']:
            with patch.dict(os.environ, ARGUS_WORKSPACE_MAX_SESSIONS=value), \
                    self.assertRaisesRegex(ValueError, 'stack_session_capacity_config_invalid'):
                self.runner.run(session_request())
        self.assertFalse((self.root / digest(session_request())).exists())
        self.client.containers.create.assert_not_called()

    def test_cancellation_does_not_report_success_when_retained_worker_is_running(self):
        with patch('stack_runner.execute', return_value=self.result), patch('workspace_session.verify_inputs'), patch('stack_startup.execute_tests', return_value=self.result):
            self.runner.run(session_request())
        self.container.attrs['State']['Running'] = True
        with self.assertRaisesRegex(ValueError, 'stack_session_stop_unconfirmed'):
            self.runner.cancel(request()['threadId'])
        self.assertTrue((self.root / (request()['threadId'] + '.canceled.json')).exists())

    def test_source_cleanup_removes_old_files_builds_and_links_but_retains_dependencies(self):
        repo = self.root / 'repo'
        for name in ('frontend/node_modules/lib/package.json', '.venv/bin/python', 'old.py', 'dist/stale.js', 'frontend/src/stale.ts', '.env'):
            file = repo / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('fixture')
        outside = self.root / 'untouched'
        outside.mkdir()
        (outside / 'proof').write_text('keep')
        (repo / 'link').symlink_to(outside)
        (repo / 'backend').mkdir()
        (repo / 'backend' / 'node_modules').symlink_to(outside)
        exec(SYNC_SOURCE.replace("root = '/repo'", 'root = ' + repr(str(repo))), {})
        self.assertTrue((repo / '.venv/bin/python').exists())
        self.assertTrue((repo / 'frontend/node_modules/lib/package.json').exists())
        self.assertEqual((outside / 'proof').read_text(), 'keep')
        for name in ('old.py', 'dist', 'frontend/src', 'link', 'backend', '.env'):
            self.assertFalse((repo / name).exists())


if __name__ == '__main__':
    unittest.main()
