"""Restore only pinned build dependency trees into an exact Bun source checkout."""
from pathlib import Path
import copy, hashlib, json, posixpath, shutil, subprocess, sys, tarfile, zipfile

BASE=Path(__file__).parent

def digest(path):
    result=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024**2),b''):result.update(block)
    return result.hexdigest()

def relocate_cache_link(member, allowed):
    if not member.issym() or not member.linkname.startswith('/'):
        return member
    prefix='/home/runner/work/_temp/dependency-acquisition/work/'
    if not member.name.startswith('bun_install_cache_dir/') or not member.linkname.startswith(prefix+'bun_install_cache_dir/'):
        raise ValueError('Unexpected absolute cache symlink')
    target=member.linkname[len(prefix):]
    if posixpath.normpath(target)!=target or target.rstrip('/') not in allowed:
        raise ValueError('Unretained cache symlink target')
    relocated=copy.copy(member)
    relocated.linkname=posixpath.relpath(target,posixpath.dirname(member.name))
    return relocated

def stage(archive, work):
    plan=json.loads((BASE/'inputs.json').read_text())
    pin=plan['artifacts']['dependencies']
    if archive.stat().st_size!=pin['bytes'] or digest(archive)!=pin['sha256']:
        raise ValueError('Dependency artifact identity mismatch')
    source=work/'source'
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
    if head!=plan['source']:raise ValueError('Source commit mismatch')
    for name,checksum in plan['sourceLockPins'].items():
        if digest(source/name)!=checksum:raise ValueError('Source lock mismatch')
    tar=work/'dependency-caches.tar.gz'
    with zipfile.ZipFile(archive) as bundle:
        item=bundle.getinfo('work/dependency-caches.tar.gz')
        if item.file_size!=114735785:raise ValueError('Unexpected cache tar length')
        with bundle.open(item) as src,tar.open('xb') as out:shutil.copyfileobj(src,out)
    if digest(tar)!='d0297fad7decb559cc092910d60a15da5a800fa0fea4d4324adee36c53e38109':raise ValueError('Cache tar hash mismatch')
    prefixes=['source/node_modules','source/packages/bun-error/node_modules',
              'source/src/node-fallbacks/node_modules','source/vendor/lolhtml',
              'source/vendor/rust-argon2','bun_install_cache_dir']
    if any((work/p).exists() for p in prefixes):raise ValueError('Refusing existing dependency tree')
    with tarfile.open(tar) as bundle:
        members=[m for m in bundle.getmembers() if any(m.name==p or m.name.startswith(p+'/') for p in prefixes)]
        if len(members)>50000 or sum(m.size for m in members)>1024**3:raise ValueError('Cache extraction bound exceeded')
        if not all(any(m.name==p or m.name.startswith(p+'/') for m in members) for p in prefixes):raise ValueError('Missing dependency tree')
        allowed={m.name.rstrip('/') for m in members}
        members=[relocate_cache_link(m,allowed) for m in members]
        if any(m.islnk() and m.linkname not in allowed for m in members):
            raise ValueError('Hardlink points outside selected cache trees')
        bundle.extractall(work,members=members,filter='data')
    for name,checksum in plan['sourceLockPins'].items():
        if digest(source/name)!=checksum:raise ValueError('Extraction changed source lock')
    (work/'source-cache-receipt.json').write_text(json.dumps({'source':head,'members':len(members),'bytes':sum(m.size for m in members),'prefixes':prefixes,'artifactSha256':pin['sha256']},indent=2)+'\n')

if __name__=='__main__':stage(*map(Path,sys.argv[1:]))
