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
    const gate = globalThis as { __e2eGraphHeld?: boolean; __e2eGraphPublished?: number }
    gate.__e2eGraphHeld = true
    gate.__e2eGraphPublished = 0
    type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    const wrap =
      (handler: Handler): Handler =>
      async (event, ...args) => {
        while (gate.__e2eGraphHeld) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const result = await handler(event, ...args)
        gate.__e2eGraphPublished = (gate.__e2eGraphPublished ?? 0) + 1
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
    const gate = globalThis as { __e2eGraphHeld?: boolean; __e2eGraphPublished?: number }
    gate.__e2eGraphHeld = false
    return gate.__e2eGraphPublished ?? 0
  })
}
