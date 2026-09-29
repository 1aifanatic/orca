import type { TuiAgent } from '../../shared/tui-agent'
import {
  CODEX_HEADER_LOADING_RE,
  isMuseReadyPromptPreview,
  LIVE_PROMPT_TAIL_LINES,
  TERMINAL_WAIT_BLOCKED_SENTINEL_RE
} from './terminal-wait-detection'
import { startOfLastNonBlankLines } from './terminal-wait-tail-window'

/**
 * Tier 1b body evidence: a ready screen from an agent with no title rest signal to settle on.
 * Why separate from isKnownReadyPromptBody: that one settles at once, while these screens only
 * prove the TUI is up — the ranking holds them to quiescence.
 * Why per-agent gates: another agent's screen can quote Muse's banner or Codex's placeholder.
 */
export function isQuietReadyScreenBody(
  waitText: string,
  agent: TuiAgent | null,
  readScreenLines: () => readonly string[] | null
): boolean {
  if ((agent === null || agent === 'muse') && isMuseReadyPromptPreview(waitText)) {
    return true
  }
  return (agent === null || agent === 'codex') && isCodexComposerReadyScreen(readScreenLines())
}

const CODEX_COMPOSER_PLACEHOLDER = 'ask codex to do anything'
// Why not "working": reasoning summaries replace it, and a remapped key still ends this way.
const CODEX_BUSY_STATUS_MARKER = 'to interrupt)'
// Why beyond the sentinel: a half-drawn approval dialog shows its title over a live composer.
const CODEX_APPROVAL_TITLE_MARKER = 'would you like to'
const CODEX_HEADER_LINES = 6

/**
 * Codex's empty composer with no turn, header load, or dialog on screen. Codex 0.158 dropped the
 * `model:`/`directory:` header, and a long session scrolls the header away, so this is its only
 * version-stable rest body. It is also painted mid-turn while the status row is briefly hidden,
 * which the caller's quiescence demand absorbs: default Codex never goes 3s silent mid-turn.
 * Known gap: with `tui.animations=false` a turn can sit silent with no status row, which neither
 * the screen nor the title distinguishes from rest.
 */
export function isCodexComposerReadyScreen(screenLines: readonly string[] | null): boolean {
  if (screenLines === null) {
    return false
  }
  const screen = screenLines.join('\n').toLowerCase()
  if (!screen.includes(CODEX_COMPOSER_PLACEHOLDER) || screen.includes(CODEX_BUSY_STATUS_MARKER)) {
    return false
  }
  if (isCodexHeaderLoading(screen)) {
    return false
  }
  const liveWindow = screen.slice(startOfLastNonBlankLines(screen, LIVE_PROMPT_TAIL_LINES))
  return (
    !TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(liveWindow) &&
    !liveWindow.includes(CODEX_APPROVAL_TITLE_MARKER)
  )
}

// Why both shapes: 0.150-0.157 paint `model: loading`, 0.158 a bare `loading` under the title.
function isCodexHeaderLoading(screen: string): boolean {
  const headerIndex = screen.indexOf('openai codex')
  if (headerIndex === -1) {
    return false
  }
  return screen
    .slice(headerIndex)
    .split('\n', CODEX_HEADER_LINES)
    .some(
      (line) => CODEX_HEADER_LOADING_RE.test(line) || line.replaceAll('│', '').trim() === 'loading'
    )
}
