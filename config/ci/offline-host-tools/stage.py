from pathlib import Path
import hashlib,json,shlex,sys,urllib.request,zipfile
ROOTS=['ninja-build','perl','nasm','git','unzip']
def extract(archive,out,digest,prefixes):
 if hashlib.sha256(archive.read_bytes()).hexdigest()!=digest: raise ValueError('artifact digest mismatch')
 out.mkdir(exist_ok=False)
 with zipfile.ZipFile(archive) as z:
  if sum(i.file_size for i in z.infolist())>512*1024**2: raise ValueError('archive too large')
  for i in z.infolist():
   if not i.filename.startswith(prefixes): continue
   p=out/i.filename
   if '..' in Path(i.filename).parts or Path(i.filename).is_absolute(): raise ValueError('unsafe archive path')
   if i.is_dir(): p.mkdir(parents=True,exist_ok=True)
   else: p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(z.read(i))
def prepare(root):
 extract(root/'llvm.zip',root/'llvm','06b70d04c2b445f55eca428a7cccb16b5877c78ff28886d52b61f30efde7e4e4',('metadata/','packages/'))
 extract(root/'indexes.zip',root/'indexes','64d2a1a7465282dc052a3443416cb66079a8735c5a89717fb090e75b98b038e8',('authenticated-lists/','base-sources.list','sources/','repository-keyrings/','trusted-keyrings/'))
 pins=json.loads((Path(__file__).parent/'historical-ubuntu-pins.json').read_text())
 (root/'preferences').write_text('\n'.join(f'Package: {n}\nPin: version {v}\nPin-Priority: 1001\n\nPackage: {n}\nPin: version *\nPin-Priority: -1\n' for n,v in pins.items()))
 (root/'roots').write_text(' '.join(n+'='+pins[n] for n in ROOTS)+'\n')
def download(root):
 r=root/'results'; out=root/'supplement';out.mkdir(exist_ok=False)
 pins=json.loads((Path(__file__).parent/'historical-ubuntu-pins.json').read_text())
 installed=dict(line.split('\t',1) for line in (r/'installed-before.tsv').read_text().splitlines())
 rows=[]
 for line in (r/'uris.txt').read_text().splitlines():
  if not line.startswith("'"):continue
  url,name,size,apt_hash=shlex.split(line)
  if Path(name).name!=name or not url.startswith(('http://','https://')):raise ValueError('unsafe URI')
  rows.append(dict(url=url,filename=name,bytes=int(size),aptHash=apt_hash))
 if not rows or len(rows)>48 or sum(x['bytes'] for x in rows)>64*1024**2:raise ValueError('closure exceeds bound')
 metadata=[]
 for p in (r/'indexes').glob('*'):
  for block in p.read_text().split('\n\n'):
   m=dict(line.split(': ',1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))
   if m.get('SHA256') and m.get('Filename'):metadata.append(m)
 from urllib.parse import urlparse,unquote
 for row in rows:
  candidates=[m for m in metadata if Path(m['Filename']).name==unquote(Path(urlparse(row['url']).path).name) and int(m['Size'])==row['bytes']]
  if len({m['SHA256'] for m in candidates})!=1:raise ValueError('unauthenticated package')
  m=candidates[0];name=m['Package'];version=m['Version']
  if name in installed or name+':amd64' in installed:raise ValueError('replaces installed package '+name)
  if pins.get(name,pins.get(name+':amd64'))!=version:raise ValueError('historical pin mismatch '+name)
  algo,checksum=row['aptHash'].split(':',1)
  if m.get({'MD5Sum':'MD5sum'}.get(algo,algo))!=checksum:raise ValueError('apt hash mismatch')
  row.update(package=name,version=version,sha256=m['SHA256'])
  with urllib.request.urlopen(row['url'].replace('http://','https://'),timeout=60) as response: data=response.read(row['bytes']+1)
  if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('download integrity')
  (out/row['filename']).write_bytes(data)
 (out/'closure.json').write_text(json.dumps({'packages':rows,'packageCount':len(rows),'downloadBytes':sum(x['bytes'] for x in rows)},indent=2)+'\n')
 (out/'SHA256SUMS').write_text(''.join(x['sha256']+'  '+x['filename']+'\n' for x in rows))
 (out/'expected.tsv').write_text(''.join(x['package']+'\t'+x['version']+'\n' for x in rows))
if __name__=='__main__':globals()[sys.argv[1]](Path(sys.argv[2]))
