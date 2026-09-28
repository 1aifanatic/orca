#!/usr/bin/env python3
import hashlib,json,os,pathlib,subprocess
root=pathlib.Path(os.environ['RUNNER_TEMP'])
inputs=[('A','02e7f7ba71594fcecbb12c38df07c73fa661cf08','1.4.214-local.1790614800000.02e7f7ba7159'),('B','04d9099d8ca9acecafa020b812a682caf7d1dcc5','1.4.214-local.1790614800001.04d9099d8ca9')]
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
