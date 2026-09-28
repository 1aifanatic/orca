#!/usr/bin/env bash
set -euo pipefail
root=${1:?}; bin=$(find "$root/tool" -type f -name xwin -print -quit); test -x "$bin"
manifest=$(find "$root/manifest" -type f -name '*.vsman' -print -quit); test -n "$manifest"
cache=$(find "$root/cache" -type d -name dl -print -quit); test -n "$cache"
out="$root/output"; mkdir -p "$out"
mkdir -p "$root/receipt"
"$bin" --accept-license --arch x86_64,aarch64 --sdk-version 10.0.26100 --crt-version 14.44.17.14 --include-atl --cache-dir "$cache" --manifest "$manifest" --http-retry 0 splat --use-winsysroot-style --preserve-ms-arch-notation --include-debug-libs --output "$out"
find "$out" -type f -print0 | sort -z | xargs -0 sha256sum > "$root/receipt/output.sha256"
printf '%s\n' '{"network":"disabled-by-unshare","xwinExecuted":true,"offlineHttpRetry":0}' > "$root/receipt/execution.json"
