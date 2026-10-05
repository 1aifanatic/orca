// Making a reservation real for an ACP agent: spawn the child, record it before any handshake,
// initialize with the client's file system and terminals off, then reattach the session this chat
// proved (`session/resume` where the agent offers it, else `session/load`) or start a new one. The
// journal already holds a reattached chat, so whatever the agent sends while it reattaches is not
// written, except context usage. The handshake is bounded: an agent that never answers fails the
// start instead of holding the chat's queue, and a close can stop the child at any point of it.

import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../shared/tui-agent-config'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { providerTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import {
  providerSpawnedProcessIdentity,
  PROVIDER_SPAWN_TOKEN_ENV
} from '../provider-process/provider-spawned-process-identity'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import { AcpAuthRequiredError, AcpRpcError } from './acp-errors'
import { ACP_CHILD_ENV_TO_DELETE } from './acp-launch-specs'
import { AcpSessionRuntime, type AcpSessionEvent } from './acp-session-runtime'
import type { AcpStructuredChild } from './acp-structured-child'
import { ACP_HANDLE_TRANSPORT } from './acp-structured-agent-definitions'
import { AcpStructuredLane } from './acp-structured-lane'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import { AcpStructuredOptions, restoreAcpSessionOptions } from './acp-structured-options'
import { AcpStructuredPrompts } from './acp-structured-prompts'
import { routeAcpSessionEvent, type AcpStructuredSession } from './acp-structured-session'
import {
  ACP_CANCEL_TIMEOUT_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import { AcpStructuredTurns, type AcpStructuredTurnsDeps } from './acp-structured-turns'
import { RequestPermissionResponseSchema } from './generated/acp-protocol.generated'

/** ACP's "resource not found": the agent holds no session under the id this chat proved. */
const ACP_RESOURCE_NOT_FOUND = -32002
/** Frames an agent may send before its session exists; past this the start is refused. */
const MAX_EARLY_FRAMES = 2_048
/** How long the agent has to answer the handshake, reattach or create its session, and take saved
 *  options back. A load-only agent replays the whole conversation, so this is generous. */
export const ACP_STARTUP_TIMEOUT_MS = 60_000

export class AcpStartupTimeoutError extends Error {
  constructor(agentName: string, timeoutMs: number) {
    super(`${agentName} did not finish starting within ${Math.round(timeoutMs / 1_000)} seconds`)
    this.name = 'AcpStartupTimeoutError'
  }
}

export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

export async function acquireAcpStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  /** A close reached this start; checked until the spawn, after which `track` hands it the child. */
  abandoned: () => boolean
  /** Registers the child so a close during the acquire can stop it. */
  track: (child: AcpStructuredChild) => void
  /** The child's exit, observed while or after the session exists. */
  onExit: (session: AcpStructuredSession | null) => void
  /** The connection closed with the child perhaps still running. Null while starting: then the
   *  start itself fails. */
  onConnectionLost: (session: AcpStructuredSession | null, error: Error) => void
  onSettled: AcpStructuredTurnsDeps['settle']
  forceClose: (sessionId: string) => void
}): Promise<{ acquisition: AgentSessionAcquisition; session: AcpStructuredSession }> {
  const { acquire, deps, generation } = input
  const { spec } = deps
  const sessionId = acquire.identity.sessionId
  const now = deps.now ?? Date.now
  const events = acquire.events
  const sink = events ? providerTimelineSink(events) : null
  if (!sink) {
    throw new AgentSessionPreSpawnError(new Error(`${spec.agent} chats need a journal sink`))
  }
  const closedBeforeSpawn = () => {
    if (input.abandoned()) {
      throw new AgentSessionPreSpawnError(
        new Error(`${acpAgentName(spec.agent)} was closed before it started`)
      )
    }
  }
  closedBeforeSpawn()
  const launch: AcpStructuredLaunch = await deps
    .resolveLaunch({ identity: acquire.identity })
    .catch((error: unknown) => {
      throw new AgentSessionPreSpawnError(error)
    })
  closedBeforeSpawn()
  const child = deps.spawnChild({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: {
      ...structuredSessionChildIdentityEnv(sessionId, launch.env),
      [PROVIDER_SPAWN_TOKEN_ENV]: acquire.spawnToken
    },
    envToDelete: ACP_CHILD_ENV_TO_DELETE
  })
  input.track(child)
  let session: AcpStructuredSession | null = null
  // A slot rather than a `let`: closures read it, and control-flow narrowing cannot see them write.
  const slot: { lane: AcpStructuredLane | null } = { lane: null }
  const options = new AcpStructuredOptions()
  const prompts = new AcpStructuredPrompts(() => slot.lane)
  const early: (() => void)[] = []
  const connection = { closed: false }
  const whenLane = (deliver: () => void): void => {
    if (slot.lane) {
      deliver()
    } else if (early.length < MAX_EARLY_FRAMES) {
      early.push(deliver)
    }
  }
  const runtime = new AcpSessionRuntime(child.stdout, child.stdin, {
    clientInfo: { name: 'orca', version: '1' },
    cancelTimeoutMs: deps.cancelTimeoutMs ?? ACP_CANCEL_TIMEOUT_MS,
    onPermission: (request, context) => {
      if (launch.fullAccess) {
        // Full access: Orca answers yes for the person, as the agent's own bypass flag would.
        const allow = request.options.find((option) => option.kind === 'allow_once')
        if (allow) {
          return { outcome: { outcome: 'selected', optionId: allow.optionId } }
        }
      }
      return prompts
        .handle('session/request_permission', request, context)
        .then((reply) => RequestPermissionResponseSchema.parse(reply))
    },
    onRequest: (method, params, context) => prompts.handle(method, params, context),
    onExtensionNotification: (method, params) =>
      whenLane(() => slot.lane?.apply(slot.lane.translator.notification(method, params, now()))),
    onDiagnostic: (message) =>
      deps.logger?.warn('ACP agent protocol diagnostic', {
        scope: 'acp-diagnostic',
        sessionId,
        message
      }),
    onClose: (error) => {
      connection.closed = true
      input.onConnectionLost(session, error)
    }
  })
  runtime.subscribe((event: AcpSessionEvent) =>
    whenLane(() => slot.lane && routeAcpSessionEvent({ lane: slot.lane, options }, event, now()))
  )
  child.onExit(() => {
    // The exit first, so the connection's close it causes is not read as one that broke.
    input.onExit(session)
    runtime.close(new Error(child.stderrTail() || `${spec.command} exited`))
  })
  const identity = providerSpawnedProcessIdentity(
    acquire,
    `${spec.agent} ACP agent`,
    deps.readProcessStartTime
  )
  /** `attaching`: the lane opens inside the attach window, before any frame queued so far. */
  const makeLane = (providerSessionId: string, attaching = false): AcpStructuredLane => {
    const lane = new AcpStructuredLane({
      sink,
      sessionId,
      agent: spec.agent,
      agentName: acpAgentName(spec.agent),
      generation,
      providerSessionId,
      dialect: spec.dialect,
      onInputAccepted: (clientMessageId) => session?.turns.accept(clientMessageId),
      onFailed: () => input.forceClose(sessionId)
    })
    slot.lane = lane
    if (attaching) {
      lane.translator.beginLoad()
    }
    for (const deliver of early.splice(0)) {
      deliver()
    }
    return lane
  }
  await child.spawned
  if (child.pid === undefined) {
    throw new AgentSessionPreSpawnError(
      new Error(child.stderrTail() || `${launch.command} could not be started`)
    )
  }
  await identity.onSpawned(child.pid)
  const agentName = acpAgentName(spec.agent)
  const startupTimeoutMs = deps.startupTimeoutMs ?? ACP_STARTUP_TIMEOUT_MS
  // Closing the connection fails whichever request the agent left unanswered.
  const startupDeadline = setTimeout(
    () => runtime.close(new AcpStartupTimeoutError(agentName, startupTimeoutMs)),
    startupTimeoutMs
  )
  try {
    await runtime.initialize()
    const resume = launch.resume
    let started: Awaited<ReturnType<AcpSessionRuntime['start']>> | null = null
    let liveLane: AcpStructuredLane | null = null
    let supersedesKey: string | undefined
    if (resume) {
      // Adoption would plug in here: a chat whose journal holds none of the agent's history would
      // load with the translator adopting the replay. No Grok chat reaches that state today.
      const attaching = makeLane(resume.sessionId, true)
      liveLane = attaching
      try {
        started = await runtime.start({
          cwd: launch.cwd,
          mcpServers: [],
          sessionId: resume.sessionId,
          resumePreference: 'resume'
        })
        attaching.apply(attaching.translator.finishLoad(now()))
      } catch (error) {
        const notFound = error instanceof AcpRpcError && error.code === ACP_RESOURCE_NOT_FOUND
        if (!notFound || resume.replaceableKey === null) {
          throw error
        }
        // A session this chat created and the agent never saved: a new one takes its place, with a
        // new lane, so nothing of the failed attach's window outlives it.
        supersedesKey = resume.replaceableKey
      }
    }
    if (!started || !liveLane) {
      liveLane?.dispose()
      slot.lane = null
      started = await runtime.start({ cwd: launch.cwd, mcpServers: [] })
      liveLane = makeLane(started.sessionId)
    }
    options.adoptSession(started.response)
    liveLane.apply(liveLane.translator.contextModels(started.response.models, now()))
    const restoreSkipped = await restoreAcpSessionOptions(runtime, options, acquire.options)
    const process = await identity.read(child.pid)
    const link: AgentSessionProviderHandleLink = {
      linkId:
        deps.mintLinkId?.() ?? `${spec.agent}-${acquire.fence}-${started.sessionId}`.slice(0, 128),
      handle: { transport: ACP_HANDLE_TRANSPORT, agent: spec.agent, nativeId: started.sessionId },
      origin: started.kind === 'new' ? 'created' : 'resumed',
      mintedAtFence: acquire.fence,
      observedAt: now(),
      ...(supersedesKey ? { supersedesKey } : {})
    }
    session = {
      sessionId,
      fence: acquire.fence,
      acquisitionGeneration: generation,
      spec,
      child,
      runtime,
      lane: liveLane,
      prompts,
      options,
      turns: new AcpStructuredTurns({
        runtime,
        lane: liveLane,
        agentName,
        now,
        settle: input.onSettled,
        // An answer Orca cannot read leaves the connection untrustworthy, as a broken one is.
        onTransportFault: (error) =>
          runtime.close(error instanceof Error ? error : new Error(String(error)))
      }),
      restoreSkipped,
      closeRequested: false,
      journalClosed: null,
      ended: false,
      exitObservedAt: null
    }
    const reading = liveLane
    const unbind = events?.bindReadingControl?.({
      pauseReading: () => child.stdout.pause(),
      resumeReading: () => {
        child.stdout.resume()
        reading.retry()
      }
    })
    if (unbind) {
      session.unbindReadingControl = unbind
    }
    if (child.exited || connection.closed) {
      throw new Error(child.stderrTail() || `${spec.command} exited while starting`)
    }
    return { acquisition: { process, link, acquisitionGeneration: generation }, session }
  } catch (error) {
    session = null
    slot.lane?.dispose()
    if (error instanceof AcpAuthRequiredError) {
      throw new AgentSessionAcquisitionRefusal(
        `${spec.agent} reported that it is not signed in: ${error.message}`,
        'notSignedIn'
      )
    }
    if (error instanceof AcpStartupTimeoutError) {
      throw new AgentSessionAcquisitionRefusal(error.message, 'hostStopped')
    }
    throw error
  } finally {
    clearTimeout(startupDeadline)
  }
}
