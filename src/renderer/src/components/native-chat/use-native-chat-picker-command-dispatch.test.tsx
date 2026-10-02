// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_HISTORY } from './native-chat-composer-state'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  installHeldNativeChatDrafts,
  installNativeChatDrafts
} from './native-chat-draft-store.test-support'

const sendNativeChatMessage = vi.fn()
const sendNativeChatTypedCommand = vi.fn()

vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: (...args: unknown[]) => sendNativeChatMessage(...args),
  sendNativeChatTypedCommand: (...args: unknown[]) => sendNativeChatTypedCommand(...args)
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))

import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'

const COMMAND = {
  kind: 'command' as const,
  id: 'command:status',
  name: 'status',
  token: '/status',
  description: 'Show status',
  skillCollision: false
}

const DRAFT_KEY = 'pane:tab-1:leaf-1'

function renderDispatch(
  agent: 'codex' | 'claude' | 'openclaude',
  trackPendingSend: (handle: { cancel: () => void }) => void = vi.fn()
) {
  return renderHook(() =>
    useNativeChatPickerCommandDispatch({
      agent,
      draftKey: DRAFT_KEY,
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: () => ({ settings: {}, ptyId: 'pty-1' }),
      sessionOptionsSurface: null,
      trackPendingSend,
      setHistory: vi.fn((update) => update(EMPTY_HISTORY)),
      // As the composer's draft hook does: a clear is saved at once.
      setDraft: (value: string) => writeNativeChatDraftCache(DRAFT_KEY, value, 'now'),
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
}

describe('useNativeChatPickerCommandDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const handle = { cancel: vi.fn(), settleAfterMs: 0 }
    sendNativeChatMessage.mockReturnValue(handle)
    sendNativeChatTypedCommand.mockReturnValue(handle)
    installNativeChatDrafts({
      load: async () => [],
      loadSync: () => [],
      write: async () => 'persisted'
    })
  })

  afterEach(() => clearNativeChatDraftCacheForTests())

  it('types Codex autocomplete commands', async () => {
    const hook = renderDispatch('codex')
    await act(async () => hook.result.current(COMMAND))

    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith({}, 'pty-1', '/status')
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it.each(['claude', 'openclaude'] as const)(
    'keeps %s autocomplete commands pasted',
    async (agent) => {
      const hook = renderDispatch(agent)
      await act(async () => hook.result.current(COMMAND))

      expect(sendNativeChatMessage).toHaveBeenCalledWith({}, 'pty-1', '/status')
      expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
    }
  )
})

// A command picked from the menu goes out like a typed message: its clear is saved first.
describe('a command picked from the menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendNativeChatTypedCommand.mockReturnValue({ cancel: vi.fn(), settleAfterMs: 0 })
  })

  afterEach(() => clearNativeChatDraftCacheForTests())

  it('is written to the terminal only once the cleared draft is saved', async () => {
    const writes = installHeldNativeChatDrafts()
    writeNativeChatDraftCache(DRAFT_KEY, '/sta', 'now')
    writes.shift()?.settle('persisted')
    const hook = renderDispatch('codex')

    act(() => hook.result.current(COMMAND))
    expect(writes.at(-1)).toMatchObject({ scopeKey: DRAFT_KEY, draft: null })
    await Promise.resolve()
    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()

    await act(async () => writes.forEach((write) => write.settle('persisted')))
    expect(sendNativeChatTypedCommand).toHaveBeenCalledWith({}, 'pty-1', '/status')
  })

  it('goes back into the box, unsent, when Stop comes while its clear is saved', async () => {
    const writes = installHeldNativeChatDrafts()
    const tracked: { cancel: () => void }[] = []
    const hook = renderDispatch('codex', (handle) => tracked.push(handle))

    act(() => hook.result.current(COMMAND))
    tracked.forEach((handle) => handle.cancel())
    await act(async () => writes.forEach((write) => write.settle('persisted')))

    expect(sendNativeChatTypedCommand).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(DRAFT_KEY)).toBe('/status')
  })
})
