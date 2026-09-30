// A Stop ends Claude's child. Before it does, the stopped turn gets what is left of the grace to end
// through Claude's own path: Claude writes the interrupted turn to its transcript, and that turn's
// result moves the resume point past it.

import type { ClaudeSession } from './claude-structured-session-state'

/** One budget from the Stop's interrupt: for Claude to answer it and for the stopped turn to end. */
export const CLAUDE_STOP_GRACE_MS = 3_000

const waiters = new WeakMap<ClaudeSession, Set<() => void>>()

/** Resolves at once when `turnId` is not Claude's open turn, else at that turn's end or after `ms`. */
export async function awaitClaudeTurnEnd(
  session: ClaudeSession,
  turnId: string,
  ms: number
): Promise<void> {
  if (session.translator?.currentTurnId !== turnId) {
    return
  }
  let waiting = waiters.get(session)
  if (!waiting) {
    waiting = new Set()
    waiters.set(session, waiting)
  }
  let wake!: () => void
  const ended = new Promise<void>((resolve) => {
    wake = resolve
  })
  waiting.add(wake)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ended,
      new Promise<void>((elapse) => {
        timer = setTimeout(elapse, ms)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
    waiting.delete(wake)
  }
}

/** The adapter's wait: whatever of the grace the Stop's interrupt left, counted from `stoppedAt`. */
export function claudeStoppedTurnEndWait(
  sessions: Map<string, ClaudeSession>
): (sessionId: string, turnId: string, stoppedAt: number) => Promise<void> {
  return async (sessionId, turnId, stoppedAt) => {
    const session = sessions.get(sessionId)
    if (session) {
      await awaitClaudeTurnEnd(
        session,
        turnId,
        Math.max(0, stoppedAt + CLAUDE_STOP_GRACE_MS - Date.now())
      )
    }
  }
}

/** Claude's open turn ended: its result, the CLI's idle, the child's exit or its close. */
export function settleClaudeTurnEndWaiters(session: ClaudeSession): void {
  const waiting = waiters.get(session)
  waiters.delete(session)
  for (const wake of waiting ?? []) {
    wake()
  }
}
