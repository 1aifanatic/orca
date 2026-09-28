#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
cmp /var/lib/dpkg/status /metadata/base-status
cd /packages
sha256sum -c SHA256SUMS
# Focal apt must run its local acquisition step to resolve archive paths.
mkdir -p /tmp/orca-empty-sources /tmp/orca-empty-lists/partial
apt-get -o Dir::Etc::sourcelist=/dev/null \
  -o Dir::Etc::sourceparts=/tmp/orca-empty-sources \
  -o Dir::State::lists=/tmp/orca-empty-lists \
  -o Dir::Cache::pkgcache= -o Dir::Cache::srcpkgcache= \
  --no-install-recommends -y install /packages/*.deb
while IFS=$'\t' read -r package expected; do
  actual=$(dpkg-query -W -f='${Version}' "$package")
  test "$actual" = "$expected"
done < /packages/expected-packages.tsv
bash /probe/verify-compiler.sh /results/compiler
printf 'network-disabled container completed exact archive installation and compiler checks\n' > /results/SUCCESS
