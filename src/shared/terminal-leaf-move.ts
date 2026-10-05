import { makePaneKey, type PaneKey } from './stable-pane-id'

/** Detach one pane into a new tab; the leaf id and its terminal move with it. */
export type TerminalLeafMoveRequest = {
  worktreeId: string
  sourceTabId: string
  targetTabId: string
  leafId: string
  /** The PTY the renderer's pane is attached to now, when it has one. */
  ptyId: string | null
}

export type TerminalLeafMoveResult =
  /** Main holds the leaf in the target tab, with every pane-keyed record (also on a repeat). */
  | { status: 'moved'; ptyId: string | null }
  /** Main's session never held the leaf, so there is nothing to move there. */
  | { status: 'not_held' }
  | {
      status: 'refused'
      reason: 'invalid_request' | 'target_tab_exists' | 'pty_mismatch' | 'leaf_in_other_tab'
    }

/** The moved pane's key before and after; only valid requests reach here. */
export function terminalLeafMovePaneKeys(request: TerminalLeafMoveRequest): {
  from: PaneKey
  to: PaneKey
} {
  return {
    from: makePaneKey(request.sourceTabId, request.leafId),
    to: makePaneKey(request.targetTabId, request.leafId)
  }
}

/** The one validation of a move request: shape, distinct tabs, and ids a pane key can carry. */
export function isTerminalLeafMoveRequest(value: unknown): value is TerminalLeafMoveRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate: Record<string, unknown> = { ...value }
  const isId = (field: unknown): field is string =>
    typeof field === 'string' && field.length > 0 && field.length <= 512
  if (
    !isId(candidate.worktreeId) ||
    !isId(candidate.sourceTabId) ||
    !isId(candidate.targetTabId) ||
    !isId(candidate.leafId) ||
    !(candidate.ptyId === null || isId(candidate.ptyId)) ||
    candidate.sourceTabId === candidate.targetTabId
  ) {
    return false
  }
  try {
    terminalLeafMovePaneKeys({
      worktreeId: candidate.worktreeId,
      sourceTabId: candidate.sourceTabId,
      targetTabId: candidate.targetTabId,
      leafId: candidate.leafId,
      ptyId: candidate.ptyId
    })
    return true
  } catch {
    return false
  }
}
