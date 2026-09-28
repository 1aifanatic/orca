import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'
import { setRendererPublishBarrier } from './pty/delivery/renderer-publish-barrier'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// The blocking hook POST used to apply an agent's event before the agent could print or exit.
// With committed hooks, main drains through this barrier before the renderer sees either.
describe('renderer publish barrier', () => {
  const { mainWindow, installObservableDaemonTestProvider } = setupPtyIpcSuite()

  it("runs before a pane's output and its exit reach the renderer", () => {
    vi.useFakeTimers()
    const wire: string[] = []
    setRendererPublishBarrier(() => wire.push('barrier'))
    try {
      const provider = installObservableDaemonTestProvider()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's mock window implements every BrowserWindow member the PTY handlers call.
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data' || channel === 'pty:exit') {
          wire.push(channel)
        }
      })

      provider.emitData('barrier-pty', '\x1b]133;D;0\x07$ ')
      vi.advanceTimersByTime(20)
      provider.emitExit('barrier-pty', 0)
      vi.advanceTimersByTime(20)

      expect(wire).toContain('pty:data')
      expect(wire).toContain('pty:exit')
      for (const [index, entry] of wire.entries()) {
        if (entry !== 'barrier') {
          expect(wire[index - 1]).toBe('barrier')
        }
      }
    } finally {
      setRendererPublishBarrier(null)
      vi.useRealTimers()
    }
  })
})
