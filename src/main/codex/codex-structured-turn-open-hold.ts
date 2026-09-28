// A send's handover waits for the turn Codex answered it into to open, or provably not to: it
// ended, the thread stopped running, or the child is gone. Held in memory only.

import { readCodexProviderVerdict } from './codex-structured-journal-provider-verdicts'
import { readCodexThreadId, readCodexTurnId } from './codex-structured-thread-facts'

export type CodexTurnOpenHolds = {
  /** Resolves once `turnId` opens or can no longer, and by `deadlineAt` (epoch ms) at the latest. */
  hold: (turnId: string, deadlineAt: number) => Promise<void>
  /** Releases the holds a notification on the session's own thread answers. */
  observe: (threadId: string, method: string, params: unknown) => void
  /** Releases every hold: the child that would open their turns is gone. */
  releaseAll: () => void
}

export function createCodexTurnOpenHolds(): CodexTurnOpenHolds {
  const holds = new Map<() => void, string>()
  const release = (turnId?: string): void => {
    for (const [releaseHold, heldTurnId] of holds) {
      if (turnId === undefined || heldTurnId === turnId) {
        releaseHold()
      }
    }
  }
  return {
    hold: (turnId, deadlineAt) =>
      new Promise<void>((resolve) => {
        const releaseHold = (): void => {
          clearTimeout(deadline)
          holds.delete(releaseHold)
          resolve()
        }
        const deadline = setTimeout(releaseHold, Math.max(0, deadlineAt - Date.now()))
        holds.set(releaseHold, turnId)
      }),
    observe: (threadId, method, params) => {
      if ((readCodexThreadId(params) ?? threadId) !== threadId) {
        return
      }
      if (readCodexProviderVerdict(method, params) === 'thread-stopped-running') {
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
