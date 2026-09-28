# Windows Bun cross-build host prerequisite audit

Local diagnostic only; no production runtime pin changes. Source: Bun commit
`744846f844374847c902b5e7fd59b4342a51ef99`, default prebuilt-WebKit Windows x64/ARM64 graph.
Compared with installed packages recorded by offline link run `36490725573`.

| Host input | Status / action | Source evidence |
| --- | --- | --- |
| Ninja | Missing; acquire `ninja-build` | `scripts/build.ts:143,259` |
| Perl plus standard modules | Missing full Perl; `perl-base` alone is installed | `configure.ts:322-331`; `src/codegen/create_hash_table` imports bigint/Getopt::Long |
| NASM | Missing; required for x64, not ARM64 | `tools.ts:575-582`, `compile.ts:265-275`, BoringSSL/libjpeg dependency declarations |
| Git | Missing; source patch application needs it | `fetch-cli.ts:328`, `config.ts:1500` |
| CMake >=3.24 | Missing from deb closure; reuse retained standalone 3.30.5 | `configure.ts:50-52` requires discovery even with prebuilt WebKit |
| unzip | Missing; needed if default ZIP extraction is exercised | `download.ts:292`; Focal GNU tar fallback cannot read ZIP |
| clang-cl | LLVM package has clang but no clang-cl alias; prepare local verified `clang-cl -> clang` | `tools.ts` Windows compiler discovery; qualified clang package member inventory |
| clang/clang++, llvm-lib/ar/ranlib/rc/mt, lld-link | Present in qualified LLVM closure; put `/usr/lib/llvm-21/bin` on PATH | Qualified package member inventory, `tools.ts:480-570` |
| Host Cargo linker | Set explicit clang path; closure has no gcc/cc executable | Sibling build-std qualification sets `CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=clang-21` |
| Codegen runtime | Use pinned Bun; retained Node 24.3 is too old for this source graph | `configure.ts:80-98` rejects Node <25 |
| make / pkg-config / python3 | No direct requirement found in scoped default graph; do not add speculatively | Native libraries mostly direct Ninja builds; nested CMake only local WebKit; in-tree runtime build.rs files only perform Rust filesystem/codegen-path operations |

The last row is not a claim about every transitive Cargo build script. The combined Cargo/build-std qualification is the execution gate for those inputs; avoid installing the broad upstream Dockerfile toolchain.

## Bounded acquisition procedure

1. Reuse `offline-llvm-ci-probe/resolve.py` URI parsing, authenticated-index SHA256 crosschecks, package/version receipts, and bounded download rules. Its existing limits are 128 packages / 256 MiB; tighten for this supplement if possible.
2. Resolve from the **post-install 68-package closure dpkg status**, not the pristine Ubuntu status, to avoid reacquiring or silently replacing qualified compiler libraries. The next container must capture that status before metadata-only tooling is installed.
3. Roots: ninja-build, perl, nasm, git, unzip. Use exact candidate versions from authenticated retained Ubuntu index metadata and record all dependency versions. Do not reuse `validate_llvm` unchanged: it expects LLVM roots in the newly resolved download set.
4. Preserve signed indexes/key provenance and downloaded size/SHA256 for every supplement. Reject drift, removals, downgrades, or replacement of the qualified LLVM closure unless explicitly reviewed.
5. Stage standalone CMake and pinned Bun separately using their retained hashes. Prepare the clang-cl alias in a diagnostic toolchain overlay or verified install directory, record it, and smoke-test that argv0 selects CL mode.
6. Install only the retained files in the same pinned Ubuntu image with network disabled. Check `ninja --version`, Perl module imports, `nasm -v`, `git --version`, CMake version, unzip availability, and Windows compiler discovery before generating the full graph.
7. Run configure-only for Windows x64 and ARM64, then the real bounded build. Preserve the retained historical `--lto=off` setting explicitly for both targets; release-default LTO is outside this qualification.

## Qualification boundary

Offline SDK extraction and C/Rust Windows x64/ARM64 link probes passed. They do not prove the full Bun build, executable runtime behavior, terminal repaint correctness, or performance. Keep production pins unchanged until those separate gates pass.
