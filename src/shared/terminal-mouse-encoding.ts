/** Mouse report encoding armed by DECSET 1006 (SGR) or 1016 (SGR pixels); independent of the tracking protocol. */
export type TerminalMouseEncoding = 'default' | 'sgr' | 'sgr-pixels'

/**
 * Reads the encoding xterm itself parsed. Its public `modes` exposes the
 * tracking protocol but not the encoding, and SerializeAddon omits it, so a
 * restored pane otherwise emits legacy `ESC [ M` reports that a ConPTY host
 * types into the app as text (#23818).
 */
export function readTerminalMouseEncoding(terminal: object): TerminalMouseEncoding {
  const core = '_core' in terminal ? terminal._core : undefined
  const service =
    typeof core === 'object' && core !== null && 'mouseStateService' in core
      ? core.mouseStateService
      : undefined
  const encoding =
    typeof service === 'object' && service !== null && 'activeEncoding' in service
      ? service.activeEncoding
      : undefined
  if (encoding === 'SGR') {
    return 'sgr'
  }
  if (encoding === 'SGR_PIXELS') {
    return 'sgr-pixels'
  }
  return 'default'
}

export function buildMouseEncodingRestoreSequence(encoding: TerminalMouseEncoding): string {
  switch (encoding) {
    case 'sgr':
      return '\x1b[?1006h'
    case 'sgr-pixels':
      return '\x1b[?1016h'
    case 'default':
      return ''
  }
}
