#!/usr/bin/env bash
set -euo pipefail
# Invoked only inside the bounded network-none container after staged input admission.
export ORCA_BACKGROUND_LAUNCH=1 CI=true
export PATH=/opt/orca-rust/bin:/opt/cmake/bin:/opt/bun/bin:/opt/node/bin:/usr/lib/llvm-21/bin:$PATH
export BUN_TOOLCHAIN_RUST=/opt/orca-rust
export BUN_TOOLCHAIN_LLVM=/usr/lib/llvm-21
export BUN_BUILD_PREFETCH_DIR=/prefetch
export BUN_INSTALL=/work/bun-install
export CARGO_HOME=/work/cargo-home CARGO_NET_OFFLINE=true
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=/usr/lib/llvm-21/bin/clang
export BUN_INSTALL_CACHE_DIR=/work/bun_install_cache_dir
mkdir -p "$CARGO_HOME" /results
cat > "$CARGO_HOME/config.toml" <<'TOML'
[source.crates-io]
replace-with = "orca-combined-vendor"
[source.orca-combined-vendor]
directory = "/vendor"
[net]
offline = true
TOML
cd /work/source
test "$(git rev-parse HEAD)" = 744846f844374847c902b5e7fd59b4342a51ef99
sha256sum --check /probe/source-locks.sha256
sha256sum --check /probe/patch.sha256
git apply --check /probe/bundled-conpty.patch
git apply /probe/bundled-conpty.patch
git diff --binary > /results/applied.patch
bun --version > /results/bootstrap-bun.txt
node --version > /results/node.txt
rustc --version --verbose > /results/rustc.txt
cmake --version > /results/cmake.txt
ninja --version > /results/ninja.txt
for arch in x64 aarch64; do
  args=(--profile=release --canary=false --os=windows "--arch=$arch" --lto=off "--build-dir=build/conpty-$arch" -j2)
  if test "$arch" = x64; then args+=(--baseline=true); fi
  printf '%s\n' "${args[@]}" > "/results/$arch-args.txt"
  timeout --kill-after=30s 5400s bun scripts/build.ts "${args[@]}" 2>&1 | tee "/results/$arch.log"
  test -s "build/conpty-$arch/bun.exe"
  grep -Fx 'pub const IS_CANARY: bool = false;' "build/conpty-$arch/codegen/build_options.rs"
  cp "build/conpty-$arch/codegen/build_options.rs" "/results/$arch-build-options.rs"
  cp "build/conpty-$arch/bun.exe" "/results/bun-windows-$arch.exe"
  llvm-readobj --file-headers --coff-imports "/results/bun-windows-$arch.exe" > "/results/$arch-pe.txt"
  if test "$arch" = x64; then machine=AMD64; else machine=ARM64; fi
  grep -F "IMAGE_FILE_MACHINE_$machine" "/results/$arch-pe.txt"
  (cd /results && sha256sum "bun-windows-$arch.exe") >> /results/output.sha256
done
sha256sum --check /probe/source-locks.sha256
printf '%s\n' 'Both patched Bun Windows targets built with network disabled. Native Windows behavior, signatures and production runtime promotion remain unqualified.' > /results/SUCCESS
