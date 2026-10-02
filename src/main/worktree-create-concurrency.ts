// In-memory count of worktree creates running in this process, so a slow create can be read
// against how many others competed with it for the disk.

type InFlightCreate = { peakOthers: number }

const inFlight = new Set<InFlightCreate>()

export type WorktreeCreateInFlightHandle = {
  /** Ends this create's membership; returns the most other creates seen running alongside it. */
  end(): number
}

export function beginWorktreeCreate(): WorktreeCreateInFlightHandle {
  const entry: InFlightCreate = { peakOthers: inFlight.size }
  for (const other of inFlight) {
    other.peakOthers = Math.max(other.peakOthers, inFlight.size)
  }
  inFlight.add(entry)
  let ended = false
  return {
    end() {
      if (!ended) {
        ended = true
        inFlight.delete(entry)
      }
      return entry.peakOthers
    }
  }
}

export async function withWorktreeCreateInFlight<T>(operation: () => Promise<T>): Promise<T> {
  const handle = beginWorktreeCreate()
  try {
    return await operation()
  } finally {
    handle.end()
  }
}

export function _resetWorktreeCreateConcurrencyForTests(): void {
  inFlight.clear()
}
