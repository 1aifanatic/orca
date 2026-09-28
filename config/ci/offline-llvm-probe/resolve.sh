#!/usr/bin/env bash
set -euo pipefail
source=/probe
receipt=/receipts
mkdir -p "$receipt/metadata"
cp /var/lib/dpkg/status "$receipt/base-status"
cp /etc/apt/sources.list "$receipt/base-sources.list"
dpkg-query -W > "$receipt/base-packages.txt"
apt-get update 2>&1 | tee "$receipt/tooling-apt-update.log"
! grep -Eq '^(Err:|W: Failed to fetch|E:)' "$receipt/tooling-apt-update.log"
apt-get install -y --no-install-recommends python3 gnupg ca-certificates
apt-get clean
dpkg-query -W > "$receipt/metadata-tooling-packages.txt"
python3 "$source/fetch-metadata.py" "$receipt/metadata"
cp "$source/select.py" "$source/verify-metadata.sh" "$receipt/metadata/"
bash "$receipt/metadata/verify-metadata.sh"
fingerprint=$(gpg --batch --with-colons --show-keys "$receipt/metadata/toolchain-ppa.asc" | awk -F: '$1=="pub" {p=1;next} p && $1=="fpr" {print $10;exit}')
test "$fingerprint" = C8EC952E2A0E1FBDC5090F6A2C277A0A352154E5
mkdir -p /etc/apt/keyrings
cp "$receipt/metadata/llvm-snapshot.gpg.key" /etc/apt/keyrings/orca-llvm.asc
cp "$receipt/metadata/toolchain-ppa.asc" /etc/apt/keyrings/orca-toolchain.asc
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/orca-llvm.asc] https://apt.llvm.org/focal/ llvm-toolchain-focal-21 main' > /etc/apt/sources.list.d/orca-llvm.list
printf '%s\n' 'deb [arch=amd64 signed-by=/etc/apt/keyrings/orca-toolchain.asc] http://ppa.launchpad.net/ubuntu-toolchain-r/test/ubuntu focal main' > /etc/apt/sources.list.d/orca-toolchain.list
apt-get update 2>&1 | tee "$receipt/apt-update.log"
! grep -Eq '^(Err:|W: Failed to fetch|E:)' "$receipt/apt-update.log"
cp -a /var/lib/apt/lists "$receipt/authenticated-lists"
cp -a /etc/apt/trusted.gpg.d "$receipt/trusted-keyrings"
cp -a /etc/apt/keyrings "$receipt/repository-keyrings"
if test -f /etc/apt/trusted.gpg; then cp /etc/apt/trusted.gpg "$receipt/ubuntu-trusted.gpg"; fi
cp -a /etc/apt/sources.list.d "$receipt/sources"
python3 "$source/resolve.py" "$receipt"
test -z "$(find /var/cache/apt/archives -maxdepth 1 -name '*.deb' -print -quit)"

python3 - "$receipt" "$source" <<'PYMANIFEST'
from pathlib import Path
import hashlib,json,sys
receipt,source=map(Path,sys.argv[1:])
records=[]
for label,root in [('receipt',receipt),('source',source)]:
 for path in sorted(root.rglob('*')):
  if not path.is_file() or path.name in ('resolution.log','provenance.json'):continue
  raw=path.read_bytes()
  records.append({'path':label+'/'+str(path.relative_to(root)),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
(receipt/'provenance.json').write_text(json.dumps(records,indent=2))
PYMANIFEST
