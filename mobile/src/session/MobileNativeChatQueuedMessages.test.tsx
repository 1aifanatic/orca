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
})
