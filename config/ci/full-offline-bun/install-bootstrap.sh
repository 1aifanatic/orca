#!/usr/bin/env bash
set -euo pipefail
cd /bootstrap
sha256sum -c SHA256SUMS
mkdir -p /opt/cmake /opt/node /opt/bun/bin /tmp/bun-bootstrap
bash cmake-x86_64-cmake-3.30.5-linux-x86_64.sh --skip-license --prefix=/opt/cmake
tar -xzf node-v24.3.0-linux-x64.tar.gz -C /opt/node --strip-components=1
unzip bun-bootstrap-x86_64-bun-linux-x64.zip -d /tmp/bun-bootstrap
cp /tmp/bun-bootstrap/bun-linux-x64/bun /opt/bun/bin/bun
chmod 755 /opt/bun/bin/bun
/opt/bun/bin/bun --version
/opt/node/bin/node --version
/opt/cmake/bin/cmake --version
