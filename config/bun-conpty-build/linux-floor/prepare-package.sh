#!/usr/bin/env bash
set -euo pipefail
arch="$1"
bun_arch="$2"
bun_zip_sha="$3"
bun_bin_sha="$4"
mkdir -p downloads private-package receipts
curl --fail --location --retry 3 -o downloads/electron.zip "https://github.com/electron/electron/releases/download/v43.7.0/electron-v43.7.0-linux-${arch}.zip"
curl --fail --location --retry 3 -o downloads/SHASUMS256.txt "https://github.com/electron/electron/releases/download/v43.7.0/SHASUMS256.txt"
electron_sha=$(awk -v asset="electron-v43.7.0-linux-${arch}.zip" '$2==asset || $2=="*"asset {print $1}' downloads/SHASUMS256.txt)
test -n "$electron_sha"
printf '%s  downloads/electron.zip\n' "$electron_sha" | sha256sum --check
unzip -q downloads/electron.zip -d private-package
mv private-package/electron private-package/orca-ide
curl --fail --location --retry 3 -o downloads/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-${bun_arch}.zip"
printf '%s  downloads/bun.zip\n' "$bun_zip_sha" | sha256sum --check
unzip -q downloads/bun.zip -d downloads
mkdir -p private-package/resources/cli-runtime
cp "downloads/bun-linux-${bun_arch}/bun" private-package/resources/cli-runtime/bun-runtime
printf '%s  private-package/resources/cli-runtime/bun-runtime\n' "$bun_bin_sha" | sha256sum --check
cp -R payload/resources/terminal-daemon private-package/resources/
private-package/resources/cli-runtime/bun-runtime --no-env-file --print 'JSON.stringify({bun:process.versions.bun,arch:process.arch,platform:process.platform})' > receipts/bun-runtime.json
printf '%s\n' 'Private package-layout fixture, not electron-builder or release artifact.' > receipts/SCOPE.txt
sha256sum private-package/orca-ide private-package/resources/cli-runtime/bun-runtime private-package/resources/terminal-daemon/*.js > receipts/artifact-sha256.txt
cp source-hashes.json receipts/
printf '%s\n' "$electron_sha" > receipts/electron-archive-sha256.txt
docker pull ubuntu:20.04
docker image inspect ubuntu:20.04 --format '{{json .RepoDigests}}' > receipts/ubuntu-image.json
docker run --rm ubuntu:20.04 /bin/bash -ec 'cat /etc/os-release; getconf GNU_LIBC_VERSION; uname -m' > receipts/floor-platform.txt
