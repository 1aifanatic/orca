from pathlib import Path
import hashlib, json, shutil, sys, zipfile
base=Path(__file__).parent
archive,destination=map(Path,sys.argv[1:]);pin=json.loads((base/'inputs.json').read_text())['artifacts']['hostTools']
if pin is None or archive.stat().st_size!=pin['bytes']:raise ValueError('Host supplement size mismatch')
h=hashlib.sha256()
with archive.open('rb') as stream:
 for block in iter(lambda:stream.read(1024**2),b''):h.update(block)
if h.hexdigest()!=pin['sha256']:raise ValueError('Host supplement hash mismatch')
destination.mkdir()
with zipfile.ZipFile(archive) as bundle:
 selected=[m for m in bundle.infolist() if m.filename.startswith('inputs/supplement/') or m.filename in ['inputs/results/installed-status','inputs/results/installed-before.tsv']]
 if sum(m.file_size for m in selected)>64*1024**2:raise ValueError('Supplement extraction bound exceeded')
 for member in selected:
  path=Path(member.filename)
  if path.is_absolute() or '..' in path.parts or (member.external_attr>>16)&0o170000==0o120000:raise ValueError('Unsafe supplement member')
  target=destination/path
  if member.is_dir():target.mkdir(parents=True,exist_ok=True);continue
  target.parent.mkdir(parents=True,exist_ok=True)
  with bundle.open(member) as source,target.open('xb') as out:shutil.copyfileobj(source,out)
