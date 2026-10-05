import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    const startupPromise = getLocalPtyStartupPromise(args.connectionId)
    if (startupPromise) {
      await startupPromise
    }
    const result = await runPtyIpcSpawn(deps, args)
    // Optional call: injected runtimes without topology publishing keep today's reply.
    const publishSeq = deps.runtime?.settleTerminalTopology?.(args.worktreeId)
    return publishSeq === undefined ? result : { ...result, publishSeq }
  })
}
