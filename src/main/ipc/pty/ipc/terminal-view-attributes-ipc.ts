import { getPtyIpc } from '../../pty-host-bindings'
import {
  getTerminalViewColorQueryReplyColors,
  setTerminalViewAttributes
} from '../../../runtime/terminal-view-attribute-store'
import { validateTerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { publishColorQueryReplyColors } from '../provider/registry'

export function installTerminalViewAttributesIpc(): void {
  const ipcMain = getPtyIpc()
  ipcMain.removeAllListeners('pty:terminalViewAttributes')
  ipcMain.on('pty:terminalViewAttributes', (_event, args: unknown) => {
    // Why validate-or-drop: a malformed palette gives a wrong color reply that breaks TUI theme detection worse than the silent-until-first-push default.
    const attributes = validateTerminalViewAttributes(args)
    if (!attributes) {
      return
    }
    setTerminalViewAttributes(attributes)
    // Why: every PTY owner answers OSC 10/11 itself, so the renderer's theme must reach each one.
    const colors = getTerminalViewColorQueryReplyColors()
    if (colors) {
      publishColorQueryReplyColors(colors)
    }
  })
}
