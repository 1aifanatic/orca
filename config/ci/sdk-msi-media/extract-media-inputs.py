"""Extract only pinned MSI databases; never execute installers."""
from pathlib import Path,PurePosixPath
import hashlib,json,sys,zipfile,stat
ARCHIVE_SHA='1e772b3917f75a5102d637462236d2b0b628142de3cc52c4e748c9f3228934f8'
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  while b:=f.read(1024*1024):h.update(b)
 return h.hexdigest()
def extract(archive,destination,plan):
 if digest(archive)!=ARCHIVE_SHA:raise ValueError('Archive identity mismatch')
 rows=plan['primaryInputs']
 if len(rows)!=9 or sum(r['retainedBytes'] for r in rows)>64*1024**2:raise ValueError('MSI input budget exceeded')
 if destination.exists():raise ValueError('Fresh destination required')
 with zipfile.ZipFile(archive) as z:
  for r in rows:
   name=r['layoutPath'];p=PurePosixPath(name)
   if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:raise ValueError('Unsafe member')
   matches=[i for i in z.infolist() if i.filename==name]
   if len(matches)!=1 or stat.S_ISLNK(matches[0].external_attr>>16) or matches[0].file_size!=r['retainedBytes']:raise ValueError('Member size/identity mismatch')
  destination.mkdir()
  for r in rows:
   output=destination/Path(r['cachePath']).name;h=hashlib.sha256();count=0
   with z.open(r['layoutPath']) as src,output.open('xb') as out:
    while b:=src.read(1024*1024):
     count+=len(b)
     if count>r['retainedBytes']:raise ValueError('Extraction exceeded size')
     h.update(b);out.write(b)
   if count!=r['retainedBytes'] or h.hexdigest()!=r['sha256']:raise ValueError('MSI digest mismatch')
if __name__=='__main__':
 archive,destination=map(Path,sys.argv[1:]);plan_path=Path(__file__).with_name('media-input-plan.json')
 if digest(plan_path)!='8884d76e085f1513fcdba4d2bb04960cd9e379af079cfc63608db70ffcdb0b1b':raise ValueError('Media plan identity mismatch')
 extract(archive,destination,json.loads(plan_path.read_text()))
