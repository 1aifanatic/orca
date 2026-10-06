// Whether a structured chat offers Stop, and what Stop does, from what this view knows of the chat.

export function structuredAgentSessionStopControl(input: {
  /** The host has published this chat to this view. */
  published: boolean
  /** The Stop the host is asked for once it has published this chat. */
  host: {
    /** The host takes a Stop naming no turn (and this view holds its fence). */
    stopsConversation: boolean
    stop: (turnId: string | null, withdrawUnsent: () => void) => Promise<unknown>
  }
  transportState: { turnId: string | null; isWorking: boolean }
  /** This client still holds a send the host has not taken. */
  holdsUnsent: boolean
  withdrawUnsent: () => void
}): { canStop: boolean; stop: () => Promise<unknown> } {
  const { published, host, holdsUnsent, withdrawUnsent } = input
  const { turnId, isWorking } = input.transportState
  return {
    // Before the host publishes this chat to this view, nothing sent has reached it: a Stop takes
    // back what this client holds, so a start that never answers cannot hold the message hostage.
    canStop:
      turnId !== null ||
      (!published && holdsUnsent) ||
      (host.stopsConversation && (isWorking || holdsUnsent)),
    stop: () => {
      if (!published) {
        withdrawUnsent()
        return Promise.resolve(null)
      }
      return host.stop(turnId, withdrawUnsent)
    }
  }
}
