// @vitest-environment happy-dom

// A /clear against a host that runs it from the queue (`agent-session.queued-clear.v1`): the
// session controller asks it to wait only where the host can hold it, a waiting /clear card queues
// later sends, and a replaced chat's messages being asked about stay transcript rows.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  sendArgs: Array.of<{ queue?: { capability: string; enabled: boolean } }>(),
  operations: 0
}))
let items: AgentJournalRenderItem[] = []
let queuedMessages: AgentSessionQueuedMessage[] | undefined
/** A replaced chat's messages the carry is asking about, drawn in this chat's transcript. */
let askedEntries: StructuredAgentSessionPendingSend[] = []

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

vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: (args: { queue?: { capability: string; enabled: boolean } }) => {
    mocks.sendArgs.push(args)
    return { pending: [], error: null, send: vi.fn(), stopSends: vi.fn() }
  }
}))
vi.mock('./use-structured-agent-session-replacement-carry', () => ({
  useStructuredAgentSessionReplacementCarry: () => askedEntries
}))

import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { ConversationCommandParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sendArgs.length = 0
  mocks.call.mockImplementation(async () => null)
  items = [RUNNING_TURN]
  queuedMessages = undefined
  askedEntries = []
  localStorage.clear()
  clearNativeChatDraftCacheForTests()
})

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('a /clear against a host that runs it from the queue', () => {
  const CLEAR_WAITS = [
    AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
    AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
    AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
    AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY
  ]
  const queuedClearAnswer = {
    command: 'clear',
    state: 'completed',
    queued: { messageId: 'operation-1', position: 1, state: 'waiting' }
  }

  it('mid-turn, goes to the host asking to wait, and its queued answer shows no notice', async () => {
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
    answerCommands(queuedClearAnswer)
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toEqual({ accepted: true, error: null })
    const parsed = ConversationCommandParams.parse(commandCalls()[0])
    expect(parsed).toMatchObject({ command: 'clear', delivery: 'queue-if-active' })
    expect(parsed.envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: 'session-1',
        fields: { command: 'clear', delivery: 'queue-if-active' }
      })
    )
  })

  it('against a host that holds only /compact, keeps the refusal and never asks (temporary)', async () => {
    // Every capability but the last, queued-clear.
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS.slice(0, -1))
    answerCommands(queuedClearAnswer)
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    // Its line stands only while the agent works, as every command refusal's does.
    expect(outcome).toEqual({
      accepted: false,
      error: "The agent is still working. Run /clear when it's done.",
      refusedWhile: 'working'
    })
    expect(commandCalls()).toHaveLength(0)
  })

  it.each([
    { card: 'waiting', held: false, enabled: true },
    { card: 'held (couldn’t send), which the queue skips', held: true, enabled: false }
  ])('a $card /clear card decides whether a send queues behind it', ({ held, enabled }) => {
    setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
    queuedMessages = [
      {
        ...draft('clear-1'),
        body: { ...draft('clear-1').body, command: { name: 'clear' } },
        ...(held ? { paused: true as const, pausedReason: 'send_failed' as const } : {})
      }
    ]
    render(false)
    expect(mocks.sendArgs.at(-1)?.queue).toEqual({ capability: 'supported', enabled })
  })

  it.each([
    { chat: 'working', turn: true },
    { chat: 'idle', turn: false }
  ])(
    "a cleared chat's queue send being asked about is one sending row while $chat: no card, no Stop",
    ({ turn }) => {
      setLocalRuntimeCapabilitiesForTests(CLEAR_WAITS)
      items = turn ? [RUNNING_TURN] : []
      askedEntries = [
        {
          clientMessageId: 'asked',
          sessionId: 'old-session',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'message asked about' }]
          },
          previewUris: [],
          queuedAt: 1,
          phase: 'sending',
          issued: true,
          delivery: 'queue-if-active'
        }
      ]
      const { result } = render()
      expect(JSON.stringify(result.current.messages).split('message asked about')).toHaveLength(2)
      expect(result.current.queuedMessages.cards).toEqual([])
      expect(result.current.canStop).toBe(turn)
      expect(
        structuredAgentSessionDeliveryNotices({
          pending: result.current.pending,
          submissions: [],
          agentName: 'Claude',
          startFailures: []
        }).get(agentJournalSubmissionKey('asked'))
      ).toEqual({ sending: true })
    }
  )

  it('without the queue lit, keeps the refusal even when the host could hold it', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_CLEAR_RUNTIME_CAPABILITY])
    const { result } = render()
    let outcome: unknown
    await act(async () => {
      outcome = await result.current.runConversationCommand('clear')
    })
    expect(outcome).toMatchObject({ accepted: false })
    expect(commandCalls()).toHaveLength(0)
  })
})
