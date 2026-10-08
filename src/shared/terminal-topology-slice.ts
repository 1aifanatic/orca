import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { ExecutionHostId } from './execution-host'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'

/** Topology and creation-time tab fields; presentation fields stay with the presenter. */
export type TerminalTopologyTabRow = Pick<
  TerminalTab,
  | 'id'
  | 'ptyId'
  | 'worktreeId'
  | 'launchAgent'
  | 'createdAt'
  | 'defaultTitle'
  | 'shellOverride'
  | 'startupCwd'
  | 'forceHostRuntime'
  | 'quickCommandLabel'
>

/** The presentation main last saved for a tab; a window shows it on a tab it has not shown yet. */
export type TerminalTabSavedPresentation = Pick<TerminalTab, 'customTitle' | 'color'>

export type TerminalTopologyLayout = Pick<
  TerminalLayoutSnapshot,
  'root' | 'ptyIdsByLeafId' | 'titlesByLeafId'
>

/** One worktree's persisted terminal topology as main holds it, keyed by owning host partition. */
export type TerminalTopologySlice = {
  hostId: ExecutionHostId
  worktreeId: string
  /** Monotonic across every slice main publishes; a reader keeps the highest per worktree. */
  publishSeq: number
  revision: number
  tabs: TerminalTopologyTabRow[]
  presentation: Record<string, TerminalTabSavedPresentation>
  layouts: Record<string, TerminalTopologyLayout>
  sleeping: Record<string, SleepingAgentSessionRecord>
}

/** On a reply whose write main publishes: the publishSeq of the push holding it. */
export type TerminalTopologyReply = { publishSeq?: number }

/** A window's own sleeping-agent record changes: records it now holds, and pane keys it dropped. */
export type TerminalSleepingRecordChanges = {
  sleep: Record<string, SleepingAgentSessionRecord>
  wake: string[]
}
