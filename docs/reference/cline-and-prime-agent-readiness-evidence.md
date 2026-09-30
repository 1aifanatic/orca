# Cline and Prime Agent readiness: what the transcripts show

Both agents paint their composer with cursor addressing on the alternate screen, so the line-folded
text tail cannot see it (#23268, #22153). Their readiness is read off the live screen by
`isClineComposerReadyScreen` and `isPrimeAgentComposerReadyScreen`, through the same tiering as
Antigravity ([`antigravity-readiness-evidence.md`](./antigravity-readiness-evidence.md)): a pane
with an output clock is believed only once quiet, and when a trustworthy screen exists it decides,
so the quiet-process lane cannot settle a dialog it cannot see. Without a readable screen (a
re-attached pane whose grid is untrusted) both keep the quiet-process lane they had before; no
rest-signal entry closes it. Recordings follow
[`agent-pty-transcript-capture.md`](./agent-pty-transcript-capture.md) and are replayed by
`cline-screen-readiness-transcripts.test.ts` and `prime-agent-screen-readiness-transcripts.test.ts`.

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
  grid is the same composer box as at rest. Only quiescence separates them. A clockless restored
  pane still settles from the screen, like Antigravity and Prime: `onPtyData` stamps
  `lastOutputAt` on every chunk, so a streaming pane has a clock from its first byte after attach,
  and only a pane that has printed nothing since attach is judged on the screen alone. A reply that
  stalls for 3s with its spinner off screen would read ready; that is not captured and not ruled
  out.
- **The placeholder is not fixed.** It changes with mode and history, so the rule accepts the three
  captured placeholders and nothing else. A typed draft looks the same to the read projection, which
  is why `readLiveTerminalScreenLines` now returns raw rows. That changes Codex's and Qoder's input
  too, so every frame of every `codex-*` and `qoder-*` capture was replayed at 120x40, 80x24 and
  100x32 through both readers: the rows differ on some Codex frames (up to 180 of 982), and no verdict of
  `isKnownReadyPromptBody` (with and without a clock) or `isQuietReadyScreenBody` changes.
- **The promo popup appears about 40ms after the composer** and returns on each launch until it
  is dismissed once (`cli-notices.json`). The quiet lane covers that race; the popup carries no
  blocked wording.
- **The approval prompt is quiet and unworded.** No blocked rule matches it, so before the screen
  decided, the quiet-process lane would have settled it. That lane stays open only while the pane
  has no readable screen.
- **Windows:** the reported bug (#23268) is Windows, where the text tail reorders rows. Only the
  3.0.65 contributor capture covers it, and it reads ready from the screen. The rule depends on
  rendered rows, not byte order, but no Windows turn or dialog is recorded.

## Prime Agent

Recorded 2026-09-30 on macOS, `prime-agent` 0.9.8, OpenRouter
`inclusionai/ling-3.0-flash-sante:free`, with an isolated `HOME` (the first-launch question only
reappears in a fresh one). `prime-agent-0-9-5-*.txt` are 120x35 captures from PR #22154.

| Fixture (`prime-agent-0-9-8-*.txt`) | Screen at the end                              | Rule      |
| ----------------------------------- | ---------------------------------------------- | --------- |
| `ready`, `ready-80x24`              | bare `>` over the `← manage` footer            | ready     |
| `ready-after-question`              | trace question answered "Not now"              | ready     |
| `turn-ended`, `tool-turn`           | a turn (one with a Python tool call) has ended | ready     |
| `trace-question`                    | animated "Share agent traces" question         | not ready |
| `slash-menu`                        | `>  /` with the command list                   | not ready |
| `busy-streaming`                    | `⠦ Writing · 6s` status row above the composer | not ready |
| `draft`                             | unsent text in the composer                    | not ready |

- **The footer and caret stay up mid-turn.** Only the braille status row Prime keeps directly above
  them says a turn is running, so the rule vetoes on it.
- **The rule reads ready for moments it should not.** Replayed in 64-byte chunks, Prime erases that
  status row before redrawing it, and on first launch it paints the idle composer a few tens of
  milliseconds before the trace question covers it. Both are covered by quiescence: the spinner and the question's
  animation repaint continuously, and an idle Prime is silent.
- **No permission prompt exists to capture.** With default settings Prime ran the tool call without
  asking.
- 0.9.4's `← agents/resume` layout is not supported; the rule needs 0.9.5 or later.
