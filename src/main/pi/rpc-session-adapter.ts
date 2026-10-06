import { randomUUID } from 'node:crypto'
import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionExitProvenError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { codexSpawnedProcessIdentity } from '../codex/codex-structured-owner-identity'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { buildPiRpcLaunch } from './rpc-launch'
import { piRpcProviderLink, type PiRpcResolvedLaunch } from './rpc-launch-resolution'
import { PiRpcSession, type PiRpcSessionDeps } from './rpc-session'
import { PiRpcPromptError, preparePiRpcPrompt } from './rpc-prompt'
import { applyPiRpcSessionOption, readPiRpcSessionOptions } from './rpc-options'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { ClaudeDispatchContentError } from '../claude/claude-structured-dispatch-content'

export type PiRpcSessionAdapterDeps = PiRpcSessionDeps & {
  resolveLaunch: (
    identity: StructuredAgentSessionAcquireInput['identity']
  ) => Promise<PiRpcResolvedLaunch>
  readProcessStartTime?: (pid: number) => Promise<number | null>
}

export class PiRpcSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, PiRpcSession>()
  private readonly acquiring = new Set<string>()
  private readonly retiring = new Set<Promise<void>>()
  constructor(private readonly deps: PiRpcSessionAdapterDeps) {}

  supportsLocation: NonNullable<StructuredAgentSessionAdapter['supportsLocation']> = (location) =>
    location.executionHostId === LOCAL_EXECUTION_HOST_ID && location.wslDistro === null
  supportsCreate: NonNullable<StructuredAgentSessionAdapter['supportsCreate']> = (
    location,
    agent
  ) => agent === 'pi' && this.supportsLocation(location)

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const id = input.identity.sessionId
    if (this.sessions.has(id) || this.acquiring.has(id)) {
      throw new AgentSessionPreSpawnError(new Error('Pi session already owns a child'))
    }
    this.acquiring.add(id)
    let session: PiRpcSession | undefined
    try {
      let launch: PiRpcResolvedLaunch
      try {
        launch = await this.deps.resolveLaunch(input.identity)
      } catch (error) {
        throw new AgentSessionPreSpawnError(error)
      }
      const spec = buildPiRpcLaunch({
        ...launch,
        structuredSession: { id, spawnToken: input.spawnToken }
      })
      session = new PiRpcSession(input, randomUUID(), spec, this.deps)
      this.sessions.set(id, session)
      // The shared acquisition helper replaces this delegate when its extraction lands.
      const spawned = codexSpawnedProcessIdentity(input, this.deps.readProcessStartTime)
      if (session.connection.pid !== undefined) {
        await spawned.onSpawned(session.connection.pid)
      }
      const process = await spawned.read(session.connection.pid)
      const file = await session.start()
      if (session.connection.closed) {
        throw new Error('Pi exited while starting')
      }
      return {
        process,
        acquisitionGeneration: session.generation,
        link: piRpcProviderLink(launch, file, input.fence, randomUUID(), Date.now())
      }
    } catch (error) {
      if (!session) {
        throw error instanceof AgentSessionPreSpawnError
          ? error
          : new AgentSessionPreSpawnError(error)
      }
      const result = await session.close(false).catch(() => null)
      if (result?.root === 'exited') {
        if (session.connection.processless) {
          throw new AgentSessionAcquisitionExitProvenError(error)
        }
        throw new AgentSessionAcquisitionRootExitObservedError(error)
      }
      throw new AgentSessionAcquisitionExitUnprovenError(error)
    } finally {
      this.acquiring.delete(id)
    }
  }

  dispatch: StructuredAgentSessionAdapter['dispatch'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    let prompt
    try {
      prompt = await preparePiRpcPrompt(input.body, session.turns.working ? 'steer' : 'followUp')
    } catch (error) {
      this.deps.logger.warn('Pi prompt could not be prepared', {
        scope: 'pi-prompt',
        sessionId: input.sessionId,
        error
      })
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          error instanceof PiRpcPromptError || error instanceof ClaudeDispatchContentError
            ? error.failure
            : agentSessionFailureFact('attachmentUnreadable'),
          { provider: 'pi', agentName: 'Pi', surface: 'rejection' }
        )
      }
    }
    return session.turns.submit(
      input.clientMessageId,
      input.requestedAt ?? Date.now(),
      { ...prompt },
      input.beforeDispatch
    )
  }

  compact: NonNullable<StructuredAgentSessionAdapter['compact']> = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    session.turns.beginCommand(input.command)
    try {
      await session.connection.request('compact', {}, { timeoutMs: null })
      session.turns.commandCompleted()
      return { state: 'accepted', providerIdentity: null }
    } catch (error) {
      if (!(error instanceof JsonlRpcResponseError)) {
        throw error
      }
      if (error.message === 'Nothing to compact (session too small)') {
        session.lane.apply([
          {
            type: 'item.close',
            item: `compact-noop:${input.command.turnId}`,
            body: { kind: 'status', tone: 'warning', text: error.message }
          }
        ])
        session.turns.commandCompleted()
        return { state: 'accepted', providerIdentity: null }
      }
      session.turns.commandRejected()
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRejected', {
            detail: providerDiagnostic(error.message, 'person')
          }),
          { provider: 'pi', agentName: 'Pi', surface: 'rejection' }
        )
      }
    }
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (input) => {
    const session = this.session(input.sessionId, input.fence)
    const turnId = input.resolveLiveTurnId ? input.resolveLiveTurnId() : session.lane.openTurnId
    if (input.turnId !== undefined && input.turnId !== turnId) {
      return { cancelled: false }
    }
    if (!turnId && !session.turns.holdsDispatch) {
      return { cancelled: false }
    }
    session.turns.stop()
    session.dialogs.cancelAll()
    await session.connection.request('abort', {}, { timeoutMs: 2_000 })
    return { cancelled: true, ...(turnId ? { turnId } : {}) }
  }
  stopEndsSession(): boolean {
    return true
  }
  awaitStoppedRequestEnd: NonNullable<StructuredAgentSessionAdapter['awaitStoppedRequestEnd']> =
    async (id, at) => {
      const session = this.sessions.get(id)
      const turn = session?.lane.openTurnId
      if (!session) {
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (turn) {
          await Promise.race([
            session.lane.whenTurnLeaves(turn),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, Math.max(0, at + 2_000 - Date.now()))
              timer.unref()
            })
          ])
        }
      } finally {
        clearTimeout(timer)
      }
      try {
        await session.connection.request('get_state', {}, { timeoutMs: 1_000 })
      } catch (error) {
        this.deps.logger.warn('Pi checkpoint could not be read before stopping', {
          scope: 'pi-stop-checkpoint',
          sessionId: id,
          error
        })
      }
    }
  routePromptCancel(): { kind: 'dismiss' } {
    return { kind: 'dismiss' }
  }
  dismissPrompt: NonNullable<StructuredAgentSessionAdapter['dismissPrompt']> = (input) =>
    this.session(input.sessionId, input.fence).dialogs.respond(
      input.itemId,
      null,
      input.commit,
      input.answer
    )
  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = (input) =>
    this.session(input.sessionId, input.fence).dialogs.respond(
      input.itemId,
      input.response,
      input.commit
    )
  setOption: StructuredAgentSessionAdapter['setOption'] = (input) => {
    const session = this.session(input.sessionId, input.fence)
    return applyPiRpcSessionOption(session.connection, session.selected, input.key, input.value)
  }
  readOptions: NonNullable<StructuredAgentSessionAdapter['readOptions']> = (input) =>
    readPiRpcSessionOptions(this.session(input.sessionId, input.fence).connection)
  readCommands(id: string) {
    return this.sessions.get(id)?.commands
  }
  readOptionRestoreFailures(id: string): readonly string[] {
    return this.sessions.get(id)?.skipped ?? []
  }
  holdsDispatch(id: string): boolean {
    return this.sessions.get(id)?.turns.holdsDispatch ?? false
  }

  async closeSession(id: string, requested = true): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) {
      return true
    }
    const result = await session.close(requested)
    if (result.root !== 'exited') {
      return false
    }
    if (result.tree !== 'exited') {
      throw new AgentSessionAcquisitionRootExitObservedError(new Error('Pi root exit observed'))
    }
    return true
  }
  releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.closeSession(input.sessionId)
  }
  forceCloseSession(id: string): Promise<boolean> {
    this.sessions.get(id)?.fail(new Error('Pi event sink failed'))
    return this.closeSession(id, false)
  }
  disposeSession(id: string): Promise<boolean> {
    return this.closeSession(id)
  }
  acknowledgeSessionRelease(id: string): void {
    const session = this.sessions.get(id)
    if (!session?.connection.closed || session.connection.rootVerdict !== 'exited') {
      return
    }
    this.sessions.delete(id)
    const retirement = session.retire()
    this.retiring.add(retirement)
    void retirement.then(() => this.retiring.delete(retirement))
  }
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)))
  }
  async drainObservedExits(): Promise<void> {
    await Promise.all([
      ...this.retiring,
      ...[...this.sessions.values()].map((session) => session.drainObservedExit())
    ])
  }
  private session(id: string, fence: number): PiRpcSession {
    const session = this.sessions.get(id)
    if (!session || session.input.fence !== fence || session.connection.closed) {
      throw new Error('Pi session is not live under this fence')
    }
    return session
  }
}
