#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
cmp /var/lib/dpkg/status /metadata/base-status
cd /packages
sha256sum -c SHA256SUMS
# Local files only; no indexes, fetches or alternate package resolution.
apt-get --no-download --no-install-recommends -y install /packages/*.deb
while IFS=$'\t' read -r package expected; do
  actual=$(dpkg-query -W -f='${Version}' "$package")
  test "$actual" = "$expected"
done < /packages/expected-packages.tsv
bash /probe/verify-compiler.sh /results/compiler
printf 'network-disabled container completed exact archive installation and compiler checks\n' > /results/SUCCESS
