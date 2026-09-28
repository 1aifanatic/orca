#!/usr/bin/env python3
"""Generate an auditable patch; never edits the supplied production source checkout."""
import argparse,difflib,hashlib,json,pathlib,subprocess
parser=argparse.ArgumentParser()
parser.add_argument('--source',type=pathlib.Path,required=True)
parser.add_argument('--ref',default='HEAD')
parser.add_argument('--output',type=pathlib.Path,required=True)
args=parser.parse_args()
root=args.source.resolve(); output=args.output.resolve()
if output.exists(): raise RuntimeError('Use a fresh overlay output directory')
output.mkdir(parents=True)
commit=subprocess.check_output(['git','rev-parse','--verify',args.ref+'^{commit}'],cwd=root,text=True).strip()
def read_source(path):
 return subprocess.check_output(['git','show',commit+':'+path],cwd=root,text=True)
changes={}
path='src/main/local-builds/local-build-switch.ts';original=read_source(path);modified="import { diagnosticManifestSelection, confirmDiagnosticSelection } from './diagnostic-update-selection'\n"+original
old="  const selection = await (window\n    ? dialog.showOpenDialog(window, openDialogOptions)\n    : dialog.showOpenDialog(openDialogOptions))"
new="  const diagnosticManifest = diagnosticManifestSelection()\n  const selection = diagnosticManifest\n    ? { canceled: false, filePaths: [diagnosticManifest] }\n    : await (window ? dialog.showOpenDialog(window, openDialogOptions) : dialog.showOpenDialog(openDialogOptions))"
assert modified.count(old)==1;modified=modified.replace(old,new)
old="    const confirmation = await (window\n      ? dialog.showMessageBox(window, messageBoxOptions)\n      : dialog.showMessageBox(messageBoxOptions))"
new="    const confirmation = confirmDiagnosticSelection(candidate.version)\n      ? { response: 0 }\n      : await (window ? dialog.showMessageBox(window, messageBoxOptions) : dialog.showMessageBox(messageBoxOptions))"
assert modified.count(old)==1;modified=modified.replace(old,new);changes[path]=(original,modified)
path='src/main/index.ts';original=read_source(path);modified="import { startDiagnosticUpdateSelection } from './local-builds/diagnostic-update-selection'\n"+original+"\nstartDiagnosticUpdateSelection()\n";changes[path]=(original,modified)
path='src/main/local-builds/diagnostic-update-selection.ts';modified=(pathlib.Path(__file__).parent/'diagnostic-update-selection.ts').read_text();changes[path]=('',modified)
patch=''
for path,(before,after) in changes.items():
 patch+=''.join(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/'+path if before else '/dev/null',tofile='b/'+path))
(output/'diagnostic-overlay.patch').write_text(patch)
receipt={'productionSource':commit,'patchSha256':hashlib.sha256(patch.encode()).hexdigest(),'changedPaths':list(changes),'scope':'diagnostic selection/confirmation only; native compatibility/signature/feed/install/supervisor unchanged','applied':False}
(output/'overlay-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
