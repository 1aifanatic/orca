import hashlib, importlib.util, json, tempfile, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('composition', Path(__file__).with_name('compose-cargo-vendor.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Composition(unittest.TestCase):
    def fixture(self, root, version='1.0', contents='one'):
        root.mkdir()
        text = '[package]\nname = "example"\nversion = "' + version + '"\n'
        (root / 'Cargo.toml').write_text(text)
        (root / 'source.rs').write_text(contents)
        checksums={'package': 'a' * 64, 'files': {n: module.digest(root / n) for n in ['Cargo.toml', 'source.rs']}}
        (root / '.cargo-checksum.json').write_text(json.dumps(checksums))
        return checksums
    def test_composition_overlap_and_conflicting_files(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); left=root/'left';right=root/'right';left.mkdir();right.mkdir()
            self.fixture(left/'example');self.fixture(right/'example')
            lock=root/'Cargo.lock';lock.write_text('[[package]]\nname="example"\nversion="1.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="' + 'a'*64 + '"\n')
            result=module.compose(left,right,lock,lock,root/'combined')
            self.assertEqual(len(result),1)
            self.assertTrue((root/'combined/vendor/example-1.0').is_dir())
            path=right/'example';(path/'source.rs').write_text('different')
            checksums=json.loads((path/'.cargo-checksum.json').read_text())
            checksums['files']['source.rs']=module.digest(path/'source.rs')
            (path/'.cargo-checksum.json').write_text(json.dumps(checksums))
            with self.assertRaisesRegex(ValueError,'Conflicting same-identity'):
                module.compose(left,right,lock,lock,root/'conflicting')
    def test_multiple_versions(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); p=root/'crate'; self.fixture(p, '2.0')
            identity,_=module.verify_crate(p,{('example','1.0'):'a'*64,('example','2.0'):'a'*64})
            self.assertEqual(identity,('example','2.0'))
    def test_file_corruption(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'crate'; self.fixture(p); (p/'source.rs').write_text('bad')
            with self.assertRaisesRegex(ValueError,'file checksum'): module.verify_crate(p,{('example','1.0'):'a'*64})
    def test_package_conflict(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'crate'; self.fixture(p)
            with self.assertRaisesRegex(ValueError,'Package checksum'): module.verify_crate(p,{('example','1.0'):'b'*64})
    def test_lock_overlap_and_conflict(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'lock'; text='[[package]]\nname="example"\nversion="1.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="aaa"\n'; p.write_text(text)
            self.assertEqual(len(module.locked_packages([p,p])),1)
            q=Path(t)/'other';q.write_text(text.replace('aaa','bbb'))
            with self.assertRaisesRegex(ValueError,'Conflicting locked'):module.locked_packages([p,q])
    def test_extra_file_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/'crate'; self.fixture(p);(p/'extra').write_text('extra')
            with self.assertRaisesRegex(ValueError,'membership'):module.verify_crate(p,{('example','1.0'):'a'*64})
if __name__ == '__main__':unittest.main()
