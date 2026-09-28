#!/usr/bin/env bash
set -euo pipefail
sysroot=${1:?}
receipt=${2:?}
mkdir -p "$receipt"
shopt -s nullglob
crt_versions=("$sysroot/VC/Tools/MSVC/"*)
sdk_versions=("$sysroot/Windows Kits/10/Include/"*)
test "${#crt_versions[@]}" = 1
test "${#sdk_versions[@]}" = 1
crt=${crt_versions[0]}
sdk_include=${sdk_versions[0]}
sdk_version=$(basename "$sdk_include")
cat > "$receipt/probe.c" <<'C'
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  void *allocation = malloc(64);
  printf("process=%lu allocation=%p\n", GetCurrentProcessId(), allocation);
  free(allocation);
  return 0;
}
C
cat > "$receipt/probe.rs" <<'RS'
fn main() {
    let data = vec![42_u32; 100];
    println!("{} {}", std::process::id(), data.iter().sum::<u32>());
}
RS
for arch in x64 arm64; do
  if test "$arch" = x64; then target=x86_64-pc-windows-msvc; machine=AMD64; else target=aarch64-pc-windows-msvc; machine=ARM64; fi
  libs=("$crt/lib/$arch" "$sysroot/Windows Kits/10/Lib/$sdk_version/ucrt/$arch" "$sysroot/Windows Kits/10/Lib/$sdk_version/um/$arch")
  test -s "${libs[0]}/libcmt.lib"
  test -s "${libs[1]}/libucrt.lib"
  test -s "${libs[2]}/kernel32.lib"
  clang-21 --driver-mode=cl "--target=$target" /MT /c "$receipt/probe.c" \
    "/imsvc$crt/include" "/imsvc$sdk_include/ucrt" "/imsvc$sdk_include/shared" "/imsvc$sdk_include/um" \
    "/Fo$receipt/$arch.obj"
  lld-link-21 /subsystem:console "/machine:$arch" "/out:$receipt/$arch.exe" \
    "/libpath:${libs[0]}" "/libpath:${libs[1]}" "/libpath:${libs[2]}" "$receipt/$arch.obj"
  llvm-readobj-21 --file-headers --coff-imports "$receipt/$arch.exe" > "$receipt/$arch-pe.txt"
  grep -F "IMAGE_FILE_MACHINE_$machine" "$receipt/$arch-pe.txt"
  grep -iF 'KERNEL32.dll' "$receipt/$arch-pe.txt"
  # The caller installs the pinned Rust components; no network or rustup lookup is allowed.
  /opt/orca-rust/bin/rustc --target "$target" -C linker=lld-link-21 \
    -L "native=${libs[0]}" -L "native=${libs[1]}" -L "native=${libs[2]}" \
    "$receipt/probe.rs" -o "$receipt/$arch-rust.exe"
  llvm-readobj-21 --file-headers --coff-imports "$receipt/$arch-rust.exe" > "$receipt/$arch-rust-pe.txt"
  grep -F "IMAGE_FILE_MACHINE_$machine" "$receipt/$arch-rust-pe.txt"
done
sha256sum "$receipt"/*.exe "$receipt"/*.obj > "$receipt/output.sha256"
printf 'Windows x64 and ARM64 C CRT/SDK and Rust std link probes passed; executables not run\n' > "$receipt/SUCCESS"
