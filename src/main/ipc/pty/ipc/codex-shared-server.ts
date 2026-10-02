import { getPtyIpc } from '../../pty-host-bindings'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import {
  isCodexPaneOnOrcaMirrorHome,
  isPaneCodexOnSharedServer,
  resolveCodexPaneHome
} from '../../../codex/codex-shared-server-pane'
import {
  disableCodexSharedServerAutoStart,
  disableCodexSharedServerAutoStartOnOrcaMirror,
  stopCodexSharedServer
} from '../../../codex/codex-shared-server-fix'
import { getLegacyDaemonAdapters } from '../../../daemon/daemon-provider-routing'
import { supportsCodexNoDaemonShellLaunch } from '../../../daemon/daemon-protocol-version'
import type { CodexSharedServerStatus } from '../../../../shared/codex-shared-server-command'
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

function handleLocalPane<T>(
  deps: Deps,
  channel: string,
  run: (id: string, rootPid: number) => Promise<T>,
  refused: T
): void {
  getPtyIpc().handle(channel, async (_event, args: { id: string }): Promise<T> => {
    try {
      const rootPid = await findLocalPaneRootPid(deps, args?.id)
      return rootPid === null ? refused : await run(args.id, rootPid)
    } catch {
      return refused
    }
  })
}

async function readPaneSharedServerStatus(
  id: string,
  rootPid: number
): Promise<CodexSharedServerStatus> {
  if (!(await isPaneCodexOnSharedServer(id, rootPid))) {
    return { joined: false }
  }
  // Why: an older daemon's shell has no codex wrapper, so a new terminal is the whole fix.
  const openedBeforeWrapper = getLegacyDaemonAdapters(getProviderForPty(id)).some(
    (adapter) => adapter.hasPty(id) && !supportsCodexNoDaemonShellLaunch(adapter.protocolVersion)
  )
  return openedBeforeWrapper ? { joined: true, openedBeforeWrapper } : { joined: true }
}

/** Runs a fix command against the pane's own CODEX_HOME, never a guessed one. */
function runForPaneHome(fix: (codexHome: string) => Promise<boolean>) {
  return async (id: string): Promise<boolean> => {
    const codexHome = resolveCodexPaneHome(id)
    return codexHome ? await fix(codexHome) : false
  }
}

// Why: a real-home pane writes ~/.codex directly; only the mirror needs promotion around the write.
function disableForPane(id: string): Promise<boolean> {
  return runForPaneHome(
    isCodexPaneOnOrcaMirrorHome(id)
      ? disableCodexSharedServerAutoStartOnOrcaMirror
      : disableCodexSharedServerAutoStart
  )(id)
}

// Why its own read: only a pane already showing Codex asks, so no cadence poll pays for argv.
export function installPtyCodexSharedServerIpcHandler(deps: Deps): void {
  handleLocalPane(deps, 'pty:isCodexOnSharedServer', readPaneSharedServerStatus, { joined: false })
  handleLocalPane(deps, 'pty:disableCodexSharedServerAutoStart', disableForPane, false)
  handleLocalPane(deps, 'pty:stopCodexSharedServer', runForPaneHome(stopCodexSharedServer), false)
}
