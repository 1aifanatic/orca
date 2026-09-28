from pathlib import Path
import subprocess,json,hashlib,shlex,re,sys,importlib.util
source=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('selection',source/'select.py');selection=importlib.util.module_from_spec(spec);spec.loader.exec_module(selection)
MAX_BYTES=256*1024*1024
MAX_PACKAGES=128

def parse_uris(text):
 rows=[]
 for line in text.splitlines():
  if not line.startswith("'"):continue
  fields=shlex.split(line)
  if len(fields)!=4 or not fields[2].isdigit():raise ValueError('Malformed URI row')
  uri,filename,size,digest=fields
  if not uri.startswith(('http://','https://')) or '/' in filename or not re.fullmatch('[A-Za-z0-9_.+%:~=-]+',filename):raise ValueError('Unsafe package URI/name')
  rows.append({'url':uri,'filename':filename,'bytes':int(size),'aptHash':digest})
 if not rows or len(rows)>MAX_PACKAGES or sum(x['bytes'] for x in rows)>MAX_BYTES:raise ValueError('Empty or over-budget closure')
 return rows

def validate_apt_hash(printed, metadata):
 algorithm,separator,digest=printed.partition(':')
 field={'MD5Sum':'MD5sum','MD5sum':'MD5sum','SHA1':'SHA1','SHA256':'SHA256','SHA512':'SHA512'}.get(algorithm)
 if not separator or field is None or not digest or metadata.get(field)!=digest:
  raise ValueError('Printed apt digest lacks matching authenticated metadata: '+algorithm)

def validate_llvm(rows, selected):
 actual={row['package']:row for row in rows}
 for expected in selected['llvmPackages']:
  row=actual.get(expected['Package'])
  if row is None or row['version']!=expected['Version'] or row['sha256']!=expected['SHA256'] or row['bytes']!=int(expected['Size']):
   raise ValueError('Resolved LLVM closure differs from pinned metadata: '+expected['Package'])

def run(receipt):
 receipt=Path(receipt);selected=selection.select(receipt/'metadata');pins=json.loads((source/'historical-ubuntu-pins.json').read_text())
 # A signed index changing after the pinned fetch is still rejected.
 llvm_release=list((receipt/'authenticated-lists').glob('*apt.llvm.org*InRelease'))
 if len(llvm_release)!=1 or llvm_release[0].read_bytes()!=(receipt/'metadata/InRelease').read_bytes():raise ValueError('LLVM Release changed during resolution')
 llvm_index=list((receipt/'authenticated-lists').glob('*apt.llvm.org*binary-amd64_Packages*'))
 if len(llvm_index)!=1:raise ValueError('Missing LLVM index')
 actual=subprocess.check_output(['/usr/lib/apt/apt-helper','cat-file',str(llvm_index[0])])
 import gzip
 if actual!=gzip.decompress((receipt/'metadata/Packages.gz').read_bytes()):raise ValueError('LLVM index changed during resolution')
 preference=[]
 for name,version in pins.items():
  preference.append(f'Package: {name}\nPin: version {version}\nPin-Priority: 1001\n\nPackage: {name}\nPin: version *\nPin-Priority: -1\n')
 Path('/etc/apt/preferences.d/orca-historical').write_text('\n'.join(preference))
 roots=[name+'='+selection.VERSION for name in selection.ROOTS]
 options=['-o','Dir::State::status='+str(receipt/'base-status'),'--no-install-recommends']
 simulated=subprocess.check_output(['apt-get',*options,'--simulate','install',*roots],text=True);(receipt/'simulation.txt').write_text(simulated)
 uris=subprocess.check_output(['apt-get',*options,'--print-uris','--download-only','--yes','install',*roots],text=True);(receipt/'uris.txt').write_text(uris)
 rows=parse_uris(uris)
 metadata={}
 for entry in (receipt/'authenticated-lists').glob('*Packages*'):
  text=subprocess.check_output(['/usr/lib/apt/apt-helper','cat-file',str(entry)]).decode()
  for paragraph in text.split('\n\n'):
   fields=dict(line.split(': ',1) for line in paragraph.splitlines() if ': ' in line and not line.startswith(' '))
   if fields.get('Filename') and fields.get('SHA256'):metadata.setdefault(fields['Filename'].split('/')[-1],[]).append(fields)
 for row in rows:
  # URI basename preserves Debian '+' while apt output filenames can encode epochs.
  from urllib.parse import unquote,urlparse
  candidates=metadata.get(unquote(urlparse(row['url']).path).split('/')[-1],[])
  candidates=[x for x in candidates if int(x['Size'])==row['bytes']]
  hashes={x['SHA256'] for x in candidates}
  if len(hashes)!=1:raise ValueError('Package lacks unambiguous authenticated SHA256: '+row['url'])
  info=candidates[0]
  validate_apt_hash(row['aptHash'],info)
  name=info['Package'];expected=pins.get(name+':amd64',pins.get(name))
  if expected and info['Version']!=expected:raise ValueError('Historical package version drift: '+name)
  row.update(package=name,version=info['Version'],sha256=info['SHA256'])
 validate_llvm(rows,selected)
 (receipt/'historical-preferences.txt').write_text('\n'.join(preference))
 (receipt/'closure.json').write_text(json.dumps({'packages':rows,'downloadBytes':sum(x['bytes'] for x in rows),'packageCount':len(rows),'downloaded':False,'compilerExecuted':False,'llvmSignatureVerified':True,'ubuntuMetadata':'authenticated by apt; per-run snapshots retained, not immutable historical metadata'},indent=2))
if __name__=='__main__':run(sys.argv[1])

