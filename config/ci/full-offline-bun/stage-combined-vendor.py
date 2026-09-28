from pathlib import Path
import hashlib, importlib.util, tarfile, zipfile, sys
base=Path(__file__).parent
spec=importlib.util.spec_from_file_location('vendor',base/'compose-cargo-vendor.py')
vendor=importlib.util.module_from_spec(spec);spec.loader.exec_module(vendor)
archive,rust,destination=map(Path,sys.argv[1:])
if vendor.digest(archive)!='79c1c4aa8d9a57658f5636787287757f9bfa4b5ab0fb74054e6a52b9642cee60' or archive.stat().st_size!=114257418:raise ValueError('Dependency artifact identity mismatch')
for name,sha in [('root-Cargo.lock','5c3a9f56eef147f4110114694f44797d66290813513add281a5403f633c1e381'),('std-Cargo.lock','9e87d1ac04edbf5fa61e27cb21984a83566573a007767713868965fba70acb6d')]:
 if vendor.digest(base/name)!=sha:raise ValueError('Lock identity mismatch')
destination.mkdir()
with zipfile.ZipFile(archive) as bundle:
 info=bundle.getinfo('work/dependency-caches.tar.gz')
 if info.file_size!=114735785:raise ValueError('Dependency tar size mismatch')
 with bundle.open(info) as source,(destination/'caches.tar.gz').open('xb') as out:
  import shutil
  shutil.copyfileobj(source,out)
if vendor.digest(destination/'caches.tar.gz')!='d0297fad7decb559cc092910d60a15da5a800fa0fea4d4324adee36c53e38109':raise ValueError('Dependency tar hash mismatch')
with tarfile.open(destination/'caches.tar.gz') as bundle:
 members=[m for m in bundle.getmembers() if m.name.startswith('cargo-vendor/')]
 if sum(m.size for m in members)>512*1024**2:raise ValueError('Vendor size exceeds bound')
 if any(not(m.isfile() or m.isdir()) for m in members):raise ValueError('Unexpected vendor file type')
 bundle.extractall(destination/'root',members=members,filter='data')
std=rust/'rust-src-nightly.tar.xz'
if vendor.digest(std)!='d4ffe57cc99d8846761bdbefc631bfd8f06fc001d7208576887e381c5709341a':raise ValueError('Rust source identity mismatch')
with tarfile.open(std) as bundle:
 members=[m for m in bundle.getmembers() if '/library/vendor/' in m.name]
 if sum(m.size for m in members)>32*1024**2:raise ValueError('Std vendor size exceeds bound')
 if any(not(m.isfile() or m.isdir()) for m in members):raise ValueError('Unexpected std file type')
 bundle.extractall(destination/'std',members=members,filter='data')
vendor.compose(destination/'root/cargo-vendor',destination/'std/rust-src-nightly/rust-src/lib/rustlib/src/rust/library/vendor',base/'root-Cargo.lock',base/'std-Cargo.lock',destination/'combined')
