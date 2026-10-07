import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MOBILE_NATIVE_CHAT_STREAMING_MESSAGE_ID } from './mobile-native-chat-render-data'
import {
  MobileNativeChatVisualContext,
  type MobileNativeChatVisualRenderer
} from './mobile-native-chat-visual-context'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: ReactNode }): ReactNode =>
    React.createElement('Text', props, children)
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Image: 'Image',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('ScrollView', props, children),
    Text,
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  Brain: 'Brain',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'

const visuals: MobileNativeChatVisualRenderer = {
  render: () => 'visual',
  renderStreaming: () => 'reserved'
}

function message(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text }], timestamp: null, source: 'transcript' }
}

describe('MobileNativeChatMessage visuals', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function markdownProps(
    row: NativeChatMessage,
    renderer_: MobileNativeChatVisualRenderer | null = visuals
  ): Record<string, unknown> {
    act(() => {
      renderer = create(
        createElement(
          MobileNativeChatVisualContext.Provider,
          { value: renderer_ },
          createElement(MobileNativeChatMessage, { message: row })
        )
      )
    })
    return renderer!.root.find((node) => String(node.type) === 'MobileMarkdown').props
  }

  it("renders a finished assistant reply's directives through the transcript renderer", () => {
    const props = markdownProps(message('a1', 'assistant', '::orca-visual{file="a.html"}'))
    expect(props.renderVisual).toBe(visuals.render)
  })

  it('holds a streaming reply to reserved space and hides a directive still being typed', () => {
    const props = markdownProps(
      message(
        MOBILE_NATIVE_CHAT_STREAMING_MESSAGE_ID,
        'assistant',
        'Chart below.\n::orca-visual{file="usage'
      )
    )
    expect(props.renderVisual).toBe(visuals.renderStreaming)
    expect(props.content).toBe('Chart below.\n')
  })

  it('leaves directives as text where the chat has no visual source', () => {
    const props = markdownProps(message('a1', 'assistant', '::orca-visual{file="a.html"}'), null)
    expect(props.renderVisual).toBeUndefined()
    expect(props.content).toBe('::orca-visual{file="a.html"}')
  })

  it('never renders visuals in system rows', () => {
    const props = markdownProps(message('s1', 'system', '::orca-visual{file="a.html"}'))
    expect(props.renderVisual).toBeUndefined()
  })
})
