import importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('stage',Path(__file__).with_name('stage.py'));stage=importlib.util.module_from_spec(spec);spec.loader.exec_module(stage)
class Bounds(unittest.TestCase):
 def fixture(self,root,name='perl',installed=''):
  results=root/'results';results.mkdir();(results/'indexes').mkdir()
  (results/'installed-before.tsv').write_text(installed)
  (results/'uris.txt').write_text("'http://archive.ubuntu.com/ubuntu/perl.deb' perl.deb 1 MD5Sum:abc\n")
  (results/'indexes'/'one').write_text('Package: '+name+'\nVersion: 5.30.0-9ubuntu0.5\nFilename: pool/perl.deb\nSize: 1\nSHA256: deadbeef\nMD5sum: abc\n')
 def test_refuses_installed_replacement(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);self.fixture(root,installed='perl\t5.30.0-9ubuntu0.5\n')
   with self.assertRaisesRegex(ValueError,'replaces installed'):stage.download(root)
 def test_refuses_wrong_historical_version(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);self.fixture(root,name='nasm')
   with self.assertRaisesRegex(ValueError,'historical pin mismatch'):stage.download(root)
 def test_refuses_unbounded_package(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);self.fixture(root)
   (root/'results/uris.txt').write_text("'http://example.org/a.deb' a.deb 100000000 MD5Sum:abc\n")
   with self.assertRaisesRegex(ValueError,'closure exceeds'):stage.download(root)
if __name__=='__main__':unittest.main()
