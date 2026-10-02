import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionHistoryPage,
  AgentSessionSubscribeEvent
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => {}),
  removeItem: vi.fn(async () => {})
}))
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Text: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})

import { MobileNativeChatComposerNotices } from './MobileNativeChatComposerNotices'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const NOTICE =
  "This chat was saved by a newer Orca, so it's read-only here. Update Orca to continue this chat."

function snapshot(readOnly?: 'written-by-newer-orca'): AgentSessionSubscribeEvent {
  const page: AgentSessionHistoryPage = {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    fence: 3,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-1', sequence: 0 } },
    liveCursor: { epoch: 'epoch-1', sequence: 0 },
    hasOlder: false,
    hasNewer: false,
    ...(readOnly ? { readOnly } : {})
  }
  return { type: 'snapshot', sessionId: 'session-1', fence: 3, page }
}

let renderer: ReactTestRenderer | null = null
let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
let listener: ((value: unknown) => void) | null = null

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only sendRequest and subscribe on the client.
const client = {
  sendRequest: vi.fn(async () => ({ ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })),
  subscribe: vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    listener = onData
    return () => {}
  })
} as unknown as RpcClient

function Harness(): null {
  hook = useMobileStructuredAgentSession({
    client,
    sessionId: 'session-1',
    sourceIdentity: 'host-a\0workspace-a',
    enabled: true,
    connected: true,
    hostSupport: null,
    agent: 'codex',
    onSendError: () => {}
  })
  return null
}

beforeEach(() => {
  listener = null
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  hook = null
})

it("words the host's read-only reason on the phone, and drops it when the host takes writes again", async () => {
  act(() => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).not.toBeNull())
  act(() => listener?.(snapshot('written-by-newer-orca')))
  expect(hook?.session.readOnlyNotice).toBe(NOTICE)
  act(() => listener?.(snapshot()))
  expect(hook?.session.readOnlyNotice).toBeNull()
})

it('shows the notice above the composer as plain text, apart from a send failure', () => {
  const rendered: { view?: ReactTestRenderer } = {}
  act(() => {
    rendered.view = create(
      createElement(MobileNativeChatComposerNotices, {
        readOnlyNotice: NOTICE,
        sendErrorMessage: 'Your message was not sent.'
      })
    )
  })
  const lines = (rendered.view?.root.findAll((node) => String(node.type) === 'View') ?? []).map(
    (node) => [
      node.props.accessibilityRole,
      node.findAll((child) => String(child.type) === 'Text')[0]?.props.children
    ]
  )
  expect(lines).toEqual([
    ['text', NOTICE],
    ['alert', 'Your message was not sent.']
  ])
  act(() => rendered.view?.unmount())
})
