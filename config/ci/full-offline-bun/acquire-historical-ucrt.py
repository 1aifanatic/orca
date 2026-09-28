"""Retain authenticated-catalog UCRT bytes; no installer execution."""
from pathlib import Path
from urllib.parse import urlparse
import hashlib,json,sys,urllib.request,time
ROOT=Path(__file__).resolve().parent
CATALOG=ROOT.parent/'offline-sdk-metadata-probe/packages.vsman'
PIN='f0a50ea157222c29abd5ea6ff01bfc3c33b04e011c5e45ee2ca38ef0778e5643'
HOST='download.visualstudio.microsoft.com'
BUDGET=160*1024**2

def validate_url(url):
 p=urlparse(url)
 if p.scheme!='https' or p.hostname!=HOST or p.port not in (None,443) or p.username or p.password or p.fragment:
  raise ValueError('Unapproved Microsoft download URL')
 return url
class Redirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  validate_url(newurl)
  return super().redirect_request(req,fp,code,msg,headers,newurl)
def select(raw):
 if hashlib.sha256(raw).hexdigest()!=PIN:raise ValueError('Catalog identity mismatch')
 packages=[p for p in json.loads(raw)['packages'] if p['id']=='Microsoft.Windows.UniversalCRT.HeadersLibsSources.Msi']
 if len(packages)!=1:raise ValueError('Ambiguous UCRT package')
 rows=packages[0]['payloads']
 if len(rows)!=12 or sum(p['size'] for p in rows)>BUDGET:raise ValueError('UCRT budget mismatch')
 for p in rows:
  validate_url(p['url'])
  if Path(p['fileName']).name!=p['fileName'] or any(c in p['fileName'] for c in '\\/:') or p['fileName'] in ('.','..'):raise ValueError('Unsafe filename')
 return rows

def retain(response,out,expected,deadline):
 length=response.headers.get('Content-Length')
 if length is not None and int(length)!=expected['size']:raise ValueError('Declared length mismatch')
 digest=hashlib.sha256();count=0
 with out.open('xb') as f:
  while True:
   if time.monotonic()>deadline:raise TimeoutError('Acquisition deadline exceeded')
   chunk=response.read(min(1024*1024,expected['size']-count+1))
   if not chunk:break
   count+=len(chunk)
   if count>expected['size']:raise ValueError('Payload exceeds declared size')
   digest.update(chunk);f.write(chunk)
 if count!=expected['size'] or digest.hexdigest()!=expected['sha256'].lower():raise ValueError('Payload byte identity mismatch')
 return {'bytes':count,'sha256':digest.hexdigest()}

def main(destination):
 rows=select(CATALOG.read_bytes())
 destination.mkdir(exist_ok=False)
 receipt={'catalogSha256':PIN,'qualificationRun':36482063593,'scope':'historical UCRT exact bytes; no installation; catalog trust qualified offline after connected preparation','status':'running','files':[]}
 def record():(destination/'acquisition.json').write_text(json.dumps(receipt,indent=2)+'\n')
 record();opener=urllib.request.build_opener(Redirect());deadline=time.monotonic()+600
 try:
  for p in rows:
   validate_url(p['url'])
   with opener.open(p['url'],timeout=30) as response:
    final=validate_url(response.geturl())
    identity=retain(response,destination/p['fileName'],p,min(deadline,time.monotonic()+120))
   receipt['files'].append({'name':p['fileName'],'url':p['url'],'finalUrl':final,**identity});record()
  receipt['status']='passed';record()
 except Exception as error:
  receipt.update(status='failed',error=type(error).__name__+': '+str(error));record();raise
if __name__=='__main__':main(Path(sys.argv[1]))
