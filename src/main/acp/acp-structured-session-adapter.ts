// A structured chat over the Agent Client Protocol: one adapter per registered ACP agent, which
// the router drives like the Claude and Codex lanes. Rewind, compaction and goals are absent, so
// the chat hides them; everything else maps onto ACP methods.

import { randomUUID } from 'node:crypto'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type AgentSessionCancelOutcome,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsSupervisedProviderChildLocation } from '../provider-process/supervised-provider-child-location'
import { withObservedProviderExit } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { acpAgentName, acquireAcpStructuredSession } from './acp-structured-acquire'
import {
  closeAcpSessionJournal,
  endAcpStructuredSession,
  type AcpStructuredSession
} from './acp-structured-session'
import { AcpStructuredStarts, type AcpStartAttempt } from './acp-structured-starts'
import {
  ACP_CANCEL_TIMEOUT_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import type { ContentBlock } from './generated/acp-protocol.generated'

export class AcpStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  /** Live children, and ones whose exit is not yet proven; a proven exit removes its entry. */
  private readonly sessions = new Map<string, AcpStructuredSession>()
  private readonly starts = new AcpStructuredStarts()

  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {}

  // The child runs on this runtime's own machine; Windows needs process start-time proof.
  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsSupervisedProviderChildLocation(location, this.deps.isWindowsProcessStartTimeAvailable)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const attempt = this.starts.begin(sessionId)
    try {
      if (!(await this.stopPrevious(sessionId))) {
        throw new AgentSessionAcquisitionExitUnprovenError(
          new Error(
            `the previous ${this.deps.spec.agent} child for ${sessionId} could not be stopped`
          )
        )
      }
      return await this.start(input, attempt)
    } finally {
      this.starts.end(sessionId, attempt)
    }
  }

  private async start(
    input: StructuredAgentSessionAcquireInput,
    attempt: AcpStartAttempt
  ): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const generation = this.deps.mintGeneration?.() ?? randomUUID()
    try {
      const { acquisition, session } = await acquireAcpStructuredSession({
        acquire: input,
        deps: this.deps,
        generation,
        abandoned: () => attempt.abandoned,
        track: (child) => this.starts.track(attempt, child),
        onExit: (session) => {
          if (session && this.sessions.get(sessionId) === session) {
            this.finish(session, this.now())
          }
        },
        onConnectionLost: (session, error) => this.connectionLost(session, error),
        onSettled: (settlement) => this.deps.onDispatchSettledLate?.({ sessionId, ...settlement }),
        forceClose: (id) => void this.forceCloseSession(id)
      })
      if (attempt.abandoned) {
        session.lane.dispose()
        throw new Error('closed while starting')
      }
      this.sessions.set(sessionId, session)
      return acquisition
    } catch (error) {
      const { child } = attempt
      // Checked before the close below, which would make any exit look like one Orca asked for.
      const exitedOnItsOwn = child?.exited === true && !attempt.abandoned
      if (child && !(await child.close().catch(() => false))) {
        this.starts.retainFailed(sessionId, child)
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
      if (attempt.abandoned) {
        const closed = new Error(
          `${acpAgentName(this.deps.spec.agent)} was closed while starting`,
          { cause: error }
        )
        throw child ? closed : new AgentSessionPreSpawnError(closed)
      }
      if (child && exitedOnItsOwn && !isAgentSessionPreSpawnError(error)) {
        // The agent's own last words are what a person can act on.
        throw new AgentSessionAcquisitionExitProvenError(
          withObservedProviderExit(new Error(child.stderrTail() || String(error), { cause: error }))
        )
      }
      throw error
    }
  }

  /** A close that must not wait behind an acquire still starting: that start stops now, its child
   *  if it has one, and the acquire fails through the start-failure surface. A failed start's
   *  child still unproven gone is asked again. */
  abandonStart = async (sessionId: string): Promise<void> => {
    await Promise.all([this.starts.abandon(sessionId), this.starts.stopFailed(sessionId)])
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  }): Promise<AgentSessionDispatchOutcome> {
    const session = this.live(input.sessionId)
    const prompt = this.promptBlocks(input.body)
    if (!prompt) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('attachmentInvalid'), {
          surface: 'rejection',
          agentName: acpAgentName(session.spec.agent)
        })
      }
    }
    await input.beforeDispatch?.()
    session.turns.dispatch({
      clientMessageId: input.clientMessageId,
      prompt,
      requestedAt: input.requestedAt ?? this.now()
    })
    // The write is the admission; the agent's first event for the turn settles it.
    return { state: 'admitted' }
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.live(input.sessionId)
    // `session/cancel` stops whatever the session runs, so a Stop naming a turn that has since
    // ended must stop nothing newer: not the turn running now, nor the follow-ups behind it.
    const liveTurnId = input.resolveLiveTurnId?.() ?? session.lane.openTurnId
    if (input.turnId !== undefined && input.turnId !== liveTurnId) {
      return { cancelled: false, refusal: { turnNotRunning: true } }
    }
    const withdrew = session.turns.withdrawQueued()
    if (session.turns.running) {
      try {
        // Ends when the agent answers the prompt `cancelled`. The cancel aborts every open request
        // first, each answered as the agent spells a cancellation. Past the bound the connection
        // closes, which stops the child.
        await session.runtime.cancel()
        return { cancelled: true }
      } catch {
        return { cancelled: false }
      }
    }
    const agentTurnId = session.lane.openTurnId
    if (agentTurnId !== null) {
      return this.cancelAgentTurn(session, agentTurnId)
    }
    return withdrew ? { cancelled: true } : { cancelled: false, refusal: { turnNotRunning: true } }
  }

  /** A turn the agent began itself, as it does when a background task finishes: no prompt of Orca's
   *  answers, so the turn's own end does, within the same bound a prompt's cancel has. */
  private async cancelAgentTurn(
    session: AcpStructuredSession,
    turnId: string
  ): Promise<AgentSessionCancelOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.deps.cancelTimeoutMs ?? ACP_CANCEL_TIMEOUT_MS)
    })
    try {
      const left = session.lane.whenTurnLeaves(turnId).then(() => true)
      await session.runtime.cancel()
      if ((await Promise.race([left, deadline])) && session.journalClosed === null) {
        return { cancelled: true }
      }
    } catch {
      // The notification could not be written: the connection's own close ends the session.
    } finally {
      clearTimeout(timer)
    }
    if (session.journalClosed === null) {
      // The agent never ended its turn, so the child goes and the turn ends with it.
      void this.forceCloseSession(session.sessionId)
    }
    return { cancelled: false }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.live(input.sessionId).prompts.answer(input)

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> {
    const session = this.live(input.sessionId)
    const write = session.options.write(input.key, input.value)
    if (!write) {
      throw new Error(`${session.spec.agent} offers no session option named ${input.key}`)
    }
    if (write.method === 'config') {
      const result = await session.runtime.setConfigOption(write.configId, write.value)
      session.options.adoptConfigOptions(result.configOptions)
    } else {
      await session.runtime.setModel(write.modelId)
      session.options.adoptModel(write.modelId)
    }
    return session.options.reported()
  }

  readOptions = async (input: { sessionId: string; fence: number }) =>
    this.live(input.sessionId).options.read()

  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    this.sessions.get(sessionId)?.restoreSkipped ?? []

  readCommands = (sessionId: string) => this.sessions.get(sessionId)?.options.readCommands()

  holdsDispatch = (sessionId: string): boolean =>
    this.sessions.get(sessionId)?.turns.holdsDispatch() ?? false

  // ACP has no way to stop one background task the agent started.
  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) =>
    this.sessions.has(sessionId) ? { supportsTaskStop: false, supportsStopAll: false } : undefined

  closeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  disposeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.close(input.sessionId)
  /** After a sink failure: the exit is recovered as unexpected. */
  forceCloseSession = (sessionId: string): Promise<boolean> => this.stop(sessionId, false)

  async closeAll(): Promise<void> {
    const ids = new Set([...this.sessions.keys(), ...this.starts.sessionIds()])
    const proven = await Promise.all([...ids].map((sessionId) => this.stop(sessionId, true)))
    if (proven.includes(false)) {
      throw new Error('an ACP agent child could not be proven stopped')
    }
  }

  /** A requested close. The root's exit proves it; a process tree the close could not prove gone is
   *  reported to the caller that owns the child's record, as the adapter contract asks. */
  private async close(sessionId: string): Promise<boolean> {
    const child = this.sessions.get(sessionId)?.child
    const closed = await this.stop(sessionId, true)
    if (closed && child?.treeUnproven) {
      throw new AgentSessionAcquisitionRootExitObservedError(
        new Error(
          `${this.deps.spec.agent} ACP agent exited, but its process tree was not proven gone`
        )
      )
    }
    return closed
  }

  /** True only once every child is proven gone, or when this adapter runs none for the session. */
  private async stop(sessionId: string, requested: boolean): Promise<boolean> {
    const [abandoned, previous] = await Promise.all([
      this.starts.abandon(sessionId),
      this.stopPrevious(sessionId, requested)
    ])
    return abandoned && previous
  }

  /** What an earlier start left: a failed start's child, and the session's own. */
  private async stopPrevious(sessionId: string, requested = true): Promise<boolean> {
    const [failedStart, session] = await Promise.all([
      this.starts.stopFailed(sessionId),
      this.stopSession(sessionId, requested)
    ])
    return failedStart && session
  }

  private async stopSession(sessionId: string, requested: boolean): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return true
    }
    session.closeRequested ||= requested
    if (session.journalClosed === null) {
      session.lane.flush()
    }
    const proven = await session.child.close()
    if (proven) {
      this.finish(session, session.exitObservedAt ?? this.now())
    }
    return proven
  }

  /** The child's exit is proven: the host hears it, and nothing of the child stays here. */
  private finish(session: AcpStructuredSession, observedAt: number): void {
    endAcpStructuredSession(session, observedAt, this.deps.onEvent)
    if (this.sessions.get(session.sessionId) === session) {
      this.sessions.delete(session.sessionId)
    }
  }

  /** The connection broke while the child may still run: nothing more it says can be journaled, so
   *  the journal closes now and the child is stopped; the host hears `ended` once that is proven. */
  private connectionLost(session: AcpStructuredSession | null, error: Error): void {
    if (
      !session ||
      this.sessions.get(session.sessionId) !== session ||
      session.journalClosed !== null
    ) {
      return
    }
    closeAcpSessionJournal(
      session,
      `${session.spec.agent} ACP connection closed: ${error.message || error.name}`
    )
    void this.stop(session.sessionId, false)
  }

  private promptBlocks(body: AgentJournalMessageItem): ContentBlock[] | null {
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

  private live(sessionId: string): AcpStructuredSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.journalClosed !== null) {
      throw new Error(`no live ${this.deps.spec.agent} child owns ${sessionId}`)
    }
    return session
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
