// The sends of one ACP session. ACP runs one prompt at a time, so a message sent while a turn runs
// is held here and sent as the next prompt once the running one is answered. Each send is settled
// exactly once: accepted when the agent's first event for its turn (or its answer) arrives,
// rejected when the agent refused it or it never left Orca, unknown when the agent died with it or
// its connection broke before it answered.

import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection
} from '../../shared/agent-session-failure-words'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import { AcpAgentError } from './acp-errors'
import type { AcpSessionRuntime } from './acp-session-runtime'
import type { AcpStructuredLane } from './acp-structured-lane'
import type { ContentBlock } from './generated/acp-protocol.generated'

export type AcpDispatchSettlement = { clientMessageId: string } & (
  | { providerIdentity: AgentJournalItemIdentity }
  | ({ state: 'rejected' } & AgentJournalDispatchRejection)
  | { state: 'unknown'; reason: string }
)

type Send = { clientMessageId: string; prompt: ContentBlock[]; requestedAt: number }

export type AcpStructuredTurnsDeps = {
  runtime: Pick<AcpSessionRuntime, 'prompt'>
  lane: AcpStructuredLane
  agentName: string
  now: () => number
  settle: (settlement: AcpDispatchSettlement) => void
  /** The prompt failed without an answer from the agent: the connection is no longer trustworthy,
   *  and the session's end settles the send. */
  onTransportFault: (error: unknown) => void
}

export class AcpStructuredTurns {
  private active: Send | null = null
  private readonly queue: Send[] = []
  private readonly unsettled = new Set<string>()
  private ended = false

  constructor(private readonly deps: AcpStructuredTurnsDeps) {}

  get running(): boolean {
    return this.active !== null
  }

  /** A send the agent has neither answered nor started: one held here, or one it has not echoed. */
  holdsDispatch(): boolean {
    return (
      this.queue.length > 0 ||
      (this.active !== null && this.unsettled.has(this.active.clientMessageId))
    )
  }

  dispatch(send: Send): void {
    this.unsettled.add(send.clientMessageId)
    if (this.active) {
      this.queue.push(send)
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

  /** A Stop: held sends never reach the agent. */
  withdrawQueued(): boolean {
    const withdrawn = this.queue.splice(0)
    for (const send of withdrawn) {
      this.reject(send.clientMessageId, agentSessionFailureFact('cancelled'))
    }
    return withdrawn.length > 0
  }

  /** The child is gone: held sends never left Orca, and the running one's fate is unknown. */
  end(reason: string): void {
    this.ended = true
    for (const send of this.queue.splice(0)) {
      this.reject(send.clientMessageId, agentSessionFailureFact('providerExited'))
    }
    const active = this.active
    if (active && this.unsettled.delete(active.clientMessageId)) {
      this.deps.settle({ clientMessageId: active.clientMessageId, state: 'unknown', reason })
    }
    this.active = null
  }

  private start(send: Send): void {
    const { lane } = this.deps
    this.active = send
    const opened = lane.translator.openPrompt(send.clientMessageId, send.requestedAt)
    lane.apply(opened.events)
    // The agent echoes this id on every event of the turn, so its rows join the turn Orca opened.
    const meta = { promptId: opened.promptId, requestId: opened.promptId }
    this.deps.runtime.prompt(send.prompt, meta).then(
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
          // until the session's end settles it `unknown`.
          this.deps.onTransportFault(error)
          return
        }
        if (lane.translator.promptRefused(send.clientMessageId)) {
          // The agent answered the prompt with an error before starting it: its own refusal.
          const detail = providerDiagnostic(error.message, 'person')
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
    const next = this.ended ? undefined : this.queue.shift()
    if (next) {
      this.start(next)
    }
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
