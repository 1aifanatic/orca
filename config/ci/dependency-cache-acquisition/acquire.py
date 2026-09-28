"""Disposable Linux x64 acquisition only; run under workflow disk/time limits."""
from pathlib import Path
import hashlib,json,os,platform,shutil,subprocess,sys,tarfile,zipfile
HERE=Path(__file__).resolve().parent
plan=json.loads((HERE/'inputs.json').read_text())
inputs,work=map(lambda p:Path(p).resolve(),sys.argv[1:])
if platform.system()!='Linux' or platform.machine()!='x86_64': raise RuntimeError('Linux x64 only')
work.mkdir()
receipts=work/'receipts';receipts.mkdir()
# Validate against committed diagnostic pins, never a mutable artifact-provided manifest.
for a in plan['tools']+plan['nativePathDependencies']:
    name=a.get('filename',a.get('cacheKey'));p=inputs/name
    if p.stat().st_size!=a.get('size',a.get('bytes')) or hashlib.sha256(p.read_bytes()).hexdigest()!=a['sha256']:
        raise ValueError('Input mismatch: '+name)
env=os.environ.copy()
for name in ['CARGO_HOME','RUSTUP_HOME','BUN_INSTALL_CACHE_DIR','npm_config_cache','XDG_CACHE_HOME']:
    env[name]=str(work/name.lower())
env.update(ORCA_BACKGROUND_LAUNCH='1',CI='true',RUSTUP_TOOLCHAIN='orca-nightly-2026-07-20')
# Existing user-level Cargo/npm config must not enter the isolated acquisition.
env['CARGO_HOME']=str(work/'cargo-home')
tools=work/'tools';tools.mkdir()
def run(argv,cwd=work,output=None):
    with (output.open('w') if output else (receipts/'commands.log').open('a')) as log:
        subprocess.run(argv,cwd=cwd,env=env,stdout=log,stderr=None if output else subprocess.STDOUT,check=True,timeout=1200)
def extract(archive,dest):
    dest.mkdir()
    with tarfile.open(archive) as t:t.extractall(dest,filter='data')
for a in plan['tools']:
    name=a['filename'];stage=tools/name.replace('.tar.xz','').replace('.tar.gz','').replace('.zip','')
    if name.endswith('.zip'):
        stage.mkdir()
        with zipfile.ZipFile(inputs/name) as z:z.extractall(stage)
        bun=next(stage.glob('*/bun'));bun.chmod(0o755)
        env['PATH']=str(bun.parent)+os.pathsep+env['PATH']
    elif name.startswith('node-'):
        extract(inputs/name,stage);node=next(stage.glob('*/bin/node'))
        env['PATH']=str(node.parent)+os.pathsep+env['PATH']
    else:
        extract(inputs/name,stage)
        installer=next(stage.glob('*/install.sh'))
        run(['bash',str(installer),'--prefix='+str(tools/'rust'),'--disable-ldconfig'])
env['PATH']=str(tools/'rust/bin')+os.pathsep+env['PATH']
env['RUSTC']=str(tools/'rust/bin/rustc')
run(['bun','--version'],output=receipts/'bun-version.txt')
run(['cargo','--version','--verbose'],output=receipts/'cargo-version.txt')
run(['rustc','--version','--verbose'],output=receipts/'rust-version.txt')
source=work/'source'
run(['git','init',str(source)])
run(['git','fetch','--depth=1','https://github.com/oven-sh/bun.git',plan['source']],source)
run(['git','checkout','--detach','FETCH_HEAD'],source)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip()
if head!=plan['source']:raise ValueError('Wrong source HEAD')
def check_locks():
    for name,digest in plan['locks'].items():
        if hashlib.sha256((source/name).read_bytes()).hexdigest()!=digest:raise ValueError('Lock changed: '+name)
check_locks()
for a in plan['nativePathDependencies']:
    stage=work/('native-'+a['name']);extract(inputs/a['cacheKey'],stage)
    roots=list(stage.iterdir())
    if len(roots)!=1 or not roots[0].is_dir():raise ValueError('Unexpected source archive layout')
    dest=source/'vendor'/a['name'];dest.parent.mkdir(exist_ok=True);shutil.move(str(roots[0]),dest)
patch=source/'patches/rust-argon2/legacy-low-memory.patch'
if hashlib.sha256(patch.read_bytes()).hexdigest()!=plan['argonPatchSha256']:raise ValueError('Wrong patch')
run(['git','apply','--check','--directory=vendor/rust-argon2',str(patch)],source)
run(['git','apply','--directory=vendor/rust-argon2',str(patch)],source)
for subdir in ['.','packages/bun-error','src/node-fallbacks']:
    run(['bun','install','--frozen-lockfile'],source/subdir)
check_locks()
# No target filter acquires the bounded all-platform root lock closure (181 registry entries).
run(['cargo','fetch','--locked'],source)
run(['cargo','vendor','--locked','--offline',str(work/'cargo-vendor')],source,receipts/'cargo-vendor-config.toml')
for target in ['x86_64-unknown-linux-gnu','x86_64-pc-windows-msvc','aarch64-pc-windows-msvc']:
    run(['cargo','metadata','--frozen','--format-version=1','--filter-platform',target],source,receipts/(target+'-metadata.json'))
check_locks()
shutil.copyfile(HERE/'inputs.json',receipts/'inputs.json')
# Bundle trees/cache together to preserve executable bits and symlinks through artifact upload.
members=['cargo-home','cargo-vendor','bun_install_cache_dir','source/node_modules',
         'source/packages/bun-error/node_modules','source/src/node-fallbacks/node_modules',
         'source/vendor/lolhtml','source/vendor/rust-argon2']
run(['tar','-czf',str(work/'dependency-caches.tar.gz'),*members])
archive=work/'dependency-caches.tar.gz';h=hashlib.sha256()
with archive.open('rb') as f:
    for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
(receipts/'result.json').write_text(json.dumps({'source':head,'archiveSha256':h.hexdigest(),'bytes':archive.stat().st_size,'frozenLocksUnchanged':True,'cargoOfflineMetadataTargets':3,'runtimeBuildQualified':False},indent=2)+'\n')
