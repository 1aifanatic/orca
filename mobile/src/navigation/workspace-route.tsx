import type { ReactNode } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { firstParam } from './route-param-reader'
import { WorkspaceExecutionHostContext } from './workspace-execution-host'
import { useOptionalHostProtocolGates } from '../components/host-protocol-gates-context'
import { PageRouteUnavailableScreen } from '../mobile-web-shell/PageRouteUnavailableScreen'
import { useHostClient } from '../transport/client-context'
import { workspaceRouteExecutionHost } from '../transport/execution-host-scoped-rpc-client'

const UNREACHABLE_SERVER_MESSAGE =
  "Your phone can't reach this workspace's server through this desktop."

/**
 * A workspace route's server, read once from its `executionHost` param: every call made and every
 * route pushed below it stays on that server. Absent for the desktop's own workspaces; a server
 * this phone can't reach (older desktop or shell, unreadable status) gets one explicit dead end.
 */
export function WorkspaceRoute({ children }: { children: ReactNode }) {
  const params = useLocalSearchParams<{
    hostId?: string | string[]
    executionHost?: string | string[]
  }>()
  const hostId = firstParam(params.hostId)
  const executionHost = normalizeExecutionHostId(firstParam(params.executionHost)) ?? undefined
  const { client, state } = useHostClient(hostId)
  const gates = useOptionalHostProtocolGates()
  // Why: once the desktop has answered, a server it can't reach for this phone is a dead end, not a spinner.
  if (
    state === 'connected' &&
    gates &&
    !gates.statusPending &&
    workspaceRouteExecutionHost(client, gates.hostCapabilities, executionHost) === null
  ) {
    return <PageRouteUnavailableScreen hostId={hostId} message={UNREACHABLE_SERVER_MESSAGE} />
  }
  return (
    <WorkspaceExecutionHostContext.Provider value={executionHost}>
      {children}
    </WorkspaceExecutionHostContext.Provider>
  )
}

/** Wraps a workspace route's default export so everything under it knows the workspace's server. */
export function withWorkspaceRoute(Screen: () => ReactNode): () => ReactNode {
  return function WorkspaceRouteScreen() {
    return (
      <WorkspaceRoute>
        <Screen />
      </WorkspaceRoute>
    )
  }
}
