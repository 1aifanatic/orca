// A Codex send a UserPromptSubmit hook of the person's own blocked. Codex records and echoes
// nothing for a blocked prompt and still completes the turn, but reports the block itself as
// `hook/completed` inside that turn. Its completed end settles the send as blocked, with the
// hook's reason, so the chat stops reading as working. With no such report a completed turn
// settles nothing, and a send only Codex's echo settles is never settled early. Driven through the
// shipped host, journal and Codex adapter; only the Codex child is fake.

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
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
import { classifyDispatchRejection } from '../../shared/structured-agent-session-dispatch-rejection'
import { CodexAppServerRequestError } from '../codex/codex-app-server-connection'
import { MAX_CODEX_HOOK_REASON_CHARS } from '../codex/codex-structured-prompt-block'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox
} from '../../shared/structured-agent-session-outbox'
import { admitStructuredAgentSessionOutboxEntry } from '../../shared/structured-agent-session-outbox-admission'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../shared/agent-session-failure-words'
import { undeliveredSentElsewhere } from '../../shared/structured-agent-session-failed-start-elsewhere'
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

const CALLER = { callerKey: 'codex-hook-blocked-send-test' }
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
/** How Codex answers a start or a steer; a test may answer otherwise. */
let routes: {
  start: () => unknown
  steer: (params: Record<string, unknown> | undefined) => unknown
}

/** The durable ledger stamps its own clock and refuses an id far from it. */
const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

function notify(method: string, params: Record<string, unknown>): void {
  handlers?.onNotification?.(method, params)
}

/** Codex's report that a UserPromptSubmit hook of the person's blocked the prompt in this turn. */
function hookBlocked(
  turnId: string,
  status: 'blocked' | 'stopped',
  entries: { kind: string; text: string }[]
): void {
  notify('hook/completed', {
    threadId: THREAD,
    turnId,
    run: {
      id: 'hook-1',
      eventName: 'userPromptSubmit',
      handlerType: 'command',
      executionMode: 'sync',
      scope: 'turn',
      sourcePath: '/home/person/.codex/hooks/check.sh',
      source: 'user',
      displayOrder: 0,
      status,
      statusMessage: null,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      entries
    }
  })
}

async function snapshot(): Promise<AgentJournalSnapshot> {
  await host.flushStreamedEvents(SESSION)
  return host.journalSnapshot(SESSION)
}

function verdictOf(journal: AgentJournalSnapshot, clientMessageId: string) {
  const submission = journal.submissions.find((entry) => entry.clientMessageId === clientMessageId)
  return submission?.dispatchState === 'rejected'
    ? classifyDispatchRejection(submission).kind
    : submission?.dispatchState
}

/** The shared rule every surface reads "working" from. */
function working(journal: AgentJournalSnapshot): boolean {
  return owesStructuredAgentSessionWork(journal.items, journal.submissions, fence)
}

/** The opening send, echoed, in a running turn. */
async function runningTurn(): Promise<void> {
  const opening = await send('look around')
  await vi.waitFor(() => expect(answers).toBe(1))
  turns.start()
  turns.echo(opening)
}

/** A follow-up Codex answered as a steer into the running turn. */
async function steered(text: string): Promise<string> {
  const before = steers
  const followUp = await send(text)
  await vi.waitFor(() => expect(steers).toBe(before + 1))
  return followUp
}

/** The send settled as a hook's block, nothing reads as working, and the next send opens a turn. */
async function blockedAndTheChatMovesOn(clientMessageId: string) {
  await vi.waitFor(async () =>
    expect(verdictOf(await snapshot(), clientMessageId)).toBe('hookBlocked')
  )
  const journal = await snapshot()
  expect(working(journal)).toBe(false)
  const before = answers
  await send('carry on')
  await vi.waitFor(() => expect(answers).toBe(before + 1))
  return journal.submissions.find((entry) => entry.clientMessageId === clientMessageId)
}

/** What a desktop shows for the message, read from its journal row. */
function sentenceFor(journal: AgentJournalSnapshot, clientMessageId: string): string | undefined {
  const row = undeliveredSentElsewhere(journal.submissions, []).find(
    (entry) => entry.clientMessageId === clientMessageId
  )
  const fact = readWholeAgentSessionFailureFact(row?.rejection)
  return fact && agentSessionFailureSentence(fact, 'rejection', { retryControl: false })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-hook-blocked-send-'))
  answers = 0
  steers = 0
  routes = {
    start: () => turns.routes['turn/start'](),
    steer: (params) => turns.routes['turn/steer'](params)
  }
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
          return routes.start()
        }
        if (method === 'turn/steer') {
          steers += 1
          return routes.steer(params)
        }
        if (method === 'turn/interrupt') {
          return turns.routes['turn/interrupt'](params)
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

describe('a Codex send a hook of the person blocked', () => {
  it("settles a blocked steer with the hook's reason, and the chat moves on", async () => {
    await runningTurn()
    const followUp = await steered('and paste the API key')
    hookBlocked('turn-1', 'blocked', [{ kind: 'feedback', text: 'No secrets in prompts.' }])
    turns.end('completed')

    const row = await blockedAndTheChatMovesOn(followUp)
    expect(row?.rejection).toEqual({
      kind: 'hookBlocked',
      detail: { text: 'No secrets in prompts.', audience: 'person' }
    })
    expect(sentenceFor(await snapshot(), followUp)).toBe(
      'A hook blocked this message: No secrets in prompts.'
    )
  })

  it('settles a blocked send that opened its turn the same way', async () => {
    const opening = await send('paste the API key')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    hookBlocked('turn-1', 'blocked', [{ kind: 'feedback', text: 'No secrets in prompts.' }])
    turns.end('completed')

    await blockedAndTheChatMovesOn(opening)
    expect(sentenceFor(await snapshot(), opening)).toBe(
      'A hook blocked this message: No secrets in prompts.'
    )
  })

  it('says only that a hook blocked it when the hook gave no reason', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    hookBlocked('turn-1', 'stopped', [])
    turns.end('completed')

    const row = await blockedAndTheChatMovesOn(followUp)
    expect(row?.rejection).toEqual({ kind: 'hookBlocked' })
    expect(sentenceFor(await snapshot(), followUp)).toBe('A hook blocked this message.')
  })

  it('keeps a long or marked-up reason plain and bounded', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    const reason = `<b>Denied</b>\n**by policy**\u0007\u202e ${'x'.repeat(600)}`
    hookBlocked('turn-1', 'stopped', [{ kind: 'stop', text: reason }])
    turns.end('completed')

    const row = await blockedAndTheChatMovesOn(followUp)
    const text = readWholeAgentSessionFailureFact(row?.rejection)?.detail?.text ?? ''
    expect(text.startsWith('<b>Denied</b> **by policy** x')).toBe(true)
    expect(text).toHaveLength(MAX_CODEX_HOOK_REASON_CHARS)
    expect(text.endsWith('\u2026')).toBe(true)
    // oxlint-disable-next-line no-control-regex -- asserting no control characters remain.
    expect(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e]/.test(text)).toBe(false)
  })

  it('leaves a send a completed turn never echoed pending when no hook blocked it', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    // A hook that ran and let the prompt through, and a block in another turn, block nothing here.
    notify('hook/completed', {
      threadId: THREAD,
      turnId: 'turn-1',
      run: { eventName: 'userPromptSubmit', status: 'completed', entries: [] }
    })
    hookBlocked('turn-0', 'blocked', [{ kind: 'feedback', text: 'Not this one.' }])
    turns.end('completed')

    await snapshot()
    expect(verdictOf(await snapshot(), followUp)).toBe('pending')
  })

  it('leaves a steer Codex echoed as delivered', async () => {
    await runningTurn()
    const followUp = await steered('and check the tests')
    turns.echo(followUp)
    turns.end('completed')

    await vi.waitFor(async () => expect(verdictOf(await snapshot(), followUp)).toBe('accepted'))
    expect(working(await snapshot())).toBe(false)
  })

  // Codex may answer a send that falls through to a new turn before it opens that turn, and report
  // the old turn's end and the thread idle in between. Only Codex's echo settles that send.
  it('delivers a send answered into a turn that opens after the last one ended', async () => {
    await runningTurn()
    routes.steer = () => {
      throw new CodexAppServerRequestError(
        'turn/steer',
        -32600,
        'codex app-server turn/steer failed: no active turn to steer',
        'no active turn to steer'
      )
    }
    routes.start = () => ({ turn: { id: 'turn-2', status: 'inProgress' } })
    const followUp = await send('and check the tests')
    await vi.waitFor(() => expect(answers).toBe(2))

    turns.end('completed')
    notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } })
    await snapshot()
    expect(verdictOf(await snapshot(), followUp)).toBe('pending')

    notify('turn/started', { threadId: THREAD, turn: { id: 'turn-2', status: 'inProgress' } })
    notify('item/completed', {
      threadId: THREAD,
      turn: { id: 'turn-2' },
      item: { type: 'userMessage', id: 'item-user-2', clientId: followUp, content: [] }
    })
    await vi.waitFor(async () => expect(verdictOf(await snapshot(), followUp)).toBe('accepted'))
  })

  // The desktop reads the host's rows as it does for any message the agent never got.
  it("is drawn from its row with the hook's words and no Retry, on every desktop", async () => {
    await runningTurn()
    const followUp = await steered('and paste the API key')
    hookBlocked('turn-1', 'blocked', [{ kind: 'feedback', text: 'No secrets in prompts.' }])
    turns.end('completed')
    await vi.waitFor(async () => expect(verdictOf(await snapshot(), followUp)).toBe('hookBlocked'))
    const journal = await snapshot()
    const key = agentJournalSubmissionKey(followUp)

    // The sending desktop lets its copy go, as no Retry can get past the hook.
    const queued = (clientMessageId: string, text: string) =>
      createStructuredAgentSessionOutboxEntry({
        clientMessageId,
        sessionId: SESSION,
        text,
        attachments: [],
        queuedAt: 1
      })
    const next = queued('op-next', 'carry on')
    const outbox = reconcileStructuredAgentSessionOutbox(
      [
        { ...queued(followUp, 'and paste the API key'), state: 'dispatching', lastAttemptAt: 1 },
        next
      ],
      journal.submissions
    )
    expect(outbox).toEqual([next])
    expect(admitStructuredAgentSessionOutboxEntry(outbox)).toEqual({
      state: 'dispatch',
      entry: next
    })

    // So every desktop, the sender included, draws it from its row as unsent.
    for (const sentHere of [outbox, []]) {
      expect(
        projectStructuredAgentSessionMessages(journal.items, sentHere, journal.submissions)
      ).toContainEqual(expect.objectContaining({ id: key, unsent: true }))
    }
    expect(sentenceFor(journal, followUp)).toBe(
      'A hook blocked this message: No secrets in prompts.'
    )
    // The phone, which can't mark a message unsent yet, keeps it hidden.
    expect(
      projectStructuredAgentSessionMessages(journal.items, [], journal.submissions, {
        showsUndeliveredSentElsewhere: false
      }).map(({ id }) => id)
    ).not.toContain(key)
  })
})
