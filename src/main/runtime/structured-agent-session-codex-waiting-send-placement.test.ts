// A send Codex takes while the turn before it has not opened yet waits for that turn: the client
// draws it after that turn's rows as they stream, never inside them. Driven through the shipped
// host, journal and Codex adapter; only the Codex child is fake, keeping Codex 0.157's turn
// bookkeeping, and the rows are drawn by the client's own projection.

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
import { settledWithin } from '../codex/codex-structured-dispatch-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import { projectNativeChatTranscriptMessages } from '../../shared/native-chat-transcript-projection'
import { nativeChatRowsInDrawOrder } from '../../shared/native-chat-turn-grouping'
import { nativeChatTurnMembership } from '../../shared/native-chat-turn-membership'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const CALLER = { callerKey: 'codex-waiting-send-test' }
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
let steers: number
let turns: ReturnType<typeof codexTurnLifecycleFake>
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

/** `/compact` as the chat surface runs it; refused while the chat still owes work. */
async function compact() {
  const command = 'compact' as const
  return host.conversationCommand(CALLER, {
    command,
    envelope: envelope('agentSession.conversationCommand', { command })
  })
}

async function submissions(): Promise<readonly AgentJournalSubmission[]> {
  await host.flushStreamedEvents(SESSION)
  return (await host.journalSnapshot(SESSION)).submissions
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-waiting-send-'))
  answers = 0
  steers = 0
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
      request: async (method, params) => {
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
        if (method === 'turn/steer') {
          steers += 1
          return turns.routes['turn/steer'](params)
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
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  await rm(root, { recursive: true, force: true })
})

/** Each row's text, in the order the client draws the conversation now. */
async function drawn(): Promise<string[]> {
  await host.flushStreamedEvents(SESSION)
  const { items, submissions } = await host.journalSnapshot(SESSION)
  const rows = projectNativeChatTranscriptMessages(
    projectStructuredAgentSessionMessages(items, [], submissions)
  )
  const { drawOrder } = nativeChatTurnMembership(rows, { items, submissions })
  return nativeChatRowsInDrawOrder(rows, drawOrder).map((row) =>
    row.blocks.map((block) => ('text' in block ? block.text : block.type)).join('')
  )
}

async function handedOver(clientMessageId: string): Promise<boolean> {
  return (
    (await submissions()).find((entry) => entry.clientMessageId === clientMessageId)
      ?.handedOverAt !== undefined
  )
}

/** A finished first turn, then `/compact` running, so the sends that follow queue behind it. */
async function compactRunning(): Promise<{ compacted: Promise<unknown> }> {
  const warmUp = await send('warm up')
  await vi.waitFor(() => expect(answers).toBe(1))
  turns.start()
  turns.echo(warmUp)
  turns.end('completed')
  const compacted = compact()
  await vi.waitFor(async () =>
    expect(
      (await host.journalSnapshot(SESSION)).items.some(
        (item) => readAgentJournalTurn(item.body)?.state === 'running'
      )
    ).toBe(true)
  )
  return { compacted }
}

/** Codex compacts and ends that turn; the host then hands every queued send over at once. */
async function finishCompaction(
  { compacted }: { compacted: Promise<unknown> },
  sends: readonly string[]
) {
  handlers?.onNotification?.('turn/started', {
    threadId: THREAD,
    turn: { id: 'turn-compact', status: 'inProgress' }
  })
  handlers?.onNotification?.('thread/compacted', { threadId: THREAD })
  handlers?.onNotification?.('turn/completed', {
    threadId: THREAD,
    turn: { id: 'turn-compact', status: 'completed' }
  })
  expect(await settledWithin(compacted, 3_000)).not.toBe('held')
  for (const sent of sends) {
    await vi.waitFor(async () => expect(await handedOver(sent)).toBe(true))
  }
}

function says(text: string, id: string): void {
  handlers?.onNotification?.('item/completed', {
    threadId: THREAD,
    turn: { id: turns.turnId },
    item: { type: 'agentMessage', id, text }
  })
}

describe('a send Codex takes before the turn ahead of it opens', () => {
  it('is drawn after that turn as it streams, not between its message and its reply', async () => {
    const compaction = await compactRunning()
    const first = await send('queued first')
    const second = await send('queued second')
    await finishCompaction(compaction, [first, second])

    turns.start()
    turns.echo(first)
    says('working on the first', 'reply-1')

    await vi.waitFor(async () =>
      expect(await drawn()).toEqual([
        'warm up',
        '/compact',
        'Context compacted',
        'queued first',
        'working on the first',
        'queued second'
      ])
    )
  })

  // A later send steered into that turn joins it; the one waiting still waits for the turn's end.
  it('is drawn after a later send steered into that turn', async () => {
    const compaction = await compactRunning()
    const zero = await send('queued zero')
    const waiting = await send('queued A')
    await finishCompaction(compaction, [zero, waiting])

    turns.start()
    turns.echo(zero)
    says('working on zero', 'reply-0')
    await vi.waitFor(async () => expect(await drawn()).toContain('working on zero'))
    const steered = await send('queued B')
    await vi.waitFor(() => expect(steers).toBe(1))
    await vi.waitFor(async () => expect(await handedOver(steered)).toBe(true))

    await vi.waitFor(async () =>
      expect(await drawn()).toEqual([
        'warm up',
        '/compact',
        'Context compacted',
        'queued zero',
        'working on zero',
        'queued B',
        'queued A'
      ])
    )
  })
})
