import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    FlatList: React.forwardRef((props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollToEnd: vi.fn(), scrollToOffset: vi.fn() }), [])
      return React.createElement('FlatList', props)
    }),
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => {
  const chain = { runOnJS: () => chain, onStart: () => chain, onUpdate: () => chain }
  return {
    Gesture: { Simultaneous: () => ({}), Native: () => ({}), Pinch: () => chain },
    GestureDetector: 'GestureDetector',
    GestureHandlerRootView: 'GestureHandlerRootView'
  }
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({ MobileNativeChatTurnStatus: 'LiveStatus' }))
vi.mock('./MobileNativeChatComposer', () => ({ MobileNativeChatComposer: 'Composer' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('./MobileAgentWorkingIndicator', () => ({
  MobileAgentWorkingIndicator: 'WorkingIndicator'
}))

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function user(id: string, text: string, queued = false): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'hook',
    ...(queued ? { queued: true as const } : {})
  }
}

function row(itemId: string, sequence: number, body: AgentJournalRenderItem['body']) {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    turnScope: { kind: 'thread' as const },
    body
  }
}

it('draws a message waiting behind a running /compact after the live status, not in the list', async () => {
  await act(async () => {
    renderer = create(
      createElement(MobileNativeChatView, {
        messages: [],
        folded: [user('compact', '/compact'), user('held', 'Say DONE', true)],
        status: 'ready',
        streaming: null,
        onSend: vi.fn().mockResolvedValue(true),
        sendSurfaceId: 'tab-a',
        getSendCompletionGeneration: () => 0,
        pending: [],
        composerText: '',
        onComposerTextChange: vi.fn(),
        structuredActivityUi: true,
        agentWorking: true,
        turnJournal: {
          items: [
            row('compact', 1, {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: '/compact' }],
              command: { name: 'compact' }
            }),
            row('command-turn', 2, {
              kind: 'turn',
              turnId: 'compact:1',
              state: 'running',
              userItemId: 'compact',
              startedAt: 1
            }),
            row('held', 3, {
              kind: 'message',
              role: 'user',
              blocks: [{ type: 'text', text: 'Say DONE' }]
            })
          ],
          submissions: []
        }
      })
    )
  })

  const list = renderer!.root.find((node) => node.type === 'FlatList')
  expect(list.props.data.map((message: NativeChatMessage) => message.id)).toEqual(['compact'])
  let footer: ReactTestRenderer | null = null
  act(() => {
    footer = create(list.props.ListFooterComponent)
  })
  const drawn = footer!.root.findAll(
    (node) => node.type === 'LiveStatus' || node.type === 'ChatMessage'
  )
  expect(
    drawn.map((node) => (node.type === 'LiveStatus' ? 'status' : node.props.message.id))
  ).toEqual(['status', 'held'])
  act(() => footer!.unmount())
})
