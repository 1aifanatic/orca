import { getPtyIpc } from '../../pty-host-bindings'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import {
  isPaneCodexOnSharedServer,
  resolveCodexPaneHome,
  resolveCodexPaneSettingsHome
} from '../../../codex/codex-shared-server-pane'
import {
  disableCodexSharedServerAutoStart,
  stopCodexSharedServer
} from '../../../codex/codex-shared-server-fix'
import { ptyOwnership } from '../provider/ownership-state'
import { getProviderForPty, hasPtyProviderForInspection } from '../provider/registry'

type Deps = { getLocalPtyProviderStartupPromise: () => Promise<void> | undefined }

/** The pane's root pid when it is a local, non-WSL pane; otherwise null. */
async function findLocalPaneRootPid(deps: Deps, id: unknown): Promise<number | null> {
  // Why local only: SSH and WSL panes run Codex on another host, which must answer for itself.
  if (
    typeof id !== 'string' ||
    id.startsWith('remote:') ||
    parseAppSshPtyId(id) ||
    (ptyOwnership.get(id) ?? null) !== null
  ) {
    return null
  }
  // Why: the pre-swap provider does not own restored daemon ids.
  await deps.getLocalPtyProviderStartupPromise()
  if (!hasPtyProviderForInspection(id)) {
    return null
  }
  const session = (await getProviderForPty(id).listProcesses()).find(
    (candidate) => candidate.id === id
  )
  return session?.rootProcessId !== undefined && !session.wslDistro ? session.rootProcessId : null
}

function handleLocalPane(
  deps: Deps,
  channel: string,
  run: (id: string, rootPid: number) => Promise<boolean>
): void {
  getPtyIpc().handle(channel, async (_event, args: { id: string }): Promise<boolean> => {
    try {
      const rootPid = await findLocalPaneRootPid(deps, args?.id)
      return rootPid === null ? false : await run(args.id, rootPid)
    } catch {
      return false
    }
  })
}

/** Runs a fix step against the pane's own CODEX_HOME, never a guessed one. */
async function disableForPane(id: string): Promise<boolean> {
  const paneHome = resolveCodexPaneHome(id)
  const settingsHome = resolveCodexPaneSettingsHome(id)
  return paneHome && settingsHome
    ? await disableCodexSharedServerAutoStart(paneHome, settingsHome)
    : false
}

async function stopForPane(id: string): Promise<boolean> {
  const paneHome = resolveCodexPaneHome(id)
  return paneHome ? await stopCodexSharedServer(paneHome) : false
}

// Why its own read: only a pane already showing Codex asks, so no cadence poll pays for argv.
export function installPtyCodexSharedServerIpcHandler(deps: Deps): void {
  handleLocalPane(deps, 'pty:isCodexOnSharedServer', isPaneCodexOnSharedServer)
  handleLocalPane(deps, 'pty:disableCodexSharedServerAutoStart', disableForPane)
  handleLocalPane(deps, 'pty:stopCodexSharedServer', stopForPane)
}
