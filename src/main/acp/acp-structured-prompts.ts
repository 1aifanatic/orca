// The agent's open requests to the user (permission, question, plan approval), each held as the
// JSON-RPC call it is until a person answers it, a Stop cancels it, or the agent withdraws it.
// An answer claims the request, commits the journal compare-and-set while the claim is held, and
// only then replies, so a second client loses the commit and the agent hears exactly one answer.

import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import {
  AgentSessionPromptAnswerRejectedError,
  AgentSessionPromptUnavailableError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpRequestPresentation } from './acp-dialects/acp-dialect'
import { AcpRpcError } from './acp-errors'
import type { AcpRequestContext } from './acp-json-rpc-peer'
import type { AcpStructuredLane } from './acp-structured-lane'

type OpenRequest = {
  key: string
  presentation: AcpRequestPresentation
  claimed: boolean
  settle: (reply: unknown) => void
}

export class AcpStructuredPrompts {
  private readonly open = new Map<string, OpenRequest>()

  constructor(private readonly lane: () => AcpStructuredLane | null) {}

  get size(): number {
    return this.open.size
  }

  /** Answers one agent request: a row the user can act on, or the translator's verdict on it. */
  handle(method: string, params: unknown, context: AcpRequestContext): Promise<unknown> {
    const lane = this.lane()
    if (!lane || context.id === null) {
      throw new AcpRpcError(-32603, 'ACP request arrived with no session to show it')
    }
    const translated = lane.translator.request(method, params, context.id)
    lane.apply(translated.events)
    const opened = translated.events.find((event) => event.type === 'request.open')
    if (!translated.presentation || opened?.type !== 'request.open') {
      throw new AcpRpcError(-32601, `Unsupported ACP client method: ${method}`)
    }
    const key = opened.request
    const presentation = translated.presentation
    return new Promise((resolve) => {
      const entry: OpenRequest = {
        key,
        presentation,
        claimed: false,
        settle: (reply) => {
          if (this.open.get(key) === entry) {
            this.open.delete(key)
          }
          resolve(reply)
        }
      }
      this.open.set(key, entry)
      // The agent or a Stop gave up on it: its card can no longer be answered.
      context.signal.addEventListener(
        'abort',
        () => {
          if (this.open.get(key) === entry && !entry.claimed) {
            this.open.delete(key)
            this.lane()?.apply([{ type: 'request.withdrawn', request: key }])
          }
        },
        { once: true }
      )
    })
  }

  async answer(input: {
    itemId: string
    response: AgentSessionPromptResponse
    commit: () => Promise<void>
  }): Promise<void> {
    const entry = this.find(input.itemId)
    if (!entry) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    let reply: unknown
    try {
      reply = entry.presentation.reply(input.response)
    } catch (error) {
      throw new AgentSessionPromptAnswerRejectedError(
        error instanceof Error ? error.message : String(error)
      )
    }
    entry.claimed = true
    try {
      await input.commit()
    } catch (error) {
      entry.claimed = false
      throw error
    }
    entry.settle(reply)
  }

  /** Declines every unclaimed request the way the agent's protocol spells a cancellation, and
   *  closes its card. */
  cancelAll(): void {
    for (const entry of Array.from(this.open.values())) {
      if (entry.claimed) {
        continue
      }
      entry.settle(entry.presentation.reply(null))
      this.lane()?.apply([{ type: 'request.withdrawn', request: entry.key }])
    }
  }

  /** The child is gone: nobody can answer for it any more. */
  clear(): void {
    this.open.clear()
  }

  private find(itemId: string): OpenRequest | null {
    const lane = this.lane()
    if (!lane) {
      return null
    }
    for (const entry of this.open.values()) {
      if (!entry.claimed && lane.isRequestRow(itemId, entry.key)) {
        return entry
      }
    }
    return null
  }
}
