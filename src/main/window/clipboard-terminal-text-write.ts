import { app, clipboard } from 'electron'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../shared/clipboard-text'
import { isLinuxWaylandSession } from '../../shared/linux-wayland-session'
import { writeClipboardTextAndVerify } from './clipboard-text-write-verify'

const WAYLAND_CLIPBOARD_WRITE_FAILED_ERROR = 'Wayland clipboard write failed'
const MAX_PENDING_CLIPBOARD_WRITES = 32

type TerminalClipboardWriterDeps = {
  isWayland: () => boolean
  helperPath: () => string
  run: typeof runProcess
  clearCache: () => void
  write: (text: string) => void
  validate: (text: string) => Promise<string>
}

export function createTerminalClipboardWriter(
  deps: TerminalClipboardWriterDeps
): (text: string) => Promise<void> {
  let pending = Promise.resolve()
  let count = 0
  let dataControlUnavailable = false
  return (text) => {
    if (count >= MAX_PENDING_CLIPBOARD_WRITES) {
      return Promise.reject(new Error('Too many pending clipboard writes'))
    }
    count += 1
    // Validate inside the queue: large copies yield and must not overwrite a later request.
    const next = pending
      .then(async () => {
        const safeText = await deps.validate(text)
        if (!deps.isWayland() || dataControlUnavailable) {
          deps.write(safeText)
          return
        }
        const result = await deps.run({
          program: deps.helperPath(),
          input: safeText,
          timeoutMs: 2000,
          stdio: ['pipe', 'ignore', 'ignore']
        })
        if (result.code === 78 && !result.timedOut) {
          // Preserve the existing backend on desktops that never exposed data-control.
          dataControlUnavailable = true
          deps.write(safeText)
          return
        }
        if (result.code !== 0 || result.timedOut) {
          throw new Error(WAYLAND_CLIPBOARD_WRITE_FAILED_ERROR)
        }
        // Discard any rejected Chromium source after the helper has established the actual owner.
        deps.clearCache()
      })
      .finally(() => {
        count -= 1
      })
    pending = next.catch(() => undefined)
    return next
  }
}

export const writeTerminalClipboardText = createTerminalClipboardWriter({
  isWayland: () =>
    isLinuxWaylandSession({
      platform: process.platform,
      env: process.env,
      ozonePlatform:
        process.platform === 'linux' ? app.commandLine.getSwitchValue('ozone-platform') : ''
    }),
  helperPath: () =>
    app.isPackaged
      ? join(process.resourcesPath, 'bin', 'orca-wayland-clipboard')
      : join(
          app.getAppPath(),
          'native',
          'wayland-clipboard',
          '.build',
          process.arch,
          'orca-wayland-clipboard'
        ),
  run: runProcess,
  clearCache: () => clipboard.clear(),
  write: writeClipboardTextAndVerify,
  validate: assertClipboardTextWriteWithinLimitWithYield
})
