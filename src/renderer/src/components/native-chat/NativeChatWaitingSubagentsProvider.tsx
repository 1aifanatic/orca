import type { StructuredSessionBackgroundTasksView } from './structured-session-background-tasks-view'
import {
  NativeChatWaitingSubagentsContext,
  useNativeChatWaitingSubagents
} from './native-chat-waiting-subagents'

/** Hands the transcript's subagent rows the waits the session's strip shows. */
export function NativeChatWaitingSubagentsProvider(props: {
  paneKey: string
  /** The session's background-task view, which the strip reads too. */
  tasks: StructuredSessionBackgroundTasksView
  children: React.ReactNode
}): React.JSX.Element {
  const waiting = useNativeChatWaitingSubagents(props.paneKey, props.tasks)
  return (
    <NativeChatWaitingSubagentsContext.Provider value={waiting}>
      {props.children}
    </NativeChatWaitingSubagentsContext.Provider>
  )
}
