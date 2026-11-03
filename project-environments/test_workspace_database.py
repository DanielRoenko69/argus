import base64
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from workspace_database import Lease, identity, configured, recover, validate, HBA_PATH

THREAD = '11111111-1111-4111-8111-111111111111'


class WorkspaceDatabase(unittest.TestCase):
    def fixture(self):
        runner = SimpleNamespace(client=Mock(), store=Path('/fixture'))
        db = Mock(id='d' * 64)
        marker = {'threadId': THREAD, 'networkId': 'c' * 64, 'databaseContainerId': db.id}
        runner.client.networks.get.return_value.attrs = {'Containers': {}}
        return runner, db, marker, Lease(runner, db, marker)

    def test_identity_is_scope_bound_and_not_injectable(self):
        a = identity('local', THREAD)
        self.assertNotEqual(a, identity('different', THREAD))
        self.assertRegex(a[0], r'^argus_run_[a-f0-9]{32}$')
        for owner, thread in [("local';", THREAD), ('local', "'; DROP DATABASE app;")]:
            with self.assertRaises(ValueError):
                identity(owner, thread)

    def test_database_without_exact_label_is_not_admitted(self):
        runner, db, _, _ = self.fixture()
        runner.client.containers.get.return_value = db
        db.attrs = {'Config': {'Labels': {}}}
        with patch.dict('os.environ', ARGUS_WORKSPACE_DATABASE_CONTAINER='fixture'):
            with self.assertRaisesRegex(ValueError, 'stack_database_policy_required'):
                configured(runner)

    def test_foreign_provenance_is_never_reset(self):
        _, _, _, lease = self.fixture()
        with patch('workspace_database.validate', return_value=16), patch('workspace_database.sql', return_value=json.dumps(
                {'roleExists': True, 'role': 'other', 'dbExists': False, 'database': None})) as sql:
            with self.assertRaisesRegex(ValueError, 'stack_database_binding_changed'):
                lease.prepare()
            self.assertEqual(sql.call_count, 1)

    def test_mutable_or_trust_hba_is_not_admitted(self):
        runner, db, _, _ = self.fixture()
        db.attrs = {'Mounts': [{'Destination': HBA_PATH, 'RW': True}]}
        with self.assertRaisesRegex(ValueError, 'stack_database_policy_required'):
            validate(runner, db)
        from stack_runner import archive
        db.attrs['Mounts'][0]['RW'] = False
        db.get_archive.return_value = ([archive([('workspace-db.pg_hba.conf', b'host all all all trust\n')])], {})
        with self.assertRaisesRegex(ValueError, 'stack_database_policy_required'):
            validate(runner, db)

    def test_disconnect_is_attempted_even_if_revocation_fails(self):
        runner, _, _, lease = self.fixture()
        lease.issued = lease.connected = True
        with patch('workspace_database.sql', side_effect=ValueError('unavailable')):
            with self.assertRaisesRegex(ValueError, 'stack_database_stop_unconfirmed'):
                lease.close()
        runner.client.networks.get.return_value.disconnect.assert_called_once()
        self.assertTrue(lease.issued)
        self.assertFalse(lease.connected)

    def test_revocation_is_not_reported_until_network_detachment_is_confirmed(self):
        runner, db, _, lease = self.fixture()
        lease.connected = True
        runner.client.networks.get.return_value.attrs = {'Containers': {db.id: {}}}
        with self.assertRaisesRegex(ValueError, 'stack_database_stop_unconfirmed'):
            lease.close()

    def test_ephemeral_password_does_not_enter_logs_or_generated_source(self):
        _, _, _, lease = self.fixture()
        result = {'stdout': lease.password, 'stderr': 'password=' + lease.password}
        lease.redact(result)
        self.assertNotIn(lease.password, json.dumps(result))
        with self.assertRaisesRegex(ValueError, 'stack_database_secret_in_output'):
            lease.redact({'outputs': [{'content': base64.b64encode(lease.password.encode()).decode()}]})

    def test_recovery_only_revokes_and_disconnects_never_resets_or_replays(self):
        runner, db, marker, _ = self.fixture()
        runner.client.containers.get.return_value = db
        runner.client.networks.get.return_value.attrs = {'Containers': {db.id: {}}}
        runner.client.networks.get.return_value.disconnect.side_effect = lambda *a, **k: runner.client.networks.get.return_value.attrs.update(Containers={})
        with patch('workspace_session.session_markers', return_value=[marker]), patch('workspace_database.validate'), patch('workspace_database.sql', return_value='1') as sql:
            recover(runner)
            statements = '\n'.join(c.args[2] for c in sql.call_args_list)
            self.assertIn('NOLOGIN PASSWORD NULL', statements)
            self.assertNotIn('DROP DATABASE', statements)
            self.assertNotIn('CREATE DATABASE', statements)
        runner.client.networks.get.return_value.disconnect.assert_called_once()

    def removed_database_fixture(self):
        from docker.errors import NotFound
        from stack_runner import LABEL, OWNER
        from workspace_session import SESSION_LABEL
        runner, db, marker, _ = self.fixture()
        marker['containerId'] = 'e' * 64
        labels = {LABEL: OWNER, SESSION_LABEL: THREAD}
        worker = Mock(id=marker['containerId'], attrs={'State': {'Running': False},
            'Config': {'Labels': labels}, 'NetworkSettings': {'Networks': {'private': {'NetworkID': marker['networkId']}}}})
        def get(ident):
            if ident == db.id:
                raise NotFound('removed database')
            self.assertEqual(ident, worker.id)
            return worker
        runner.client.containers.get.side_effect = get
        network = runner.client.networks.get.return_value
        network.id = marker['networkId']
        network.attrs = {'Internal': True, 'Labels': labels, 'Containers': {}}
        return runner, marker, worker, network

    def test_removed_database_keeps_stopped_isolated_session_without_touching_replacement(self):
        runner, marker, worker, network = self.removed_database_fixture()
        before = dict(marker)
        with patch('workspace_session.session_markers', return_value=[marker]), patch('workspace_database.sql') as sql:
            recover(runner)
            sql.assert_not_called()
        self.assertEqual(marker, before)
        worker.start.assert_not_called()
        network.connect.assert_not_called()
        network.disconnect.assert_not_called()

    def test_removed_database_does_not_ignore_running_or_foreign_resources(self):
        for kind in ['running', 'paused', 'foreign-worker', 'external-network', 'extra-endpoint', 'extra-network', 'missing-network']:
            runner, marker, worker, network = self.removed_database_fixture()
            if kind == 'running': worker.attrs['State']['Running'] = True
            if kind == 'paused': worker.attrs['State']['Paused'] = True
            if kind == 'foreign-worker': worker.id = 'f' * 64
            if kind == 'external-network': network.attrs['Internal'] = False
            if kind == 'extra-endpoint': network.attrs['Containers'] = {'f' * 64: {}}
            if kind == 'extra-network': worker.attrs['NetworkSettings']['Networks']['other'] = {'NetworkID': 'f' * 64}
            if kind == 'missing-network':
                from docker.errors import NotFound
                runner.client.networks.get.side_effect = NotFound('gone')
            with patch('workspace_session.session_markers', return_value=[marker]), \
                    self.assertRaisesRegex(ValueError, 'stack_database_stop_unconfirmed', msg=kind):
                recover(runner)

    def test_missing_database_and_worker_and_network_are_safe_but_docker_outages_are_not(self):
        from docker.errors import NotFound
        runner, marker, _, _ = self.removed_database_fixture()
        runner.client.containers.get.side_effect = NotFound('gone')
        runner.client.networks.get.side_effect = NotFound('gone')
        with patch('workspace_session.session_markers', return_value=[marker]), patch('workspace_database.sql') as sql:
            recover(runner)
            sql.assert_not_called()
            runner.client.containers.get.side_effect = TimeoutError('daemon offline')
            with self.assertRaisesRegex(ValueError, 'stack_database_stop_unconfirmed'):
                recover(runner)


if __name__ == '__main__':
    unittest.main()
