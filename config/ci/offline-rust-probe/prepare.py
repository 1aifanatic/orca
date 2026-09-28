from pathlib import Path
import importlib.util,json,hashlib,sys,urllib.request,shutil
root=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('retain',root/'retain-rust-components.py');retain=importlib.util.module_from_spec(spec);spec.loader.exec_module(retain)
context=Path(sys.argv[1]);context.mkdir(exist_ok=False);downloads=context/'downloads';downloads.mkdir()
with urllib.request.urlopen('https://static.rust-lang.org/dist/2026-07-20/channel-rust-nightly.toml',timeout=30) as response:manifest=response.read(2*1024*1024)
selected=retain.select(manifest)
assets=json.loads((root/'rust-assets.json').read_text())['components']
assert [{k:a[k] for k in ['package','target','url','filename','sha256']} for a in assets]==selected
rustup=json.loads((root/'rustup-asset.json').read_text());assets.append(rustup)
assert sum(a['size'] for a in assets)<192*1024*1024
for asset in assets:retain.retain_asset(asset,downloads,asset['size'])
(context/'channel-rust-nightly.toml').write_bytes(manifest)
(context/'bootstrap.sha256').write_text(''.join(a['sha256']+'  '+a['filename']+'\n' for a in assets))
for name in ['Dockerfile','install-verified-bootstrap.sh','verify.sh']:shutil.copyfile(root/name,context/name)
(context/'inputs.json').write_text(json.dumps({'manifestSha256':hashlib.sha256(manifest).hexdigest(),'archives':assets,'signatureVerified':False,'baseImage':'ubuntu@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214','scope':'offline Rust installation only'},indent=2))
