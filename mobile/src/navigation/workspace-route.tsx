import type { ReactNode } from 'react'
import { useLocalSearchParams } from 'expo-router'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { firstParam } from './route-param-reader'
import { WorkspaceExecutionHostContext } from './workspace-execution-host'

/**
 * A workspace route's server, read once from its `executionHost` param: every call made and every
 * route pushed below it stays on that server. Absent for the desktop's own workspaces.
 */
export function WorkspaceRoute({ children }: { children: ReactNode }) {
  const params = useLocalSearchParams<{ executionHost?: string | string[] }>()
  const executionHost = normalizeExecutionHostId(firstParam(params.executionHost)) ?? undefined
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
