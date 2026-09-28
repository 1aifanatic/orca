#!/usr/bin/env bash
set -euo pipefail
# Run on a disposable Linux Docker host. Only the selected working directory is mounted.
fixture_dir="$(cd "$(dirname "$0")" && pwd)"
bun_build_root="${BUN_CONPTY_BUILD_ROOT:?Set a new disposable build directory}"
mkdir -p "$bun_build_root"
git clone --filter=blob:none --no-checkout https://github.com/oven-sh/bun.git "$bun_build_root/bun"
git -C "$bun_build_root/bun" checkout 744846f844374847c902b5e7fd59b4342a51ef99
git -C "$bun_build_root/bun" submodule update --init --recursive --depth 1
git -C "$bun_build_root/bun" apply --check "$fixture_dir/bundled-conpty.patch"
git -C "$bun_build_root/bun" apply "$fixture_dir/bundled-conpty.patch"
docker build --target base --tag bun-conpty-toolchain-base --file "$bun_build_root/bun/.buildkite/Dockerfile" "$bun_build_root/bun"
docker build --tag bun-conpty-toolchain --file "$fixture_dir/Dockerfile" "$fixture_dir"
for bun_target_arch in x64 arm64; do
  bun_baseline_arg=""
  if [[ "$bun_target_arch" == x64 ]]; then bun_baseline_arg="--baseline=true"; fi
  docker run --rm --mount "type=bind,source=$bun_build_root/bun,target=/work/bun" \
    --env CI=true --env ORCA_BACKGROUND_LAUNCH=1 --env RUSTUP_TOOLCHAIN=nightly-2026-07-20 \
    bun-conpty-toolchain bash -lc \
    "bun install --frozen-lockfile && bun scripts/build.ts --profile=release --os=windows --arch=$bun_target_arch $bun_baseline_arg --lto=off --build-dir=build/conpty-$bun_target_arch -j2"
done
