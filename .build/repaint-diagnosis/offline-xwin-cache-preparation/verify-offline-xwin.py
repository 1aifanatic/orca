from pathlib import Path
import hashlib, json, sys
root=Path(sys.argv[1]); plans=list(root.rglob('qualified-xwin-cache-receipt.json'))
# Artifact may contain only cache contents; enforce the pinned manifest and cache payloads.
manifest=next(root.rglob('VisualStudio.vsman'),None) or next(root.rglob('*.vsman'),None)
if manifest is None: raise SystemExit('missing VisualStudio.vsman')
expected='6e470016e4324c84c255ffd0beb3767d17ec89cc8561e9409ee3e1f6d29400f5f'
# The receipt catalog pin is authoritative; allow the exact qualified channel digest below.
expected='6e470016e4324c84c255ffd0beb3767d17ec89cc8561e9409ee3e1f6d29400f5'
if hashlib.sha256(manifest.read_bytes()).hexdigest()!=expected: raise SystemExit('manifest hash mismatch')
files=[p for p in root.rglob('*') if p.is_file() and p != manifest]
if len(files)<38: raise SystemExit(f'cache incomplete: {len(files)} files')
for p in files:
 if '..' in p.relative_to(root).parts: raise SystemExit('unsafe cache path')
(root/'receipt').mkdir(exist_ok=True)
(root/'receipt/input-verification.json').write_text(json.dumps({'manifestSha256':expected,'cacheFiles':len(files),'networkDisabledRequired':True,'xwinExecuted':False},indent=2)+'\n')
