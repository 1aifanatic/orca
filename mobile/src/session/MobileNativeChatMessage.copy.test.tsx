import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

const { writeText, alert } = vi.hoisted(() => ({
  writeText: vi.fn<(text: string) => Promise<void>>(),
  alert: vi.fn()
}))
vi.mock('react-native', () => ({
  Alert: { alert },
  Image: 'Image',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ Copy: 'Copy', Check: 'Check' }))
vi.mock('../components/MobileSelectableText', () => ({ MobileSelectableText: 'Text' }))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('./MobileNativeChatReasoningRow', () => ({ MobileNativeChatReasoningRow: 'Reasoning' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({ MobileNativeChatTurnStatus: 'TurnStatus' }))
vi.mock('./MobileNativeChatToolRun', () => ({ ToolRun: 'ToolRun' }))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { MobileNativeChatLongPressContent } from './MobileNativeChatLongPressContent'

const first = '# Answer\n\n- first\n  - nested\n\n```ts\n  const x = 1\n```'
const last = '| Name | Value |\n| --- | --- |\n| x | 1 |\n\nFinal paragraph.\n'
const message: NativeChatMessage = {
  id: 'reply',
  role: 'assistant',
  source: 'transcript',
  timestamp: null,
  blocks: [{ type: 'text', text: 'Started' }]
}

describe('iOS whole-message copy', () => {
  let renderer: ReactTestRenderer | undefined
  const nodes = (type: string) => renderer!.root.findAll((node) => String(node.type) === type)
  function copyButton() {
    const node = nodes('Pressable').find(
      (button) => button.props.accessibilityLabel === 'Copy message'
    )
    if (!node) {
      throw new Error('Copy message action is missing')
    }
    return node
  }
  function render(value = message) {
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message: value }))
    })
  }
  beforeEach(() => {
    vi.clearAllMocks()
    writeText.mockResolvedValue(undefined)
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    vi.useRealTimers()
  })

  it.each(['user', 'assistant'] as const)(
    'copies current %s source outside the text after streaming',
    async (role) => {
      render({ ...message, role })
      const current: NativeChatMessage = {
        ...message,
        role,
        blocks: [
          { type: 'text', text: first },
          { type: 'tool-call', name: 'Read', input: { file_path: 'private.txt' } },
          { type: 'image-ref', path: '/attachment.png' },
          { type: 'text', text: last }
        ]
      }
      act(() => renderer!.update(createElement(MobileNativeChatMessage, { message: current })))
      const copy = copyButton()
      expect(copy.props.accessibilityRole).toBe('button')
      expect(copy.props.onLongPress).toBeUndefined()
      const body = renderer!.root.findByType(MobileNativeChatLongPressContent)
      expect(body.findAll((node) => node.props.accessibilityLabel === 'Copy message')).toHaveLength(
        0
      )
      expect(
        copy.findAll((node) => ['MobileMarkdown', 'ToolRun'].includes(String(node.type)))
      ).toHaveLength(0)
      for (const node of nodes('MobileMarkdown')) {
        expect(node.props.onLongPress).toBeUndefined()
      }
      expect(nodes('Pressable').filter((node) => node.props.onLongPress)).toHaveLength(0)
      await act(async () => copy.props.onPress())
      expect(writeText.mock.calls).toEqual([[first + '\n\n' + last]])
      expect(nodes('MessageActionsSheet')).toHaveLength(0)
      expect(nodes('Check')).toHaveLength(1)
    }
  )

  it('reports clipboard rejection without claiming Copied', async () => {
    writeText.mockRejectedValue(new Error('Clipboard unavailable'))
    render()
    await act(async () => copyButton().props.onPress())
    expect(alert).toHaveBeenCalledWith('Copy failed', 'Clipboard unavailable')
    expect(nodes('Check')).toHaveLength(0)
    expect(nodes('Text').some((node) => node.props.children === 'Copied')).toBe(false)
  })

  it('clears success when source changes and never creates idle-row timers', async () => {
    vi.useFakeTimers()
    render()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(1)
    act(() =>
      renderer!.update(
        createElement(MobileNativeChatMessage, {
          message: { ...message, blocks: [{ type: 'text', text: 'New source' }] }
        })
      )
    )
    expect(nodes('Check')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    act(() => renderer!.update(createElement(MobileNativeChatMessage, { message })))
    expect(nodes('Check')).toHaveLength(0)
    await act(async () => copyButton().props.onPress())
    act(() => renderer!.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)(
    'drops late %s feedback after unmount',
    async (outcome) => {
      vi.useFakeTimers()
      let finish = () => {}
      writeText.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          finish = outcome === 'success' ? resolve : () => reject(new Error('Unavailable'))
        })
      )
      render()
      act(() => copyButton().props.onPress())
      act(() => renderer!.unmount())
      await act(async () => finish())
      expect(alert).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['success', 'failure'] as const)(
    'drops late %s feedback after source changes',
    async (outcome) => {
      vi.useFakeTimers()
      let finish = () => {}
      writeText.mockReturnValue(
        new Promise<void>((resolve, reject) => {
          finish = outcome === 'success' ? resolve : () => reject(new Error('Unavailable'))
        })
      )
      render()
      act(() => copyButton().props.onPress())
      act(() =>
        renderer!.update(
          createElement(MobileNativeChatMessage, {
            message: { ...message, blocks: [{ type: 'text', text: 'Newest source' }] }
          })
        )
      )
      await act(async () => finish())
      expect(writeText.mock.calls).toEqual([['Started']])
      expect(nodes('Check')).toHaveLength(0)
      expect(alert).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('expires confirmation so later copies are still available', async () => {
    vi.useFakeTimers()
    render()
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1500))
    expect(nodes('Check')).toHaveLength(0)
    await act(async () => copyButton().props.onPress())
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('clears an earlier success when the next copy is rejected', async () => {
    vi.useFakeTimers()
    render()
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(1)
    writeText.mockRejectedValue(new Error('Clipboard unavailable'))
    await act(async () => copyButton().props.onPress())
    expect(nodes('Check')).toHaveLength(0)
    expect(alert).toHaveBeenCalledWith('Copy failed', 'Clipboard unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('has no copy footer for image-only or tool-only messages', () => {
    render({ ...message, blocks: [{ type: 'image-ref', path: '/attachment.png' }] })
    expect(nodes('Pressable')).toHaveLength(0)
    act(() =>
      renderer!.update(
        createElement(MobileNativeChatMessage, {
          message: { ...message, blocks: [{ type: 'tool-call', name: 'Read', input: {} }] }
        })
      )
    )
    expect(nodes('Pressable')).toHaveLength(0)
  })
})
