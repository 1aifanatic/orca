import importlib.util,tempfile,unittest
from pathlib import Path
root=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('selection',root/'select.py');selection=importlib.util.module_from_spec(spec);spec.loader.exec_module(selection)
class Tests(unittest.TestCase):
 def test_exact_identity_and_budget(self):
  result=selection.select(root);self.assertLess(result['llvmDownloadBytes'],96*1024*1024);self.assertTrue(all(x['Version']==selection.VERSION for x in result['llvmPackages']));self.assertFalse(result['closureComplete']);self.assertFalse(result['signatureVerified'])
 def test_corrupt_index(self):
  with tempfile.TemporaryDirectory() as temp:
   p=Path(temp);(p/'InRelease').write_bytes((root/'InRelease').read_bytes());(p/'Packages.gz').write_bytes((root/'Packages.gz').read_bytes()+b'x')
   with self.assertRaisesRegex(ValueError,'checksum'):selection.select(p)
 def test_unavailable_fails_closed(self):
  old=selection.VERSION
  try:
   selection.VERSION='unavailable'
   with self.assertRaisesRegex(ValueError,'unavailable'):selection.select(root)
  finally:selection.VERSION=old
if __name__=='__main__':unittest.main()
