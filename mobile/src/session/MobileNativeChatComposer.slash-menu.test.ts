import { createElement, type ComponentProps } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type { AgentSessionSlashCommand } from '../../../src/shared/agent-session-wire'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'
import { mobileNativeChatSlashMenu } from './mobile-native-chat-slash-menu'

vi.mock('react-native', async () => ({
  ActivityIndicator: 'ActivityIndicator',
  Image: 'Image',
  Keyboard: { dismiss: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  SectionList: (await import('../test-support/section-list-test-double')).SectionListTestDouble,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic',
  Square: 'Square',
  X: 'X'
}))

// The session-option pickers reach a drawer that imports untransformable native modules.
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))

// A pass-through spy, so a test can count how often the rows are rebuilt.
vi.mock('./mobile-native-chat-slash-menu', async (importOriginal) => {
  const actual: { mobileNativeChatSlashMenu: (args: never) => unknown } = await importOriginal()
  return { mobileNativeChatSlashMenu: vi.fn(actual.mobileNativeChatSlashMenu) }
})

const REPORT: AgentSessionSlashCommand[] = [
  { name: 'review', kind: 'command', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'triage', kind: 'skill', description: 'Sort incoming issues' }
]

const CONVERSATION_COMMANDS: AgentSessionConversationCommand[] = ['clear', 'compact']

type ComposerProps = ComponentProps<typeof MobileNativeChatComposer>

describe('MobileNativeChatComposer `/` menu', () => {
  let renderer: ReactTestRenderer | null = null
  const onChangeText = vi.fn()
  const onSend = vi.fn().mockResolvedValue(true)
  const generation = () => 0

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function props(overrides: Partial<ComposerProps>): ComposerProps {
    return {
      value: '/',
      onChangeText,
      onSend,
      sendSurfaceId: 'tab-a',
      getSendCompletionGeneration: generation,
      getComposerEditGeneration: generation,
      agent: 'claude',
      structuredCommands: CONVERSATION_COMMANDS,
      ...overrides
    }
  }

  async function open(overrides: Partial<ComposerProps> = {}): Promise<void> {
    const next = props(overrides)
    await act(async () => {
      renderer = create(createElement(MobileNativeChatComposer, next))
    })
    const input = renderer!.root.find((node) => String(node.type) === 'TextInput')
    await act(async () =>
      input.props.onSelectionChange({ nativeEvent: { selection: { end: next.value.length } } })
    )
  }

  function texts(): unknown[] {
    return renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => (node.props as { children?: unknown }).children)
  }

  function row(token: string): ReactTestInstance {
    return renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.findAll((child) => String(child.type) === 'Text' && child.props.children === token)
          .length > 0
    )
  }

  function sections(): unknown {
    return renderer!.root.find((node) => String(node.type) === 'SectionList').props.sections
  }

  it('lists reported commands and skills under their headings with hint and description', async () => {
    await open({ sessionCommands: REPORT })
    expect(texts()).toEqual([
      'Commands',
      '/review',
      '<pr>',
      'Review a pull request',
      'Skills',
      '/triage',
      'Sort incoming issues'
    ])
  })

  it('inserts the picked skill and command tokens, ready for arguments', async () => {
    await open({ sessionCommands: REPORT })
    await act(async () => row('/triage').props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('/triage ')
    await act(async () => row('/review').props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('/review ')
  })

  it('shows a heading only for a group with rows', async () => {
    await open({ sessionCommands: [REPORT[0]!] })
    expect(texts()).toContain('Commands')
    expect(texts()).not.toContain('Skills')
  })

  it('keeps an older host on the host-owned fallback commands', async () => {
    await open({ sessionCommands: undefined })
    expect(texts().filter((text) => text === 'Commands' || String(text).startsWith('/'))).toEqual([
      'Commands',
      '/model',
      '/effort',
      '/clear',
      '/compact'
    ])
    expect(texts()).not.toContain('Skills')
  })

  it('keeps file autocomplete on `@`', async () => {
    await open({ value: '@app', filePaths: ['src/apple.ts', 'docs/readme.md'] })
    expect(texts()).toEqual(['@src/apple.ts'])
    await act(async () => row('@src/apple.ts').props.onPress())
    expect(onChangeText).toHaveBeenLastCalledWith('@src/apple.ts ')
  })

  it('does not rebuild the rows when a streamed frame re-renders the composer', async () => {
    await open({ sessionCommands: REPORT })
    const builds = vi.mocked(mobileNativeChatSlashMenu).mock.calls.length
    const before = sections()
    // A parent re-render with unrelated changes, as a streamed transcript frame causes.
    await act(async () => {
      renderer!.update(
        createElement(
          MobileNativeChatComposer,
          props({ sessionCommands: REPORT, placeholder: 'Another frame' })
        )
      )
    })
    expect(vi.mocked(mobileNativeChatSlashMenu).mock.calls.length).toBe(builds)
    expect(sections()).toBe(before)

    const refreshed: AgentSessionSlashCommand[] = [...REPORT, { name: 'init', kind: 'command' }]
    await act(async () => {
      renderer!.update(
        createElement(MobileNativeChatComposer, props({ sessionCommands: refreshed }))
      )
    })
    expect(vi.mocked(mobileNativeChatSlashMenu).mock.calls.length).toBe(builds + 1)
    expect(sections()).not.toBe(before)
    expect(texts()).toContain('/init')
  })
})
