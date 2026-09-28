#!/usr/bin/env bash
set -euo pipefail
cd /opt/orca-bootstrap
sha256sum --check SHA256SUMS
case "${TARGETARCH:?}" in
  amd64) cpu=x86_64; bun_cpu=x64; node_cpu=x64 ;;
  arm64) cpu=aarch64; bun_cpu=aarch64; node_cpu=arm64 ;;
  *) echo 'Unsupported bootstrap host architecture' >&2; exit 2 ;;
esac
case "${1:?}" in
  cmake)
    sh "cmake-${cpu}-cmake-3.30.5-linux-${cpu}.sh" --skip-license --prefix=/usr
    ;;
  bun)
    mkdir /tmp/orca-verified-bun
    unzip "bun-bootstrap-${cpu}-bun-linux-${bun_cpu}.zip" -d /tmp/orca-verified-bun
    cp /tmp/orca-verified-bun/*/bun /usr/bin/bun
    chmod +x /usr/bin/bun
    rm -rf /tmp/orca-verified-bun
    ;;
  node)
    tar -xzf "node-v24.3.0-linux-${node_cpu}.tar.gz" -C /usr/local --strip-components=1
    mkdir -p /opt/orca-provenance
    node --version > /opt/orca-provenance/node.txt
    ;;
  rust)
    test "$TARGETARCH" = amd64 || { echo 'Retained Rust inputs require an x64 build host' >&2; exit 2; }
    cp "rustup-${cpu}-rustup-init" /tmp/orca-verified-rustup-init
    chmod +x /tmp/orca-verified-rustup-init
    /tmp/orca-verified-rustup-init -y --no-modify-path --default-toolchain none
    mkdir /tmp/orca-verified-rust
    for component in rustc-nightly-x86_64-unknown-linux-gnu cargo-nightly-x86_64-unknown-linux-gnu \
      rust-std-nightly-x86_64-unknown-linux-gnu rust-std-nightly-x86_64-pc-windows-msvc \
      rust-std-nightly-aarch64-pc-windows-msvc; do
      tar -xJf "$component.tar.xz" -C /tmp/orca-verified-rust
      bash "/tmp/orca-verified-rust/$component/install.sh" --prefix=/opt/orca-rust --disable-ldconfig
    done
    rustup toolchain link orca-nightly-2026-07-20 /opt/orca-rust
    mkdir -p /opt/orca-provenance
    cp /opt/orca-rust/lib/rustlib/components /opt/orca-provenance/rust-components.txt
    rm -rf /tmp/orca-verified-rust /tmp/orca-verified-rustup-init
    ;;
  windows)
    tar -xzf "xwin-${cpu}-xwin-0.9.0-${cpu}-unknown-linux-musl.tar.gz" -C /opt
    /opt/xwin-0.9.0-${cpu}-unknown-linux-musl/xwin --accept-license --arch x86_64,aarch64 \
      --sdk-version 10.0.26100 --crt-version 14.44.17.14 --include-atl \
      --cache-dir /opt/orca-provenance/xwin-cache splat --use-winsysroot-style \
      --preserve-ms-arch-notation --include-debug-libs --output /opt/winsysroot
    ln -s include '/opt/winsysroot/Windows Kits/10/Include'
    ln -s lib '/opt/winsysroot/Windows Kits/10/Lib'
    find /opt/orca-provenance/xwin-cache -type f -exec sha256sum '{}' + \
      > /opt/orca-provenance/xwin-cache.sha256
    ;;
  *) echo 'Unknown bootstrap stage' >&2; exit 2 ;;
esac
