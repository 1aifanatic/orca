#!/usr/bin/env python3
import hashlib,json,os,pathlib,subprocess
root=pathlib.Path(os.environ['RUNNER_TEMP'])
inputs=[('A','7996f1f8ee49a88203d44a28478b576214ffb9cd','1.4.214-local.1790627959054.7996f1f8ee49'),('B','2956015b2c6722b7809aa981ad1e76e1e83ba756','1.4.214-local.1790627959055.2956015b2c67')]
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
for label,source,version in inputs:
 directory=root/('input-'+label);receipt=json.loads((directory/'build-receipt.json').read_text())
 assert receipt['source']==source and receipt['version']==version and receipt['arch']==os.environ['ARCH']
 assert receipt['overlaySha256']==os.environ['OVERLAY_SHA256'] and receipt['publish']=='never'
 for field in ['trackedDiagnosticDiffSha256','diagnosticSeamSha256','packageMetadataSha256','signedCompatibilitySha256']:
  assert len(receipt[field])==64 and all(c in '0123456789abcdef' for c in receipt[field])
 assert digest(directory/'expected-inputs.json')==receipt['expectedInputsSha256']
 expected=json.loads((directory/'expected-inputs.json').read_text())
 assert expected['package.json']==receipt['packageMetadataSha256']
 assert expected['src/main/local-builds/diagnostic-update-selection.ts']==receipt['diagnosticSeamSha256']
 assert receipt['diagnosticSeamSha256']==digest(pathlib.Path('.build/integration-audit/mac-installed-update-qualification/diagnostic-update-selection.ts'))
 assert pathlib.Path(receipt['archive']).name==receipt['archive']
 archive=directory/receipt['archive']
 assert digest(archive)==receipt['archiveSha256']
 assert digest(directory/'latest-mac.yml')==receipt['manifestSha256']
 target=root/('app-'+label);target.mkdir()
 subprocess.run(['/usr/bin/ditto','-x','-k',str(archive),str(target)],check=True,timeout=120)
 assert digest(target/'Orca.app/Contents/Resources/orca-local-build.json')==receipt['signedCompatibilitySha256']
