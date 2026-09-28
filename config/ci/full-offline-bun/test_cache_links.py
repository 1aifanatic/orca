import importlib.util, tarfile, unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('stage',Path(__file__).with_name('stage-source-cache.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class CacheLinks(unittest.TestCase):
 def link(self,target):
  m=tarfile.TarInfo('bun_install_cache_dir/pkg/1.0@@@1');m.type=tarfile.SYMTYPE;m.linkname=target;return m
 def test_rebase_exact_old_cache(self):
  m=self.link('/home/runner/work/_temp/dependency-acquisition/work/bun_install_cache_dir/pkg@1.0@@@1');n=module.relocate_cache_link(m,{'bun_install_cache_dir/pkg@1.0@@@1'})
  self.assertEqual(n.linkname,'../pkg@1.0@@@1');self.assertTrue(m.linkname.startswith('/'))
 def test_reject_foreign_absolute(self):
  with self.assertRaises(ValueError):module.relocate_cache_link(self.link('/etc/passwd'),set())
 def test_reject_missing_target(self):
  with self.assertRaises(ValueError):module.relocate_cache_link(self.link('/home/runner/work/_temp/dependency-acquisition/work/bun_install_cache_dir/missing'),set())
 def test_reject_traversal(self):
  with self.assertRaises(ValueError):module.relocate_cache_link(self.link('/home/runner/work/_temp/dependency-acquisition/work/bun_install_cache_dir/../secret'),set())
 def test_relative_link_unchanged(self):
  m=self.link('../pkg@1.0@@@1');self.assertIs(module.relocate_cache_link(m,set()),m)
if __name__=='__main__':unittest.main()
