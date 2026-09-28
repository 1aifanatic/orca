import importlib.util, io, hashlib, tempfile, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('download', Path(__file__).with_name('download-inputs.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Response(io.BytesIO):
    headers = {}
class Downloads(unittest.TestCase):
    def check(self, data, size, sha):
        with tempfile.TemporaryDirectory() as root:
            module.retain(Response(data), Path(root) / 'input', size, sha)
    def test_exact(self):
        self.check(b'abc', 3, hashlib.sha256(b'abc').hexdigest())
    def test_corrupt(self):
        with self.assertRaises(ValueError): self.check(b'bad', 3, hashlib.sha256(b'abc').hexdigest())
    def test_truncated(self):
        with self.assertRaises(ValueError): self.check(b'ab', 3, hashlib.sha256(b'abc').hexdigest())
    def test_oversize(self):
        with self.assertRaises(ValueError): self.check(b'abcd', 3, hashlib.sha256(b'abc').hexdigest())
    def test_origin(self):
        with self.assertRaises(ValueError): module.check_url('http://nodejs.org/input')
if __name__ == '__main__': unittest.main()
