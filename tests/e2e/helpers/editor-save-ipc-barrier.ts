import type { ElectronApplication } from '@stablyai/playwright-test'

type SaveBarrierTarget = {
  filePath: string
  relativePath: string
  runtimeEnvironmentId: string | null
}

type FileWriteHandler = (event: unknown, args: unknown) => unknown
type EditorSaveIpcBarrier = {
  held: boolean
  completed: boolean
  timedOut: boolean
  response: string
  original: FileWriteHandler
  channel: string
  release: () => void
  timeout: ReturnType<typeof setTimeout>
}

declare global {
  var __orcaEditorSaveIpcBarrier: EditorSaveIpcBarrier | undefined
}

export async function installEditorSaveIpcBarrier(
  app: ElectronApplication,
  target: SaveBarrierTarget
): Promise<void> {
  await app.evaluate(({ ipcMain }, target) => {
    if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
      throw new Error('Missing owned IPC registry')
    }
    const handlers = ipcMain._invokeHandlers
    const channel = target.runtimeEnvironmentId ? 'runtimeEnvironments:call' : 'fs:writeFile'
    const original: unknown = handlers.get(channel)
    function isFileWriteHandler(value: unknown): value is FileWriteHandler {
      return typeof value === 'function'
    }
    if (!isFileWriteHandler(original)) {
      throw new Error('Missing real file write handler')
    }
    if (globalThis.__orcaEditorSaveIpcBarrier) {
      throw new Error('Save barrier already installed')
    }
    let release: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const gate: EditorSaveIpcBarrier = {
      held: false,
      completed: false,
      timedOut: false,
      response: '',
      original,
      channel,
      release,
      timeout: setTimeout(() => {
        gate.timedOut = true
        release()
      }, 10_000)
    }
    globalThis.__orcaEditorSaveIpcBarrier = gate
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, args: unknown) => {
      const params = args && typeof args === 'object' && 'params' in args ? args.params : null
      const matches = target.runtimeEnvironmentId
        ? args &&
          typeof args === 'object' &&
          'selector' in args &&
          args.selector === target.runtimeEnvironmentId &&
          'method' in args &&
          args.method === 'files.write' &&
          params &&
          typeof params === 'object' &&
          'relativePath' in params &&
          params.relativePath === target.relativePath
        : args &&
          typeof args === 'object' &&
          'filePath' in args &&
          args.filePath === target.filePath
      if (gate.held || !matches) {
        return original(event, args)
      }
      gate.held = true
      await pending
      clearTimeout(gate.timeout)
      const response = await original(event, args)
      gate.response = JSON.stringify(response) ?? 'undefined'
      gate.completed = true
      return response
    })
  }, target)
}

export async function readEditorSaveIpcBarrier(app: ElectronApplication) {
  return app.evaluate(() => {
    const gate = globalThis.__orcaEditorSaveIpcBarrier
    if (!gate) {
      throw new Error('Save barrier missing')
    }
    return {
      held: Boolean(gate.held),
      completed: Boolean(gate.completed),
      timedOut: gate.timedOut,
      response: String(gate.response)
    }
  })
}

export async function releaseEditorSaveIpcBarrier(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const gate = globalThis.__orcaEditorSaveIpcBarrier
    if (!gate || typeof gate.release !== 'function') {
      throw new Error('Save barrier missing')
    }
    gate.release()
  })
}

export async function restoreEditorSaveIpcBarrier(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const gate = globalThis.__orcaEditorSaveIpcBarrier
    if (!gate) {
      return
    }
    clearTimeout(gate.timeout)
    gate.release()
    ipcMain.removeHandler(gate.channel)
    ipcMain.handle(gate.channel, gate.original)
    globalThis.__orcaEditorSaveIpcBarrier = undefined
  })
}
