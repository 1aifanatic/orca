import { defineMethod } from '../../core'
import { normalizeColorQueryReplyColors } from '../../../../../shared/pty-owner-color-query-colors'
import { setTerminalViewerColors } from '../../../terminal-view-attribute-store'
import { TerminalSetViewerColors } from './unary-schemas'

export const TERMINAL_VIEWER_COLORS_METHODS = [
  defineMethod({
    name: 'terminal.setViewerColors',
    params: TerminalSetViewerColors,
    // Why: a paired client paints the host's panes with its own theme, so while it is the viewer
    // acting last, every PTY owner on this host answers OSC 10/11 with its colours.
    handler: async (params) => {
      const colors = normalizeColorQueryReplyColors(params.colors)
      if (colors) {
        setTerminalViewerColors(colors)
      }
      return { applied: colors !== null }
    }
  })
]
