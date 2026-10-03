import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../../src/shared/agent-session-host-status-rows'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { colors } from '../theme/mobile-theme'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'

vi.mock('react-native', () => ({
  Image: 'Image',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./MobileNativeChatToolRun', () => ({ ToolRun: 'ToolRun' }))
vi.mock('./MobileNativeChatTurnStatus', () => ({ MobileNativeChatTurnStatus: 'TurnStatus' }))

function message(
  role: NativeChatMessage['role'],
  presentation?: 'history-item-too-large'
): NativeChatMessage {
  return {
    id: 'notice',
    role,
    timestamp: 1,
    blocks: [{ type: 'text', text: 'provider fallback', presentation }]
  }
}

describe('MobileNativeChatMessage host notices', () => {
  it.each(['system', 'user'] as const)(
    'shows a selectable muted notice for a %s row without a markdown answer',
    async (role) => {
      const renderer = create(createElement('View'))
      try {
        await act(async () =>
          renderer.update(
            createElement(MobileNativeChatMessage, {
              message: message(role, 'history-item-too-large'),
              fontScale: 1.5
            })
          )
        )
        expect(
          renderer.root.findAll((node) => String(node.type) === 'MobileMarkdown')
        ).toHaveLength(0)
        const text = renderer.root.find((node) => String(node.type) === 'Text')
        expect(text.props.children).toBe(AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large'])
        expect(text.props.selectable).toBe(true)
        expect(Object.assign({}, ...text.props.style)).toMatchObject({
          color: colors.textMuted,
          fontSize: 25.5
        })
      } finally {
        act(() => renderer.unmount())
      }
    }
  )

  it('preserves an ordinary assistant answer without treating its text as a host notice', async () => {
    const renderer = create(createElement('View'))
    try {
      await act(async () =>
        renderer.update(createElement(MobileNativeChatMessage, { message: message('assistant') }))
      )
      expect(
        renderer.root.find((node) => String(node.type) === 'MobileMarkdown').props.content
      ).toBe('provider fallback')
    } finally {
      act(() => renderer.unmount())
    }
  })
})
