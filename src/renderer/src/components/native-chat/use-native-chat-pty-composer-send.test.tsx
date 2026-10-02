// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatSendClassification } from '../../../../shared/native-chat-slash-commands'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { sendNativeChatMessage } from './native-chat-runtime-send'
import { sendNativeChatMessageWithImageAttachments } from './native-chat-runtime-image-send'
import {
  clearNativeChatDraftCacheForTests,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'
import {
  installHeldNativeChatDrafts,
  installNativeChatDrafts
} from './native-chat-draft-store.test-support'

const handle = vi.hoisted(() => ({ cancel: () => {}, settleAfterMs: 0 }))
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => handle),
  sendNativeChatTypedCommand: vi.fn(() => handle),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: vi.fn(() => handle)
}))
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ clearNativeChatLaunchDraft: vi.fn() }) }
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

const DRAFT_KEY = 'pane:tab:leaf'

function press(
  agent: AgentType,
  classification: NativeChatSendClassification,
  draft: string,
  imagePaths: string[] = []
) {
  const callbacks = { rejected: vi.fn(), unconfirmed: vi.fn(), setDraft: vi.fn() }
  const { result } = renderHook(() =>
    useNativeChatPtyComposerSend({
      agent,
      draftKey: DRAFT_KEY,
      draft,
      imageAttachments: imagePaths.map((path) => ({ path })),
      disabled: false,
      isDispatchingSessionOption: false,
      launchDraftResolved: true,
      resolveTarget: () => ({ ptyId: 'pty', settings: null }),
      classifySend: () => classification,
      onOptimisticSend: () => 'pending-1',
      optimisticSendOutcome: { reject: callbacks.rejected, holdUnconfirmed: callbacks.unconfirmed },
      sessionOptionsSurface: null,
      terminalTabId: 'tab',
      trackPendingSend: vi.fn(),
      setHistory: vi.fn(),
      // As the composer's draft hook does: a clear is saved at once.
      setDraft: (value) => {
        callbacks.setDraft(value)
        writeNativeChatDraftCache(DRAFT_KEY, value, 'now')
      },
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    })
  )
  result.current()
  return callbacks
}

/** Presses Enter and waits for the write to the terminal, which follows the saved clear. */
async function send(...args: Parameters<typeof press>) {
  const callbacks = press(...args)
  await vi.waitFor(() =>
    expect(
      vi.mocked(sendNativeChatMessage).mock.calls.length +
        vi.mocked(sendNativeChatMessageWithImageAttachments).mock.calls.length
    ).toBe(1)
  )
  return callbacks
}

beforeEach(() => {
  vi.mocked(sendNativeChatMessage).mockClear()
  vi.mocked(sendNativeChatMessageWithImageAttachments).mockClear()
  installNativeChatDrafts({
    load: async () => [],
    loadSync: () => [],
    write: async () => 'persisted'
  })
})

afterEach(() => {
  clearNativeChatDraftCacheForTests()
  vi.useRealTimers()
})

it('routes a Claude chat send outcome to its own pending echo', async () => {
  const callbacks = await send('claude', 'chat', 'hello')
  const options = vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]
  options?.onWriteRejected?.()
  options?.onWriteUnconfirmed?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
  expect(callbacks.unconfirmed).toHaveBeenCalledWith('pending-1')
})

it('routes a Claude image send outcome to its own pending echo', async () => {
  const callbacks = await send('claude', 'chat', 'look', ['/tmp/shot.png'])
  vi.mocked(sendNativeChatMessageWithImageAttachments).mock.calls[0]?.[5]?.onWriteRejected?.()
  expect(callbacks.rejected).toHaveBeenCalledWith('pending-1')
})

it.each([
  ['codex', 'chat', 'hello'],
  ['claude', 'command', '/compact']
] as const)(
  'leaves a %s %s send on the unobserved write path',
  async (agent, classification, draft) => {
    await send(agent, classification, draft)
    expect(vi.mocked(sendNativeChatMessage).mock.calls[0]?.[3]?.onWriteRejected).toBeUndefined()
  }
)

// A crash after the agent took the message must not bring it back as a draft, so the cleared
// draft is on disk before the message is written to the terminal.
describe('the saved draft at send', () => {
  it('empties the box at Enter and writes to the terminal only once the clear is saved', async () => {
    const writes = installHeldNativeChatDrafts()
    writeNativeChatDraftCache(DRAFT_KEY, 'hello', 'now')
    writes.shift()?.settle('persisted')

    const callbacks = press('codex', 'chat', 'hello')

    expect(callbacks.setDraft).toHaveBeenCalledWith('')
    expect(writes).toEqual([expect.objectContaining({ scopeKey: DRAFT_KEY, draft: null })])
    await Promise.resolve()
    expect(sendNativeChatMessage).not.toHaveBeenCalled()

    writes[0]?.settle('persisted')
    await vi.waitFor(() => expect(sendNativeChatMessage).toHaveBeenCalledOnce())
  })

  it('still sends when the clear could not be saved', async () => {
    const writes = installHeldNativeChatDrafts()
    press('codex', 'chat', 'hello')

    writes[0]?.settle('failed')
    await vi.waitFor(() => expect(sendNativeChatMessage).toHaveBeenCalledOnce())
  })

  it('still sends, after a short wait, when saving the clear stalls', async () => {
    vi.useFakeTimers()
    installHeldNativeChatDrafts()
    press('codex', 'chat', 'hello')

    await vi.advanceTimersByTimeAsync(200)
    expect(sendNativeChatMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    expect(sendNativeChatMessage).toHaveBeenCalledOnce()
  })
})
