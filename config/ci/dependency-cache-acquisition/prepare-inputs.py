"""Copy already retained inputs; no network or execution. Refuses overwrite."""
from pathlib import Path
import hashlib,json,shutil,sys
here=Path(__file__).resolve().parent
plan=json.loads((here/'inputs.json').read_text())
# Arguments: prior offline-rust context downloads, rust-src retention, native retention, destination.
bootstrap,source,native,dest=map(Path,sys.argv[1:])
selected=[]
for asset in plan['tools']:
    root=source if asset.get('package')=='rust-src' else bootstrap
    selected.append((root/asset['filename'],asset['filename'],asset['sha256'],asset['size']))
for asset in plan['nativePathDependencies']:
    selected.append((native/'by-url'/asset['cacheKey'],asset['cacheKey'],asset['sha256'],asset['bytes']))
for path,name,digest,size in selected:
    if path.stat().st_size!=size or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        raise ValueError('Retained input mismatch: '+name)
dest.mkdir()
for path,name,digest,size in selected: shutil.copyfile(path,dest/name)
shutil.copyfile(here/'inputs.json',dest/'inputs.json')
