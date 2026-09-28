from pathlib import Path
import importlib.util,unittest
p=Path(__file__).with_name('resolve.py');spec=importlib.util.spec_from_file_location('resolver',p);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Tests(unittest.TestCase):
 def test_print_uris_only(self):
  rows=module.parse_uris("Reading package lists...\n'https://apt.llvm.org/pool/a.deb' a.deb 25 SHA256:abc\n")
  self.assertEqual(rows[0]['bytes'],25)
 def test_budget(self):
  with self.assertRaisesRegex(ValueError,'budget'):module.parse_uris("'https://example.org/a.deb' a.deb 268435457 SHA256:abc")
 def test_count(self):
  with self.assertRaisesRegex(ValueError,'budget'):module.parse_uris("\n".join("'https://example.org/a.deb' a.deb 1 SHA256:abc" for _ in range(129)))
 def test_unknown_scheme(self):
  with self.assertRaisesRegex(ValueError,'Unsafe'):module.parse_uris("'file:///etc/passwd' a.deb 25 SHA256:abc")
 def test_required_llvm_closure(self):
  selected={'llvmPackages':[{'Package':'clang-21','Version':'pinned','SHA256':'hash','Size':'25'}]}
  row={'package':'clang-21','version':'pinned','sha256':'hash','bytes':25}
  module.validate_llvm([row],selected)
  for rows in [[],[{**row,'version':'new'}],[{**row,'sha256':'other'}],[{**row,'bytes':26}]]:
   with self.assertRaisesRegex(ValueError,'closure differs'):module.validate_llvm(rows,selected)
 def test_apt_hash_matches_authenticated_metadata(self):
  module.validate_apt_hash('MD5Sum:abc',{'MD5sum':'abc','SHA256':'strong'})
  module.validate_apt_hash('SHA256:strong',{'SHA256':'strong'})
  for printed,metadata in [('MD5Sum:abc',{'SHA256':'strong'}),('SHA256:wrong',{'SHA256':'strong'}),('UNKNOWN:abc',{'UNKNOWN':'abc'}),('SHA256',{'SHA256':'strong'})]:
   with self.assertRaisesRegex(ValueError,'authenticated metadata'):module.validate_apt_hash(printed,metadata)
 def test_empty(self):
  with self.assertRaises(ValueError):module.parse_uris('No rows')
if __name__=='__main__':unittest.main()
