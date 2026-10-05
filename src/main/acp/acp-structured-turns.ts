// The sends of one ACP session. ACP runs one prompt at a time, so a message sent while Orca's prompt
// runs steers: that prompt is cancelled (the session stays) and the message goes as the next prompt
// once the agent answers the cancel. A steer waits here until then; one behind it cancels it in turn,
// so the last one runs, and a Stop withdraws what waits. A turn the agent began itself is not Orca's
// to cut short: a message sent during it goes to the agent at once. Each send is settled exactly once:
// accepted when the agent's first event for its turn (or its answer) arrives, rejected when the
// agent refused it or it never left Orca, unknown when the agent died with it or its connection
// broke before it answered.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../shared/agent-session-failure-words'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import { AcpAgentError } from './acp-errors'
import type { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { ContentBlock } from './generated/acp-protocol.generated'

export type AcpDispatchSettlement = { clientMessageId: string } & (
  | { providerIdentity: AgentJournalItemIdentity }
  | ({ state: 'rejected' } & AgentJournalDispatchRejection)
  | { state: 'unknown'; reason: string }
)

/** A person's message as an ACP prompt; null when it carries what the agent cannot take. */
export function acpPromptBlocks(body: AgentJournalMessageItem): ContentBlock[] | null {
  const blocks: ContentBlock[] = []
  for (const block of body.blocks) {
    if (block.type !== 'text') {
      // Images wait for an ACP image path; the chat offers none while `imagePrompts` is off.
      return null
    }
    blocks.push({ type: 'text', text: block.text })
  }
  return blocks
}

type Send = { clientMessageId: string; prompt: ContentBlock[]; requestedAt: number }

export type AcpStructuredTurnsDeps = {
  runtime: Pick<AcpSessionRuntime, 'prompt' | 'cancel'>
  lane: AcpStructuredLane
  agentName: string
  now: () => number
  settle: (settlement: AcpDispatchSettlement) => void
}

export class AcpStructuredTurns {
  private active: Send | null = null
  /** Steers waiting for the prompt ahead of them to answer its cancel. */
  private readonly steers: Send[] = []
  private readonly unsettled = new Set<string>()
  private readonly idleWaiters = new Set<() => void>()
  private ended = false

  constructor(private readonly deps: AcpStructuredTurnsDeps) {}

  get running(): boolean {
    return this.active !== null
  }

  /** Resolves once no prompt of Orca's is running. */
  whenIdle(): Promise<void> {
    if (!this.active) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  dispatch(send: Send): void {
    this.unsettled.add(send.clientMessageId)
    if (this.active) {
      this.steers.push(send)
      this.cancelForSteer()
      return
    }
    this.start(send)
  }

  /** The agent took the send: its turn's first event, or its answer, arrived. */
  accept(clientMessageId: string): void {
    if (this.unsettled.delete(clientMessageId)) {
      this.deps.settle({
        clientMessageId,
        providerIdentity: { provider: 'orca', clientMessageId }
      })
    }
  }

  /** A Stop: held steers never reach the agent. */
  withdrawSteers(): boolean {
    const withdrawn = this.steers.splice(0)
    for (const send of withdrawn) {
      this.reject(send.clientMessageId, agentSessionFailureFact('cancelled'))
    }
    return withdrawn.length > 0
  }

  /** The child is gone: held sends never left Orca, and the running one's fate is unknown. */
  end(reason: string): void {
    this.ended = true
    for (const send of this.steers.splice(0)) {
      this.reject(send.clientMessageId, agentSessionFailureFact('providerExited'))
    }
    const active = this.active
    if (active && this.unsettled.delete(active.clientMessageId)) {
      this.deps.settle({ clientMessageId: active.clientMessageId, state: 'unknown', reason })
    }
    this.active = null
    this.notifyIdle()
  }

  private start(send: Send): void {
    const { lane } = this.deps
    this.active = send
    const opened = lane.translator.openPrompt(send.clientMessageId, send.requestedAt)
    lane.apply(opened.events)
    // The agent echoes this id on every event of the turn, so its rows join the turn Orca opened.
    const meta = { promptId: opened.promptId, requestId: opened.promptId }
    const answered = this.deps.runtime.prompt(send.prompt, meta)
    if (this.steers.length > 0) {
      this.cancelForSteer()
    }
    answered.then(
      (result) => {
        if (this.active !== send) {
          return
        }
        lane.apply(lane.translator.promptResult(send.clientMessageId, result, this.deps.now()))
        this.accept(send.clientMessageId)
        this.finish(send)
      },
      (error: unknown) => {
        if (this.active !== send) {
          return
        }
        if (!(error instanceof AcpAgentError)) {
          // No answer from the agent, so neither a refusal nor an end: the send stays running here
          // until a Stop or the session's end settles it.
          return
        }
        const refusal = lane.translator.promptRefused(send.clientMessageId, error)
        if (refusal !== null) {
          // The agent answered the prompt with an error before starting it: its own refusal.
          const detail = providerDiagnostic(refusal, 'person')
          this.reject(
            send.clientMessageId,
            agentSessionFailureFact('providerRejected', detail ? { detail } : {})
          )
        } else {
          lane.apply(lane.translator.promptFailed(send.clientMessageId, error, this.deps.now()))
        }
        this.finish(send)
      }
    )
  }

  private finish(send: Send): void {
    if (this.active === send) {
      this.active = null
    }
    const next = this.ended ? undefined : this.steers.shift()
    if (next) {
      this.start(next)
    } else if (!this.active) {
      this.notifyIdle()
    }
  }

  /** Answers the agent's open requests cancelled and ends the running prompt. One the agent never
   *  answers closes the connection past the runtime's bound, which ends the session. */
  private cancelForSteer(): void {
    void this.deps.runtime.cancel().catch(() => undefined)
  }

  private notifyIdle(): void {
    for (const wake of this.idleWaiters) {
      wake()
    }
    this.idleWaiters.clear()
  }

  private reject(clientMessageId: string, fact: SubmissionRejectionFact): void {
    if (!this.unsettled.delete(clientMessageId)) {
      return
    }
    this.deps.settle({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(fact, { surface: 'rejection', agentName: this.deps.agentName })
    })
  }
}
