import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'
import {
  applyOpenCodeCatalog,
  updateOpenCodeContextWindow
} from './opencode-structured-session-options'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { openCodeSelectedModel } from './serve/session-catalog'
import { OpenCodeStructuredSessionEvents } from './opencode-structured-session-events'
import { OpenCodeStructuredSessionPrompts } from './opencode-structured-session-prompt'
import {
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { acquireOpenCodeSession } from './opencode-structured-session-acquire'
import { dispatchOpenCodeSession } from './opencode-structured-session-dispatch'
import { readOpenCodeProviderHistoryWindow } from './opencode-structured-history-window'
import {
  closeAllOpenCodeSessions,
  closeOpenCodeSession,
  observeOpenCodeExit
} from './opencode-structured-session-lifecycle'
import type {
  OpenCodeSession,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'

export type {
  OpenCodeStructuredLaunch,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'

export class OpenCodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, OpenCodeSession>()
  private readonly acquiring = new Map<string, Promise<unknown>>()
  private readonly acquireCancels = new Map<string, { cancelled: boolean }>()
  private readonly events: OpenCodeStructuredSessionEvents
  private readonly prompts: OpenCodeStructuredSessionPrompts

  constructor(private readonly deps: OpenCodeStructuredSessionAdapterDeps) {
    this.events = new OpenCodeStructuredSessionEvents(this.sessions, deps)
    this.prompts = new OpenCodeStructuredSessionPrompts(this.sessions, deps, (id) =>
      this.forceCloseSession(id)
    )
  }

  acquire(input: StructuredAgentSessionAcquireInput) {
    const sessionId = input.identity.sessionId
    const previous = this.acquiring.get(sessionId) ?? Promise.resolve()
    const oldCancellation = this.acquireCancels.get(sessionId)
    if (oldCancellation) {
      oldCancellation.cancelled = true
    }
    const cancellation = { cancelled: false }
    this.acquireCancels.set(sessionId, cancellation)
    const current = previous
      .catch(() => {})
      .then(() =>
        acquireOpenCodeSession({
          request: input,
          deps: this.deps,
          sessions: this.sessions,
          onFrame: (session, event) => this.events.onFrame(session, event),
          activate: (session) => this.events.activate(session),
          onExit: (session) => observeOpenCodeExit(this.sessions, session, this.deps),
          close: (id) => closeOpenCodeSession(this.sessions, id, this.deps, true),
          cancelled: () => cancellation.cancelled
        })
      )
    this.acquiring.set(sessionId, current)
    void current
      .finally(() => {
        if (this.acquiring.get(sessionId) === current) {
          this.acquiring.delete(sessionId)
          this.acquireCancels.delete(sessionId)
        }
      })
      .catch(() => {})
    return current
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    return session
      ? dispatchOpenCodeSession(session, input)
      : { state: 'unknown', reason: 'OpenCode server is absent' }
  }

  providerHistoryWindow: NonNullable<StructuredAgentSessionAdapter['providerHistoryWindow']> = (
    input
  ) => readOpenCodeProviderHistoryWindow(input.identity, this.deps)

  stopEndsSession = (): boolean => true

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.fence !== input.fence) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    try {
      if (session.client && session.root) {
        await session.client.abort(session.root.id)
      }
    } catch (error) {
      this.deps.logger?.warn('OpenCode interrupt did not complete', {
        scope: 'opencode-stop',
        sessionId: input.sessionId,
        error
      })
    }
    const closed = await this.closeSession(input.sessionId)
    return { cancelled: closed, ...(input.turnId ? { turnId: input.turnId } : {}) }
  }

  routePromptCancel: NonNullable<StructuredAgentSessionAdapter['routePromptCancel']> = () => ({
    kind: 'dismiss'
  })

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.prompts.answerPrompt(input)

  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = (input) =>
    this.prompts.dismissPrompt(input)

  setOption: StructuredAgentSessionAdapter['setOption'] = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.fence !== input.fence || !session.client || !session.root) {
      throw new Error('OpenCode session is unavailable')
    }
    const previousModel = session.optionValues.model
    const options = await session.client.setOption(
      session.root.id,
      input.key,
      input.value,
      session.optionValues
    )
    if (this.sessions.get(input.sessionId) !== session || session.ended) {
      throw new Error('OpenCode session closed while changing options')
    }
    session.optionValues = options
    session.options = {
      ...options,
      model: options.model ?? 'default',
      confirmed: Object.keys(options)
    }
    updateOpenCodeContextWindow(session)
    if (previousModel !== options.model) {
      await session.lane?.apply([
        { type: 'context.usage', usage: { used: { kind: 'unknown', capturedAt: Date.now() } } }
      ])
    }
    return { ...session.optionValues }
  }

  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.fence !== input.fence || !session.client || !session.root) {
      throw new Error('OpenCode session is unavailable')
    }
    const catalog = await session.client.readCatalog(session.root.id)
    if (this.sessions.get(input.sessionId) !== session || session.ended) {
      throw new Error('OpenCode session closed while reading options')
    }
    applyOpenCodeCatalog(session, catalog, this.deps)
    return { models: catalog.models, current: session.options, modes: catalog.modes }
  }

  readCommands = (sessionId: string): AgentSessionSlashCommand[] | undefined => {
    const session = this.sessions.get(sessionId)
    return session?.commands
  }

  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    this.sessions.get(sessionId)?.restoreSkippedOptions ?? []

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.fence !== input.fence || !session.client || !session.root) {
      return { state: 'unknown', reason: 'OpenCode session is unavailable' }
    }
    try {
      await session.client.compact(session.root.id, openCodeSelectedModel(session.optionValues))
      return { state: 'accepted', providerIdentity: null }
    } catch (error) {
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
  }

  holdsDispatch = (sessionId: string): boolean =>
    (this.sessions.get(sessionId)?.translator?.awaitingNativeInputs.length ?? 0) > 0
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)
  private closeOwned = async (sessionId: string, requested: boolean): Promise<boolean> => {
    const token = this.acquireCancels.get(sessionId)
    if (token) {
      token.cancelled = true
    }
    if (this.sessions.has(sessionId)) {
      const closed = await closeOpenCodeSession(this.sessions, sessionId, this.deps, requested)
      if (!closed) {
        return false
      }
    }
    return closeOpenCodeSession(this.sessions, sessionId, this.deps, requested)
  }
  closeSession = (sessionId: string): Promise<boolean> => this.closeOwned(sessionId, true)
  forceCloseSession = (sessionId: string): Promise<boolean> => this.closeOwned(sessionId, false)
  disposeSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  closeAll = async (): Promise<void> => {
    for (const token of this.acquireCancels.values()) {
      token.cancelled = true
    }
    await closeAllOpenCodeSessions(this.sessions, this.closeSession)
    const starts = await withTimeout(Promise.allSettled(this.acquiring.values()), 30_000, null)
    if (!starts) {
      throw new Error('OpenCode acquisitions did not finish after shutdown')
    }
    const rootOnly = starts.flatMap((result) =>
      result.status === 'rejected' &&
      result.reason instanceof AgentSessionAcquisitionRootExitObservedError
        ? [result.reason]
        : []
    )
    if (rootOnly.length > 0) {
      throw new AggregateError(
        rootOnly,
        'OpenCode startup roots exited but descendant cleanup is unproven'
      )
    }
  }
}
