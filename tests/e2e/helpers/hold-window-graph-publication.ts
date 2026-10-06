import type { ElectronApplication } from '@stablyai/playwright-test'
import type { IpcMainInvokeEvent } from 'electron'

const GRAPH_CHANNEL = 'runtime:syncWindowGraph'

/**
 * Holds a relaunched desktop host's renderer graph publication so a paired client deterministically
 * meets the host in the window between its RPC server accepting calls and its first published tab
 * graph. Install via `session.launch({ beforeFirstWindow })`.
 */
export async function holdWindowGraphPublication(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    Reflect.set(globalThis, '__e2eGraphHeld', true)
    Reflect.set(globalThis, '__e2eGraphPublished', 0)
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    const wrap =
      (handler: Handler): Handler =>
      async (event, ...args) => {
        while (Reflect.get(globalThis, '__e2eGraphHeld') === true) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const result = await handler(event, ...args)
        const published: unknown = Reflect.get(globalThis, '__e2eGraphPublished')
        Reflect.set(
          globalThis,
          '__e2eGraphPublished',
          (typeof published === 'number' ? published : 0) + 1
        )
        return result
      }
    // Electron keeps invoke handlers in a private map; patch both an existing and a later registration.
    const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers')
    const existing = handlers instanceof Map ? handlers.get(channel) : undefined
    if (handlers instanceof Map && typeof existing === 'function') {
      handlers.set(channel, wrap(existing))
    }
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (name, listener) => handle(name, name === channel ? wrap(listener) : listener)
  }, GRAPH_CHANNEL)
}

/**
 * Releases the hold and returns how many graph publications completed before release. Zero proves
 * every client call so far met a host that had published nothing.
 */
export async function releaseWindowGraphPublication(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => {
    Reflect.set(globalThis, '__e2eGraphHeld', false)
    const published: unknown = Reflect.get(globalThis, '__e2eGraphPublished')
    return typeof published === 'number' ? published : 0
  })
}
