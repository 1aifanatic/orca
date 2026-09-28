#!/usr/bin/env bash
set -euo pipefail
receipt=${1:?}
mkdir -p "$receipt"
test "$(uname -m)" = x86_64
test "$(rustup show active-toolchain | cut -d' ' -f1)" = orca-nightly-2026-07-20
rustc --version --verbose | tee "$receipt/rustc.txt"
cargo --version --verbose | tee "$receipt/cargo.txt"
grep -Fx 'commit-hash: 9f36de775bc636c8e88c31a173c2bcb6995956a0' "$receipt/rustc.txt"
grep -Fx 'host: x86_64-unknown-linux-gnu' "$receipt/rustc.txt"
grep -Fx 'release: 1.99.0-nightly' "$receipt/rustc.txt"
grep -E '^cargo 1\.100\.0-nightly \(3efb1f477 2026-07-17\)$' "$receipt/cargo.txt"
cp /opt/orca-rust/lib/rustlib/components "$receipt/installed-components.txt"
for target in x86_64-unknown-linux-gnu x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
  grep -Fx "rust-std-$target" "$receipt/installed-components.txt"
  library=$(rustc --print target-libdir --target "$target")
  test "$library" = "/opt/orca-rust/lib/rustlib/$target/lib"
  test -n "$(find "$library" -maxdepth 1 -name 'libstd-*.rlib' -print -quit)"
  printf '%s\t%s\n' "$target" "$library" >> "$receipt/installed-targets.txt"
done
rustup --version > "$receipt/rustup.txt"
dpkg-query -W > "$receipt/host-packages.txt"
sha256sum /opt/orca-rust/bin/rustc /opt/orca-rust/bin/cargo > "$receipt/executables.sha256"
cp /opt/orca-bootstrap/SHA256SUMS "$receipt/archives.sha256"
printf '%s\n' 'PASS: exact retained Rust installation and target libraries only; no runtime build qualification' > "$receipt/verdict.txt"
