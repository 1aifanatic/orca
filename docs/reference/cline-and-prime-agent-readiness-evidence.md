# Cline and Prime Agent readiness: what the transcripts show

Cline paints its composer with cursor addressing on the alternate screen, so the line-folded text
tail cannot see it (#23268). Its readiness is read off the live screen by
`isClineComposerReadyScreen`, through the same tiering as Antigravity
([`antigravity-readiness-evidence.md`](./antigravity-readiness-evidence.md)): a pane with an output
clock is believed only once quiet, and when a trustworthy screen exists it decides, so the
quiet-process lane cannot settle a dialog it cannot see. Recordings follow
[`agent-pty-transcript-capture.md`](./agent-pty-transcript-capture.md) and are replayed by
`cline-screen-readiness-transcripts.test.ts`.

## Cline

Recorded 2026-09-30 on macOS, `cline` 3.0.66, OpenRouter's free router, with an isolated
`--config`/`--data-dir`. `cline-3-0-65-win32-startup.txt` is a Windows capture from PR #23269.

| Fixture (`cline-3-0-66-*.txt`) | Screen at the end                                   | Rule        |
| ------------------------------ | --------------------------------------------------- | ----------- |
| `ready`, `ready-80x24`         | startup composer, `❯ What can I do for you?`        | ready       |
| `ready-plan`                   | Plan mode, `❯ Plan something...`                    | ready       |
| `turn-ended`                   | after a turn, `❯ Ask anything...`                   | ready       |
| `promo`                        | "Introducing Cline Desktop" drawn over the composer | not ready   |
| `permission`                   | `Approve tool call?` with `[y] Approve [n] Deny`    | not ready   |
| `slash-menu`                   | `❯ /` with the command list under it                | not ready   |
| `draft`                        | unsent text in the composer                         | not ready   |
| `busy-streaming`               | a reply streaming, spinner scrolled off the top     | reads ready |

- **The streaming screen is the idle screen.** Once a long reply scrolls its spinner row away, the
  grid is the same composer box as at rest. Only quiescence separates them, so Cline has no
  clockless tier-1 path: a restored Cline pane waits for output. A reply that stalls for 3s with
  its spinner off screen would read ready; that is not captured and not ruled out.
- **The placeholder is not fixed.** It changes with mode and history, so the rule accepts the three
  captured placeholders and nothing else. A typed draft looks the same to the read projection, which
  is why `readLiveTerminalScreenLines` now returns raw rows.
- **The promo popup appears about 40ms after the composer** and returns on each launch until it
  is dismissed once (`cli-notices.json`). The quiet lane covers that race; the popup carries no
  blocked wording.
- **The approval prompt is quiet and unworded.** No blocked rule matches it, so before the screen
  decided, the quiet-process lane would have settled it.
- **Windows:** the reported bug (#23268) is Windows, where the text tail reorders rows. Only the
  3.0.65 contributor capture covers it, and it reads ready from the screen. The rule depends on
  rendered rows, not byte order, but no Windows turn or dialog is recorded.
