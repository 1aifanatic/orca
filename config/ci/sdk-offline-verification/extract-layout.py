from pathlib import Path,PurePosixPath
import hashlib,stat,sys,zipfile
archive,destination=map(Path,sys.argv[1:])
h=hashlib.sha256()
with archive.open('rb') as source:
 while block:=source.read(1024*1024):h.update(block)
if h.hexdigest()!='1e772b3917f75a5102d637462236d2b0b628142de3cc52c4e748c9f3228934f8':raise ValueError('Retained layout artifact hash mismatch')
with zipfile.ZipFile(archive) as z:
 files=z.infolist();seen=set()
 if len(files)>1000 or sum(f.file_size for f in files)>4*1024**3:raise ValueError('Retained layout over budget')
 for f in files:
  name=PurePosixPath(f.filename)
  if name.is_absolute() or '..' in name.parts or chr(92) in f.filename or ':' in f.filename or f.filename.casefold() in seen or stat.S_ISLNK(f.external_attr>>16):raise ValueError('Unsafe archive path')
  seen.add(f.filename.casefold())
 if destination.exists():raise ValueError('Fresh extraction required')
 destination.mkdir()
 for f in files:
  path=destination/f.filename
  if f.is_dir():path.mkdir(parents=True,exist_ok=True);continue
  path.parent.mkdir(parents=True,exist_ok=True)
  with z.open(f) as source,path.open('xb') as output:
   while block:=source.read(1024*1024):output.write(block)
