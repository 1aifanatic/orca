import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }): ReactNode =>
      React.createElement(name, props, children)
  return {
    ActivityIndicator: host('ActivityIndicator'),
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

import { MobileNativeChatLiveLine } from './MobileNativeChatLiveLine'

const block: NativeChatMessage = {
  id: 'r-1',
  role: 'reasoning',
  blocks: [{ type: 'text', text: 'Weighing two approaches' }],
  timestamp: null,
  source: 'transcript',
  state: 'running'
}

describe('MobileNativeChatLiveLine', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(reasoning: NativeChatMessage | null, reasoningExpanded = false) {
    const onToggleReasoning = vi.fn()
    act(() => {
      renderer = create(
        createElement(MobileNativeChatLiveLine, {
          line: { thinking: true, activityText: null, reasoning, reasoningExpanded },
          onToggleReasoning,
          fontScale: 1
        })
      )
    })
    return { root: renderer!.root, onToggleReasoning }
  }
  const byType = (root: ReactTestInstance, type: string): ReactTestInstance[] =>
    root.findAll((node) => String(node.type) === type)
  const labels = (root: ReactTestInstance): string[] =>
    byType(root, 'Text').map((text) => String(text.children.join('')))
  const buttons = (root: ReactTestInstance): ReactTestInstance[] =>
    root.findAll(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityRole === 'button'
    )

  it('is the plain live line, not a button, while no open block has text', () => {
    const { root } = render(null)
    expect(labels(root)).toEqual(['Thinking'])
    expect(buttons(root)).toHaveLength(0)
  })

  it('discloses the open block under one "Thinking", collapsed, toggled by its block key', () => {
    const { root, onToggleReasoning } = render(block)
    expect(labels(root)).toEqual(['Thinking'])
    const [toggle] = buttons(root)
    expect(toggle?.props.accessibilityState).toEqual({ expanded: false })
    expect(byType(root, 'ReasoningBody')).toHaveLength(0)
    act(() => toggle?.props.onPress())
    expect(onToggleReasoning).toHaveBeenCalledWith('reasoning:r-1')
  })

  it('shows the live text outside the live region once opened', () => {
    const { root } = render(block, true)
    const [body] = byType(root, 'ReasoningBody')
    expect(body?.props.markdown).toBe('Weighing two approaches')
    let ancestor = body?.parent ?? null
    while (ancestor) {
      expect(ancestor.props.accessibilityLiveRegion).toBeUndefined()
      ancestor = ancestor.parent
    }
    expect(buttons(root)[0]?.props.accessibilityLiveRegion).toBe('polite')
  })
})
