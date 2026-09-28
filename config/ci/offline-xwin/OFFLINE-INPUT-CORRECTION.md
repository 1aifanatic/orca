# Corrected offline xwin diagnostic inputs

The previous verifier did not establish input integrity: it counted arbitrary files, only hashed a package manifest, and did not verify xwin. The previous command also passed a package catalog to `--manifest` and the `dl` directory to `--cache-dir`. Those are incorrect for retained xwin 0.9.0. No prior assembly receipt proves extraction or a runtime build.

The corrected local preparation verifies an explicit 47-member cache (472,496,708 bytes), the exact xwin executable (7,901,024 bytes, SHA256 `0767d311a73af67ef9bd5204ad728d7e01f1b22721d51aac5568b7cb98404d5a`) extracted from its pinned archive, and the retained channel (91,781 bytes, SHA256 `fca418ba94ffbcfb7a2b25f10f16f39dd09660568d21eef4bd3f274cb0b27b8c`). It rejects missing, unexpected, corrupt, and symlink input files. The cache includes the original 38 SDK/UCRT files, eight CRT/ATL VSIX inputs omitted by the old assembler, and the package catalog.

## Why the catalog digest differs from the channel field

The unchanged retained `channel.json` advertises a package manifest SHA256 of `6e470016e4324c84c255ffd0beb3767d17ec89cc8561e9409ee3e1f6d29400f5` and 30,443,537 bytes. The actual response and retained `packages.vsman` are 17,954,732 bytes, SHA256 `f0a50ea157222c29abd5ea6ff01bfc3c33b04e011c5e45ee2ca38ef0778e5643`. Today's direct URL observation returned HTTP 200, not the previously reported 400.

This does not establish trust in arbitrary bytes under that URL. The actual bytes were independently matched to `Catalog.json` inside the retained layout archive (SHA256 `1e772b3917f75a5102d637462236d2b0b628142de3cc52c4e748c9f3228934f8`, 1,778,892,124 bytes). That layout was qualified in run 36482063593: the unchanged original passed offline verification after connected Windows trust preparation; catalog-signature and payload-hash negative controls failed explicitly; all 465 files were restored. Relevant retained evidence lives in `../offline-sdk-metadata-probe/qualified-offline-verification.json`, `retained-archive-verification.json`, and `run36482063593/`. The assembler rechecks the archive and extracts the exact Catalog.json member; it does not download a replacement or infer trust from xwin.

Retained `src/manifest.rs:168-180` explains that upstream xwin does not enforce the advertised package-manifest digest; it names its cache entry using that field. `src/main.rs:543-553` reads `--manifest` as a channel object; `src/ctx.rs:75-93` appends `dl` to the cache root. Therefore the correct mapping is:

- `--manifest inputs/manifest/channel.json`: unchanged channel.
- `--cache-dir inputs/cache`: parent of `dl`.
- `inputs/cache/dl/pkg_manifest_6e470016e4324c84c255ffd0beb3767d17ec89cc8561e9409ee3e1f6d29400f5.vsman`: independently authenticated Catalog.json, verified against its **actual** f0a50 digest.

The receipt records both identities distinctly. This is reuse of qualified catalog bytes under the source-defined cache key, not a claim that those bytes hash to the channel field. This also is not fresh air-gap trust qualification.

## Execution and remaining gates

`qualified-offline-inputs-v2/` was assembled locally and every file rehashed; no downloaded executable was run. Stage its `cache/`, `tool/`, and `manifest/` contents as the three exact artifact roots in a separate diagnostic branch. Keep the pins JSON and Python scripts from the same reviewed commit. Artifact ZIP permissions are not trusted; the execution script sets the verified binary executable only after rechecking its contents.

The Linux workflow uses `sudo unshare --net` and drops to the runner UID before invoking the diagnostic. The child verifies that only loopback exists and no IPv4 route exists before running xwin with `--http-retry 0`. A bounded 4 GiB scratch filesystem and 15-minute command deadline remain. The workflow must run on Linux; the Mac cannot qualify Linux execution. Do not claim CPU/memory/PID cgroup bounds: this workflow does not yet impose them.

No byte inputs are currently missing from local assembly. Artifact staging, actual isolated Linux extraction, x64/ARM64 output inspection, minimal LLVM/Rust link probes, full patched Bun build, and real Windows terminal qualification remain undone. Thirteen focused preparation tests passed; they do not qualify xwin execution.

## Connected CI staging alternative

`connected-offline-xwin-workflow.yml` eliminates manual local artifact upload: it requests the exact retained SDK artifact from run 36476269793 using the Actions API, checks its whole-archive hash, reads the qualified catalog/channel entries, obtains only the twelve catalog-selected UCRT inputs plus pinned xwin archive, and assembles inputs before dropping network access. `stage-offline-xwin-inputs.py` never executes an installer or downloaded tool. If the historical artifact is expired, absent, duplicated, or has a different ZIP digest, preparation fails; it does not silently accept a regenerated archive. This workflow is a local candidate only, not dispatched; use a separate diagnostic branch, not the production PR.
