import type {
  AgentSessionBackgroundTaskState,
  AgentSessionHistoryRequest,
  AgentSessionHistoryResult
} from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { structuredChildWorkLegacyTasks } from '../../../shared/structured-agent-session-child-work-legacy'
import { structuredStripChildWork } from '../../../shared/structured-agent-session-child-work-selection'
import { readStructuredAgentSessionHistoryResult } from './structured-agent-session-history-result'
import type {
  AgentSessionSubscribers,
  AgentSessionSubscribeInput
} from './structured-agent-session-subscribers'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** The chat strip's roster: the host's child records for one session (every running child, then
 *  the newest finished ones, up to the strip's row budget), with the legacy task rows an older
 *  client reads derived from them. */
export class StructuredAgentSessionBackgroundTaskChannel {
  private readonly published = new Map<string, string>()

  constructor(
    private readonly deps: StructuredAgentSessionHostDeps,
    private readonly sessions: Map<string, StructuredAgentSessionHostSession>,
    private readonly subscribers: AgentSessionSubscribers,
    /** The host's accessor: opens a conversation at rest, and never starts an agent. */
    private readonly conversation: (
      sessionId: string
    ) => Promise<StructuredAgentSessionHostSession>,
    private readonly readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  ) {}

  async history(request: AgentSessionHistoryRequest): Promise<AgentSessionHistoryResult> {
    const result = readStructuredAgentSessionHistoryResult({
      journal: (await this.conversation(request.sessionId)).journal,
      record: this.deps.store.getRecord(request.sessionId),
      request
    })
    const backgroundTasks = this.state(request.sessionId)
    const hostNow = this.deps.now?.() ?? Date.now()
    return {
      ...result,
      page: {
        ...result.page,
        hostNow,
        ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
      }
    }
  }

  /** Resolves once the conversation is open and the subscriber holds its opening frame. */
  async subscribe(input: AgentSessionSubscribeInput): Promise<() => void> {
    const session = await this.conversation(input.sessionId)
    const backgroundTasks = this.state(input.sessionId)
    return this.subscribers.open({
      ...input,
      journal: session.journal,
      fence: structuredAgentSessionConversationFence(this.deps.store, input.sessionId),
      ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
    })
  }

  /** Re-read after the session's child records changed; an unchanged roster sends nothing. */
  publish(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    // Explicit null once rows were sent, not silence: a reader keeps its last roster on
    // `undefined`, and a closing provider stops answering before its records are gone.
    const read = this.state(sessionId)
    const state = read === undefined && this.published.has(sessionId) ? null : read
    if (!session || state === undefined) {
      return
    }
    const fingerprint = JSON.stringify(state)
    if (this.published.get(sessionId) === fingerprint) {
      return
    }
    if (state === null) {
      this.published.delete(sessionId)
    } else {
      this.published.set(sessionId, fingerprint)
    }
    this.subscribers.backgroundTasks(
      sessionId,
      state,
      structuredAgentSessionConversationFence(this.deps.store, sessionId)
    )
  }

  private state(sessionId: string): AgentSessionBackgroundTaskState | null | undefined {
    const session = this.sessions.get(sessionId)
    const stored = session ? this.readChildWork(sessionId) : undefined
    if (!session || stored === undefined) {
      return undefined
    }
    const views = structuredStripChildWork(stored)
    const stops = this.deps.adapter.backgroundTaskStops?.(sessionId)
    if (views.length === 0) {
      // As before: a session no live provider holds says nothing, a live one says "none".
      return stops === undefined ? undefined : null
    }
    const { tasks, settledTasks } = structuredChildWorkLegacyTasks(views, session.params.provider)
    return {
      state: 'monitoring',
      ...(tasks ? { tasks } : {}),
      ...(settledTasks ? { settledTasks } : {}),
      ...(stops?.supportsTaskStop ? { supportsTaskStop: true } : {}),
      // A session no live provider holds has nothing a stop could reach.
      ...(stops?.supportsStopAll ? {} : { supportsStopAll: false }),
      children: views
    }
  }
}
