// Why both shapes: 0.150-0.157 paint `model: loading` in a box, 0.158 a bare `loading` under the title.
const CODEX_HEADER_LOADING_RE = /(?:model|directory):\s+loading|^\s*loading\s*$/m
// Why a line cap: 0.158 draws no box, so nothing else ends its header before the chat.
const CODEX_HEADER_LINES = 6
// Why the whole line: a pager, a `cat`ed transcript, or chat can quote the placeholder mid-line.
const CODEX_EMPTY_COMPOSER_RE = /^› ask codex to do anything\s*$/
// Why not "working": reasoning summaries replace it, and a remapped key still ends this way.
const CODEX_BUSY_STATUS_MARKER = 'to interrupt)'
// Why 2: the status row sits right above the composer, at most a one-line tip between (120x40 corpus).
const CODEX_STATUS_ROW_LINES = 2

// Why the header only: chat below it can mention "OpenAI Codex" or `model: loading`.
function findCodexHeader(screen: string): { index: number; text: string } | null {
  const index = screen.indexOf('openai codex')
  if (index === -1) {
    return null
  }
  const boxEnd = screen.indexOf('╰', index)
  const text = screen
    .slice(index, boxEnd === -1 ? undefined : boxEnd)
    .split('\n', CODEX_HEADER_LINES)
    .join('\n')
  return { index, text }
}

/** Tier 1: the 0.150-0.157 header, which only a grid reassembles (see isKnownReadyPromptBody). */
export function findCodexScreenReadyPromptIndex(screen: string): number | null {
  const header = findCodexHeader(screen)
  return header !== null &&
    header.text.includes('model:') &&
    header.text.includes('directory:') &&
    !CODEX_HEADER_LOADING_RE.test(header.text)
    ? header.index
    : null
}

/**
 * Tier 1b, codex panes only: the empty composer with no busy status row just above it and no
 * header load. Codex 0.158 dropped `model:`/`directory:`, and a long session scrolls the header
 * away, so this is its only version-stable rest body. No dialog check: every Codex dialog
 * replaces the composer, while an answer ending "Would you like to…?" must not block the lane.
 * The mid-turn guard is the caller's quiescence, fed by the ~100 ms title spinner and status
 * timer; `tui.animations=false` (set by a screen reader), `tui.effects.progress=false`, or a
 * `tui.terminal_title` without activity/spinner removes it.
 */
export function isCodexComposerReadyScreen(screen: string): boolean {
  const lines = screen.split('\n')
  const composer = lines.findLastIndex((line) => CODEX_EMPTY_COMPOSER_RE.test(line))
  if (composer === -1 || hasBusyStatusRowAbove(lines, composer)) {
    return false
  }
  const header = findCodexHeader(screen)
  return header === null || !CODEX_HEADER_LOADING_RE.test(header.text)
}

// Why only the rows above the composer: a finished answer can quote a status row verbatim.
function hasBusyStatusRowAbove(lines: readonly string[], composer: number): boolean {
  return lines
    .slice(0, composer)
    .filter((line) => line.trim() !== '')
    .slice(-CODEX_STATUS_ROW_LINES)
    .some((line) => line.includes(CODEX_BUSY_STATUS_MARKER))
}
