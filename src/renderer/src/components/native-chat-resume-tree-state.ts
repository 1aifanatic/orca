import { createContext, useState } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  ResumeCandidate,
  ResumeFailure,
  ResumeWorkspaceGroup
} from './native-chat-resume-on-restart-grouping'
import {
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'

// The resume tree's shared state: which nodes are open, how deep a chat row sits, and how a chat
// is read by its key.

/**
 * Which nodes are open. Everything starts expanded unless `defaultExpanded` says otherwise; what the
 * user opens or closes then wins, also over a default that changes as answers arrive. The state is
 * this mount's own, so a dialog that unmounts its tree on close reopens it from the defaults. Never
 * persisted.
 */
export function useResumeTreeExpansion(defaultExpanded?: (key: string) => boolean): {
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
} {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  return {
    isExpanded: (key) => chosen.get(key) ?? defaultExpanded?.(key) ?? true,
    setExpanded: (key, expanded) => setChosen((current) => new Map(current).set(key, expanded))
  }
}

/** The tree depth a chat row renders at; the enclosing workspace node provides it. */
export const ResumeTreeDepthContext = createContext(0)

/** Lets a row that an earlier resume could not carry on show what went wrong and what to do. */
export type FailureProps = {
  failureFor?: (sessionId: string) => ResumeFailure | undefined
  onFailureAction?: (action: ResumeFailureAction, sessionId: string) => void
}

/** What a caller listing several machines adds: chats are keyed by `rowKey` (two machines may
 *  hold the same session id), so `selected`, `onToggle`, `failureFor`, `onFailureAction` and
 *  `originLabelFor` all take that key; each machine can be busy on its own, start open or closed,
 *  and carry a line beside its name. */
export type MachineProps = {
  /** A chat's key in every lookup; the session id when absent. */
  rowKey?: (candidate: ResumeCandidate) => string
  /** One machine mid-resume locks only its own nodes. */
  busyFor?: (hostId: ExecutionHostId) => boolean
  /** Where a chat that does not start ticked came from ("Automation", "Another device"). */
  originLabelFor?: (key: string) => string | undefined
  /** Whether a node starts open; the user's own opening and closing then wins. */
  defaultExpanded?: (nodeKey: string) => boolean
  /** A line beside a machine's name, e.g. why it stopped and when. */
  machineSubtitle?: (hostId: ExecutionHostId) => string | undefined
}

/** What every node needs from the tree as a whole. */
export type TreeProps = {
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
  repoIdOf: (group: ResumeWorkspaceGroup) => string | null
  ancestorsOf: (group: ResumeWorkspaceGroup) => readonly string[]
} & FailureProps &
  Pick<MachineProps, 'rowKey' | 'busyFor' | 'originLabelFor'>

/** Whether a node on this host is locked: the whole tree, or this machine, is mid-resume. */
export function treeBusy(tree: TreeProps, hostId: ExecutionHostId): boolean {
  return tree.busy || tree.busyFor?.(hostId) === true
}

/**
 * The one place a chat's key is read: its row's tick, toggle and failure, and every group's
 * coverage all go through here, so a change of key stays in this function.
 */
export function chatState(candidate: ResumeCandidate, tree: TreeProps) {
  const key = tree.rowKey?.(candidate) ?? candidate.sessionId
  const failure = tree.failureFor?.(key)
  return {
    key,
    checked: tree.selected.has(key),
    onCheckedChange: (checked: boolean) => tree.onToggle(key, checked),
    failure,
    // The row's own actions and where it came from, named by the same key.
    onFailureAction:
      tree.onFailureAction &&
      ((action: ResumeFailureAction) => tree.onFailureAction?.(action, key)),
    originLabel: tree.originLabelFor?.(key),
    // A group checkbox never ticks a failure a retry cannot fix.
    selectable: !failure || resumeFailureSelectable(failure)
  }
}

/** The keys a group checkbox covers: every selectable chat under it. */
export function coveredKeys(candidates: readonly ResumeCandidate[], tree: TreeProps): string[] {
  return candidates
    .map((candidate) => chatState(candidate, tree))
    .filter((chat) => chat.selectable)
    .map((chat) => chat.key)
}
