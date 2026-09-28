#!/usr/bin/env bash
set -euo pipefail
bash /probe/install-offline.sh
cd /rust
sha256sum -c SHA256SUMS
cp decoded-components.json /results/rust-decoded-components.json
mkdir /tmp/pinned-rust
while IFS= read -r component; do
  tar -xf "/rust/$component.tar" -C /tmp/pinned-rust
  bash "/tmp/pinned-rust/$component/install.sh" --prefix=/opt/orca-rust --disable-ldconfig
done < /rust/components.txt
/opt/orca-rust/bin/rustc --version --verbose > /results/rust-version.txt
bash /probe/verify-windows-sdk-link.sh /winsysroot /results/sdk-link
