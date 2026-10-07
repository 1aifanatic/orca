# Crash ec86e831 — v1.4.222 Windows renderer access violation

**Verdict: not reproduced. No source fix.** The crash maps exactly to a Chromium Blink function. Two hidden-window runs on awin (70 minutes combined) did not crash. Machine-readable results: [`results.json`](./results.json).

## Field crash

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| Build       | Orca 1.4.222, Electron 43.7.5, Chrome 150.0.7871.250                     |
| OS          | Windows 10.0.22621 x64                                                   |
| Process     | renderer, exit -1073741819, exception 0xc0000005                         |
| Frame       | `Orca.exe+0x1f07125` (absolute 0x7ff7753a7125)                           |
| Session     | main start 02:59:26.909Z, report 05:00:31.851Z                           |
| Last memory | used heap 53 MB, private 214 MB, 17.8 GB RAM free; not an OOM            |
| Minidump    | reported as captured (1,839,600 bytes) but **not attached**; unavailable |

## Release identity (verified)

- Tag `v1.4.222` → `4bb6f2072b07c1f0664b809551f77754700570e4`. This worktree's HEAD is not the release, so every run used the released binary itself.
- Downloaded `orca-windows-setup.exe` from the GitHub release. Its sha512 matches `latest.yml`. It was **extracted with portable 7-Zip, not installed**, because the installer's process sweep could close the user's running Orca.
- The extracted `Orca.exe` reports ProductVersion 1.4.222.0. Its CodeView ID is `electron.exe.pdb` `FA93794E22E98CCB4C4C44205044422E1`, identical to the official Electron 43.7.5 Breakpad `MODULE` line.
- The `.text` section of the release `Orca.exe` is byte-identical to the repo's stock Electron 43.7.5 `electron.exe` (sha256 `05dcfd82…`). A harness on stock Electron runs the same Blink machine code.
- Hashes: [`identity-sha256.txt`](./identity-sha256.txt).

## Symbolication

```
RVA 0x1f07125 → blink::HashTrieNode<const blink::CSSValue>::MakeShared() + 0x5
                third_party/blink/renderer/core/style/style_variables.h:231
0x1f07120  push rsi
0x1f07121  sub  rsp, 0x20
0x1f07125  cmp  byte ptr [rcx + 0x100], 0    ← fault: read this->shared
```

With cppgc pointer compression, `children_` sits at `+0xc0` and `shared` at `+0x100`. The fault is the very first field read, so the node pointer (`this`) was already invalid when `MakeShared()` was entered. It could be null (+0x100), freed, or corrupted; without the dump's exception parameters these can't be told apart.

`MakeShared()` is called from the `StyleVariables` copy constructor and copy assignment when a computed style is copied. `data_root_->MakeShared()` runs first, then `values_root_->MakeShared()`. The faulting template is the `values_root_` trie, or a recursive call into one of its children. That trie holds computed values only for custom properties registered with a typed syntax. The shipped renderer CSS registers 10 such properties, all non-inherited Tailwind ones: `--tw-gradient-from/via/to` (`<color>`), `--tw-gradient-*-position` (`<length-percentage>`), `--tw-shadow-alpha`, `--tw-inset-shadow-alpha`, `--tw-drop-shadow-alpha` (`<percentage>`), and `--tw-ring-offset-width` (`<length>`). No app code calls `CSS.registerProperty`.

Only the top frame was reported, so no Orca JS or React path can be attributed. Electron 43.7.6–43.7.9 backports were checked (#54569, #54658, #54667): none touch Blink style/CSS or cppgc, so an Electron patch bump is not evidenced to fix this.

## Reproduction attempts (awin, Windows 11 26200)

All launches used `ORCA_BACKGROUND_LAUNCH=1` and hidden windows. Screenshots came only from CDP; no window was shown or focused. Both runs were driven through the `electron` skill's Playwright-CDP route (`.claude/skills/electron`).

### A. Released app, hidden soak — 40 min, no crash

```sh
scripts/launch-release.sh 'C:\Users\neil\orca-crash-222\run1' 9341 47622   # background
scripts/orca222.sh repo add --path <repoN>; scripts/orca222.sh worktree create ...  # 6 repos × 3 worktrees
scripts/orca222.sh terminal create --worktree path:<wt> --command 'node scripts/agent-sim.js'  # ×6
ORCA_BACKGROUND_LAUNCH=1 REPO_ROOT=<worktree> node scripts/soak.mjs 9341 40 <logs> <profile>
```

- Workload:
  - 6 repos with 18 worktrees.
  - 6 terminals redrawing an agent-like spinner and tool blocks at 10 Hz.
  - Each cycle clicks a worktree and an agent tab and hovers a button.
  - Dark/light theme flips through `window.api.settings.set` every 5 cycles.
  - Viewport resizes every 7 cycles; settings open and close every 11.
- Result:
  - 436 cycles, 0 action errors, no `crash` event and no Crashpad dump. Crashpad was armed (`metadata` and `settings.dat` present).
  - Renderer heap went from 43 to 141 MB, ending at 125 MB; at most 4,722 DOM nodes.
  - Evidence: [`logs/app-soak.ndjson`](./logs/app-soak.ndjson) (also contains the 1-minute smoke run first) and [`screenshots/`](./screenshots/).

### B. Amplified Blink style churn on identical code — 30 min, no crash

```sh
ORCA_BACKGROUND_LAUNCH=1 HARNESS_OUT=<dir> HARNESS_MINUTES=30 HARNESS_WINDOWS=2 \
  node_modules/electron/dist/electron.exe harness/main.cjs
```

`harness/page.html` loads `release.css`, which is a copy of the release `out/renderer/assets/I18nProvider-BcmPW0dL.css`. It runs ordinary DOM/CSS operations every 16 ms:

- class swaps across gradient, shadow and ring utilities that set the typed properties;
- toggling the root `dark` class;
- subtree rebuilds and clones;
- forced layout and `getComputedStyle`.

Result: 2 windows × 108,735 steps, no `render-process-gone` and no dump ([`logs/style-harness.ndjson`](./logs/style-harness.ndjson)).

## Launch-safety finding (separate from the crash)

On packaged Windows builds, v1.4.222's `pruneOldDaemonHosts` (`src/main/daemon/daemon-host-relocation.ts`) deletes every `%LOCALAPPDATA%\Orca\daemon-host\<version>` folder for which the current profile's runtime dir has no live pid record. A second packaged Orca started with an isolated profile but the real `LOCALAPPDATA` would therefore try to delete the user's live daemon-host folder (here `1.4.221-adhoc…`). Every launch here redirected `LOCALAPPDATA`, and the user's daemon-host folders were confirmed intact. Anyone repeating this with a packaged build must do the same.

## Diagnosis and limits

- **Best-supported reading:** an invalid Blink custom-property trie node is reached while a computed style is copied. This is a Chromium-internal memory-safety failure in the renderer, and no Orca source change is shown to cause or avoid it. Whether the node was freed or corrupted can't be settled without the dump.
- **No source fix was made.** The task requires a matching reproduction first, and disabling Tailwind typed properties or theme transitions without one would be speculative.
- **What would move this forward:**
  1. The 1.8 MB minidump. Its exception parameters give the read address (near-null versus a freed cage page) and its stack gives the caller (style builder, animation, or inheritance).
  2. Other crash reports with the same RVA.
  3. A longer soak on a 22621 host with a real agent session and PR polling.
- **Not covered here:**
  - Real Claude CLI and gh-authenticated PR refresh (the home folder was isolated).
  - The user's repos and worktree count.
  - A ~2 h session age.
  - GPU and driver differences between 22621 and 26200.

Scripts in [`scripts/`](./scripts/) and [`harness/`](./harness/) are the ones used, except that the committed JS copies went through `oxlint --fix` and `oxfmt` for the pre-commit hook (braces, template literals, wrapping only; no behavior change). Their scratch paths (`C:\Users\neil\orca-crash-222`) are hardcoded.
