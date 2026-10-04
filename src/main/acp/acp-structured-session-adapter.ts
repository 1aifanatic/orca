// A structured chat over the Agent Client Protocol: one adapter per registered ACP agent, which
// the router drives like the Claude and Codex lanes. Rewind, compaction and goals are absent, so
// the chat hides them; everything else maps onto ACP methods.

import { randomUUID } from 'node:crypto'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import {
  AgentSessionAcquisitionExitUnprovenError,
  type AgentSessionAcquisition,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsCodexStructuredLocation } from '../codex/codex-structured-location-support'
import { acpAgentName, acquireAcpStructuredSession } from './acp-structured-acquire'
import { AcpRequestTimeoutError } from './acp-errors'
import type { AcpStructuredChild } from './acp-structured-child'
import { endAcpStructuredSession, type AcpStructuredSession } from './acp-structured-session'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import type { ContentBlock } from './generated/acp-protocol.generated'

export class AcpStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, AcpStructuredSession>()
  /** Children still starting, so a close during the acquire can stop them. */
  private readonly starting = new Map<string, AcpStructuredChild>()

  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {}

  // The child runs on this runtime's own machine; Windows needs process start-time proof.
  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsCodexStructuredLocation(location, this.deps.isWindowsProcessStartTimeAvailable)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    if (!(await this.closeSession(sessionId))) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(
          `the previous ${this.deps.spec.agent} child for ${sessionId} could not be stopped`
        )
      )
    }
    const generation = this.deps.mintGeneration?.() ?? randomUUID()
    const tracked: { child: AcpStructuredChild | null } = { child: null }
    try {
      const { acquisition, session } = await acquireAcpStructuredSession({
        acquire: input,
        deps: this.deps,
        generation,
        track: (started) => {
          tracked.child = started
          this.starting.set(sessionId, started)
        },
        onExit: (session) => {
          if (session && this.sessions.get(sessionId) === session) {
            endAcpStructuredSession(session, this.now(), this.deps.onEvent)
          }
        },
        onSettled: (settlement) => this.deps.onDispatchSettledLate?.({ sessionId, ...settlement }),
        forceClose: (id) => void this.forceCloseSession(id)
      })
      this.sessions.set(sessionId, session)
      return acquisition
    } catch (error) {
      if (tracked.child && !(await tracked.child.close().catch(() => false))) {
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
      throw error
    } finally {
      if (this.starting.get(sessionId) === tracked.child) {
        this.starting.delete(sessionId)
      }
    }
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
    const withdrew = session.turns.withdrawQueued()
    session.prompts.cancelAll()
    if (!session.turns.running) {
      return withdrew
        ? { cancelled: true }
        : { cancelled: false, refusal: { turnNotRunning: true } }
    }
    try {
      // Ends when the agent answers the prompt `cancelled`; open permissions are declined first.
      await session.runtime.cancel()
      return { cancelled: true }
    } catch (error) {
      if (error instanceof AcpRequestTimeoutError) {
        // The agent never ended the turn; its connection is closed, so the child goes too.
        void this.forceCloseSession(input.sessionId)
      }
      return { cancelled: false }
    }
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

  readCommands = (sessionId: string) => this.sessions.get(sessionId)?.options.readCommands()

  holdsDispatch = (sessionId: string): boolean =>
    this.sessions.get(sessionId)?.turns.holdsDispatch() ?? false

  // ACP has no way to stop one background task the agent started.
  backgroundTaskStops: NonNullable<StructuredAgentSessionAdapter['backgroundTaskStops']> = (
    sessionId
  ) =>
    this.sessions.has(sessionId) ? { supportsTaskStop: false, supportsStopAll: false } : undefined

  closeSession = (sessionId: string): Promise<boolean> => this.stop(sessionId, true)
  disposeSession = (sessionId: string): Promise<boolean> => this.stop(sessionId, true)
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.stop(input.sessionId, true)
  /** After a sink failure: the exit is recovered as unexpected. */
  forceCloseSession = (sessionId: string): Promise<boolean> => this.stop(sessionId, false)

  async closeAll(): Promise<void> {
    const ids = new Set([...this.sessions.keys(), ...this.starting.keys()])
    const proven = await Promise.all([...ids].map((sessionId) => this.closeSession(sessionId)))
    if (proven.includes(false)) {
      throw new Error('an ACP agent child could not be proven stopped')
    }
  }

  /** True only once the child is proven gone, or when this adapter runs none for the session. */
  private async stop(sessionId: string, requested: boolean): Promise<boolean> {
    const starting = this.starting.get(sessionId)
    if (starting && !(await starting.close())) {
      return false
    }
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return true
    }
    session.closeRequested ||= requested
    session.lane.flush()
    const proven = await session.child.close()
    if (proven) {
      endAcpStructuredSession(session, session.exitObservedAt ?? this.now(), this.deps.onEvent)
    }
    return proven
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
    if (!session || session.ended) {
      throw new Error(`no live ${this.deps.spec.agent} child owns ${sessionId}`)
    }
    return session
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
