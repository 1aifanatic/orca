FROM bun-conpty-toolchain-base
ENV CARGO_HOME=/opt/bun-cargo RUSTUP_HOME=/opt/bun-rustup
ENV PATH=/opt/bun-cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
 && sh /tmp/rustup.sh -y --profile minimal --default-toolchain nightly-2026-07-20 \
 && rustup target add --toolchain nightly-2026-07-20 x86_64-pc-windows-msvc aarch64-pc-windows-msvc
WORKDIR /work/bun
