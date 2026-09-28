#!/usr/bin/env bash
set -euo pipefail
root=${1:?}
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# Require a fresh network namespace with no external interfaces or routes.
python3 - "$root" <<'PY'
from pathlib import Path
import errno
import json
import socket
import sys
interfaces = [name for _, name in socket.if_nameindex()]
routes = Path('/proc/self/net/route').read_text()
ipv6_routes = Path('/proc/self/net/ipv6_route').read_text()
receipt = {'interfaces': interfaces, 'ipv4Routes': routes, 'ipv6Routes': ipv6_routes,
           'namespace': str(Path('/proc/self/ns/net').readlink()), 'socketProbes': []}
if set(interfaces) != {'lo'}:
    raise SystemExit('network namespace still has external interfaces')
for family, address in ((socket.AF_INET, ('192.0.2.1', 443)),
                        (socket.AF_INET6, ('2001:db8::1', 443))):
    with socket.socket(family, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        result = probe.connect_ex(address)
    receipt['socketProbes'].append({'address': address[0], 'errno': result})
print(json.dumps(receipt, indent=2))
destination = Path(sys.argv[1]) / 'receipt'
destination.mkdir(exist_ok=True)
(destination / 'network-isolation.json').write_text(json.dumps(receipt, indent=2) + '\n')
for probe in receipt['socketProbes']:
    if probe['errno'] not in (errno.ENETUNREACH, errno.EHOSTUNREACH, errno.EADDRNOTAVAIL):
        raise SystemExit(f'network isolation probe unexpected result: {probe}')
route_rows = [line for line in routes.splitlines() if line.strip() and not line.startswith('Iface')]
if route_rows:
    raise SystemExit('current process namespace still has IPv4 routes')
if any(line.split()[-1] != 'lo' for line in ipv6_routes.splitlines() if line.strip()):
    raise SystemExit('current process namespace still has external IPv6 routes')
PY
python3 "$script_dir/verify-offline-xwin.py" "$root"
test ! -e "$root/output"
mkdir "$root/output"
chmod u+x "$root/tool/xwin"
"$root/tool/xwin" --accept-license --arch x86_64,aarch64 --sdk-version 10.0.26100 --crt-version 14.44.17.14 --include-atl --cache-dir "$root/cache" --manifest "$root/manifest/channel.json" --http-retry 0 splat --use-winsysroot-style --preserve-ms-arch-notation --include-debug-libs --output "$root/output"
find "$root/output" -type f -print0 | sort -z | xargs -0 sha256sum > "$root/receipt/output.sha256"
printf '%s\n' '{"network":"isolated-namespace-interfaces-and-routes-checked","xwinExecuted":true,"offlineHttpRetry":0}' > "$root/receipt/execution.json"
