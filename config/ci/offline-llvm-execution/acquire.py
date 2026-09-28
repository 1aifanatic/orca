from pathlib import Path, PurePosixPath
import hashlib,json,re,stat,sys,time,urllib.request,zipfile
ARTIFACT_SHA='64d2a1a7465282dc052a3443416cb66079a8735c5a89717fb090e75b98b038e8'
COUNT=68
TOTAL=106204004

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def extract(archive,destination):
 if digest(archive)!=ARTIFACT_SHA:raise ValueError('Artifact hash mismatch')
 with zipfile.ZipFile(archive) as z:
  members=z.infolist();names=set()
  if len(members)>512 or sum(m.file_size for m in members)>256*1024*1024:raise ValueError('Archive budget exceeded')
  for m in members:
   p=PurePosixPath(m.filename);mode=m.external_attr>>16
   if p.is_absolute() or '..' in p.parts or '\\' in m.filename or m.filename in names or stat.S_ISLNK(mode):raise ValueError('Unsafe archive member')
   names.add(m.filename)
  if destination.exists():raise ValueError('Receipt destination must be fresh')
  destination.mkdir()
  for m in members:
   p=destination/m.filename
   if m.is_dir():p.mkdir(parents=True,exist_ok=True);continue
   p.parent.mkdir(parents=True,exist_ok=True)
   with z.open(m) as source,p.open('xb') as target:
    while block:=source.read(1024*1024):target.write(block)

def verify(receipt,source,indexes):
 provenance=json.loads((receipt/'provenance.json').read_text())
 if len(provenance)!=58:raise ValueError('Unexpected provenance count')
 for item in provenance:
  prefix,relative=item['path'].split('/',1)
  if prefix not in ('receipt','source') or '..' in PurePosixPath(relative).parts:raise ValueError('Unsafe provenance path')
  path=(receipt if prefix=='receipt' else source)/relative
  if path.stat().st_size!=item['bytes'] or digest(path)!=item['sha256']:raise ValueError('Provenance mismatch: '+item['path'])
 closure=json.loads((receipt/'closure.json').read_text());rows=closure['packages']
 if len(rows)!=COUNT or sum(r['bytes'] for r in rows)!=TOTAL:raise ValueError('Unexpected closure size')
 metadata={}
 for p in indexes.glob('*.txt'):
  for paragraph in p.read_text().split('\n\n'):
   fields=dict(line.split(': ',1) for line in paragraph.splitlines() if ': ' in line and not line.startswith(' '))
   if fields.get('Filename'):metadata.setdefault(fields['Filename'].split('/')[-1],[]).append(fields)
 from urllib.parse import urlparse,unquote
 names=set()
 for r in rows:
  if not re.fullmatch('[A-Za-z0-9_.+%:~=-]+',r['filename']) or r['filename'] in names:raise ValueError('Unsafe or duplicate filename')
  names.add(r['filename']);url=urlparse(r['url'])
  if url.scheme not in ('https','http') or url.hostname not in ('apt.llvm.org','archive.ubuntu.com','security.ubuntu.com','ppa.launchpad.net'):raise ValueError('Unexpected archive origin')
  if not re.fullmatch('[a-f0-9]{64}',r['sha256']):raise ValueError('Invalid package hash')
  matches=metadata.get(unquote(url.path).split('/')[-1],[])
  if not any(x.get('Package')==r['package'] and x.get('Version')==r['version'] and x.get('SHA256')==r['sha256'] and int(x.get('Size','-1'))==r['bytes'] for x in matches):raise ValueError('Closure mismatch with authenticated index: '+r['package'])
 return rows

def acquire(row,destination):
 target=destination/row['filename'];temporary=target.with_suffix('.partial')
 if target.exists():
  if target.stat().st_size==row['bytes'] and digest(target)==row['sha256']:return
  raise ValueError('Existing archive is corrupt')
 for attempt in range(3):
  try:
   count=0;hasher=hashlib.sha256()
   with urllib.request.urlopen(row['url'],timeout=30) as response,temporary.open('xb') as output:
    while block:=response.read(1024*1024):
     count+=len(block)
     if count>row['bytes']:raise ValueError('Archive exceeds pinned size')
     hasher.update(block);output.write(block)
   if count!=row['bytes'] or hasher.hexdigest()!=row['sha256']:raise ValueError('Archive checksum mismatch')
   temporary.rename(target);return
  except Exception:
   temporary.unlink(missing_ok=True)
   if attempt==2:raise
   time.sleep(2**attempt)

if __name__=='__main__':
 action=sys.argv[1]
 if action=='extract':extract(Path(sys.argv[2]),Path(sys.argv[3]))
 elif action=='acquire':
  receipt,source,indexes,destination=map(Path,sys.argv[2:]);rows=verify(receipt,source,indexes);destination.mkdir(exist_ok=False)
  for row in rows:acquire(row,destination)
  (destination/'SHA256SUMS').write_text(''.join(r['sha256']+'  '+r['filename']+'\n' for r in rows))
  (destination/'expected-packages.tsv').write_text(''.join(r['package']+'\t'+r['version']+'\n' for r in rows))
 else:raise ValueError('Unknown action')
