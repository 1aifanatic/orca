#!/usr/bin/env bash
set -euo pipefail
root=${1:?}
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# Require a fresh network namespace with no external interfaces or routes.
python3 - <<'PY'
from pathlib import Path
import socket
if {name for _, name in socket.if_nameindex()} != {'lo'}:
    raise SystemExit('network namespace still has external interfaces')
if len(Path('/proc/net/route').read_text().splitlines()) != 1:
    raise SystemExit('network namespace still has IPv4 routes')
PY
python3 "$script_dir/verify-offline-xwin.py" "$root"
test ! -e "$root/output"
mkdir "$root/output"
chmod u+x "$root/tool/xwin"
"$root/tool/xwin" --accept-license --arch x86_64,aarch64 --sdk-version 10.0.26100 --crt-version 14.44.17.14 --include-atl --cache-dir "$root/cache" --manifest "$root/manifest/channel.json" --http-retry 0 splat --use-winsysroot-style --preserve-ms-arch-notation --include-debug-libs --output "$root/output"
find "$root/output" -type f -print0 | sort -z | xargs -0 sha256sum > "$root/receipt/output.sha256"
printf '%s\n' '{"network":"isolated-namespace-interfaces-and-routes-checked","xwinExecuted":true,"offlineHttpRetry":0}' > "$root/receipt/execution.json"
