import gzip,hashlib,json,re
from pathlib import Path
VERSION='1:21.1.5~++20251023083255+45afac62e373-1~exp1~20251023083404.50'
ROOTS=['clang-21','lld-21','llvm-21']
def select(root):
 root=Path(root);raw=(root/'Packages.gz').read_bytes();release=(root/'InRelease').read_text()
 section=release.split('SHA256:\n',1)[1].split('\nSHA',1)[0]
 match=re.search(r'^ ([a-f0-9]{64})\s+(\d+)\s+main/binary-amd64/Packages.gz$',section,re.M)
 if not match or hashlib.sha256(raw).hexdigest()!=match[1] or len(raw)!=int(match[2]):raise ValueError('Index does not match retained Release checksum')
 records={}
 for paragraph in gzip.decompress(raw).decode().split('\n\n'):
  fields=dict(line.split(': ',1) for line in paragraph.splitlines() if ': ' in line and not line.startswith(' '))
  if fields.get('Architecture')=='amd64':records[fields['Package']]=fields
 pending=list(ROOTS);selected={};external={}
 while pending:
  name=pending.pop()
  if name in selected:continue
  package=records.get(name)
  if package is None or package['Version']!=VERSION:raise ValueError('Exact historical package unavailable: '+name)
  if not re.fullmatch(r'pool/[A-Za-z0-9_+./~:-]+\.deb',package['Filename']) or '..' in package['Filename'].split('/'):raise ValueError('Unsafe archive path')
  if not re.fullmatch('[a-f0-9]{64}',package['SHA256']):raise ValueError('Missing archive SHA256')
  selected[name]={k:package.get(k) for k in ['Package','Version','Filename','Size','SHA256','Depends']}
  for dep in package.get('Depends','').split(','):
   dep=dep.strip();child=dep.split(' ',1)[0]
   if child in records:pending.append(child)
   elif child:external.setdefault(child,[]).append(dep)
 return {'signatureVerified':False,'exactVersion':VERSION,'llvmPackages':list(selected.values()),'llvmDownloadBytes':sum(int(x['Size']) for x in selected.values()),'externalUbuntuRequirements':external,'closureComplete':False}
if __name__=='__main__':print(json.dumps(select(Path(__file__).resolve().parent),indent=2))
