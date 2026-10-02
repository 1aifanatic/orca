// A Stop's or a send's wait for the turn Codex answered a send into to open, or provably not
// to: it ended, the thread stopped running, or the child is gone. Held in memory only.

import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import {
  codexThreadStoppedRunning,
  readCodexThreadId,
  readCodexTurnId
} from './codex-structured-thread-facts'

/** How long a Stop or a send waits for Codex to open the turn it answered a send into. A close or
 *  quit queued behind either spends this out of the eviction budget, so a full wait plus a slow
 *  provider close can overrun it; the next launch's recovery then settles the lease. */
export const CODEX_TURN_OPEN_WAIT_MS = 5_000

export type CodexTurnOpenWaits = {
  /** Resolves once `turnId` opens or can no longer (true), or after `withinMs` (false). */
  wait: (turnId: string, withinMs: number) => Promise<boolean>
  /** Ends the waits a notification on the session's own thread answers. */
  observe: (threadId: string, method: string, params: unknown) => void
  /** Ends every wait: the child that would open their turns is gone. */
  releaseAll: () => void
}

export function createCodexTurnOpenWaits(): CodexTurnOpenWaits {
  const waits = new Map<(answered: boolean) => void, string>()
  const release = (turnId?: string): void => {
    for (const [endWait, waitedTurnId] of waits) {
      if (turnId === undefined || waitedTurnId === turnId) {
        endWait(true)
      }
    }
  }
  return {
    wait: (turnId, withinMs) =>
      new Promise<boolean>((resolve) => {
        const endWait = (answered: boolean): void => {
          clearTimeout(bound)
          waits.delete(endWait)
          resolve(answered)
        }
        const bound = setTimeout(() => endWait(false), withinMs)
        // A Stop's wait must never be what keeps the process alive at quit.
        bound.unref?.()
        waits.set(endWait, turnId)
      }),
    observe: (threadId, method, params) => {
      if ((readCodexThreadId(params) ?? threadId) !== threadId) {
        return
      }
      if (method === 'thread/status/changed' && codexThreadStoppedRunning(params)) {
        release()
        return
      }
      const turnId = readCodexTurnId(params)
      if (turnId && (method === 'turn/started' || method === 'turn/completed')) {
        release(turnId)
      }
    },
    releaseAll: () => release()
  }
}

/** What a Stop or a send finds to act on: a turn running, or one Codex answered a send into that
 *  has not opened in time and may still open; null when neither. */
export type CodexStopTarget = { turnId: string } | { opening: string } | null

/**
 * The turn a Stop or a send names: the latest Codex reported started and not ended, or else the
 * one Codex answered a send into, once it opens. `opening` when the wait runs out first, or an
 * earlier wait already gave up on it with its send still owed. Null when none is running and that
 * one ends, the thread stops running or the child exits first; each such turn is waited for once.
 */
export async function codexStopTarget(session: {
  threadId: string
  activeTurnIds?: ReadonlySet<string>
  dispatchEchoes: Pick<
    CodexDispatchEchoes,
    'answeredUnopenedTurn' | 'leftUnopened' | 'answeredTurnLeftUnopened'
  >
  turnOpenWaits: Pick<CodexTurnOpenWaits, 'wait'>
}): Promise<CodexStopTarget> {
  const running = [...(session.activeTurnIds ?? [])].at(-1)
  if (running) {
    return { turnId: running }
  }
  const answered = session.dispatchEchoes.answeredUnopenedTurn(
    session.threadId,
    session.activeTurnIds ?? new Set<string>()
  )
  if (!answered) {
    // An earlier wait gave up on it, yet its send is still owed: it may still open.
    const left = session.dispatchEchoes.answeredTurnLeftUnopened(
      session.threadId,
      session.activeTurnIds ?? new Set<string>()
    )
    return left ? { opening: left } : null
  }
  // Codex refuses an interrupt, and before 0.148 a steer, until it opens the turn.
  const settled = await session.turnOpenWaits.wait(answered, CODEX_TURN_OPEN_WAIT_MS)
  if (session.activeTurnIds?.has(answered)) {
    return { turnId: answered }
  }
  // Before 0.148 a turn that fails before it starts reports no end; one that opens later is still
  // found running.
  session.dispatchEchoes.leftUnopened(session.threadId, answered)
  return settled ? null : { opening: answered }
}

/** `codexStopTarget`'s running or opened turn, for a send. */
export async function codexRunningOrOpeningTurn(
  session: Parameters<typeof codexStopTarget>[0]
): Promise<string | null> {
  const target = await codexStopTarget(session)
  return target !== null && 'turnId' in target ? target.turnId : null
}
