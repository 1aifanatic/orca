import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  ResumeCandidate,
  ResumeFailure,
  ResumeWorkspaceGroup,
  ResumeWorkspaceNode
} from './native-chat-resume-on-restart-grouping'
import {
  resumeFailureSelectable,
  type ResumeFailureAction
} from './native-chat-resume-failure-guidance'

// What the resume tree's nodes share, and what a caller listing several machines adds to it.

/** Lets a row that an earlier resume could not carry on show what went wrong and what to do. */
export type FailureProps = {
  failureFor?: (sessionId: string) => ResumeFailure | undefined
  onFailureAction?: (action: ResumeFailureAction, sessionId: string) => void
}

/** What a caller listing several machines adds: chats are keyed by `rowKey` (two machines may
 *  hold the same session id), so `selected`, `onToggle`, `failureFor`, `onFailureAction` and
 *  `originLabelFor` all take that key; each machine can be busy on its own, start open or closed,
 *  and carry a line under its name. */
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
  /** The whole tree mid-resume, or one machine's part of it. */
  busyFor: (hostId: ExecutionHostId) => boolean
  selected: ReadonlySet<string>
  onToggle: (key: string, checked: boolean) => void
  /** A chat's key in every lookup below. */
  keyOf: (candidate: ResumeCandidate) => string
  /** Whether a group checkbox may tick this chat; a failure a retry cannot fix is left out. */
  selectable: (key: string) => boolean
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
  repoIdOf: (group: ResumeWorkspaceGroup) => string | null
  ancestorsOf: (group: ResumeWorkspaceGroup) => readonly string[]
  originLabelFor?: (key: string) => string | undefined
} & FailureProps

/** Every chat key under a workspace node, its nested workspaces included. */
export function workspaceKeys(node: ResumeWorkspaceNode, tree: TreeProps): string[] {
  return [
    ...node.group.candidates.map(tree.keyOf),
    ...node.children.flatMap((child) => workspaceKeys(child, tree))
  ]
}

/** Whether a group checkbox may tick a chat: a failure a retry cannot fix is left out. */
export function selectableUnder(failureFor: FailureProps['failureFor']): (key: string) => boolean {
  return (key) => {
    const failure = failureFor?.(key)
    return !failure || resumeFailureSelectable(failure)
  }
}
