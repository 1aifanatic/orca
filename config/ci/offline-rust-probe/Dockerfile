FROM ubuntu@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214
ARG TARGETARCH=amd64
RUN test "$TARGETARCH" = amd64 && apt-get update && apt-get install -y --no-install-recommends xz-utils ca-certificates libgcc-s1 libc6 && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/opt/bun-cargo RUSTUP_HOME=/opt/bun-rustup
ENV PATH=/opt/bun-cargo/bin:$PATH RUSTUP_TOOLCHAIN=orca-nightly-2026-07-20
COPY downloads/ /opt/orca-bootstrap/
COPY bootstrap.sha256 /opt/orca-bootstrap/SHA256SUMS
COPY install-verified-bootstrap.sh /opt/orca-bootstrap/install.sh
COPY verify.sh /opt/orca-probe/verify.sh
RUN --network=none bash /opt/orca-bootstrap/install.sh rust
RUN --network=none bash /opt/orca-probe/verify.sh /opt/orca-provenance
CMD ["bash", "/opt/orca-probe/verify.sh", "/receipts"]
