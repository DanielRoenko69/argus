import base64
import copy
import io
import tarfile
import unittest
from codegen_contract import parse_codegen_request, read_regular, export_outputs, verify_inputs
from stack_runner import archive
from test_stack import request


def fixture():
    r = request()
    for k in ('phase', 'probe', 'preparedImage'):
        del r[k]
    r['plan'] = {'version': 1, 'summary': 'generate', 'setup': 'true', 'start': '',
                 'generate': 'generator', 'outputPaths': ['client.ts']}
    return r


class FileContainer:
    def __init__(self, data):
        self.data = data

    def get_archive(self, name):
        content = self.data[name]
        return [archive([(name.split('/')[-1], content)])], {'size': len(content), 'linkTarget': ''}


class CodeGeneration(unittest.TestCase):
    def test_contract_and_source_digest(self):
        self.assertEqual(parse_codegen_request(fixture()), fixture())
        for key in ('mounts', 'image', 'network', 'privileged', 'credentials'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                parse_codegen_request({**fixture(), key: []})
        value = fixture()
        value['source'][0]['content'] = base64.b64encode(b'tampered').decode()
        with self.assertRaises(ValueError):
            parse_codegen_request(value)

    def test_protected_or_unbounded_outputs(self):
        for output in ('../client.ts', '/etc/passwd', '.env', 'src/.git/config', 'Jenkinsfile',
                       'package.json', 'requirements.txt', 'client/*', 'node_modules/client.ts', 'x' * 241):
            value = fixture()
            value['plan']['outputPaths'] = [output]
            with self.subTest(path=output), self.assertRaises(ValueError):
                parse_codegen_request(value)
        value = fixture()
        value['plan']['outputPaths'] = ['client.ts', 'client.ts']
        with self.assertRaises(ValueError):
            parse_codegen_request(value)

    def test_reads_regular_text_and_binds_originals(self):
        r = fixture()
        c = FileContainer({'/repo/example.py': base64.b64decode(r['source'][0]['content']), '/repo/client.ts': b'export type Q = string\n'})
        verify_inputs(c, r['source'])
        outputs = export_outputs(c, r)
        self.assertEqual(outputs[0]['beforeSha256'], None)
        self.assertEqual(base64.b64decode(outputs[0]['content']), c.data['/repo/client.ts'])
        c.data['/repo/example.py'] = b'changed'
        with self.assertRaisesRegex(ValueError, 'modified_input'):
            verify_inputs(c, r['source'])
        verify_inputs(c, r['source'], ['example.py'])

    def test_symlink_tar_and_binary_artifacts_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE):
            out = io.BytesIO()
            with tarfile.open(fileobj=out, mode='w') as tar:
                item = tarfile.TarInfo('client.ts')
                item.type = kind
                item.linkname = '/etc/passwd'
                tar.addfile(item)
            c = FileContainer({})
            c.get_archive = lambda _: ([out.getvalue()], {'size': 0, 'linkTarget': ''})
            with self.assertRaises(ValueError):
                read_regular(c, 'client.ts', 1024)
        for content in (b'\x00', b'\xff', b'x' * (1024 * 1024 + 1)):
            with self.assertRaises((ValueError, UnicodeDecodeError)):
                export_outputs(FileContainer({'/repo/client.ts': content}), fixture())


if __name__ == '__main__':
    unittest.main()
