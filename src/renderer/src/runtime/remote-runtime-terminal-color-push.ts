import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { TerminalOscColorQueryReplyColors } from '../../../shared/terminal-osc-color-reply'
import { colorQueryReplyColorsEqual } from '../../../shared/pty-owner-color-query-colors'
import { callRuntimeRpc, RuntimeRpcCallError } from './runtime-rpc-client'

type PushCall = (
  environmentId: string,
  colors: TerminalOscColorQueryReplyColors
) => Promise<unknown>

type ConnectedHost = { runtimeId: string; unsupported: boolean }

export type RemoteRuntimeTerminalColorPush = {
  observeStatusSnapshot: (snapshot: RuntimeHostStatusSnapshot) => void
  setColors: (colors: TerminalOscColorQueryReplyColors) => void
  /** This window gained focus: its viewer is acting again on every host it is connected to. */
  pushToAllHosts: () => void
}

function connectedRuntimeId(snapshot: RuntimeHostStatusSnapshot): string | null {
  const live =
    snapshot.verification === 'verified' && snapshot.transport === 'ready' && !snapshot.retired
  return live ? (snapshot.status?.runtimeId ?? null) : null
}

// Why: a host that predates the method, or a scope that refuses it, will not start accepting it
// on this connection; stop asking until the host reconnects.
function isPermanentRefusal(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    (error.code === 'method_not_found' || error.code === 'forbidden')
  )
}

/**
 * Each paired host answers its panes' OSC 10/11 with the theme of whichever viewer acted last,
 * so this client tells every host it is connected to its colours on connect, change and focus.
 */
export function createRemoteRuntimeTerminalColorPush(
  call: PushCall
): RemoteRuntimeTerminalColorPush {
  const hosts = new Map<string, ConnectedHost>()
  let colors: TerminalOscColorQueryReplyColors | null = null

  const push = (environmentId: string): void => {
    const host = hosts.get(environmentId)
    if (!colors || !host || host.unsupported) {
      return
    }
    // Best-effort: a failed push leaves the host answering with the last viewer's colours.
    call(environmentId, colors).catch((error: unknown) => {
      if (isPermanentRefusal(error) && hosts.get(environmentId) === host) {
        host.unsupported = true
      }
    })
  }

  const pushToAllHosts = (): void => {
    for (const environmentId of hosts.keys()) {
      push(environmentId)
    }
  }

  return {
    observeStatusSnapshot: (snapshot) => {
      const runtimeId = connectedRuntimeId(snapshot)
      if (!runtimeId) {
        hosts.delete(snapshot.environmentId)
        return
      }
      if (hosts.get(snapshot.environmentId)?.runtimeId === runtimeId) {
        return
      }
      hosts.set(snapshot.environmentId, { runtimeId, unsupported: false })
      push(snapshot.environmentId)
    },
    setColors: (next) => {
      if (colorQueryReplyColorsEqual(colors, next)) {
        return
      }
      colors = next
      pushToAllHosts()
    },
    pushToAllHosts
  }
}

// Why one instance: status snapshots arrive through the app-lifetime IPC bridge, while the
// colours and window focus come from the app shell.
export const remoteRuntimeTerminalColorPush = createRemoteRuntimeTerminalColorPush(
  (environmentId, colors) =>
    callRuntimeRpc({ kind: 'environment', environmentId }, 'terminal.setViewerColors', { colors })
)
