// One grammar event's journal writes, admitted as one sink transition.
//
// Planning lays out the writes the event may need and changes nothing. What each write says, and
// which row it lands on, is decided by its resolver when the transition reaches its turn in the
// journal's write queue; those resolvers are the only code that changes the assembler's ledger.
// `onAdmitted` work (the forecast, text marked written) runs only when the sink takes the
// transition, so a refused event leaves the assembler exactly as it was and re-applying it is the
// retry.

import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../agent-session-wire/structured-agent-session-event-sink'
import type {
  StructuredAgentSessionTransitionJournal,
  StructuredAgentSessionTransitionStep
} from '../agent-session-wire/structured-agent-session-transition'

/** The sink calls the assembler needs: one-operation transitions, and the journal as it stands. */
export type ProviderTimelineSink = Required<
  Pick<StructuredAgentSessionEventSink, 'tryAppendTransition' | 'journalItems'>
> &
  Pick<StructuredAgentSessionEventSink, 'setActivity'>

type ItemStep = Extract<StructuredAgentSessionTransitionStep, { kind: 'item' }>
type SettlementStep = Extract<StructuredAgentSessionTransitionStep, { kind: 'settlement' }>

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export class ProviderTimelinePlan {
  private readonly steps: StructuredAgentSessionTransitionStep[] = []
  private readonly admitted: (() => void)[] = []
  private readonly executions: ((journal: StructuredAgentSessionTransitionJournal) => void)[] = []
  private lifecycle = false
  private refusal: StructuredAgentSessionSinkAdmission | null = null

  item(step: Omit<ItemStep, 'kind'>, lifecycle = false): void {
    this.steps.push({ kind: 'item', ...step })
    this.lifecycle ||= lifecycle
  }

  settlement(step: Omit<SettlementStep, 'kind'>): void {
    this.steps.push({ kind: 'settlement', ...step })
    this.lifecycle = true
  }

  /** Runs once the sink takes the transition. */
  onAdmitted(change: () => void): void {
    this.admitted.push(change)
  }

  /** Ledger work that rides the transition's place in the queue, after its last step resolved. */
  atExecution(change: (journal: StructuredAgentSessionTransitionJournal) => void): void {
    this.executions.push(change)
  }

  /** The event cannot be taken at all (over budget); nothing is submitted. */
  refuse(admission: StructuredAgentSessionSinkAdmission): void {
    this.refusal ??= admission
  }

  /** Whether submitting sends a transition (and so `landed` will be heard). */
  get writes(): boolean {
    return this.steps.length > 0 || this.executions.length > 0
  }

  submit(sink: ProviderTimelineSink, landed?: () => void): StructuredAgentSessionSinkAdmission {
    if (this.refusal) {
      return this.refusal
    }
    if (this.executions.length > 0 && this.steps.length === 0) {
      this.item({
        reservedBytes: 0,
        resolve: () => null,
        options: { turnScope: { kind: 'thread' } }
      })
    }
    if (this.steps.length > 0) {
      const admission = sink.tryAppendTransition({
        steps: this.withExecutions(),
        lifecycle: this.lifecycle,
        publish: true,
        ...(landed ? { landed: () => landed() } : {})
      })
      if (!admission.accepted) {
        return admission
      }
    }
    for (const change of this.admitted) {
      change()
    }
    return ADMITTED
  }

  private withExecutions(): StructuredAgentSessionTransitionStep[] {
    const last = this.steps.at(-1)
    if (!last || this.executions.length === 0) {
      return this.steps
    }
    const executions = this.executions
    const finish = (journal: StructuredAgentSessionTransitionJournal) =>
      executions.forEach((change) => change(journal))
    const wrapped: StructuredAgentSessionTransitionStep =
      last.kind === 'item'
        ? {
            ...last,
            resolve: (journal) => {
              const resolved = last.resolve(journal)
              finish(journal)
              return resolved
            }
          }
        : {
            ...last,
            resolve: (journal) => {
              const resolved = last.resolve(journal)
              finish(journal)
              return resolved
            }
          }
    return [...this.steps.slice(0, -1), wrapped]
  }
}

/** The sink as the assembler needs it; null for a sink without transitions or a journal view. */
export function providerTimelineSink(
  sink: StructuredAgentSessionEventSink
): ProviderTimelineSink | null {
  const { tryAppendTransition, journalItems, setActivity } = sink
  if (!tryAppendTransition || !journalItems) {
    return null
  }
  return {
    tryAppendTransition: (transition) => tryAppendTransition.call(sink, transition),
    journalItems: () => journalItems.call(sink),
    ...(setActivity
      ? {
          setActivity: (activity: AgentSessionTurnActivity | null) =>
            setActivity.call(sink, activity)
        }
      : {})
  }
}
