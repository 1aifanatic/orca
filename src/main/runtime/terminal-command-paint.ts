import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { normalizeTerminalChunk } from './terminal-ansi-normalization'

/**
 * Where the running command's own output begins. Orca's shell integration prints OSC 133;C
 * after the prompt and the echoed command line, right before the command runs, so only
 * visible output after it can be the command's. Absent when no marker was ever seen.
 */
export type TerminalCommandPaintRecord = {
  commandStartedAt?: number | null
  /** First visible output since `commandStartedAt`; null while the command has painted nothing. */
  commandPaintedAt?: number | null
}

const COMMAND_START_MARKER = '\x1b]133;C'
// eslint-disable-next-line no-control-regex -- control bytes are exactly what is not visible.
const VISIBLE_CHARACTER_RE = /[^\s\u0000-\u001f\u007f-\u009f]/

function hasVisibleText(normalizedText: string): boolean {
  return VISIBLE_CHARACTER_RE.test(stripAnsiEscapeSequences(normalizedText))
}

/** Index just past the chunk's last command-start marker, or -1 when it has none. */
function commandStartMarkerEnd(data: string): number {
  // Why includes first: this runs on every chunk, and lastIndexOf is several times slower.
  if (!data.includes(COMMAND_START_MARKER)) {
    return -1
  }
  const start = data.lastIndexOf(COMMAND_START_MARKER)
  const bel = data.indexOf('\x07', start)
  const st = data.indexOf('\x1b\\', start)
  if (bel !== -1 && (st === -1 || bel < st)) {
    return bel + 1
  }
  return st === -1 ? data.length : st + 2
}

/** `normalizedText` is the chunk as the tail buffer received it (pending escapes resolved). */
export function observeTerminalCommandPaint(
  record: TerminalCommandPaintRecord,
  data: string,
  normalizedText: string,
  at: number
): void {
  const markerEnd = commandStartMarkerEnd(data)
  if (markerEnd !== -1) {
    record.commandStartedAt = at
    // Why the rest of this chunk counts: a fast binary can paint in the same read as the marker.
    record.commandPaintedAt = hasVisibleText(normalizeTerminalChunk(data.slice(markerEnd)).text)
      ? at
      : null
    return
  }
  if (
    record.commandStartedAt != null &&
    record.commandPaintedAt == null &&
    hasVisibleText(normalizedText)
  ) {
    record.commandPaintedAt = at
  }
}

/** Why no marker reads as painted: some launches get no command boundary (cmd.exe, a bash
 *  startup command run from PROMPT_COMMAND), so any output is all the evidence there is. */
export function hasTerminalCommandPainted(record: TerminalCommandPaintRecord): boolean {
  return record.commandStartedAt == null || record.commandPaintedAt != null
}
