import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { StructuredAgentSessionTaskQueue } from '../native-chat/agent-session-wire/structured-agent-session-task-queue'
import { applyOpenCodeCatalog } from './opencode-structured-session-options'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  structuredProviderProcessIdentity,
  STRUCTURED_PROVIDER_SPAWN_TOKEN_ENV
} from '../provider-process/structured-process-identity'
import { openOpenCodeServer, type OpenCodeServerConnection } from './serve/server-connection'
import { OpenCodeSessionClient } from './serve/session-client'
import { restoreOpenCodeSessionHistory } from './opencode-structured-session-history'
import { OpenCodeTimelineTranslator } from './serve/timeline-translator'
import { openCodeSelectedModel } from './serve/session-catalog'
import { OPENCODE_SERVE_TRANSPORT } from './opencode-structured-agent-definition'
import type {
  OpenCodeSession,
  OpenCodeStructuredLaunch,
  OpenCodeStructuredSessionAdapterDeps
} from './opencode-structured-session-state'

const CONNECT_TIMEOUT_MS = 30_000

export async function acquireOpenCodeSession(input: {
  request: StructuredAgentSessionAcquireInput
  deps: OpenCodeStructuredSessionAdapterDeps
  sessions: Map<string, OpenCodeSession>
  onFrame: (
    session: OpenCodeSession,
    event: Parameters<OpenCodeTimelineTranslator['translate']>[0]
  ) => Promise<void>
  onExit: (session: OpenCodeSession) => void
  close: (sessionId: string) => Promise<boolean>
  activate: (session: OpenCodeSession) => Promise<void>
  cancelled: () => boolean
}): Promise<AgentSessionAcquisition> {
  const { request, deps, sessions } = input
  const sessionId = request.identity.sessionId
  const previous = sessions.get(sessionId)
  if (previous && !(await input.close(sessionId))) {
    throw new AgentSessionAcquisitionExitUnprovenError(
      new Error('Previous OpenCode server remains owned')
    )
  }
  let launch: OpenCodeStructuredLaunch
  try {
    const resolved = await withTimeout(
      deps.resolveLaunch({ identity: request.identity }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      ),
      30_000,
      null
    )
    if (!resolved) {
      throw new Error('OpenCode launch resolution did not finish')
    }
    if (!resolved.ok) {
      throw resolved.error
    }
    launch = resolved.value
  } catch (error) {
    throw new AgentSessionPreSpawnError(error)
  }
  if (launch.agent !== request.identity.agent) {
    throw new AgentSessionPreSpawnError(new Error('OpenCode launch agent does not match the chat'))
  }
  if (input.cancelled()) {
    throw new AgentSessionPreSpawnError(new Error('OpenCode acquisition closed before spawn'))
  }
  const generation = deps.mintAcquisitionGeneration?.() ?? randomUUID()
  const open = deps.openServer ?? openOpenCodeServer
  let connection: OpenCodeServerConnection
  try {
    connection = await open({
      command: launch.command,
      cwd: launch.cwd,
      environment: {
        ...launch.environment,
        [STRUCTURED_PROVIDER_SPAWN_TOKEN_ENV]: request.spawnToken
      },
      sessionId
    })
  } catch (error) {
    throw new AgentSessionPreSpawnError(error)
  }
  const session: OpenCodeSession = {
    sessionId,
    fence: request.fence,
    generation,
    launch,
    connection,
    process: null,
    client: null,
    root: null,
    translator: null,
    lane: null,
    streamAbort: new AbortController(),
    ready: false,
    ended: false,
    closing: null,
    exitObservedAt: null,
    pending: new Map(),
    claims: new Set(),
    outstanding: new Map(),
    dispatchOrder: [],
    inputRecorded: new Set(),
    optionValues: { ...launch.options, ...request.options },
    restoreSkippedOptions: [],
    options: { model: launch.options?.model ?? '' },
    commands: [],
    models: [],
    modes: [],
    heldFrames: [],
    heldFrameBytes: 0,
    eventQueue: new StructuredAgentSessionTaskQueue(),
    childActive: new Set()
  }
  sessions.set(sessionId, session)
  connection.process.onExit(() => input.onExit(session))
  try {
    if (input.cancelled()) {
      throw new Error('OpenCode acquisition closed during spawn')
    }
    const processIdentity = await structuredProviderProcessIdentity(
      {
        identity: request.identity,
        spawnToken: request.spawnToken,
        pid: connection.process.child.pid,
        processName: 'OpenCode server'
      },
      deps.readProcessStartTime
    )
    session.process = processIdentity
    await request.onSpawned?.(processIdentity)
    const version = await connection.waitUntilReady()
    if (session.ended || input.cancelled()) {
      throw new Error('OpenCode server exited during startup')
    }
    const client = new OpenCodeSessionClient(connection.peer, version, launch.cwd)
    session.client = client
    let connected = false
    let acceptConnected = (): void => {}
    let rejectConnected = (_error: unknown): void => {}
    const connectedPromise = new Promise<void>((resolve, reject) => {
      acceptConnected = resolve
      rejectConnected = reject
    })
    const stream = client.events(async (event) => {
      if (sessions.get(sessionId) !== session || session.ended) {
        return
      }
      if (event.type === 'server.connected') {
        connected = true
        acceptConnected()
        return
      }
      if (!connected) {
        return
      }
      await input.onFrame(session, event)
    }, session.streamAbort.signal)
    void stream.catch((error: unknown) => {
      rejectConnected(error)
      if (
        !session.streamAbort.signal.aborted &&
        !session.ended &&
        sessions.get(sessionId) === session
      ) {
        deps.logger?.error('OpenCode event stream ended', {
          scope: 'opencode-event-stream',
          sessionId,
          error
        })
        session.closing ??= 'unexpected-exit'
        void input.close(sessionId).catch((closeError: unknown) =>
          deps.logger?.error('OpenCode event stream close failed', {
            scope: 'opencode-event-stream',
            sessionId,
            error: closeError
          })
        )
      }
    })
    const connectTimeout = new AbortController()
    try {
      await Promise.race([
        connectedPromise,
        delay(CONNECT_TIMEOUT_MS, undefined, { signal: connectTimeout.signal }).then(() => {
          throw new Error('OpenCode event stream did not connect')
        })
      ])
    } finally {
      connectTimeout.abort()
    }
    if (session.ended || input.cancelled()) {
      throw new Error('OpenCode server exited during startup')
    }
    const initialModel = openCodeSelectedModel(session.optionValues)
    const root = launch.resumeSessionId
      ? await client.load(launch.resumeSessionId)
      : await client.create({
          permissions: launch.permissions,
          ...(initialModel ? { model: initialModel } : {})
        })
    if (root.parentID || (launch.resumeSessionId && root.id !== launch.resumeSessionId)) {
      throw new Error('OpenCode resumed a different root session')
    }
    session.root = root
    const translator = new OpenCodeTimelineTranslator({ sessionId: root.id, major: version.major })
    session.translator = translator
    translator.registerSession(root)
    await restoreOpenCodeSessionHistory(session, request.events)
    let catalog = await client.readCatalog(root.id).catch(() => null)
    if (catalog && version.major === 2) {
      for (const key of ['model', 'effort', 'mode'] as const) {
        const value = session.optionValues[key]
        if (!value || catalog.current[key] === value) {
          continue
        }
        try {
          session.optionValues = await client.setOption(root.id, key, value, session.optionValues)
        } catch (error) {
          session.restoreSkippedOptions.push(key)
          delete session.optionValues[key]
          deps.logger?.warn('OpenCode saved option could not be restored', {
            scope: 'opencode-option-restore',
            sessionId,
            key,
            error
          })
        }
      }
      catalog = await client.readCatalog(root.id).catch(() => catalog)
    }
    if (catalog) {
      applyOpenCodeCatalog(session, catalog, deps)
    }
    await input.activate(session)
    if (session.ended || sessions.get(sessionId) !== session || input.cancelled()) {
      throw new Error('OpenCode acquisition closed before publication')
    }
    return {
      process: processIdentity,
      link: {
        linkId: deps.mintLinkId?.() ?? randomUUID(),
        handle: { transport: OPENCODE_SERVE_TRANSPORT, agent: launch.agent, nativeId: root.id },
        origin: launch.resumeSessionId ? 'resumed' : 'created',
        mintedAtFence: request.fence,
        observedAt: deps.now?.() ?? Date.now()
      },
      acquisitionGeneration: generation
    }
  } catch (error) {
    session.closing ??= 'unexpected-exit'
    let closed = false
    try {
      closed = await input.close(sessionId)
    } catch (closeError) {
      if (closeError instanceof AgentSessionAcquisitionRootExitObservedError) {
        throw new AgentSessionAcquisitionRootExitObservedError(error)
      }
    }
    if (!closed) {
      throw new AgentSessionAcquisitionExitUnprovenError(error)
    }
    if (connection.process.processless) {
      throw new AgentSessionPreSpawnError(error)
    }
    if (
      connection.process.rootExitObserved &&
      connection.process.lastCloseResult?.tree !== 'exited'
    ) {
      throw new AgentSessionAcquisitionRootExitObservedError(error)
    }
    throw new AgentSessionAcquisitionExitProvenError(error)
  }
}
