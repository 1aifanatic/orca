import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'

export function indexTerminalTabExecutionHosts(
  tabs: readonly Tab[]
): ReadonlyMap<string, ExecutionHostId> {
  return new Map(
    tabs.flatMap((tab) =>
      tab.contentType === 'terminal' && tab.executionHostId
        ? [[tab.entityId, tab.executionHostId] as const, [tab.id, tab.executionHostId] as const]
        : []
    )
  )
}
