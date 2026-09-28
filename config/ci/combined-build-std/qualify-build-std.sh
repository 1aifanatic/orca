#!/usr/bin/env bash
set -euo pipefail
export PATH=/opt/orca-rust/bin:/usr/lib/llvm-21/bin:$PATH
export CARGO_HOME=/work/cargo-home CARGO_NET_OFFLINE=true
export RUSTC=/opt/orca-rust/bin/rustc
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=clang-21
mkdir -p /work /results/build-std
bash /probe/install-offline.sh
cd /rust
sha256sum -c SHA256SUMS
mkdir /tmp/pinned-rust
while IFS= read -r component; do
  tar -xf "/rust/$component.tar" -C /tmp/pinned-rust
  bash "/tmp/pinned-rust/$component/install.sh" --prefix=/opt/orca-rust --disable-ldconfig
done < /rust/components.txt
rustc --version --verbose > /results/build-std/rustc.txt
grep -Fx 'commit-hash: 9f36de775bc636c8e88c31a173c2bcb6995956a0' /results/build-std/rustc.txt
cp /vendor-receipt.json /results/build-std/vendor-receipt.json
for kind in runtime shim; do
  mkdir -p "/work/$kind/src" "/work/$kind/.cargo"
  cat > "/work/$kind/.cargo/config.toml" <<'TOML'
[source.crates-io]
replace-with = "orca-combined-vendor"
[source.orca-combined-vendor]
directory = "/vendor"
TOML
  cat > "/work/$kind/Cargo.toml" <<TOML
[package]
name = "orca_build_std_$kind"
version = "0.0.0"
edition = "2021"
[lib]
crate-type = ["rlib"]
[profile.release]
panic = "abort"
TOML
  if test "$kind" = runtime; then
    cat >> /work/runtime/Cargo.toml <<'TOML'
[dependencies]
libc = "=0.2.185"
memchr = "=2.8.0"
TOML
    printf '%s\n' 'pub fn probe() -> (String, Option<usize>, usize) { (String::from("offline"), memchr::memchr(1, &[0, 1]), core::mem::size_of::<libc::c_int>()) }' > /work/runtime/src/lib.rs
    args=(-Zbuild-std=core,alloc,std,proc_macro,panic_abort -Zbuild-std-features=panic-unwind,default)
    unset RUSTFLAGS
  else
    printf '%s\n' '#![no_std]' 'pub fn probe() -> usize { 42 }' > /work/shim/src/lib.rs
    args=(-Zbuild-std=core,compiler_builtins -Zbuild-std-features=compiler-builtins-mem)
    export RUSTFLAGS='-Zunstable-options -Cpanic=immediate-abort'
  fi
  cd "/work/$kind"
  cargo generate-lockfile --offline
  cp Cargo.lock "/results/build-std/$kind-Cargo.lock"
  for target in x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
    timeout --kill-after=15s 900s cargo build --frozen --lib --release --target "$target" -j2 "${args[@]}" 2>&1 | tee "/results/build-std/$target-$kind.log"
    test -s "target/$target/release/liborca_build_std_$kind.rlib"
    cp "target/$target/release/liborca_build_std_$kind.rlib" "/results/build-std/$target-$kind.rlib"
    (cd /results/build-std && sha256sum "$target-$kind.rlib") >> /results/build-std/output.sha256
  done
  cmp Cargo.lock "/results/build-std/$kind-Cargo.lock"
done
printf '%s\n' 'Both Windows targets compiled runtime and shim standard-library feature sets offline with combined root/std source replacement; full Bun build and Windows execution not qualified.' > /results/build-std/SUCCESS
