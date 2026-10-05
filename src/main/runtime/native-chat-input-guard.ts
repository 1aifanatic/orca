// Why bounded: action ids are client-chosen; a PTY only needs the recent ones to fence delayed steps.
const MAX_TRACKED_ACTIONS_PER_PTY = 64

type PtyChatInputState = {
  /** Set when the host proved this incarnation's agent exited; new actions are refused. */
  exitedIncarnationId: string | null | undefined
  started: Set<string>
  /** Actions a proven exit interrupted or refused; never admitted again on this PTY. */
  cancelled: Set<string>
}

export type NativeChatInputVerdict = 'admitted' | 'agent-exited'

function remember(set: Set<string>, actionId: string): void {
  set.delete(actionId)
  set.add(actionId)
  while (set.size > MAX_TRACKED_ACTIONS_PER_PTY) {
    const oldest = set.values().next().value
    if (oldest === undefined) {
      return
    }
    set.delete(oldest)
  }
}

/**
 * Host-side fence for chat composer writes. A proven agent exit refuses later chat actions on that
 * PTY incarnation and permanently cancels every action already started there; later agent evidence
 * re-admits only NEW actions. Raw terminal input never passes through here (narrow guard).
 */
export class NativeChatInputGuard {
  private readonly byPtyId = new Map<string, PtyChatInputState>()

  private stateFor(ptyId: string): PtyChatInputState {
    let state = this.byPtyId.get(ptyId)
    if (!state) {
      state = { exitedIncarnationId: undefined, started: new Set(), cancelled: new Set() }
      this.byPtyId.set(ptyId, state)
    }
    return state
  }

  /** Before an action's first write: refuses (and cancels it) once the agent is proven gone. */
  admit(ptyId: string, incarnationId: string | null, actionId: string): NativeChatInputVerdict {
    const state = this.stateFor(ptyId)
    if (state.cancelled.has(actionId)) {
      return 'agent-exited'
    }
    if (this.isExited(ptyId, incarnationId)) {
      remember(state.cancelled, actionId)
      return 'agent-exited'
    }
    remember(state.started, actionId)
    return 'admitted'
  }

  /** Before every later write of an admitted action (next chunk, delayed Enter, next step). */
  recheck(ptyId: string, incarnationId: string | null, actionId: string): NativeChatInputVerdict {
    return this.admit(ptyId, incarnationId, actionId)
  }

  confirmExit(ptyId: string, incarnationId: string | null): void {
    const state = this.stateFor(ptyId)
    state.exitedIncarnationId = incarnationId
    for (const actionId of state.started) {
      remember(state.cancelled, actionId)
    }
    state.started.clear()
  }

  /** New agent evidence on the PTY: new actions may write again; cancelled ones stay cancelled. */
  clearExit(ptyId: string): void {
    const state = this.byPtyId.get(ptyId)
    if (state) {
      state.exitedIncarnationId = undefined
    }
  }

  isExited(ptyId: string, incarnationId: string | null): boolean {
    const exited = this.byPtyId.get(ptyId)?.exitedIncarnationId
    return exited !== undefined && exited === incarnationId
  }

  /** The PTY itself exited or was replaced; its ids can never be addressed again. */
  forget(ptyId: string): void {
    this.byPtyId.delete(ptyId)
  }
}
