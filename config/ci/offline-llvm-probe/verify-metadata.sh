#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")" && pwd)
keydir=$(mktemp -d)
trap 'rm -rf "$keydir"' EXIT
fingerprint=$(gpg --batch --homedir "$keydir" --with-colons --show-keys "$root/llvm-snapshot.gpg.key" | awk -F: '$1=="pub" {primary=1;next} primary && $1=="fpr" {print $10;exit}')
test "$fingerprint" = 6084F3CF814B57C1CF12EFD515CF4D18AF4F7421
gpg --batch --homedir "$keydir" --dearmor --output "$keydir/llvm.gpg" "$root/llvm-snapshot.gpg.key"
gpgv --homedir "$keydir" --keyring "$keydir/llvm.gpg" --status-fd 1 "$root/InRelease" > "$root/gpg-status.txt"
grep '^\[GNUPG:\] VALIDSIG ' "$root/gpg-status.txt"
python3 "$root/select.py" > "$root/closure-estimate.json"
