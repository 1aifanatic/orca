import { toast } from 'sonner'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest
} from './native-chat-resume-on-restart-dialog'
import {
  _resetNativeChatRestartOffer,
  continueNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const offered: ResumeCandidate[] = ['a', 'b'].map((sessionId) => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1_800_000_000_000
}))

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  vi.mocked(toast).mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.mocked(console.warn).mockRestore()
  _resetNativeChatRestartOffer()
})

/** The host lists both chats, then loses every later call. */
function hostLostAfterListing(): void {
  let reachable = true
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable' && reachable) {
      return { sessions: offered, failed: [] }
    }
    reachable = false
    throw new Error('host unreachable')
  })
}

// With the host unreachable there is no list to narrow by: every chat the click named failed, and
// nothing is listed for Show to open.
it('counts every chat of a lost click when the host cannot be read either', async () => {
  hostLostAfterListing()
  await refreshNativeChatRestartOffer()
  await continueNativeChatRestartOffer(['a', 'b'])
  expect(vi.mocked(toast).mock.calls).toEqual([['2 chats couldn’t be resumed', {}]])
})

// An opted-in launch names no chats, only the ones it reports: no click, so no toast.
it('raises no toast when an opted-in launch loses its resume request', async () => {
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: offered, failed: [] }
    }
    throw new Error('response lost')
  })
  await refreshNativeChatRestartOffer()
  await continueNativeChatRestartOffer(undefined, ['a', 'b'])
  expect(getNativeChatRestartOffer().failed.map((entry) => entry.sessionId)).toEqual(['a', 'b'])
  expect(toast).not.toHaveBeenCalled()
})

// The agent was seen carrying on while the toast was up, so the host retired the failure: Show
// re-reads and opens nothing, rather than latching a request for a dialog with no rows to draw.
it('opens nothing from Show once the host no longer lists the chat', async () => {
  let failed = [{ ...offered[0]!, failedAt: 1, outcome: 'unconfirmed', reason: 'unknown' }]
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: [], failed }
      : { continued: [{ sessionId: 'a', outcome: 'unknown' }], sessions: [], failed }
  )
  await refreshNativeChatRestartOffer()
  await continueNativeChatRestartOffer(['a'])
  expect(vi.mocked(toast).mock.calls.map(([title]) => title)).toEqual([
    'Couldn’t confirm 1 chat was resumed'
  ])
  failed = []
  const action = vi.mocked(toast).mock.calls[0]?.[1]?.action
  if (action && typeof action === 'object' && 'onClick' in action) {
    Reflect.apply(action.onClick, undefined, [])
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rpc.mock.calls.at(-1)?.[1]).toBe('agentSession.restartResumable')
  expect(getNativeChatRestartOffer().failed).toEqual([])
  expect(getNativeChatResumeOnRestartDialogRequest()).toBe(false)
})
