#!/usr/bin/env bash
set -euo pipefail
bash /probe/install-offline.sh
cmp /var/lib/dpkg/status /supplement/results/installed-status
cd /supplement/supplement
sha256sum -c SHA256SUMS
apt-get -o Dir::Etc::sourcelist=/dev/null -o Dir::Etc::sourceparts=/tmp/orca-empty-sources -o Dir::State::lists=/tmp/orca-empty-lists --no-install-recommends -y install /supplement/supplement/*.deb
while IFS=$'\t' read -r name expected; do test "$(dpkg-query -W -f='${Version}' "$name")" = "$expected"; done < expected.tsv
while IFS=$'\t' read -r name expected; do test "$(dpkg-query -W -f='${Version}' "$name")" = "$expected"; done < /supplement/results/installed-before.tsv
ln -s clang /usr/lib/llvm-21/bin/clang-cl
cd /rust
sha256sum -c SHA256SUMS
mkdir /tmp/pinned-rust
while IFS= read -r component; do
  tar -xf "/rust/$component.tar" -C /tmp/pinned-rust
  bash "/tmp/pinned-rust/$component/install.sh" --prefix=/opt/orca-rust --disable-ldconfig
done < /rust/components.txt
bash /probe/install-bootstrap.sh
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/work/source
dpkg-query -W > /results/installed-packages.txt
cp /rust/decoded-components.json /results/rust-inputs.json
bash /probe/build-patched-bun.sh
