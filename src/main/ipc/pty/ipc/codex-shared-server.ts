import { getPtyIpc } from '../../pty-host-bindings'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { isPaneCodexOnSharedServer } from '../../../codex/codex-shared-server-pane'
import { ptyOwnership } from '../provider/ownership-state'
import { getProviderForPty, hasPtyProviderForInspection } from '../provider/registry'

// Why its own read: only a pane already showing Codex asks, so no cadence poll pays for argv.
export function installPtyCodexSharedServerIpcHandler(deps: {
  getLocalPtyProviderStartupPromise: () => Promise<void> | undefined
}): void {
  getPtyIpc().handle(
    'pty:isCodexOnSharedServer',
    async (_event, args: { id: string }): Promise<boolean> => {
      // Why local only: SSH and WSL panes run Codex on another host, which must answer for itself.
      if (
        typeof args?.id !== 'string' ||
        args.id.startsWith('remote:') ||
        parseAppSshPtyId(args.id) ||
        (ptyOwnership.get(args.id) ?? null) !== null
      ) {
        return false
      }
      // Why: the pre-swap provider does not own restored daemon ids.
      await deps.getLocalPtyProviderStartupPromise()
      if (!hasPtyProviderForInspection(args.id)) {
        return false
      }
      try {
        const session = (await getProviderForPty(args.id).listProcesses()).find(
          (candidate) => candidate.id === args.id
        )
        return session?.rootProcessId !== undefined && !session.wslDistro
          ? await isPaneCodexOnSharedServer(args.id, session.rootProcessId)
          : false
      } catch {
        return false
      }
    }
  )
}
