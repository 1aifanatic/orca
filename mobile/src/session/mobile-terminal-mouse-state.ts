import {
  parseTerminalMouseModes,
  type TerminalMouseModes
} from '../../../src/shared/terminal-mouse-modes'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

/** One subscription: a late snapshot must not undo a newer live mode change. */
export class MobileTerminalMouseState {
  modes: TerminalMouseModes | undefined

  receive(data: Record<string, unknown>, terminal: TerminalWebViewHandle | undefined): void {
    const incoming = parseTerminalMouseModes(data.mouseModes)
    const snapshot =
      data.type === 'scrollback' || (data.type === 'resized' && typeof data.serialized === 'string')
    if (snapshot && !incoming) {
      this.modes = undefined
    }
    if (incoming && (!this.modes || incoming.seq >= this.modes.seq)) {
      this.modes = incoming
    }
    if (data.type === 'metadata' && 'mouseModes' in data) {
      if (!incoming) {
        this.modes = undefined
      }
      terminal?.write('', this.modes ?? null)
    }
  }
}
