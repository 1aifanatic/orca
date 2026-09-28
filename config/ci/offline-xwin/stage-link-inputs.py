"""Retain exact previously qualified LLVM archives and pinned Rust components."""
from pathlib import Path
import importlib.util
import hashlib
import json
import stat
import sys
import time
import tarfile
import urllib.request
import zipfile

BASE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('verifier', BASE / 'verify-offline-xwin.py')
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
spec = importlib.util.spec_from_file_location('acquire', BASE / 'acquire-historical-ucrt.py')
acquire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acquire)


def stage(archive, destination):
    verify.verify_file(archive, {'bytes': 219107903, 'sha256': '06b70d04c2b445f55eca428a7cccb16b5877c78ff28886d52b61f30efde7e4e4'})
    destination.mkdir(exist_ok=False)
    with zipfile.ZipFile(archive) as bundle:
        selected = [item for item in bundle.infolist() if item.filename.startswith(('metadata/', 'packages/'))]
        if sum(item.file_size for item in selected) > 512 * 1024**2:
            raise ValueError('LLVM input extraction exceeds bound')
        for item in selected:
            path = verify.checked_path(destination, item.filename)
            if item.is_dir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            if stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError('symlink in LLVM archive')
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open('xb') as output:
                output.write(bundle.read(item))
    rust = destination / 'rust'
    rust.mkdir()
    pins = json.loads((BASE / 'rust-assets.json').read_text())
    for item in pins['components']:
        if not item['url'].startswith('https://static.rust-lang.org/dist/2026-07-20/'):
            raise ValueError('unexpected Rust source')
        with urllib.request.urlopen(item['url'], timeout=30) as response:
            acquire.retain(response, verify.checked_path(rust, item['filename']), item, time.monotonic()+180)
    (rust / 'SHA256SUMS').write_text(''.join(f"{item['sha256']}  {item['filename']}\n" for item in pins['components']))
    (rust / 'components.txt').write_text(''.join(item['filename'].removesuffix('.tar.xz')+'\n' for item in pins['components']))


def extract_sdk(archive, destination):
    digest = hashlib.sha256()
    with archive.open('rb') as source:
        for data in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(data)
    if digest.hexdigest() != 'bd027d161f2acf29f6c61a89b6af0e25b10976348bbf9cb8cea7cbf97085ebf9':
        raise ValueError('extracted SDK archive hash mismatch')
    destination.mkdir(exist_ok=False)
    with tarfile.open(archive) as bundle:
        if sum(item.size for item in bundle.getmembers()) > 3 * 1024**3:
            raise ValueError('SDK extraction exceeds 3 GiB bound')
        bundle.extractall(destination, filter='data')


if __name__ == '__main__':
    if sys.argv[1] == 'sdk':
        extract_sdk(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        stage(Path(sys.argv[2]), Path(sys.argv[3]))
