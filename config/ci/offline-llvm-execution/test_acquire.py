import importlib.util,tempfile,unittest,zipfile,hashlib
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('acquire',Path(__file__).with_name('acquire.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_archive_traversal_refused(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'a.zip'
   with zipfile.ZipFile(p,'w') as z:z.writestr('../escape','bad')
   with patch.object(m,'ARTIFACT_SHA',m.digest(p)),self.assertRaisesRegex(ValueError,'Unsafe'):m.extract(p,Path(d)/'out')
   self.assertFalse((Path(d)/'out').exists())
 def test_verified_archive_extracts(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'a.zip'
   with zipfile.ZipFile(p,'w') as z:z.writestr('nested/input','bytes')
   with patch.object(m,'ARTIFACT_SHA',m.digest(p)):m.extract(p,Path(d)/'out')
   self.assertEqual((Path(d)/'out/nested/input').read_text(),'bytes')
 def test_corrupt_artifact_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'a.zip';p.write_bytes(b'bad')
   with self.assertRaisesRegex(ValueError,'hash mismatch'):m.extract(p,Path(d)/'out')
 def test_oversize_download_removed(self):
  import io
  with tempfile.TemporaryDirectory() as d,patch.object(m.urllib.request,'urlopen',side_effect=lambda *a,**kw:io.BytesIO(b'too much')),patch.object(m.time,'sleep'):
   row={'filename':'a.deb','bytes':1,'sha256':hashlib.sha256(b'a').hexdigest(),'url':'https://example.org/a'}
   with self.assertRaisesRegex(ValueError,'pinned size'):m.acquire(row,Path(d))
   self.assertEqual(list(Path(d).iterdir()),[])
 def test_exact_download(self):
  import io
  with tempfile.TemporaryDirectory() as d,patch.object(m.urllib.request,'urlopen',return_value=io.BytesIO(b'exact')):
   row={'filename':'a.deb','bytes':5,'sha256':hashlib.sha256(b'exact').hexdigest(),'url':'https://example.org/a'}
   m.acquire(row,Path(d));self.assertEqual((Path(d)/'a.deb').read_bytes(),b'exact')
if __name__=='__main__':unittest.main()
