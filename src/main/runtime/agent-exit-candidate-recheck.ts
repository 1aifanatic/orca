import { FOREGROUND_CONFIRM_RETRY_DELAYS_MS } from '../../shared/foreground-agent-verdict'

type Candidate = {
  incarnationId: string | null
  titleObservedAt: number | null
  timer: ReturnType<typeof setTimeout> | null
}

export type AgentExitRecheck = { attempt: number; titleObservedAt: number | null }

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
  scheduleNext(
    ptyId: string,
    incarnationId: string | null,
    titleObservedAt: number | null,
    attempt: number
  ): boolean {
    this.clear(ptyId)
    const delay = FOREGROUND_CONFIRM_RETRY_DELAYS_MS[attempt]
    if (attempt >= FINAL_AGENT_EXIT_RECHECK) {
      return false
    }
    const candidate: Candidate = { incarnationId, titleObservedAt, timer: null }
    this.byPtyId.set(ptyId, candidate)
    if (delay === undefined) {
      return false
    }
    candidate.timer = setTimeout(() => {
      candidate.timer = null
      if (this.byPtyId.get(ptyId) === candidate) {
        this.byPtyId.delete(ptyId)
        this.recheck(ptyId, { attempt: attempt + 1, titleObservedAt })
      }
    }, delay)
    candidate.timer.unref?.()
    return true
  }

  /** The host answered for this PTY again: re-read a candidate the ladder left undecided, once. */
  recheckAfterContact(ptyId: string, incarnationId: string | null): void {
    const candidate = this.byPtyId.get(ptyId)
    if (!candidate || candidate.timer !== null) {
      return
    }
    this.byPtyId.delete(ptyId)
    if (candidate.incarnationId === incarnationId) {
      this.recheck(ptyId, {
        attempt: FINAL_AGENT_EXIT_RECHECK,
        titleObservedAt: candidate.titleObservedAt
      })
    }
  }

  clear(ptyId: string): void {
    const candidate = this.byPtyId.get(ptyId)
    if (candidate?.timer) {
      clearTimeout(candidate.timer)
    }
    this.byPtyId.delete(ptyId)
  }
}
