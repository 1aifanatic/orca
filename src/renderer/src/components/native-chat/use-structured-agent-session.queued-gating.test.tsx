// @vitest-environment happy-dom

// Capability gating for mid-turn queueing at the session controller: only a
// host advertising `agent-session.queued-messages.v1` gets `delivery` or the
// card RPCs — anything older sees exactly today's client. Stop and /clear are
// today's plain writes for every host: drafts are never withdrawn by either,
// and no draft text ever rides an answer. A host-held draft is a card above
// the composer, never a transcript bubble.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  outboxArgs: Array.of<{ queueDelivery?: { capability: string; enabled: boolean } }>(),
  operations: 0
}))
let items: AgentJournalRenderItem[] = []
let queuedMessages: AgentSessionQueuedMessage[] | undefined
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
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      ...(queuedMessages !== undefined ? { queuedMessages } : {})
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

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

  it('behind a message this window has not handed to the host, waits quietly, then goes out', async () => {
    answerCommands({
      command: 'compact',
      state: 'completed',
      queued: { messageId: 'operation-1', position: 1, state: 'waiting' }
    })
    outboxEntries = [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'unsent',
        sessionId: 'session-1',
        text: 'on its way',
        attachments: [],
        queuedAt: 1
      })
    ]
    const { result, rerender } = render()
    let outcome: Promise<unknown> | undefined
    act(() => {
      outcome = result.current.runConversationCommand('compact')
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(commandCalls()).toHaveLength(0)
    // The message leaves the outbox (the host has it, or it was given back): the command follows.
    outboxEntries = []
    rerender()
    await act(async () => {
      expect(await outcome).toEqual({ accepted: true, error: null })
    })
    expect(commandCalls()).toHaveLength(1)
  })

  it('a wait the pane outlives sends nothing', async () => {
    outboxEntries = [
      createStructuredAgentSessionOutboxEntry({
        clientMessageId: 'unsent',
        sessionId: 'session-1',
        text: 'on its way',
        attachments: [],
        queuedAt: 1
      })
    ]
    const { result, unmount } = render()
    let outcome: Promise<unknown> | undefined
    act(() => {
      outcome = result.current.runConversationCommand('compact')
    })
    unmount()
    expect(await outcome).toEqual({ accepted: false, error: null })
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

  it('a send behind a waiting command card queues, even with follow-ups off', () => {
    queuedMessages = [
      {
        ...draft('compact-1'),
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }
      }
    ]
    render(false)
    expect(mocks.outboxArgs.at(-1)?.queueDelivery).toEqual({
      capability: 'supported',
      enabled: true
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
    let outcome: { accepted: boolean; error: string | null } | undefined
    await act(async () => {
      outcome = await result.current.runConversationCommand('compact')
    })
    expect(outcome).toEqual({
      accepted: false,
      error: 'Wait for pending work and messages to finish before using this command.'
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
