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
