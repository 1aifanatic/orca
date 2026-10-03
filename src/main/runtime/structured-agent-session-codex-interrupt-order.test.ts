// Codex answers an interrupt it took before it ends the turn: on `TurnAborted` the app-server
// answers pending interrupts, then sends `turn/completed` (interrupted) on the same channel. The
// Stop's settle, which runs between the two, must label the turn the Stop's: no end row for it
// ever reads as a failure. Driven through the shipped host, journal and Codex adapter; only the
// Codex child is fake, and the test delivers the turn's end after the Stop has answered.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import type * as CodexTurnOpenWait from '../codex/codex-structured-turn-open-wait'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalTurnItem } from '../../shared/agent-session-journal-types'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

// The turns a Stop is waiting on to open, so a test knows the wait began.
const openWaits = vi.hoisted(() => {
  const turnIds: string[] = []
  return { turnIds }
})
vi.mock('../codex/codex-structured-turn-open-wait', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexTurnOpenWait>()
  return {
    ...actual,
    createCodexTurnOpenWaits: () => {
      const waits = actual.createCodexTurnOpenWaits()
      return {
        ...waits,
        wait: (turnId: string, withinMs: number) => {
          openWaits.turnIds.push(turnId)
          return waits.wait(turnId, withinMs)
        }
      }
    }
  }
})

const CALLER = { callerKey: 'codex-interrupt-order-test' }
const MODEL = {
  model: 'gpt-test',
  displayName: 'GPT Test',
  hidden: false,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  isDefault: true
}

let root: string
let host: StructuredAgentSessionHost
let fence: number
let handlers: CodexAppServerConnectionHandlers | undefined
let answers: number
let interrupts: number
let turns: ReturnType<typeof codexTurnLifecycleFake>
let statuses: AgentSessionStatusSummary[]
let operations = 0

/** The durable ledger stamps its own clock and refuses an id far from it. */
const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

function envelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

async function stop(turnId?: string): Promise<void> {
  const stopped = await host.cancel(CALLER, {
    envelope: envelope('agentSession.cancel', turnId === undefined ? {} : { turnId }),
    ...(turnId === undefined ? {} : { turnId })
  })
  if (!stopped.ok) {
    throw new Error(JSON.stringify(stopped.refusal))
  }
}

/** Every end row written for turn-1, as a row or a lifecycle batch's mutation, in order. */
function turnEndRows(): AgentJournalTurnItem[] {
  return liveTestJournalRows(openTestJournalHostDatabase(root).db, SESSION).flatMap((stored) => {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      return []
    }
    const { row } = parsed
    const bodies = row.kind === 'lifecycle-batch' ? row.mutations : [row]
    return bodies.flatMap((entry) =>
      entry.kind === 'item' &&
      entry.body.kind === 'turn' &&
      entry.body.turnId === 'turn-1' &&
      entry.body.state !== 'running'
        ? [entry.body]
        : []
    )
  })
}

/** The Stop has answered with Codex's end still to come; then Codex ends the turn. Stopping
 *  showed while the Stop settled, ended with the turn, and no status read the turn as failed. */
async function expectInterruptedThroughout(): Promise<void> {
  expect(interrupts).toBe(1)
  expect(turnEndRows()).toEqual([
    expect.objectContaining({ state: 'interrupted', outcome: 'cancellation' })
  ])

  turns.end('interrupted')

  await vi.waitFor(async () => expect(await owesWork()).toBe(false))
  const ends = turnEndRows()
  expect(ends.length).toBeGreaterThan(0)
  for (const end of ends) {
    expect(end).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  }
  await vi.waitFor(() =>
    expect(statuses.at(-1)).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
  )
  expect(statuses.some((summary) => summary.stopping === true)).toBe(true)
  expect(statuses.at(-1)).not.toHaveProperty('stopping')
  const otherVerdicts = statuses.filter(
    (summary) => summary.turnOutcome !== undefined && summary.turnOutcome !== 'cancellation'
  )
  expect(otherVerdicts).toEqual([])
}

async function owesWork(): Promise<boolean> {
  const snapshot = await host.journalSnapshot(SESSION)
  return owesStructuredAgentSessionWork(snapshot.items, snapshot.submissions, fence)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-interrupt-order-'))
  openWaits.turnIds.length = 0
  answers = 0
  interrupts = 0
  turns = codexTurnLifecycleFake(
    THREAD,
    () => (method, params) => handlers?.onNotification?.(method, params)
  )
  const openConnection: typeof openCodexAppServerConnection = async (
    _launch,
    connectionHandlers = {}
  ) => {
    handlers = connectionHandlers
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method) => {
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: THREAD } }
        }
        if (method === 'model/list') {
          return { data: [MODEL], nextCursor: null }
        }
        if (method === 'turn/start') {
          answers += 1
          return turns.routes['turn/start']()
        }
        if (method === 'turn/interrupt') {
          // Taken: answered now; the test sends the turn's end once the Stop has answered.
          interrupts += 1
          return {}
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    }
    return connection
  }
  host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
    resolveCodexCommand: () => 'codex',
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    openCodexConnection: openConnection,
    readProcessStartTime: async () => 1_700_000_000_000
  })
  const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
  attachParams.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, attachParams)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  fence = attached.value.fence
  statuses = []
  host.subscribeStatus({
    id: 'interrupt-order',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        statuses.push(event.session)
      }
    }
  })
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

describe("a Codex Stop answered before Codex's turn/completed (interrupted)", () => {
  it.each([
    ['names the running turn', 'turn-1'],
    ['names no turn', undefined]
  ] as const)(
    'reads the turn as interrupted by the Stop, never failed, when it %s',
    async (_, named) => {
      await send('look around')
      await vi.waitFor(() => expect(answers).toBe(1))
      turns.start()

      await stop(named)

      await expectInterruptedThroughout()
    }
  )

  // No turn showed when the person pressed Stop: the turn that opens is bound by the Stop's settle.
  it('reads the turn that opens behind an in-flight turn/start as interrupted, never failed', async () => {
    const release = turns.holdNextAnswer()
    await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    const stopping = stop()
    release()
    await vi.waitFor(() => expect(openWaits.turnIds).toContain('turn-1'))
    turns.start()
    await stopping

    await expectInterruptedThroughout()
  })
})
