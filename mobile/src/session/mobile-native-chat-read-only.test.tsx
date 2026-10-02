import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => {}),
  removeItem: vi.fn(async () => {})
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {} },
  View: 'View'
}))
vi.mock('./MobileNativeChatView', () => ({ MobileNativeChatView: 'ChatView' }))
vi.mock('./MobileNativeChatQueuedMessages', () => ({ MobileNativeChatQueuedMessages: 'Queued' }))

import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import type { MobileNativeChatController } from './use-mobile-native-chat-controller'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const NOTICE = 'Saved by a newer Orca. Update Orca to continue this chat.'

function snapshot(readOnly?: 'written-by-newer-orca'): AgentSessionSubscribeEvent {
  const page: AgentSessionHistoryPage = {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    fence: 3,
    direction: 'tail',
    // A turn that opened and never settled, as a read-only host leaves it.
    items: [
      {
        itemId: 'turn-1',
        revision: 1,
        sequence: 1,
        observedAt: 1,
        body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
      }
    ],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
    liveCursor: { epoch: 'epoch-1', sequence: 0 },
    hasOlder: false,
    hasNewer: false,
    ...(readOnly ? { readOnly } : {})
  }
  return { type: 'snapshot', sessionId: 'session-1', fence: 3, page }
}

let renderer: ReactTestRenderer | null = null
let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
let listener: ((value: unknown) => void) | null = null

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only sendRequest and subscribe on the client.
const client = {
  sendRequest: vi.fn(async () => ({ ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })),
  subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return () => {}
  })
} as unknown as RpcClient

function Harness(): null {
  hook = useMobileStructuredAgentSession({
    client,
    sessionId: 'session-1',
    sourceIdentity: 'host-a\0workspace-a',
    enabled: true,
    connected: true,
    hostSupport: null,
    agent: 'codex',
    onSendError: () => {}
  })
  return null
}

beforeEach(() => {
  listener = null
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  hook = null
})

it("words the host's read-only reason on the phone with no turn or work, until the host takes writes", async () => {
  act(() => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).not.toBeNull())
  act(() => listener?.(snapshot('written-by-newer-orca')))
  expect(hook?.session.readOnlyNotice).toBe(NOTICE)
  expect(hook).toMatchObject({ turnId: null, isWorking: false })
  act(() => listener?.(snapshot()))
  expect(hook?.session.readOnlyNotice).toBeNull()
  expect(hook).toMatchObject({ turnId: 'turn-1', isWorking: true })
})

function overlayElement(
  readOnlyNotice: string | null,
  inputLockReason: 'disconnected' | null = null
): ReturnType<typeof createElement> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay reads only these controller members; the rest of the controller is unreachable from it.
  const controller = {
    showNativeChat: true,
    nativeChatSession: { messages: [], status: 'ready', readOnlyNotice },
    nativeChatAgent: 'claude',
    nativeChatStreamScopeKey: 'tab-a',
    nativeChatQuestion: { id: 'question-1' },
    nativeChatPermission: { id: 'permission-1' },
    chatPending: [],
    chatImagePreviewsByMessageId: {},
    chatComposerText: 'a draft',
    setChatComposerText: vi.fn(),
    nativeChatQueued: {
      cards: [],
      send: vi.fn(),
      delete: vi.fn(),
      edit: vi.fn(),
      pause: null,
      resume: vi.fn(),
      sessionKey: 'session-a'
    }
  } as unknown as MobileNativeChatController
  return createElement(MobileNativeChatOverlay, {
    controller,
    onOpenFile: vi.fn(),
    images: {
      attachments: [],
      isAttaching: false,
      attachImage: vi.fn(async () => {}),
      removeAttachment: vi.fn(),
      sendNativeChat: vi.fn(async () => true)
    },
    onMicPress: vi.fn(),
    micActive: false,
    dictationMode: 'toggle',
    onMicPressIn: vi.fn(),
    onMicPressOut: vi.fn(),
    inputLockReason,
    sendErrorMessage: null,
    onClearSendError: vi.fn(),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    keyboardInset: 0
  })
}

function chatViewProps(element: ReturnType<typeof createElement>): Record<string, unknown> {
  act(() => {
    renderer = create(element)
  })
  const [view] = renderer!.root.findAll((node) => String(node.type) === 'ChatView')
  const props: Record<string, unknown> = view!.props
  act(() => renderer?.unmount())
  renderer = null
  return props
}

/** The queued cards the overlay hands the chat view. */
function queuedCardsProps(props: Record<string, unknown>): Record<string, unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the overlay builds this slot with useMobileNativeChatQueuedSlot, whose `cards` is one element.
  return (props.queuedSlot as { cards: { props: Record<string, unknown> } }).cards.props
}

it("hands the session's one read-only fact to the chat view: prompts shown, queued cards inert", () => {
  const readOnly = chatViewProps(overlayElement(NOTICE))
  expect(readOnly).toMatchObject({
    inputLockReason: null,
    readOnlyNotice: NOTICE,
    question: { id: 'question-1' },
    permission: { id: 'permission-1' },
    composerText: 'a draft'
  })
  expect(queuedCardsProps(readOnly)).toMatchObject({ disabled: true })
  expect(chatViewProps(overlayElement(NOTICE, 'disconnected'))).toMatchObject({
    inputLockReason: 'disconnected'
  })
  const writable = chatViewProps(overlayElement(null))
  expect(writable).toMatchObject({ inputLockReason: null, readOnlyNotice: null })
  expect(queuedCardsProps(writable)).toMatchObject({ disabled: false })
})
