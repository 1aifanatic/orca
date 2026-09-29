import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'

// Orca's default dark terminal theme ('Ghostty Default Style Dark'), used until a viewer reports one.
export const ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS = {
  foreground: '#ffffff',
  background: '#282c34'
} as const satisfies TerminalOscColorQueryReplyColors

function answersBothSlots(
  colors: TerminalOscColorQueryReplyColors | null | undefined
): colors is TerminalOscColorQueryReplyColors {
  return !!colors && terminalOscColorQueryReplies(colors, [10, 11]) !== null
}

/** Wire payloads are untrusted; only a pair that can answer both OSC 10 and 11 is kept. */
export function normalizeColorQueryReplyColors(
  value: unknown
): TerminalOscColorQueryReplyColors | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const foreground = 'foreground' in value ? value.foreground : undefined
  const background = 'background' in value ? value.background : undefined
  if (typeof foreground !== 'string' || typeof background !== 'string') {
    return null
  }
  const colors = { foreground, background }
  return answersBothSlots(colors) ? colors : null
}

// Why process-wide: each process that owns PTYs (main, the daemon, a relay) serves one host,
// so all its panes answer from one viewer theme, pushed to it by the app that shows them.
let hostColors: TerminalOscColorQueryReplyColors | null = null

/** A malformed push keeps the previous colours rather than blanking them. */
export function setPtyOwnerHostColors(value: unknown): void {
  hostColors = normalizeColorQueryReplyColors(value) ?? hostColors
}

export function getPtyOwnerHostColors(): TerminalOscColorQueryReplyColors | null {
  return hostColors
}

export function _resetPtyOwnerHostColorsForTest(): void {
  hostColors = null
}

/**
 * The PTY owner always answers. The host-wide viewer theme wins over the colours the
 * creating viewer sent at spawn, so every pane on a host agrees and a theme change reaches
 * old panes; Orca's default theme answers when no viewer has reported anything yet.
 */
export function resolvePtyOwnerColorQueryColors(
  host: TerminalOscColorQueryReplyColors | null | undefined,
  spawn: TerminalOscColorQueryReplyColors | null | undefined
): TerminalOscColorQueryReplyColors {
  if (answersBothSlots(host)) {
    return host
  }
  if (answersBothSlots(spawn)) {
    return spawn
  }
  return ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS
}
