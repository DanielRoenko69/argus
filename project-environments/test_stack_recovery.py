import base64
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from stack_contract import digest
from stack_runner import archive, durable, CANCEL, LABEL, OWNER
from stack_recovery import reconcile, preview, execute_recovered
from test_stack import request


class Recovery(unittest.TestCase):
    def setUp(self):
        CANCEL.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.r = request()
        self.key = digest(self.r)
        self.job = Path(self.tmp.name) / self.key
        self.job.mkdir()
        self.meta = dict(requestSha256=self.key, threadId=self.r['threadId'], planSha256=digest(self.r['plan']), sourceSha256=self.r['sourceSha256'], containerId='c'*64)
        durable(self.job / 'intent.json', {k:self.meta[k] for k in ['requestSha256', 'threadId', 'planSha256']})
        durable(self.job / 'snapshot-started.json', self.meta)
        durable(self.job / 'snapshot-failure.json', {**self.meta, 'code':'stack_snapshot_unavailable_no_replay'})
        self.client = Mock()
        self.client.api.timeout = 30
        self.client.images.list.return_value = []
        self.image = SimpleNamespace(id='sha256:'+'d'*64, attrs={'Config':{'Labels':{LABEL:OWNER, 'io.argus.recovery':self.key}}})
        self.client.images.get.return_value = self.image
        self.container = Mock(id='c'*64, attrs={'State':{'Running':False}, 'Mounts':[], 'NetworkSettings':{'Networks':{}},
            'Image':'sha256:'+'b'*64, 'Config':{'Labels':{LABEL:OWNER}}})
        self.client.containers.get.return_value = self.container
        self.container.commit.return_value = self.image
        self.container.get_archive.return_value = ([archive([('example.py',base64.b64decode(self.r['source'][0]['content']))])], {})
        self.runner = SimpleNamespace(client=self.client,store=Path(self.tmp.name),base='sha256:'+'b'*64)
        self.boot = patch('stack_recovery.boot_time', return_value=self.job.stat().st_mtime+10)
        self.boot.start(); self.addCleanup(self.boot.stop)

    def test_no_preview_before_operator_and_no_install_or_tests_on_reconcile(self):
        with self.assertRaises(FileNotFoundError): preview(self.runner,self.r)
        old=(self.job/'snapshot-failure.json').read_bytes()
        proof=reconcile(self.runner,self.r)
        self.assertEqual(preview(self.runner,self.r),proof)
        self.assertEqual(reconcile(self.runner,self.r),proof)
        self.assertEqual(old,(self.job/'snapshot-failure.json').read_bytes())
        self.assertEqual(self.client.api.timeout,30)
        self.container.commit.assert_called_once()
        self.container.start.assert_not_called()
        self.container.remove.assert_not_called()
        self.client.containers.create.assert_not_called()

    def test_reboot_required_and_export_loss_is_one_shot(self):
        with patch('stack_recovery.boot_time',return_value=0), self.assertRaisesRegex(ValueError,'engine_reboot_required'):
            reconcile(self.runner,self.r)
        self.container.commit.assert_not_called()
        self.container.commit.side_effect=RuntimeError('PRIVATE')
        for _ in range(2):
            with self.assertRaisesRegex(ValueError,'uncertain_no_replay'): reconcile(self.runner,self.r)
        self.container.commit.assert_called_once()
        self.assertNotIn('PRIVATE',(self.job/'recovery-snapshot-started.json').read_text())

    def test_source_worker_scope_and_cancel_are_enforced(self):
        for key,value in [('Mounts',[{}]),('Image','other'),('State',{'Running':True}),('NetworkSettings',{'Networks':{'live':{}}})]:
            old=self.container.attrs[key]; self.container.attrs[key]=value
            with self.assertRaises(ValueError): reconcile(self.runner,self.r)
            self.container.attrs[key]=old
        self.container.get_archive.return_value=([archive([('example.py',b'changed')])],{})
        with self.assertRaisesRegex(ValueError,'source_changed'): reconcile(self.runner,self.r)
        self.container.commit.assert_not_called()
        durable(self.runner.store/(self.r['threadId']+'.canceled.json'),{})
        with self.assertRaisesRegex(ValueError,'terminal'): reconcile(self.runner,self.r)

    def test_tests_execute_once_offline_without_setup_and_preserve_old_worker(self):
        proof=reconcile(self.runner,self.r)
        test_worker=Mock(); self.client.containers.create.return_value=test_worker
        with patch('stack_startup.execute_tests',return_value={'status':'completed','exitCode':0,'stdout':'ok','stderr':'','durationMs':1,'testStarted':True}) as execute:
            receipt=execute_recovered(self.runner,self.r)
        self.assertEqual(receipt['phase'],'project')
        self.assertEqual(receipt['preparedImage'],proof['preparedImage'])
        execute.assert_called_once()
        self.assertEqual(execute.call_args.args[2:4],(self.r['plan']['start'],self.r['plan']['test']))
        self.assertEqual(self.client.containers.create.call_args.kwargs['network'],'none')
        self.container.remove.assert_not_called()
        test_worker.remove.assert_called_once()
        with self.assertRaisesRegex(ValueError,'terminal'): preview(self.runner,self.r)

    def test_crash_after_test_intent_cannot_replay(self):
        reconcile(self.runner,self.r)
        self.client.containers.create.side_effect=RuntimeError('crash')
        with self.assertRaises(RuntimeError): execute_recovered(self.runner,self.r)
        with self.assertRaisesRegex(ValueError,'already_consumed'): execute_recovered(self.runner,self.r)
        self.client.containers.create.assert_called_once()


if __name__=='__main__': unittest.main()
