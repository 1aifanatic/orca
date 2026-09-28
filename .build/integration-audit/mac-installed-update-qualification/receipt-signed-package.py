#!/usr/bin/env python3
import argparse,base64,hashlib,json,pathlib,plistlib,shutil,subprocess,tempfile
p=argparse.ArgumentParser()
for name in ['dist','output','source','version','arch','overlay','expected-inputs']:p.add_argument('--'+name,required=True)
a=p.parse_args();dist=pathlib.Path(a.dist).resolve();out=pathlib.Path(a.output).resolve();out.mkdir()
def digest(path,algorithm='sha256'):
 h=hashlib.new(algorithm)
 with path.open('rb') as stream:
  for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
 return h.digest()
archives=list(dist.glob('*.zip'));assert len(archives)==1
archive=archives[0]
# YAML is parsed with the dependency installed for the production build.
parser="const fs=require('fs'),yaml=require('yaml');console.log(JSON.stringify(yaml.parse(fs.readFileSync(process.argv[1],'utf8'))))"
matches=[]
for file in dist.glob('*.yml'):
 manifest=json.loads(subprocess.check_output(['node','-e',parser,str(file)],text=True))
 if isinstance(manifest,dict) and manifest.get('version')==a.version and any(f.get('url')==archive.name for f in manifest.get('files',[])):matches.append((file,manifest))
assert len(matches)==1,'Expected one exact generated update manifest'
file,manifest=matches[0];entry=next(f for f in manifest['files'] if f['url']==archive.name)
assert entry['sha512']==base64.b64encode(digest(archive,'sha512')).decode()
assert entry.get('size',archive.stat().st_size)==archive.stat().st_size
with tempfile.TemporaryDirectory(prefix='signed-verify-') as directory:
 subprocess.run(['/usr/bin/ditto','-x','-k',str(archive),directory],check=True,timeout=120)
 app=pathlib.Path(directory)/'Orca.app'
 for command in [['/usr/bin/codesign','--verify','--deep','--strict',str(app)],['/usr/bin/xcrun','stapler','validate',str(app)],['/usr/sbin/spctl','--assess','--type','execute',str(app)]]:subprocess.run(command,check=True,timeout=60)
 metadata=json.loads((app/'Contents/Resources/orca-local-build.json').read_text())
 assert metadata['commit']==a.source and metadata['version']==a.version and metadata['architecture']==a.arch
 with (app/'Contents/Info.plist').open('rb') as stream:assert plistlib.load(stream)['CFBundleShortVersionString']==a.version
 metadata_sha=digest(app/'Contents/Resources/orca-local-build.json').hex()
shutil.copyfile(archive,out/archive.name);shutil.copyfile(file,out/'latest-mac.yml')
expected=json.loads(pathlib.Path(a.expected_inputs).read_text())
for name,sha in expected.items():assert digest(pathlib.Path(name)).hex()==sha,'Build inputs changed during packaging'
shutil.copyfile(a.expected_inputs,out/'expected-inputs.json')
# Preserve the exact signed source changes as hashes, not merely their claimed version.
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==a.source
tracked_diff=subprocess.check_output(['git','diff','--binary','HEAD','--','src/main/index.ts','src/main/local-builds/local-build-switch.ts','package.json'])
seam=pathlib.Path('src/main/local-builds/diagnostic-update-selection.ts')
package=pathlib.Path('package.json')
receipt={'source':a.source,'version':a.version,'arch':a.arch,'overlaySha256':a.overlay,'trackedDiagnosticDiffSha256':hashlib.sha256(tracked_diff).hexdigest(),'diagnosticSeamSha256':digest(seam).hex(),'packageMetadataSha256':digest(package).hex(),'signedCompatibilitySha256':metadata_sha,'archive':archive.name,'archiveSha256':digest(archive).hex(),'manifestSha256':digest(out/'latest-mac.yml').hex(),'expectedInputsSha256':digest(out/'expected-inputs.json').hex(),'publish':'never'}
(out/'build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
