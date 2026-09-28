import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatQueuedMessages } from './MobileNativeChatQueuedMessages'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  Clock: 'Clock',
  RotateCcw: 'RotateCcw'
}))

describe('MobileNativeChatQueuedMessages', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('offers Edit on a returned card, so a refused message can be fixed rather than retyped', async () => {
    const onEdit = vi.fn(async () => true)
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, {
          cards: [
            {
              messageId: 'returned-1',
              text: 'fix me',
              state: 'returned',
              paused: false,
              label: "Couldn't send — Send to retry"
            }
          ],
          onSend: vi.fn(async () => true),
          onDelete: vi.fn(async () => true),
          onEdit
        })
      )
    })
    const edit = mounted.root.findByProps({ accessibilityLabel: 'Edit this queued message' })
    await act(async () => edit.props.onPress())
    expect(onEdit).toHaveBeenCalledWith('returned-1')
  })

  it('reads plain Send on a paused card, since no turn is running for it to jump', async () => {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, {
          cards: [
            {
              messageId: 'paused-1',
              text: 'later',
              state: 'waiting',
              paused: true,
              label: 'Paused — sends after your next message'
            },
            {
              messageId: 'waiting-1',
              text: 'next',
              state: 'waiting',
              paused: false,
              label: 'Queued — sends when the current turn ends'
            }
          ],
          onSend: vi.fn(async () => true),
          onDelete: vi.fn(async () => true),
          onEdit: vi.fn(async () => true)
        })
      )
    })
    expect(mounted.root.findByProps({ accessibilityLabel: 'Send this message' })).toBeTruthy()
    expect(mounted.root.findByProps({ accessibilityLabel: 'Send this message now' })).toBeTruthy()
    const labels = mounted.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
      .filter((child) => child === 'Send' || child === 'Send now')
    expect(labels).toEqual(['Send', 'Send now'])
  })

  it('gives every card action at least a 44pt touch target', async () => {
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, {
          cards: [
            {
              messageId: 'waiting-1',
              text: 'next',
              state: 'waiting',
              paused: false,
              label: 'Queued — sends when the current turn ends'
            }
          ],
          onSend: vi.fn(async () => true),
          onDelete: vi.fn(async () => true),
          onEdit: vi.fn(async () => true)
        })
      )
    })
    const buttons = mounted.root.findAll((node) => node.props.accessibilityRole === 'button')
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      const resolved: unknown = button.props.style({ pressed: false })
      const style = Object.assign({}, ...(Array.isArray(resolved) ? resolved : [resolved]))
      expect(style.minHeight).toBeGreaterThanOrEqual(44)
      expect(style.minWidth).toBeGreaterThanOrEqual(44)
    }
  })
})
