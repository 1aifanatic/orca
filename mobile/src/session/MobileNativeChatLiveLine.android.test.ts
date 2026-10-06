import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveReasoning } from '../../../src/shared/native-chat-reasoning-row'

// Why a separate file: Android has no inline selection, so the live text is copied the way a
// finished row's is, through the message actions sheet.
vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }): ReactNode =>
      React.createElement(name, props, children)
  return {
    ActivityIndicator: host('ActivityIndicator'),
    Platform: { OS: 'android' },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('lucide-react-native', () => ({ ChevronRight: 'ChevronRight' }))
vi.mock('./MobileNativeChatReasoningRow', () => ({
  MobileNativeChatReasoningBody: 'ReasoningBody'
}))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'

const block: NativeChatLiveReasoning = {
  message: {
    id: 'r-1',
    role: 'reasoning',
    blocks: [{ type: 'text', text: 'Weighing two approaches' }],
    timestamp: null,
    source: 'transcript',
    state: 'running'
  },
  markdown: 'Weighing two approaches'
}

describe('MobileNativeChatLiveLine on Android', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  const byType = (type: string): ReactTestInstance[] =>
    renderer!.root.findAll((node) => String(node.type) === type)

  it('opens the actions sheet for the live block from a long press on its text', () => {
    act(() => {
      renderer = create(
        createElement(MobileNativeChatLiveLine, {
          line: { thinking: true, activityText: null, reasoning: block, reasoningExpanded: true },
          onToggleReasoning: vi.fn(),
          fontScale: 1
        })
      )
    })
    expect(byType('MessageActionsSheet')).toHaveLength(0)
    const [body] = byType('ReasoningBody')
    expect(typeof body?.props.onLongPress).toBe('function')

    act(() => body!.props.onLongPress())
    const [sheet] = byType('MessageActionsSheet')
    // The sheet copies and selects the message's own text: the block as it stands.
    expect(sheet?.props.message).toBe(block.message)

    act(() => sheet!.props.onClose())
    expect(byType('MessageActionsSheet')).toHaveLength(0)
  })
})
