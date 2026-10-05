/** Detach one pane into a new tab; the leaf id and its terminal move with it. */
export type TerminalLeafMoveRequest = {
  worktreeId: string
  sourceTabId: string
  targetTabId: string
  leafId: string
  ptyId: string | null
  /** Put back a committed move the renderer could not apply: the leaf returns to sourceTabId. */
  undo?: true
}

export type TerminalLeafMoveResult =
  /** Main moved the leaf and every pane-keyed record in one durable write. */
  | { status: 'moved'; ptyId: string | null }
  /** Main's session never held the leaf, so there is nothing to move there. */
  | { status: 'not_held' }
  /** Undo only: the source tab closed meanwhile, so main dropped the tab the move created. */
  | { status: 'retired' }
  | {
      status: 'refused'
      reason:
        | 'invalid_request'
        | 'target_tab_exists'
        | 'pty_mismatch'
        | 'leaf_in_other_tab'
        /** Undo only: the moved tab gained another pane, so it is no longer the move's to undo. */
        | 'target_changed'
    }

export function isTerminalLeafMoveRequest(value: unknown): value is TerminalLeafMoveRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate: Record<string, unknown> = { ...value }
  const isId = (field: unknown): field is string =>
    typeof field === 'string' && field.length > 0 && field.length <= 512
  return (
    isId(candidate.worktreeId) &&
    isId(candidate.sourceTabId) &&
    isId(candidate.targetTabId) &&
    isId(candidate.leafId) &&
    (candidate.ptyId === null || isId(candidate.ptyId)) &&
    (candidate.undo === undefined || candidate.undo === true)
  )
}
