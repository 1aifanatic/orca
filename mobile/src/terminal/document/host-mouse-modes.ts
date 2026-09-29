import { parseTerminalMouseModes } from '../../../../src/shared/terminal-mouse-modes'
import type { TerminalDocumentScope } from './document-scope'

export function applyHostMouseModes(scope: TerminalDocumentScope, value: unknown) {
  const modes = parseTerminalMouseModes(value)
  if (!modes) {
    scope.hostMouseModes = undefined
    scope.mouseEncodingKnown = false
    scope.mouseModeScanTail = ''
    return
  }
  if (scope.hostMouseModes && scope.hostMouseModes.seq > modes.seq) {
    return
  }
  scope.hostMouseModes = modes
  scope.mouseEncodingKnown = true
  scope.sgrMouseMode = modes.sgrMouseMode
  scope.sgrMousePixelsMode = modes.sgrMousePixelsMode
}
