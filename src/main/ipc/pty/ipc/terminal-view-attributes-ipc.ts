import { getPtyIpc } from '../../pty-host-bindings'
import {
  getTerminalViewColorQueryReplyColors,
  setTerminalViewAttributes
} from '../../../runtime/terminal-view-attribute-store'
import { validateTerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import { resolveConfiguredTerminalColors } from '../../../../shared/terminal-theme-selection'
import { publishColorQueryReplyColors } from '../provider/registry'
import type { PtyIpcSession } from '../session'

export function installTerminalViewAttributesIpc(
  session: Pick<PtyIpcSession, 'getSettings' | 'options'>
): void {
  const settings = session.getSettings?.()
  // Why seed from settings: a headless host never gets a renderer push, and a desktop pane can
  // query before the first one lands; either way the owner should answer with the saved theme.
  if (settings && !getTerminalViewColorQueryReplyColors()) {
    publishColorQueryReplyColors(
      resolveConfiguredTerminalColors(settings, session.options?.systemPrefersDark?.() ?? true)
    )
  }
  const ipcMain = getPtyIpc()
  ipcMain.removeAllListeners('pty:terminalViewAttributes')
  ipcMain.on('pty:terminalViewAttributes', (_event, args: unknown) => {
    // Why validate-or-drop: a malformed palette would give TUIs a wrong color reply.
    const attributes = validateTerminalViewAttributes(args)
    if (!attributes) {
      return
    }
    setTerminalViewAttributes(attributes)
    // Why: the renderer's composed theme is more exact than the settings seed, so it replaces it.
    const colors = getTerminalViewColorQueryReplyColors()
    if (colors) {
      publishColorQueryReplyColors(colors)
    }
  })
}
