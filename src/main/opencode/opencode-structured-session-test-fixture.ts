import { OpenCodeServerConnection } from './serve/server-connection'
import { openCodeManagedProcessFixture } from './serve/server-process-test-fixture'
import { OpenCodeSessionClient } from './serve/session-client'
import { OpenCodeTimelineTranslator } from './serve/timeline-translator'
import { StructuredAgentSessionTaskQueue } from '../native-chat/agent-session-wire/structured-agent-session-task-queue'
import type { OpenCodeSession } from './opencode-structured-session-state'

export function openCodeSessionTestFixture(
  major: 1 | 2,
  fetchImpl: typeof fetch,
  sessionId = 'chat'
) {
  const managed = openCodeManagedProcessFixture()
  const connection = new OpenCodeServerConnection(managed.process, 48718, 'fixture', fetchImpl)
  const client = new OpenCodeSessionClient(
    connection.peer,
    {
      major,
      version: major === 1 ? '1.18.31' : '2.0.14'
    },
    '/workspace'
  )
  const session: OpenCodeSession = {
    sessionId,
    fence: 1,
    generation: 'fixture-generation',
    launch: {
      command: 'fixture',
      cwd: '/workspace',
      environment: {},
      resumeSessionId: null,
      permissions: [],
      agent: major === 1 ? 'opencode' : 'opencode2'
    },
    connection,
    process: null,
    client,
    root: { id: 'root' },
    translator: new OpenCodeTimelineTranslator({ sessionId: 'root', major }),
    lane: null,
    streamAbort: new AbortController(),
    ready: true,
    ended: false,
    closing: null,
    exitObservedAt: null,
    pending: new Map(),
    claims: new Set(),
    outstanding: new Map(),
    dispatchOrder: [],
    inputRecorded: new Set(),
    optionValues: {},
    restoreSkippedOptions: [],
    options: { model: 'default' },
    commands: [],
    models: [],
    modes: [],
    heldFrames: [],
    heldFrameBytes: 0,
    eventQueue: new StructuredAgentSessionTaskQueue(),
    childActive: new Set()
  }
  return { session, sessions: new Map([[sessionId, session]]), managed }
}
