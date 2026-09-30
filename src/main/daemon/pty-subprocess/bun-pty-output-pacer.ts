/**
 * Bun drains a PTY until EAGAIN in one loop turn (hundreds of KiB), and each chunk is parsed
 * synchronously downstream, so client input waits behind it. Deliver bounded slices per turn instead.
 */
export type PtyOutputPacer = {
  push(data: string): void
  /** Delivers everything queued, in order, before exit or teardown. */
  flush(): void
}

export type PtyOutputPacerOptions = {
  sliceChars?: number
  turnBudgetMs?: number
  /** Past this backlog the pacer stops deferring, so memory stays bounded. */
  maxPendingChars?: number
  now?: () => number
  schedule?: (callback: () => void) => void
}

const DEFAULT_SLICE_CHARS = 16 * 1024
const DEFAULT_TURN_BUDGET_MS = 4
const DEFAULT_MAX_PENDING_CHARS = 4 * 1024 * 1024

function sliceEnd(data: string, start: number, sliceChars: number): number {
  const end = Math.min(data.length, start + sliceChars)
  if (end < data.length) {
    const code = data.charCodeAt(end - 1)
    // Never split a surrogate pair across deliveries.
    if (code >= 0xd800 && code <= 0xdbff && end - 1 > start) {
      return end - 1
    }
  }
  return end
}

export function createPtyOutputPacer(
  deliver: (data: string) => void,
  options: PtyOutputPacerOptions = {}
): PtyOutputPacer {
  const sliceChars = options.sliceChars ?? DEFAULT_SLICE_CHARS
  const turnBudgetMs = options.turnBudgetMs ?? DEFAULT_TURN_BUDGET_MS
  const maxPendingChars = options.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? ((callback) => void setImmediate(callback))
  const queue: string[] = []
  let queuedChars = 0
  let turnStartedAt: number | null = null
  let turnResetScheduled = false
  let drainScheduled = false

  const startTurn = (): void => {
    if (turnStartedAt !== null) {
      return
    }
    turnStartedAt = now()
    if (!turnResetScheduled) {
      turnResetScheduled = true
      // setImmediate runs after the poll phase, i.e. after Bun's read loop yields.
      schedule(() => {
        turnResetScheduled = false
        turnStartedAt = null
      })
    }
  }

  const deliverWithinBudget = (): void => {
    startTurn()
    while (queue.length > 0) {
      const head = queue[0]!
      const end = sliceEnd(head, 0, sliceChars)
      const slice = head.slice(0, end)
      if (end === head.length) {
        queue.shift()
      } else {
        queue[0] = head.slice(end)
      }
      queuedChars -= slice.length
      deliver(slice)
      if (queue.length > 0 && now() - (turnStartedAt ?? now()) >= turnBudgetMs) {
        scheduleDrain()
        return
      }
    }
  }

  const scheduleDrain = (): void => {
    if (drainScheduled) {
      return
    }
    drainScheduled = true
    schedule(() => {
      drainScheduled = false
      deliverWithinBudget()
    })
  }

  return {
    push(data) {
      if (!data) {
        return
      }
      queue.push(data)
      queuedChars += data.length
      if (queuedChars > maxPendingChars) {
        this.flush()
        return
      }
      if (drainScheduled) {
        return
      }
      deliverWithinBudget()
    },
    flush() {
      while (queue.length > 0) {
        const head = queue.shift()!
        queuedChars -= head.length
        for (let start = 0; start < head.length;) {
          const end = sliceEnd(head, start, sliceChars)
          deliver(head.slice(start, end))
          start = end
        }
      }
    }
  }
}
