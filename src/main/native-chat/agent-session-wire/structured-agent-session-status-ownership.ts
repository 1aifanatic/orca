import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  parseAgentStatusSubject,
  serializeAgentStatusSubject,
  type AgentStatusStructuredSessionSubject
} from '../../../shared/agent-status-subject'
import {
  savedStructuredSessionStatusChanged,
  savedStructuredSessionSummary,
  type SavedStructuredSessionStatus
} from '../../../shared/structured-agent-session-saved-status'

export type StructuredAgentSessionStatusSink = {
  publish: (
    summary: AgentSessionStatusSummary,
    subject: AgentStatusStructuredSessionSubject
  ) => void
  forget: (subject: AgentStatusStructuredSessionSubject) => void
  /** The session's child-work evidence, addressed by the subject its parent row landed under. */
  publishChildWork?: (
    subject: AgentStatusStructuredSessionSubject,
    evidence: AgentChildWorkEvidence[],
    provider: AgentSessionRecord['provider']
  ) => void
  /** The child records the sink holds for that subject, as the views every surface reads. */
  readChildWork?: (subject: AgentStatusStructuredSessionSubject) => AgentChildWorkView[]
  /** What a restart shows for the chat before anything opens it. */
  saveStatus?: (saved: SavedStructuredSessionStatus) => void
  dropSavedStatus?: (sessionId: string) => void
  readSavedStatuses?: () => SavedStructuredSessionStatus[]
}

/** Retain the owner address because record removal may precede the final status callback. */
export class StructuredAgentSessionStatusOwnership {
  private readonly subjects = new Map<string, AgentStatusStructuredSessionSubject>()
  // Why separate from `subjects`: the address must survive a throwing publish so teardown can still
  // forget a row that did land, but "we hold an address" is not evidence the row is there. Only a
  // publish that returned proves that, and only that proof may suppress the re-offer below.
  private readonly landed = new Set<string>()
  private readonly saved = new Map<string, SavedStructuredSessionStatus>()

  constructor(private readonly sink: () => StructuredAgentSessionStatusSink | undefined) {}

  matchesLocation(sessionId: string, location: AgentSessionExecutionLocation): boolean {
    const subject = this.subjects.get(sessionId)
    return (
      this.landed.has(sessionId) &&
      subject?.executionHostId === location.executionHostId &&
      subject.wslDistro === location.wslDistro &&
      subject.workspaceId === location.workspaceId &&
      subject.workspaceKind === location.workspaceKind
    )
  }

  /** `turnFence`: the lease fence of the child running the session, which writes its turns. */
  publish(
    summary: AgentSessionStatusSummary,
    location?: AgentSessionExecutionLocation,
    turnFence?: number
  ): void {
    const sink = this.sink()
    if (!sink || (!location && !this.subjects.has(summary.sessionId))) {
      return
    }
    const subject = location
      ? parseAgentStatusSubject({
          ...location,
          kind: 'structured-session',
          sessionId: summary.sessionId
        })
      : this.subjects.get(summary.sessionId)
    if (!subject || subject.kind !== 'structured-session') {
      throw new Error('Structured status requires its full trusted execution location')
    }
    const previous = this.subjects.get(summary.sessionId)
    if (
      previous &&
      serializeAgentStatusSubject(previous) !== serializeAgentStatusSubject(subject)
    ) {
      sink.forget(previous)
    }
    this.subjects.set(summary.sessionId, subject)
    this.landed.delete(summary.sessionId)
    sink.publish(summary, subject)
    this.landed.add(summary.sessionId)
    this.save(sink, summary, turnFence)
  }

  /** Only on what a restart would show: a status or verdict edge, or a new child under a turn. */
  private save(
    sink: StructuredAgentSessionStatusSink,
    summary: AgentSessionStatusSummary,
    turnFence: number | undefined
  ): void {
    const saved = savedStructuredSessionSummary(summary)
    const fence = saved?.status === 'idle' ? undefined : turnFence
    const previous = this.saved.get(summary.sessionId)
    if (
      !saved ||
      (!savedStructuredSessionStatusChanged(previous?.summary, saved) &&
        previous?.turnFence === fence)
    ) {
      return
    }
    const entry = { summary: saved, ...(fence === undefined ? {} : { turnFence: fence }) }
    this.saved.set(summary.sessionId, entry)
    sink.saveStatus?.(entry)
  }

  /** Children ride the address the parent landed under: without that proof the store would
   *  refuse them anyway, and offering them earlier would race the parent row. */
  publishChildWork(
    sessionId: string,
    evidence: AgentChildWorkEvidence[],
    provider: AgentSessionRecord['provider']
  ): void {
    const subject = this.subjects.get(sessionId)
    if (subject && this.landed.has(sessionId)) {
      this.sink()?.publishChildWork?.(subject, evidence, provider)
    }
  }

  /** Undefined until the parent row has landed: a sink holds no children for a parent it lacks. */
  readChildWork(sessionId: string): AgentChildWorkView[] | undefined {
    const subject = this.subjects.get(sessionId)
    return subject && this.landed.has(sessionId) ? this.sink()?.readChildWork?.(subject) : undefined
  }

  forget(sessionId: string): void {
    const subject = this.subjects.get(sessionId)
    if (!subject) {
      return
    }
    this.landed.delete(sessionId)
    this.saved.delete(sessionId)
    const sink = this.sink()
    sink?.forget(subject)
    this.subjects.delete(sessionId)
    // The host let go of an unlisted chat: no restart lists it, so its saved status dies too.
    sink?.dropSavedStatus?.(sessionId)
  }
}
