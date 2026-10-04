// Making a reservation real for an ACP agent: spawn the child, record it before any handshake,
// initialize with the client's file system and terminals off, then load the session this chat
// proved or start a new one.

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
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import { AcpStructuredTurns, type AcpStructuredTurnsDeps } from './acp-structured-turns'
import { RequestPermissionResponseSchema } from './generated/acp-protocol.generated'

/** ACP's "resource not found": the agent holds no session under the id this chat proved. */
const ACP_RESOURCE_NOT_FOUND = -32002
/** Frames an agent may send before its session exists; past this the start is refused. */
const MAX_EARLY_FRAMES = 2_048

export function acpAgentName(agent: string): string {
  return isTuiAgent(agent) ? TUI_AGENT_DISPLAY_NAMES[agent] : agent
}

export async function acquireAcpStructuredSession(input: {
  acquire: StructuredAgentSessionAcquireInput
  deps: AcpStructuredSessionAdapterDeps
  generation: string
  /** Registers the child so a close during the acquire can stop it. */
  track: (child: AcpStructuredChild) => void
  /** The child's exit, observed while or after the session exists. */
  onExit: (session: AcpStructuredSession | null) => void
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
  const launch: AcpStructuredLaunch = await deps
    .resolveLaunch({ identity: acquire.identity })
    .catch((error: unknown) => {
      throw new AgentSessionPreSpawnError(error)
    })
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
  let lane: AcpStructuredLane | null = null
  const options = new AcpStructuredOptions()
  const prompts = new AcpStructuredPrompts(() => lane)
  const early: (() => void)[] = []
  const whenLane = (deliver: () => void): void => {
    if (lane) {
      deliver()
    } else if (early.length < MAX_EARLY_FRAMES) {
      early.push(deliver)
    }
  }
  const runtime = new AcpSessionRuntime(child.stdout, child.stdin, {
    clientInfo: { name: 'orca', version: '1' },
    ...(deps.cancelTimeoutMs === undefined ? {} : { cancelTimeoutMs: deps.cancelTimeoutMs }),
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
      whenLane(() => lane?.apply(lane.translator.notification(method, params, now()))),
    onDiagnostic: (message) =>
      deps.logger?.warn('ACP agent protocol diagnostic', {
        scope: 'acp-diagnostic',
        sessionId,
        message
      })
  })
  runtime.subscribe((event: AcpSessionEvent) =>
    whenLane(() => lane && routeAcpSessionEvent({ lane, options }, event, now()))
  )
  child.onExit(() => {
    runtime.close(new Error(child.stderrTail() || `${spec.command} exited`))
    input.onExit(session)
  })
  const identity = providerSpawnedProcessIdentity(
    acquire,
    `${spec.agent} ACP agent`,
    deps.readProcessStartTime
  )
  const makeLane = (providerSessionId: string): AcpStructuredLane => {
    lane = new AcpStructuredLane({
      sink,
      sessionId,
      agent: spec.agent,
      generation,
      providerSessionId,
      dialect: spec.dialect,
      onInputAccepted: (clientMessageId) => session?.turns.accept(clientMessageId),
      onFailed: () => input.forceClose(sessionId)
    })
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
  try {
    const initialized = await runtime.initialize()
    const resume = launch.resume
    let started: Awaited<ReturnType<AcpSessionRuntime['start']>> | null = null
    let liveLane: AcpStructuredLane | null = null
    let supersedesKey: string | undefined
    if (resume) {
      const loading = makeLane(resume.sessionId)
      liveLane = loading
      const replays = initialized.agentCapabilities?.loadSession === true
      if (replays) {
        // The translator recognises replayed history against what the journal already holds.
        await events?.written?.()
        loading.translator.beginLoad()
      }
      try {
        started = await runtime.start({
          cwd: launch.cwd,
          mcpServers: [],
          sessionId: resume.sessionId
        })
      } catch (error) {
        const notFound = error instanceof AcpRpcError && error.code === ACP_RESOURCE_NOT_FOUND
        if (!notFound || resume.replaceableKey === null) {
          throw error
        }
        // A session this chat created and the agent never saved: a new one takes its place.
        supersedesKey = resume.replaceableKey
      } finally {
        if (replays) {
          loading.apply(loading.translator.finishLoad(now()))
        }
      }
    }
    if (!started || !liveLane) {
      liveLane?.dispose()
      lane = null
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
        agentName: acpAgentName(spec.agent),
        now,
        settle: input.onSettled
      }),
      restoreSkipped,
      closeRequested: false,
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
    if (child.exited) {
      throw new Error(child.stderrTail() || `${spec.command} exited while starting`)
    }
    return { acquisition: { process, link, acquisitionGeneration: generation }, session }
  } catch (error) {
    session = null
    lane?.dispose()
    if (error instanceof AcpAuthRequiredError) {
      throw new AgentSessionAcquisitionRefusal(
        `${spec.agent} reported that it is not signed in: ${error.message}`,
        'notSignedIn'
      )
    }
    throw error
  }
}
