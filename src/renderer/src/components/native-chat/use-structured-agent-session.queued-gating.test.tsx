// @vitest-environment happy-dom

// Capability gating for mid-turn queueing at the session controller: only a
// host advertising `agent-session.queued-messages.v1` gets `delivery` or the
// card RPCs — anything older sees exactly today's client. Stop and /clear are
// today's plain writes for every host: drafts are never withdrawn by either,
// and no draft text ever rides an answer. A host-held draft is a card above
// the composer, never a transcript bubble.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { withdrawUnsentStructuredAgentSessionOutboxEntries } from '../../../../shared/structured-agent-session-outbox-stop-withdrawal'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import type * as RewindModule from './use-native-chat-rewind'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  outboxArgs: Array.of<{ queueDelivery?: { capability: string; enabled: boolean } }>(),
  operations: 0,
  /** A rewind this pane started is on its way. */
  rewindPending: false
}))
let items: AgentJournalRenderItem[] = []
let queuedMessages: AgentSessionQueuedMessage[] | undefined
let submissions: AgentJournalSubmission[] = []
let outboxEntries: StructuredAgentSessionOutboxEntry[] = []

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items,
      submissions,
      status: 'ready',
      error: null,
      hasOlder: false,
      ...(queuedMessages !== undefined ? { queuedMessages } : {})
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

// The real rewind hook, with only its in-flight latch forced when a test says so.
vi.mock('./use-native-chat-rewind', async (importOriginal) => {
  const actual = await importOriginal<typeof RewindModule>()
  return {
    ...actual,
    useStructuredAgentSessionRewind: (
      ...args: Parameters<typeof actual.useStructuredAgentSessionRewind>
    ) => {
      const rewind = actual.useStructuredAgentSessionRewind(...args)
      return mocks.rewindPending ? { ...rewind, blockedRef: { current: true } } : rewind
    }
  }
})

vi.mock('./use-structured-agent-session-outbox', () => ({
  structuredSessionOperationId: () => `operation-${++mocks.operations}`,
  useStructuredAgentSessionOutbox: (args: {
    queueDelivery?: { capability: string; enabled: boolean }
  }) => {
    mocks.outboxArgs.push(args)
    return {
      outbox: outboxEntries,
      error: null,
      send: vi.fn(),
      retry: vi.fn(),
      withdrawUnsent: vi.fn()
    }
  }
}))

import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { ConversationCommandParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { useStructuredAgentSession } from './use-structured-agent-session'

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
}

function draft(id: string): AgentSessionQueuedMessage {
  return {
    messageId: id,
    position: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `queued ${id}` }] },
    state: 'waiting'
  }
}

function render(queueFollowUps?: boolean) {
  return renderHook(() =>
    useStructuredAgentSession({
      sessionId: 'session-1',
      agent: 'claude',
      target: { kind: 'local' },
      isVisible: true,
      composerScopeKey: 'scope-1',
      ...(queueFollowUps === undefined ? {} : { queueFollowUps })
    })
  )
}

function cancels(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.cancel')
    .map(([, , params]) => params)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.outboxArgs.length = 0
  mocks.rewindPending = false
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.cancel'
      ? {
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'e', sequence: 1 },
          value: { cancelled: true }
        }
      : null
  )
  items = [RUNNING_TURN]
  queuedMessages = undefined
  submissions = []
  outboxEntries = []
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('against a capable host', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
    ])
  })

  it('queues sends while the setting is on, immediately when it is off', () => {
    render()
    expect(mocks.outboxArgs.at(-1)?.queueDelivery).toEqual({
      capability: 'supported',
      enabled: true
    })
    mocks.outboxArgs.length = 0
    render(false)
    expect(mocks.outboxArgs.at(-1)?.queueDelivery).toEqual({
      capability: 'supported',
      enabled: false
    })
  })

  // The host's queue would hold a send behind a prompt nothing here can settle.
  it('sends immediately while every pending prompt is one this build cannot answer', () => {
    const approval = (subject: Record<string, unknown>): AgentJournalRenderItem =>
      JSON.parse(
        JSON.stringify({
          itemId: `approval-${String(subject.kind)}`,
          revision: 1,
          sequence: 2,
          observedAt: 1,
          body: {
            kind: 'approval',
            title: 'Review',
            detail: null,
            subject,
            options: [{ id: 'allow', label: 'Approve' }],
            resolution: {
              state: 'pending',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        })
      )
    const newer = approval({ kind: 'diff', path: 'a.ts' })
    items = [newer]
    render()
    expect(mocks.outboxArgs.at(-1)?.queueDelivery).toEqual({
      capability: 'supported',
      enabled: false
    })
    mocks.outboxArgs.length = 0
    items = [newer, approval({ kind: 'plan', text: 'do it' })]
    render()
    expect(mocks.outboxArgs.at(-1)?.queueDelivery).toEqual({
      capability: 'supported',
      enabled: true
    })
  })

  it('Stop is a plain cancel: drafts stay as cards and no text lands in the composer', async () => {
    queuedMessages = [{ ...draft('draft-1'), paused: true }]
    const { result } = render(false)
    await act(async () => {
      await result.current.stop()
    })
    const [params] = cancels()
    expect(params).toBeDefined()
    expect(params).not.toHaveProperty('withdrawQueued')
    // The host still owns the draft; the client shows it paused and restores nothing.
    expect(result.current.queuedMessages.cards).toMatchObject([
      { messageId: 'draft-1', hold: 'paused' }
    ])
    expect(readNativeChatDraftCache('scope-1')).toBe('')
  })

  it("/clear is exactly today's command — drafts are the host's to carry", async () => {
    items = []
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.conversationCommand'
        ? {
            ok: true,
            replayed: false,
            fence: 3,
            cursor: { epoch: 'e', sequence: 1 },
            value: { command: 'clear', state: 'completed' }
          }
        : null
    )
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    const clearCall = mocks.call.mock.calls.find(
      ([, method]) => method === 'agentSession.conversationCommand'
    )
    // The host's REAL strict schema accepts the request as sent — and it carries
    // no withdraw key: the host moves the drafts to the replacement session itself.
    const parsed = ConversationCommandParams.parse(clearCall?.[2])
    expect(parsed.command).toBe('clear')
    expect('withdrawQueued' in parsed).toBe(false)
    // Fingerprint parity with the host's digest; a mismatch would refuse the
    // operation at admission.
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: parsed.command }
      })
    )
  })

  // The host finds an earlier /clear from its own journal, so the client keeps no id for it.
  it("an unconfirmed /clear's next press goes out under its own id", async () => {
    items = []
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.conversationCommand'
        ? {
            ok: true,
            replayed: false,
            fence: 3,
            cursor: { epoch: 'e', sequence: 1 },
            value: { command: 'clear', state: 'unknown' }
          }
        : null
    )
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    const ids = mocks.call.mock.calls
      .filter(([, method]) => method === 'agentSession.conversationCommand')
      .map(([, , params]) => ConversationCommandParams.parse(params).envelope.clientOperationId)
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('a mid-turn queue send is never a transcript bubble, before or after the host holds it', () => {
    const entry = (id: string, text: string) =>
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: id,
        sessionId: 'session-1',
        text,
        attachments: [],
        queuedAt: 1
      })
    outboxEntries = [
      // Not sent yet: against a host that queues, with the setting on, it will ask to be queued.
      entry('pending-queue', 'awaiting the answer'),
      // Sent plain: a bubble, whatever the capability now says.
      {
        ...entry('plain', 'immediate send'),
        state: 'dispatching',
        lastAttemptAt: 2,
        sentDelivery: null
      }
    ]
    const working = render()
    const workingText = JSON.stringify(working.result.current.messages)
    expect(workingText).not.toContain('awaiting the answer')
    expect(workingText).toContain('immediate send')
    // The host already publishes it as a draft: the card alone shows it, whatever the turn.
    items = []
    queuedMessages = [draft('pending-queue')]
    const idle = render()
    expect(JSON.stringify(idle.result.current.messages)).not.toContain('awaiting the answer')
    queuedMessages = undefined
    const idleUnheld = render()
    expect(JSON.stringify(idleUnheld.result.current.messages)).toContain('awaiting the answer')
  })

  it('shows host-held drafts as cards, never as transcript bubbles', () => {
    queuedMessages = [draft('draft-1')]
    const { result } = render()
    expect(result.current.queuedMessages.cards.map((card) => card.text)).toEqual(['queued draft-1'])
    const transcriptText = JSON.stringify(result.current.messages)
    expect(transcriptText).not.toContain('queued draft-1')
  })
})

function commandCalls(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.conversationCommand')
    .map(([, , params]) => params)
}

function answerCommands(value: Record<string, unknown>): void {
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.conversationCommand'
      ? { ok: true, replayed: false, fence: 3, cursor: { epoch: 'e', sequence: 1 }, value }
      : null
  )
}

describe('a /compact against a host that holds commands in line', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY
    ])
  })

  it('mid-turn, goes to the host asking to wait, and its queued answer shows no notice', async () => {
    answerCommands({
      command: 'compact',
      state: 'completed',
      queued: { messageId: 'operation-1', position: 1, state: 'waiting' }
    })
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({ accepted: true, error: null })
    const parsed = ConversationCommandParams.parse(commandCalls()[0])
    expect(parsed).toMatchObject({ command: 'compact', delivery: 'queue-if-active' })
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: 'compact', delivery: 'queue-if-active' }
      })
    )
  })

  function unsent(id: string, overrides: Partial<StructuredAgentSessionOutboxEntry> = {}) {
    return {
      ...createStructuredAgentSessionOutboxEntry({
        clientMessageId: id,
        sessionId: 'session-1',
        text: `message ${id}`,
        attachments: [],
        queuedAt: 1
      }),
      ...overrides
    }
  }

  it('behind a message still on its way: Send is busy, the message reads Sending, nothing is armed', async () => {
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    outboxEntries = [unsent('on-its-way')]
    const { result, rerender } = render()
    // The composer's send control is Stop while a send is on its way: the existing busy state.
    expect(result.current.canStop).toBe(true)
    // Its row reads "Sending…" (`NativeChatMessageRow`), from the same outbox.
    expect(
      structuredAgentSessionDeliveryNotices(
        outboxEntries,
        'Claude',
        () => {},
        [],
        [],
        new Set()
      ).get(agentJournalSubmissionKey('on-its-way'))
    ).toEqual({ sending: true })
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({ accepted: false, error: null })
    // The host has it now: nothing goes out on its own; the next press does.
    outboxEntries = []
    rerender()
    expect(commandCalls()).toHaveLength(0)
    expect(result.current.canStop).toBe(false)
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({ accepted: true, error: null })
    expect(commandCalls()).toHaveLength(1)
  })

  it('a send stuck behind one in doubt never holds the command for good: Stop gives it back', async () => {
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    // The first send's outcome is unknown and waits for its Retry; the second waits behind it.
    const inDoubt = unsent('in-doubt', {
      state: 'unconfirmed',
      lastAttemptAt: 2,
      retryAfterUnknownSubmittedAt: 2
    })
    outboxEntries = [inDoubt, unsent('behind')]
    const { result, rerender } = render()
    expect(result.current.canStop).toBe(true)
    await act(async () => {
      expect(await result.current.runConversationCommand('compact')).toEqual({
        accepted: false,
        error: null
      })
    })
    // The busy control is Stop, always pressable. Stop takes back what has not gone out
    // (`withdrawUnsentStructuredAgentSessionOutboxEntries`), leaving only the one in doubt.
    expect(
      withdrawUnsentStructuredAgentSessionOutboxEntries(outboxEntries, [], null).map(
        (entry) => entry.clientMessageId
      )
    ).toEqual(['in-doubt'])
    outboxEntries = [inDoubt]
    rerender()
    expect(result.current.canStop).toBe(false)
    await act(async () => {
      expect(await result.current.runConversationCommand('compact')).toEqual({
        accepted: true,
        error: null
      })
    })
  })

  it('mid-turn, behind a queue send on its way: it reads Sending as a card, and nothing is armed', async () => {
    answerCommands({ command: 'compact', state: 'completed' })
    outboxEntries = [
      unsent('on-its-way', {
        state: 'dispatching',
        lastAttemptAt: 2,
        sentDelivery: 'queue-if-active'
      })
    ]
    const { result } = render()
    // Not a transcript bubble mid-turn; the card it is about to become reads as sending.
    expect(JSON.stringify(result.current.messages)).not.toContain('message on-its-way')
    expect(result.current.queuedMessages.cards).toEqual([
      expect.objectContaining({
        messageId: 'on-its-way',
        text: 'message on-its-way',
        hold: 'sending'
      })
    ])
    await act(async () => {
      expect(await result.current.runConversationCommand('compact')).toEqual({
        accepted: false,
        error: null
      })
    })
    expect(commandCalls()).toHaveLength(0)
  })

  it('an idle send the host has recorded is its transcript row only, never a sending card too', () => {
    items = []
    outboxEntries = [
      unsent('recorded', {
        state: 'dispatching',
        lastAttemptAt: 2,
        sentDelivery: 'queue-if-active'
      })
    ]
    // The host took it straight through: its own submission, unanswered, makes the chat working.
    submissions = [
      {
        clientMessageId: 'recorded',
        fence: 3,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'pending',
        providerItemId: null,
        reason: null,
        submittedAt: 2,
        resolvedAt: null,
        handoverRecorded: true,
        handedOverAt: 3
      }
    ]
    const { result } = render()
    expect(result.current.isWorking).toBe(true)
    expect(result.current.queuedMessages.cards).toEqual([])
  })

  it('/clear right after a Stop kept a send on its way names no Retry it does not show', async () => {
    items = []
    outboxEntries = [
      unsent('kept', {
        state: 'dispatching',
        lastAttemptAt: 2,
        sentDelivery: 'queue-if-active',
        outlivedStop: true
      })
    ]
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: 'Your earlier message is still being sent. Run /clear once it has gone.',
      refusedWhile: 'outbox'
    })
  })

  it('/clear with the agent idle behind its own unsent message says it is still being sent', async () => {
    items = []
    outboxEntries = [unsent('on-its-way')]
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: 'Your earlier message is still being sent. Run /clear once it has gone.',
      refusedWhile: 'outbox'
    })
    expect(commandCalls()).toHaveLength(0)
  })

  it('/clear behind only a failed message names its Retry, not the agent working', async () => {
    items = []
    outboxEntries = [unsent('failed', { lastAttemptAt: 2, lastFailure: { kind: 'failed' } })]
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: 'Retry your earlier message, then run /clear.',
      refusedWhile: 'outbox'
    })
    expect(commandCalls()).toHaveLength(0)
  })

  it('/clear mid-turn is still refused here, and never asks to wait', async () => {
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    expect(commandCalls()).toHaveLength(0)
    items = []
    answerCommands({ command: 'clear', state: 'completed' })
    const idle = render()
    await act(async () => {
      await idle.result.current.runConversationCommand('clear')
    })
    expect(ConversationCommandParams.parse(commandCalls()[0])).not.toHaveProperty('delivery')
  })

  it('a rewind on its way holds /clear and /compact alike, in the same words, and writes nothing', async () => {
    items = []
    mocks.rewindPending = true
    const { result } = render()
    for (const command of ['clear', 'compact'] as const) {
      let outcome: unknown
      await act(async () => {
        outcome = await result.current.runConversationCommand(command)
      })
      expect(outcome).toEqual({
        accepted: false,
        error: 'Wait for pending work and messages to finish before using this command.'
      })
    }
    expect(commandCalls()).toHaveLength(0)
  })

  const compactCard = (held: boolean) => ({
    ...draft('compact-1'),
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: '/compact' }],
      command: { name: 'compact' as const }
    },
    ...(held ? { paused: true as const, pausedReason: 'kept' as const } : {})
  })

  it('a send behind a waiting command card queues, even with follow-ups off', () => {
    queuedMessages = [compactCard(false)]
    render(false)
    expect(mocks.outboxArgs.at(-1)?.queueDelivery).toEqual({
      capability: 'supported',
      enabled: true
    })
  })

  it('a kept command card, which the queue skips, does not force a send to queue', () => {
    queuedMessages = [compactCard(true)]
    render(false)
    expect(mocks.outboxArgs.at(-1)?.queueDelivery).toEqual({
      capability: 'supported',
      enabled: false
    })
  })
})

describe('a /compact against a host that queues messages but not commands', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
    ])
  })

  it('mid-turn, is held back here as today, and idle goes out without `delivery`', async () => {
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('compact')
    })
    expect(commandCalls()).toHaveLength(0)
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    const idle = render()
    await act(async () => {
      await idle.result.current.runConversationCommand('compact')
    })
    expect(ConversationCommandParams.parse(commandCalls()[0])).not.toHaveProperty('delivery')
  })
})

describe('a /compact against a host that holds commands but has its queue dark', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
      AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY
    ])
  })

  it("is exactly today's: held back mid-turn, and idle goes out without `delivery`", async () => {
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: "The agent is still working. Run /compact when it's done.",
      refusedWhile: 'working'
    })
    expect(commandCalls()).toHaveLength(0)
    items = []
    answerCommands({ command: 'compact', state: 'completed' })
    const idle = render()
    await act(async () => {
      await idle.result.current.runConversationCommand('compact')
    })
    expect(ConversationCommandParams.parse(commandCalls()[0])).not.toHaveProperty('delivery')
  })
})

describe('against a host without the capability', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY])
  })

  it('never asks for queue delivery, whatever the setting says', () => {
    render()
    expect(mocks.outboxArgs.at(-1)?.queueDelivery?.capability).toBe('unsupported')
  })

  it("Stop stays exactly today's conversation Stop — no withdrawQueued key at all", async () => {
    const { result } = render()
    await act(async () => {
      await result.current.stop()
    })
    const [params] = cancels()
    expect(params).toBeDefined()
    expect(params).not.toHaveProperty('withdrawQueued')
  })

  it("/clear stays exactly today's command — no withdrawQueued key", async () => {
    items = []
    mocks.call.mockImplementation(async (_target, method) =>
      method === 'agentSession.conversationCommand'
        ? {
            ok: true,
            replayed: false,
            fence: 3,
            cursor: { epoch: 'e', sequence: 1 },
            value: { command: 'clear', state: 'completed' }
          }
        : null
    )
    const { result } = render()
    await act(async () => {
      await result.current.runConversationCommand('clear')
    })
    const clearCall = mocks.call.mock.calls.find(
      ([, method]) => method === 'agentSession.conversationCommand'
    )
    const parsed = ConversationCommandParams.parse(clearCall?.[2])
    expect('withdrawQueued' in parsed).toBe(false)
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: parsed.command }
      })
    )
  })

  it('steering the newest card is inert', () => {
    queuedMessages = [draft('draft-1')]
    const { result } = render()
    expect(result.current.queuedMessages.steerNewest()).toBe(false)
    expect(
      mocks.call.mock.calls.filter(([, method]) =>
        String(method).startsWith('agentSession.queuedMessage')
      )
    ).toHaveLength(0)
  })
})
