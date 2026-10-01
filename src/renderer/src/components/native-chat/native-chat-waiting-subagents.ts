// Which of a structured session's subagents are waiting on the user, as the composer strip reads it:
// the host's child records through the strip's own row model. The transcript's subagent rows take
// their state from the journal, which records no wait, so they read this to say waiting with it.

import { createContext, useContext, useMemo } from 'react'
import type { AgentChildRowModel } from '../../../../shared/agent-child-row-model'
import { agentChildRunStateFor } from '../../../../shared/agent-status-child-work-display'
import { normalizeSubagentState } from '../../../../shared/native-chat-subagent-summary'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentState
} from '../../../../shared/native-chat-types'
import { buildBackgroundTaskGroupsFromViews } from './background-task-roster'
import type { StructuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import { useStructuredSessionChildRowContext } from './use-structured-session-child-row-context'

/** A subagent's state as the transcript shows it: the journal's, or waiting while the host says so. */
export type NativeChatSubagentDisplayState = NativeChatSubagentState | 'waiting'

const NO_WAITING: ReadonlySet<string> = new Set()

/** Provider ids of the subagents the session's strip shows waiting; empty outside one. */
export const NativeChatWaitingSubagentsContext = createContext<ReadonlySet<string>>(NO_WAITING)

function collectWaiting(rows: readonly AgentChildRowModel[], into: Set<string>): void {
  for (const row of rows) {
    if (row.providerId && agentChildRunStateFor(row.displayState) === 'waiting') {
      into.add(row.providerId)
    }
    collectWaiting(row.owned, into)
  }
}

/** The subagents the strip shows waiting, by the provider id the journal names each one by. */
export function useNativeChatWaitingSubagents(
  paneKey: string,
  backgroundTasks: StructuredSessionBackgroundTasksView
): ReadonlySet<string> {
  const childRowContext = useStructuredSessionChildRowContext(paneKey)
  const children = backgroundTasks.children
  return useMemo(() => {
    if (!children) {
      return NO_WAITING
    }
    const waiting = new Set<string>()
    for (const group of buildBackgroundTaskGroupsFromViews(children, childRowContext)) {
      collectWaiting(
        group.tasks.map((task) => task.row),
        waiting
      )
    }
    return waiting.size > 0 ? waiting : NO_WAITING
  }, [children, childRowContext])
}

/** A journal entry's state, read waiting while the host's record of that child is waiting. Only a
 *  running entry can be: a settled one has its own verdict. */
export function nativeChatSubagentDisplayState(
  entry: Pick<NativeChatSubagentEntry, 'id' | 'state'>,
  waiting: ReadonlySet<string>
): NativeChatSubagentDisplayState {
  const state = normalizeSubagentState(entry.state)
  return state === 'working' && waiting.has(entry.id) ? 'waiting' : state
}

export function useNativeChatWaitingSubagentSet(): ReadonlySet<string> {
  return useContext(NativeChatWaitingSubagentsContext)
}
