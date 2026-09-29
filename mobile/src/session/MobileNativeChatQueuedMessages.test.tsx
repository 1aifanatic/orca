import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionQueuePause } from '../../../src/shared/agent-session-wire'
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
              label: "Couldn't send — tap Send to retry"
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

  it("lets a returned card's reason wrap whole while a waiting card's hold stays one line", async () => {
    const reason =
      'The provider did not accept this message: Claude does not support the image type .bmp in a steering message.'
    const mounted = create(createElement('View'))
    renderer = mounted
    await act(async () => {
      mounted.update(
        createElement(MobileNativeChatQueuedMessages, {
          cards: [
            { messageId: 'r', text: 'fix me', state: 'returned', paused: false, label: reason },
            {
              messageId: 'w',
              text: 'later',
              state: 'waiting',
              paused: false,
              label: 'Queued — sends when the current turn ends'
            }
          ]
        })
      )
    })
    const lineCap = (label: string) =>
      mounted.root.findAll(
        (node) => String(node.type) === 'Text' && node.props.children === label
      )[0]?.props.numberOfLines
    expect(lineCap(reason)).toBeUndefined()
    expect(lineCap('Queued — sends when the current turn ends')).toBe(1)
  })

  it('reads Steer on a waiting card and plain Send on one whose own send failed', async () => {
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
              label: "Couldn't send — tap Send to retry"
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
    expect(
      mounted.root.findByProps({
        accessibilityLabel: 'Submit without interrupting the model'
      })
    ).toBeTruthy()
    const labels = mounted.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
      .filter((child) => child === 'Send' || child === 'Steer' || child === 'Send now')
    expect(labels).toEqual(['Send', 'Steer'])
  })

  describe('a paused queue', () => {
    const waiting = {
      messageId: 'waiting-1',
      text: 'next',
      state: 'waiting' as const,
      paused: false,
      label: 'Queued'
    }

    async function mountPaused(
      props: Partial<Parameters<typeof MobileNativeChatQueuedMessages>[0]>
    ): Promise<ReactTestRenderer> {
      const mounted = create(createElement('View'))
      renderer = mounted
      await act(async () => {
        mounted.update(
          createElement(MobileNativeChatQueuedMessages, {
            cards: [waiting],
            onSend: vi.fn(async () => true),
            ...props
          })
        )
      })
      return mounted
    }

    function texts(mounted: ReactTestRenderer): unknown[] {
      return mounted.root
        .findAll((node) => String(node.type) === 'Text')
        .map((node) => node.props.children)
    }

    it('heads the cards with why the queue is paused, for each reason', async () => {
      const rows: readonly [AgentSessionQueuePause['reason'], string][] = [
        ['stopped', 'Queue paused because you interrupted'],
        ['restarted', 'Queue paused because Orca restarted'],
        ['cleared', 'Queue paused after you cleared the conversation']
      ]
      for (const [reason, label] of rows) {
        const mounted = await mountPaused({ pause: { reason } })
        expect(texts(mounted)).toContain(label)
      }
    })

    it('shows no header without a pause or without cards', async () => {
      expect(texts(await mountPaused({ pause: null }))).not.toContain(
        'Queue paused because you interrupted'
      )
      const empty = await mountPaused({ cards: [], pause: { reason: 'stopped' } })
      expect(empty.toJSON()).toBeNull()
    })

    function resumeButton(mounted: ReactTestRenderer) {
      return mounted.root.findByProps({ accessibilityLabel: 'Resume sending the queued messages' })
    }

    it('Resume asks the host to lift the pause once, however fast it is tapped twice', async () => {
      let answer: (resumed: boolean) => void = () => undefined
      const onResume = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
      const mounted = await mountPaused({ pause: { reason: 'restarted' }, onResume })
      const resolved: unknown = resumeButton(mounted).props.style({ pressed: false })
      const style = Object.assign({}, ...(Array.isArray(resolved) ? resolved : [resolved]))
      expect(style.minHeight).toBeGreaterThanOrEqual(44)
      // Both taps land in one frame, before the disabled state can render.
      await act(async () => {
        resumeButton(mounted).props.onPress()
        resumeButton(mounted).props.onPress()
      })
      expect(onResume).toHaveBeenCalledTimes(1)
      await act(async () => answer(true))
    })

    it('re-enables Resume when its answer is lost, so it can be tried again', async () => {
      let answer: (resumed: boolean) => void = () => undefined
      const onResume = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
      const mounted = await mountPaused({ pause: { reason: 'stopped' }, onResume })
      await act(async () => resumeButton(mounted).props.onPress())
      expect(resumeButton(mounted).props.disabled).toBe(true)
      // A lost answer reads as not resumed.
      await act(async () => answer(false))
      expect(resumeButton(mounted).props.disabled).toBe(false)
      await act(async () => resumeButton(mounted).props.onPress())
      expect(onResume).toHaveBeenCalledTimes(2)
    })

    it('keeps the whole Resume target inside its row, and announces the row', async () => {
      const mounted = await mountPaused({ pause: { reason: 'stopped' } })
      const row = mounted.root.findByProps({ testID: 'queued-pause-row' })
      // Android drops touches outside the parent: no margin may pull the row past the list's edge.
      const margins = Object.entries(Object.assign({}, row.props.style)).filter(([key]) =>
        key.startsWith('margin')
      )
      expect(margins.filter(([, value]) => typeof value === 'number' && value < 0)).toEqual([])
      expect(row.props.accessibilityLiveRegion).toBe('polite')
    })

    it('keeps Steer on its cards: one card can still go beside the paused rest', async () => {
      const onSend = vi.fn(async () => true)
      const mounted = await mountPaused({ pause: { reason: 'stopped' }, onSend })
      const steer = mounted.root.findByProps({
        accessibilityLabel: 'Submit without interrupting the model'
      })
      expect(texts(mounted)).toContain('Steer')
      expect(texts(mounted)).not.toContain('Send')
      await act(async () => steer.props.onPress())
      expect(onSend).toHaveBeenCalledWith('waiting-1')
    })
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
