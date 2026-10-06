// Whether a structured chat offers Stop, and what Stop does, from what this view knows of the chat.

export function structuredAgentSessionStopControl<T>(input: {
  /** The host has published this chat to this view. */
  published: boolean
  /** The host takes a Stop naming no turn (and this view holds its fence). */
  stopsConversation: boolean
  turnId: string | null
  isWorking: boolean
  /** This client still holds a send the host has not taken. */
  holdsUnsent: boolean
  withdrawUnsent: () => void
  cancel: (params: { turnId?: string }) => Promise<T | null>
}): { canStop: boolean; stop: () => Promise<T | null> } {
  const { published, stopsConversation, turnId } = input
  return {
    // Before the host publishes this chat to this view, nothing sent has reached it: a Stop takes
    // back what this client holds, so a start that never answers cannot hold the message hostage.
    canStop:
      turnId !== null ||
      (!published && input.holdsUnsent) ||
      (stopsConversation && (input.isWorking || input.holdsUnsent)),
    stop: () => {
      if (!published) {
        input.withdrawUnsent()
        return Promise.resolve(null)
      }
      if (stopsConversation) {
        // Unsent text this client still owns goes back to its composer — a local move.
        // Host-held drafts are never withdrawn by a Stop: the host pauses them and
        // they stay visible as cards, on every device, until the user acts on one.
        input.withdrawUnsent()
        return input.cancel({})
      }
      return turnId ? input.cancel({ turnId }) : Promise.resolve(null)
    }
  }
}
