from pathlib import Path
import urllib.request,json,hashlib,sys
source=Path(__file__).resolve().parent;target=Path(sys.argv[1]);target.mkdir(parents=True,exist_ok=True)
for name,item in json.loads((source/'metadata-pins.json').read_text()).items():
 if name=='apt-guidance.html':continue
 with urllib.request.urlopen(item['url'],timeout=30) as response:data=response.read(item['bytes']+1)
 if len(data)!=item['bytes'] or hashlib.sha256(data).hexdigest()!=item['sha256']:raise ValueError('Metadata pin mismatch: '+name)
 (target/name).write_bytes(data)
