# Mobile Shell Fingerprint

With OTA, most mobile changes ship from the desktop inside the page bundle. A change to the
**shell**, the binary a user installs from a store, needs a store release instead. The
`Mobile shell fingerprint` check in `.github/workflows/mobile-shell-fingerprint.yml` says which one a
change is.

## What counts as the shell

The shell is two artifacts, fingerprinted as built rather than guessed from a file list. Inlined
build constants and dependency bumps change what ships without touching an imported file, so a
source rule would miss them.

- **Native project.** The inputs `expo prebuild` and gradle/Xcode consume, hashed by
  `@expo/fingerprint` per platform: app config, config plugins and the files they reference,
  autolinked native module directories (including `mobile/modules/`), `mobile/patches/`, and the
  React Native version. The gitignored `mobile/android` and `mobile/ios` prebuild output is excluded.
- **Shell JS.** The bundle the binary embeds, from `expo export` for Android and iOS, once per shell
  variant: `native` (default) and `ota` (`EXPO_PUBLIC_MOBILE_SHELL=ota`). Both variants ship today.
  The hash covers the bundle, `metadata.json` and the content-addressed assets. Source maps and
  `assetmap.json`, which carries absolute paths, are excluded.

The OTA page bundle built by `config/scripts/build-mobile-web-app-bundle.mjs` is not part of the
shell. The desktop delivers it.

## The verdict

`mobile/scripts/mobile-shell-fingerprint.mjs compute` writes one record per tree, and `compare`
turns two records into a verdict.

- **Pull request.** The base is the merge commit's first parent. The summary reads
  `Mobile shell: unchanged — OTA delivers this` or `Mobile shell: changed` with one line per part.
- **Push to main.** The base is the newest `mobile-android-v*` tag by version. The Android release
  workflow creates that tag when it publishes an APK, and it lives on a side branch, so it is found
  by name, not ancestry. The summary reads `Mobile release needed since mobile-android-vX.Y.Z:
yes/no`. iOS releases create no tag, so there is no iOS anchor.
- **Unknown.** A failed install or export at either end, or records from different script
  versions, report `verdict unknown` rather than a guess.

The base gets its own frozen install, so a dependency bump is fingerprinted with the right
`node_modules`. The check never fails the run.

## Reading the summary

Each part that moved gets one line that names it in plain words:

- `native (android): app config, native module expo-camera` names the fingerprint inputs that
  moved, up to five, then `+N more`.
- `shell JS (ota, android): 3 modules differ` counts the source modules whose content differs in
  that bundle. `bundle only, no source module differs` means the bundle moved through something no
  module shows, such as an inlined constant or a transform.

Below the parts, `Sources that differ inside the changed bundles` lists those modules, capped at 40
lines. Dependency files collapse to one line per package. A listed file did not necessarily move
the bundle: a comment-only edit is listed beside the edit that did.

## False positives

The verdict is exact about the artifacts, so a "changed" can still need no release:

- **Refactor-only shell edits.** Renaming or reformatting shell code changes the minified bundle
  though the behaviour is the same.
- **Bundler and toolchain bumps.** A Metro, Babel or Hermes-adjacent upgrade rewrites the bundle
  with no source change. These show as package lines or `no source module differs`.
- **Whole-config hashing.** The app config is hashed as one input, so an Android-only field such as
  a permission also marks `native project (ios)` as changed.

## The label

Same-repository pull requests whose shell changed get `needs-mobile-release`. The label is removed
when a later push makes the shell unchanged. It is left alone on forks and on unknown verdicts.

## When it runs

The workflow runs for changes under `mobile/` and `src/shared/`, which are the only places the
shell bundles draw modules from. It skips `mobile/rpc-foundation/`, test files and Markdown, which
never enter a bundle. The root lockfile and `config/patches/` are left out because mobile is its
own pnpm project and no bundle module resolves from the root `node_modules`.
