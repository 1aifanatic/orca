import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import tarfile
import zipfile
import io
import unittest
from unittest.mock import patch

BASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('verify_xwin', BASE / 'verify-offline-xwin.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
spec = importlib.util.spec_from_file_location('assemble_xwin', BASE / 'assemble-qualified-xwin-cache.py')
assembler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembler)


def pin(data):
    return {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}


class InputVerification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for directory in ('cache/dl', 'tool', 'manifest'):
            (self.root / directory).mkdir(parents=True)
        channel = json.dumps({'channelItems': [{'type': 'Manifest', 'payloads': [{'sha256': 'advertised'}]}]}).encode()
        self.files = {'cache/dl/package': b'cache', 'tool/xwin': b'tool', 'manifest/channel.json': channel}
        for path, data in self.files.items():
            (self.root / path).write_bytes(data)
        self.pins = {'cache': {'dl/package': pin(b'cache')}, 'tool': pin(b'tool'),
                     'channel': pin(channel), 'catalogTrust': {'channelAdvertisedSha256': 'advertised'}}

    def test_exact_inputs(self):
        self.assertTrue(verify.verify_inputs(self.root, self.pins)['inputsVerified'])

    def test_each_input_corruption(self):
        for path, data in self.files.items():
            with self.subTest(path=path):
                (self.root / path).write_bytes(b'x' * len(data))
                with self.assertRaisesRegex(ValueError, 'hash mismatch'):
                    verify.verify_inputs(self.root, self.pins)
                (self.root / path).write_bytes(data)

    def test_each_missing_input(self):
        for path, data in self.files.items():
            with self.subTest(path=path):
                (self.root / path).unlink()
                with self.assertRaisesRegex(ValueError, 'layout mismatch'):
                    verify.verify_inputs(self.root, self.pins)
                (self.root / path).write_bytes(data)

    def test_extra_cache_file(self):
        (self.root / 'cache/extra').write_bytes(b'extra')
        with self.assertRaisesRegex(ValueError, 'layout mismatch'):
            verify.verify_inputs(self.root, self.pins)

    def test_symlink_file(self):
        p = self.root / 'tool/xwin'
        p.unlink()
        p.symlink_to(self.root / 'cache/dl/package')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            verify.verify_inputs(self.root, self.pins)

    def test_symlink_directory(self):
        (self.root / 'cache/dl').rename(self.root / 'saved')
        (self.root / 'cache/dl').symlink_to(self.root / 'saved', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            verify.verify_inputs(self.root, self.pins)

    def test_unsafe_plan_path(self):
        for path in ('../escape', '/absolute', 'dl/../escape', 'dl//file'):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'unsafe'):
                verify.checked_path(self.root, path)

    def test_channel_alias_mismatch(self):
        self.pins['catalogTrust']['channelAdvertisedSha256'] = 'wrong'
        with self.assertRaisesRegex(ValueError, 'alias mismatch'):
            verify.verify_inputs(self.root, self.pins)

    def test_refuses_existing_assembly_destination(self):
        with self.assertRaisesRegex(ValueError, 'fresh directory'):
            assembler.assemble(self.root, None, None, None, None, self.pins)

    def test_assembly_size_limit(self):
        self.pins['cache']['dl/package']['bytes'] = 1024**3 + 1
        with self.assertRaisesRegex(ValueError, 'bound'):
            assembler.assemble(self.root / 'fresh', None, None, None, None, self.pins)

    def test_assembly_preserves_two_aliases_of_one_source(self):
        archive = self.root / 'source.zip'
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('same-source', b'cache')
        tool_archive = self.root / 'tool.tar.gz'
        with tarfile.open(tool_archive, 'w:gz') as bundle:
            member = tarfile.TarInfo('xwin/xwin')
            member.size = 4
            bundle.addfile(member, io.BytesIO(b'tool'))
        pins = dict(self.pins)
        pins['sourceArchive'] = pin(archive.read_bytes())
        pins['toolArchive'] = {**pin(tool_archive.read_bytes()), 'member': 'xwin/xwin'}
        pins['cache'] = {name: {**pin(b'cache'), 'source': 'same-source'}
                         for name in ('dl/first', 'dl/second')}
        destination = self.root / 'assembled'
        receipt = assembler.assemble(destination, archive, self.root,
                                     self.root / 'manifest/channel.json', tool_archive, pins)
        self.assertEqual(receipt['cacheFiles'], 2)
        self.assertEqual((destination / 'cache/dl/first').read_bytes(), b'cache')
        self.assertEqual((destination / 'cache/dl/second').read_bytes(), b'cache')

    def test_connected_stage_checks_archive_before_network(self):
        stage_spec = importlib.util.spec_from_file_location('stage_xwin', BASE / 'stage-offline-xwin-inputs.py')
        stage = importlib.util.module_from_spec(stage_spec)
        stage_spec.loader.exec_module(stage)
        archive = self.root / 'wrong.zip'
        archive.write_bytes(b'not the qualified archive')
        with patch.object(stage.urllib.request, 'build_opener') as connect:
            with self.assertRaisesRegex(ValueError, 'size mismatch'):
                stage.stage(archive, self.root / 'staged')
            connect.assert_not_called()
        self.assertFalse((self.root / 'staged').exists())

    def test_real_pins_include_full_selection(self):
        pins = json.loads((BASE / 'offline-xwin-input-pins.json').read_text())
        self.assertEqual(len(pins['cache']), 47)
        self.assertEqual(sum(p['bytes'] for p in pins['cache'].values()), 472496708)
        self.assertEqual(sum(path.endswith('.vsix') for path in pins['cache']), 8)
        alias = 'dl/pkg_manifest_' + pins['catalogTrust']['channelAdvertisedSha256'] + '.vsman'
        self.assertEqual(pins['cache'][alias]['sha256'], pins['catalogTrust']['actualSha256'])
        self.assertNotEqual(pins['cache'][alias]['sha256'], pins['catalogTrust']['channelAdvertisedSha256'])


if __name__ == '__main__':
    unittest.main()
