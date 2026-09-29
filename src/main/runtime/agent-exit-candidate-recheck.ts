import { FOREGROUND_CONFIRM_RETRY_DELAYS_MS } from '../../shared/foreground-agent-verdict'

/** The process whose neutral title raised the candidate, so a same-id replacement never answers it. */
export type AgentExitCandidateOwner = {
  incarnationId: string | null
  lifecycleGeneration: number
  titleObservedAt: number | null
}

type Candidate = { owner: AgentExitCandidateOwner; timer: ReturnType<typeof setTimeout> | null }

export type AgentExitRecheck = AgentExitCandidateOwner & { attempt: number }

/** The ladder is spent: the candidate waits for the host to be reached again. */
export const SPENT_AGENT_EXIT_RECHECK = FOREGROUND_CONFIRM_RETRY_DELAYS_MS.length
/** A reconnect's single re-read, which never re-arms. */
const FINAL_AGENT_EXIT_RECHECK = SPENT_AGENT_EXIT_RECHECK + 1

/**
 * An agent exit candidate (its own neutral title) whose confirming read could not answer.
 * Re-read on the shared bounded ladder, then keep it only until the host is reached again once.
 */
export class AgentExitCandidateRechecks {
  private readonly byPtyId = new Map<string, Candidate>()

  constructor(private readonly recheck: (ptyId: string, recheck: AgentExitRecheck) => void) {}

  /** False when the ladder is spent; the candidate then waits for one reconnect re-read. */
  scheduleNext(ptyId: string, owner: AgentExitCandidateOwner, attempt: number): boolean {
    this.clear(ptyId)
    const delay = FOREGROUND_CONFIRM_RETRY_DELAYS_MS[attempt]
    if (attempt >= FINAL_AGENT_EXIT_RECHECK) {
      return false
    }
    const candidate: Candidate = { owner, timer: null }
    this.byPtyId.set(ptyId, candidate)
    if (delay === undefined) {
      return false
    }
    candidate.timer = setTimeout(() => {
      candidate.timer = null
      if (this.byPtyId.get(ptyId) === candidate) {
        this.byPtyId.delete(ptyId)
        this.recheck(ptyId, { ...owner, attempt: attempt + 1 })
      }
    }, delay)
    candidate.timer.unref?.()
    return true
  }

  /** The host answered for this PTY again: re-read a candidate the ladder left undecided, once. */
  recheckAfterContact(ptyId: string): void {
    const candidate = this.byPtyId.get(ptyId)
    if (!candidate || candidate.timer !== null) {
      return
    }
    this.byPtyId.delete(ptyId)
    this.recheck(ptyId, { ...candidate.owner, attempt: FINAL_AGENT_EXIT_RECHECK })
  }

  clear(ptyId: string): void {
    const candidate = this.byPtyId.get(ptyId)
    if (candidate?.timer) {
      clearTimeout(candidate.timer)
    }
    this.byPtyId.delete(ptyId)
  }
}
