import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentSessionDispatchOutcome } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import { piRpcPromptReplySchema } from './rpc-protocol'

type Submission = {
  id: string
  at: number
  frame: JsonlRpcRecord
  accepted: boolean
  retries: number
}
type DeliveryDeps = {
  send: (frame: JsonlRpcRecord) => Promise<void>
  accepted: (id: string, at: number) => void
  commandOnly: () => void
  rejectedAfterAcceptance: (error: string) => void
  settled: (id: string, outcome: AgentSessionDispatchOutcome) => void
  failed: (error: Error) => void
}

/** Idless prompt acknowledgements are FIFO and may wait indefinitely on extension dialogs. */
export class PiRpcPromptDelivery {
  private readonly acknowledgements: Submission[] = []
  private readonly waiting: Submission[] = []
  private readonly retries = new Set<ReturnType<typeof setTimeout>>()
  private ended = false
  constructor(private readonly deps: DeliveryDeps) {}
  get holdsDispatch(): boolean {
    return this.waiting.length > 0
  }

  async submit(
    id: string,
    at: number,
    frame: JsonlRpcRecord,
    before?: () => Promise<void>
  ): Promise<AgentSessionDispatchOutcome> {
    await before?.()
    if (this.ended || this.acknowledgements.length >= 128) {
      throw new Error('Pi prompt queue unavailable')
    }
    const submission: Submission = { id, at, frame, accepted: false, retries: 0 }
    this.acknowledgements.push(submission)
    this.waiting.push(submission)
    try {
      await this.deps.send(frame)
      return { state: 'admitted' }
    } catch {
      this.remove(submission)
      return { state: 'unknown', reason: 'Pi prompt write did not settle' }
    }
  }

  consumeNext(): boolean {
    const submission = this.waiting[0]
    if (!submission) {
      return false
    }
    this.accept(submission)
    return true
  }

  reply(frame: JsonlRpcRecord): void {
    const reply = piRpcPromptReplySchema.parse(frame)
    const submission = this.acknowledgements.shift()
    if (!submission) {
      throw new Error('Pi prompt reply has no request')
    }
    if (!reply.success) {
      if (
        !submission.accepted &&
        reply.error?.startsWith('No API key found for ') &&
        submission.retries++ < 8
      ) {
        const timer = setTimeout(() => {
          this.retries.delete(timer)
          if (this.ended) {
            return
          }
          this.acknowledgements.push(submission)
          void this.deps
            .send(submission.frame)
            .catch((error: unknown) =>
              this.deps.failed(error instanceof Error ? error : new Error(String(error)))
            )
        }, 250)
        timer.unref()
        this.retries.add(timer)
        return
      }
      this.remove(submission)
      const fact = agentSessionFailureFact(
        reply.error?.startsWith('No API key found for ') ? 'notSignedIn' : 'providerRejected',
        { detail: providerDiagnostic(reply.error ?? 'Pi rejected the prompt', 'person') }
      )
      this.deps.settled(submission.id, {
        state: 'rejected',
        ...agentSessionFailureWords(fact, { provider: 'pi', agentName: 'Pi', surface: 'rejection' })
      })
      if (submission.accepted) {
        this.deps.rejectedAfterAcceptance(reply.error ?? 'Pi rejected the prompt')
      }
      return
    }
    if (reply.data?.disposition === 'handled' || reply.data?.agentInvoked === false) {
      this.accept(submission)
      this.deps.commandOnly()
    }
  }

  end(): void {
    this.ended = true
    for (const timer of this.retries) {
      clearTimeout(timer)
    }
    this.retries.clear()
    for (const submission of this.waiting) {
      this.deps.settled(submission.id, {
        state: 'unknown',
        reason: 'Pi ended before confirming delivery'
      })
    }
    this.waiting.length = 0
    this.acknowledgements.length = 0
  }

  private accept(submission: Submission): void {
    if (submission.accepted) {
      return
    }
    submission.accepted = true
    const index = this.waiting.indexOf(submission)
    if (index !== -1) {
      this.waiting.splice(index, 1)
    }
    this.deps.accepted(submission.id, submission.at)
  }
  private remove(submission: Submission): void {
    for (const list of [this.waiting, this.acknowledgements]) {
      const index = list.indexOf(submission)
      if (index !== -1) {
        list.splice(index, 1)
      }
    }
  }
}
