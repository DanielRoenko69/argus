import base64
import hashlib
import json
from pathlib import Path
import unittest
from project_snapshot import project_path, check_project_content
from stack_contract import digest, parse_request
from codegen_contract import parse_codegen_request
from test_stack import request

class ProjectSnapshot(unittest.TestCase):
    def test_shared_cases(self):
        cases=json.loads(Path(__file__).with_name('project_snapshot_cases.json').read_text())
        for name in cases['allowed']: self.assertTrue(project_path(name),name)
        for name in cases['denied']: self.assertFalse(project_path(name),name)
        for row in cases['contentAllowed']: check_project_content(row['path'],row['text'].encode())
        for row in cases['contentDenied']:
            with self.assertRaisesRegex(ValueError,'sensitive_content'): check_project_content(row['path'],row['text'].encode())

    def test_session_generator_inputs_not_write_scope_or_legacy(self):
        r=request()
        r['source'].insert(0,{'path':'.python-version','content':base64.b64encode(b'3.14\n').decode()})
        r['sourceSha256']=digest([r['baseCommitSha'],[[f['path'],hashlib.sha256(base64.b64decode(f['content'])).hexdigest()] for f in r['source']]])
        with self.assertRaises(ValueError): parse_request(r)
        r.update(executionMode='workspace-session-v1',preparedSession=None)
        self.assertEqual(parse_request(r),r)
        gen={k:r[k] for k in ['version','threadId','basisSha256','sourceSha256','baseCommitSha','source','executionMode']}
        gen['plan']={'version':1,'summary':'fixture','setup':'true','start':'','generate':'true','outputPaths':['client.ts']}
        self.assertEqual(parse_codegen_request(gen),gen)
        gen['plan']['outputPaths']=['.python-version']
        with self.assertRaises(ValueError): parse_codegen_request(gen)

if __name__=='__main__': unittest.main()
