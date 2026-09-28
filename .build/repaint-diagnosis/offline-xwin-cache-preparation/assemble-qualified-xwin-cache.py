from pathlib import Path
import zipfile,json,hashlib,stat,shutil
base=Path('/Users/m4air/orca/workspaces/orca/np-orca-data-json/.build/bun-runtime-modernization/source/.build/consolidation-stack/.build/repaint-diagnosis/offline-xwin-cache-preparation')
archive=base/'../offline-sdk-metadata-probe/sdk-layout-retained-inputs-36476269793.zip'
out=base/'qualified-xwin-cache';
if out.exists(): shutil.rmtree(out)
out.mkdir(); (out/'dl').mkdir()
plan=json.loads((base/'media-input-plan.json').read_text()); sdk=json.loads((base/'sdk-media-qualified.json').read_text()); ucrt=json.loads((base/'ucrt-media-qualified.json').read_text()); ur=json.loads((base/'run36485283209/ucrt/ucrt-media.json').read_text(encoding='utf-8-sig'))
# use raw complete receipts: sdk aliases + UCRT aliases. Candidate identities are all listed in retained map.
aliases=sdk['receipt'] if False else None
s=json.loads((base/'run36485283209/sdk/msi-media.json').read_text(encoding='utf-8-sig')); ua=ur['cabinetAliases']
selected=[]
for x in s['cabinetAliases']+ua:
 selected.append((x['layoutPath'],x['cachePath'],x['sha256'],x['bytes']))
for x in s['databases']+ur['databases']:
 # source MSI member is plan matching by hash, UCRT path fixed
 rows=plan['primaryInputs']
 match=next((a for a in rows if a['sha256']==x['sha256']),None)
 if match: selected.append((match['layoutPath'],match['cachePath'],match['sha256'],match['retainedBytes']))
# UCRT MSI not in primary plan; locate in missing envelope
mu=next(a for a in json.loads((base/'retained-input-map.json').read_text())['missingEnvelope'] if a['sha256']==ur['databases'][0]['sha256'])
selected.append(('__LOCAL__/'+mu['fileName'],ur['databases'][0]['cachePath'],mu['sha256'],mu['size']))
selected={a[0]:a for a in selected}
uroot=base/'historical-ucrt-retained'
ucrtNames={x['name'] for x in json.loads((uroot/'acquisition.json').read_text())['files']}
print('members',len(selected))
with zipfile.ZipFile(archive) as z:
 names={i.filename:i for i in z.infolist()}
 uroot=base/'historical-ucrt-retained'
 for layout,(lp,cache,sha,size) in selected.items():
  if layout.startswith('__LOCAL__/') or Path(layout).name in ucrtNames:
   src=uroot/(Path(layout).name if not layout.startswith('__LOCAL__/') else layout.split('/',1)[1]); dest=out/cache;dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(src,dest); assert dest.stat().st_size==size and hashlib.sha256(dest.read_bytes()).hexdigest()==sha; continue
  info=names.get(layout)
  if not info or info.file_size!=size: raise ValueError((layout, info.file_size if info else None,size))
  dest=out/cache
  dest.parent.mkdir(parents=True,exist_ok=True)
  h=hashlib.sha256();n=0
  with z.open(info) as src,dest.open('xb') as f:
   while b:=src.read(1024*1024): n+=len(b); h.update(b); f.write(b)
  if n!=size or h.hexdigest()!=sha: raise ValueError(('hash',layout,n,size,h.hexdigest(),sha))
print('bytes',sum(p.stat().st_size for p in out.rglob('*') if p.is_file()))
(base/'qualified-xwin-cache-receipt.json').write_text(json.dumps({'archiveSha256':'1e772b3917f75a5102d637462236d2b0b628142de3cc52c4e748c9f3228934f8','members':len(selected),'files':sum(1 for p in out.rglob('*') if p.is_file()),'bytes':sum(p.stat().st_size for p in out.rglob('*') if p.is_file()),'sdkRun':36485283209,'ucrtRun':36485283209,'executed':False,'xwinExtractionQualified':False},indent=2)+'\n')
