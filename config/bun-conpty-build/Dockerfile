FROM bun-conpty-toolchain-base
ENV CARGO_HOME=/opt/bun-cargo RUSTUP_HOME=/opt/bun-rustup
ENV PATH=/opt/bun-cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
 && sh /tmp/rustup.sh -y --profile minimal --default-toolchain nightly-2026-07-20 \
 && rustup target add --toolchain nightly-2026-07-20 x86_64-pc-windows-msvc aarch64-pc-windows-msvc
ARG TARGETARCH
ARG XWIN_VERSION="0.9.0"
RUN XWIN_ARCH=$(if [ "$TARGETARCH" = "arm64" ]; then echo "aarch64"; else echo "x86_64"; fi) \
    && curl -fsSL "https://github.com/Jake-Shadle/xwin/releases/download/${XWIN_VERSION}/xwin-${XWIN_VERSION}-${XWIN_ARCH}-unknown-linux-musl.tar.gz" \
       -o /tmp/xwin.tar.gz \
    && tar -xzf /tmp/xwin.tar.gz -C /tmp \
    && /tmp/xwin-${XWIN_VERSION}-${XWIN_ARCH}-unknown-linux-musl/xwin --accept-license --arch x86_64,aarch64 --sdk-version 10.0.26100 --crt-version 14.44.17.14 --include-atl --cache-dir /tmp/xwin-cache \
       splat --use-winsysroot-style --preserve-ms-arch-notation --include-debug-libs --output /opt/winsysroot \
       > /dev/null \
    && ln -s include "/opt/winsysroot/Windows Kits/10/Include" \
    && ln -s lib "/opt/winsysroot/Windows Kits/10/Lib" \
    && rm -rf /tmp/xwin.tar.gz /tmp/xwin-${XWIN_VERSION}-${XWIN_ARCH}-unknown-linux-musl /tmp/xwin-cache
ENV WINDOWS_SYSROOT=/opt/winsysroot
RUN git config --global --add safe.directory /work/bun
WORKDIR /work/bun
