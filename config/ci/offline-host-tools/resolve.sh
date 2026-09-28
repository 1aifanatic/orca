#!/usr/bin/env bash
set -euo pipefail
bash /probe/install-offline.sh
cp /var/lib/dpkg/status /results/installed-status
dpkg-query -W -f='${binary:Package}\t${Version}\n' > /results/installed-before.tsv
cp /inputs/indexes/base-sources.list /etc/apt/sources.list
cp -a /inputs/indexes/sources/. /etc/apt/sources.list.d/
mkdir -p /etc/apt/keyrings
cp -a /inputs/indexes/repository-keyrings/. /etc/apt/keyrings/
cp -a /inputs/indexes/trusted-keyrings/. /etc/apt/trusted.gpg.d/
cp -a /inputs/indexes/authenticated-lists/. /var/lib/apt/lists/
cp /inputs/preferences /etc/apt/preferences.d/orca-historical
read -r -a roots < /inputs/roots
apt-get --no-install-recommends --simulate install "${roots[@]}" > /results/simulation.txt
! grep -q '^Remv ' /results/simulation.txt
apt-get --no-install-recommends --print-uris --download-only -y install "${roots[@]}" > /results/uris.txt
mkdir /results/indexes
for item in /var/lib/apt/lists/*Packages*; do /usr/lib/apt/apt-helper cat-file "$item" > "/results/indexes/$(basename "$item").txt"; done
