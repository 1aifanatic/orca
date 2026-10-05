import { AcpRequestTimeoutError } from './acp-errors'
import type { PromptResponse } from './generated/acp-protocol.generated'

export type ActivePrompt = {
  response: Promise<PromptResponse>
  cancelling: boolean
  cancelPromise?: Promise<void>
}

/** Sends `session/cancel` and waits, bounded, for Orca's prompt to settle; past the bound it closes. */
export async function confirmAcpPromptCancel(
  active: ActivePrompt,
  connection: {
    send: () => Promise<void>
    close: (error: Error) => void
    closed: () => boolean
    timeoutMs: number
  }
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unconfirmed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new AcpRequestTimeoutError('session/cancel')
      connection.close(error)
      reject(error)
    }, connection.timeoutMs)
  })
  try {
    await Promise.race([connection.send(), unconfirmed]).catch((error) => {
      // Only a cancel that reached the agent is shared; a failed write is retried next call.
      active.cancelPromise = undefined
      active.cancelling = false
      throw error
    })
    await Promise.race([
      active.response.catch((error) => {
        if (connection.closed()) {
          throw error
        }
      }),
      unconfirmed
    ])
  } finally {
    clearTimeout(timer)
  }
}
