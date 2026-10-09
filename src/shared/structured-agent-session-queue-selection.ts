/** The oldest actionable card: individual holds are skipped; returned cards and queue pauses block. */
export function nextActionableQueuedMessage<T extends { state: string }>(
  cards: readonly T[],
  individuallyHeld: (card: T) => boolean,
  paused: (card: T) => boolean
): T | null {
  for (const card of cards) {
    if (card.state === 'returned') {
      return null
    }
    if (card.state !== 'waiting' || individuallyHeld(card)) {
      continue
    }
    if (paused(card)) {
      return null
    }
    return card
  }
  return null
}

/** A /clear next in line that only background tasks hold, read from the agent's own work (not the
 *  queue's coming send, which the host still names): the host runs it once they end. */
export function queuedClearWaitsOnBackgroundTasks<
  T extends { body: { command?: { name: string } } }
>(
  card: T,
  next: T | null,
  live: { agentWorking?: boolean; backgroundTasksRunning?: boolean }
): boolean {
  return (
    card === next &&
    live.backgroundTasksRunning === true &&
    live.agentWorking !== true &&
    card.body.command?.name === 'clear'
  )
}
