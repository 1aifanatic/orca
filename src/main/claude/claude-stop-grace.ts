// A Stop ends Claude's child. Before it does, Claude gets a short grace to abort the turn through
// its own path: that turn's result frame is what moves the resume point past it, and a first turn
// killed before Claude saved it leaves a resume id for a conversation that does not exist.

import type { ClaudeSession } from './claude-structured-session-state'

export const CLAUDE_STOP_GRACE_MS = 3_000

type ClaudeStopGrace = { ended: Promise<void>; end: () => void }

const graces = new WeakMap<ClaudeSession, ClaudeStopGrace>()

/** Armed before the interrupt goes out, so a result that beats the interrupt's answer counts.
 *  Returns the disarm for an interrupt Claude did not take: that turn will not end by itself. */
export function armClaudeStopGrace(session: ClaudeSession): () => void {
  let grace = graces.get(session)
  if (!grace) {
    let end!: () => void
    const ended = new Promise<void>((resolve) => {
      end = resolve
    })
    grace = { ended, end }
    graces.set(session, grace)
  }
  return () => settleClaudeStopGrace(session)
}

/** The turn ended: its result, the CLI's idle, or the child's exit. */
export function settleClaudeStopGrace(session: ClaudeSession): void {
  const grace = graces.get(session)
  graces.delete(session)
  grace?.end()
}

/** What a Stop's close waits on before it ends the child; nothing armed returns at once. */
export async function awaitClaudeStopGrace(
  session: ClaudeSession,
  ms = CLAUDE_STOP_GRACE_MS
): Promise<void> {
  const grace = graces.get(session)
  if (!grace) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      grace.ended,
      new Promise<void>((elapse) => {
        timer = setTimeout(elapse, ms)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
    settleClaudeStopGrace(session)
  }
}
