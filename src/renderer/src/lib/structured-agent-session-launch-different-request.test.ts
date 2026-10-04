// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  restoreIntent: vi.fn(),
  launch: vi.fn(),
  seedDraft: vi.fn(),
  clearDraft: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: mocks.seedDraft,
      clearNativeChatLaunchDraft: mocks.clearDraft
    }),
    subscribe: () => () => undefined
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import {
  getStructuredAgentLaunchStatus,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'
import { structuredLaunchRequest } from './structured-agent-session-launch-request'

const WORKTREE_ID = 'wt-different-request'

function launchIntent(sessionId: string): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
    sessionId,
    executionHostId: 'local',
    target: { kind: 'local' },
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${WORKTREE_ID}`,
      agent: 'codex'
    }
  }
}

function publishedSnapshot(...sessionIds: string[]): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: sessionIds.map((sessionId) => ({
      type: 'agent-session',
      id: `tab-${sessionId}`,
      title: 'Codex',
      sessionId,
      agent: 'codex',
      isActive: false
    }))
  }
}

const first = launchIntent('session-first')
const second = launchIntent('session-second')

/** Every `agentSession.send` as [session, text]. */
function sends(): [string, string][] {
  return mocks.callStructuredAgentSession.mock.calls
    .filter((call) => call[1] === 'agentSession.send')
    .map((call) => [call[2].envelope.sessionId, call[2].body.blocks[0].text])
}

describe('a different new request while the first chat is still starting', () => {
  let resolveFirstLaunch!: (receipt: { sessionId: string; fence: number }) => void

  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
      intent.sessionId === first.sessionId
        ? new Promise((resolve) => (resolveFirstLaunch = resolve))
        : Promise.resolve({ sessionId: intent.sessionId, fence: 1 })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(first.sessionId, second.sessionId)
    ])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('opens a new chat with its own text while the first create is in flight', async () => {
    const checkA = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })
    const checkB = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'Fix check B',
      promptDelivery: 'submit-after-ready'
    })

    expect(checkB.sessionId).toBe(second.sessionId)
    await expect(checkB.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })
    await expect(checkA.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([
      [second.sessionId, 'Fix check B'],
      [first.sessionId, 'Fix check A']
    ])
  })

  it('opens a new chat with its own text while the first chat is still sending its text', async () => {
    let resolveFirstSend!: (result: unknown) => void
    mocks.callStructuredAgentSession.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirstSend = resolve))
    )
    const checkA = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready'
    })
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })
    await vi.waitFor(() => expect(sends()).toEqual([[first.sessionId, 'Fix check A']]))

    const checkB = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'Fix check B',
      promptDelivery: 'submit-after-ready'
    })

    expect(checkB.sessionId).toBe(second.sessionId)
    await expect(checkB.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    resolveFirstSend({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    await expect(checkA.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([
      [first.sessionId, 'Fix check A'],
      [second.sessionId, 'Fix check B']
    ])
  })
})

describe('the same request repeated while the first chat is still starting', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    mocks.createIntent.mockReturnValueOnce(first).mockReturnValueOnce(second)
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(first.sessionId)
    ])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('makes one chat from a double click with no text', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))

    const pick = startStructuredAgentLaunch(WORKTREE_ID, 'codex')
    const again = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      promptDelivery: 'submit-after-ready'
    })

    expect(again.sessionId).toBe(pick.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
  })

  it('makes one chat and sends its text once while the create is in flight', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    mocks.launch.mockImplementation(() => new Promise((resolve) => (resolveLaunch = resolve)))
    const onFirstDelivered = vi.fn()
    const onRepeatDelivered = vi.fn()

    const click = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: onFirstDelivered
    })
    const repeat = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'Fix check A',
      promptDelivery: 'submit-after-ready',
      onPromptDelivered: onRepeatDelivered
    })
    resolveLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(repeat.sessionId).toBe(click.sessionId)
    for (const caller of [click, repeat]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(sends()).toEqual([[first.sessionId, 'Fix check A']])
    expect(onFirstDelivered).toHaveBeenCalledOnce()
    expect(onRepeatDelivered).toHaveBeenCalledOnce()
  })

  it('seeds a repeated draft once', () => {
    mocks.launch.mockImplementation(() => new Promise(() => undefined))

    const click = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'PR context',
      promptDelivery: 'draft'
    })
    const repeat = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'PR context',
      promptDelivery: 'draft'
    })

    expect(repeat.sessionId).toBe(click.sessionId)
    expect(mocks.seedDraft).toHaveBeenCalledOnce()
  })
})

describe('an empty chat still starting', () => {
  let resolveFirstLaunch!: (receipt: { sessionId: string; fence: number }) => void
  const third = launchIntent('session-third')
  const notesRequest = { prompt: 'review notes', promptDelivery: 'submit-after-ready' } as const

  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    mocks.createIntent
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third)
    mocks.launch.mockImplementation((intent: StructuredAgentSessionLaunchIntent) =>
      intent.sessionId === first.sessionId
        ? new Promise((resolve) => (resolveFirstLaunch = resolve))
        : Promise.resolve({ sessionId: intent.sessionId, fence: 1 })
    )
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([
      publishedSnapshot(first.sessionId, second.sessionId, third.sessionId)
    ])
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
  })

  it('takes notes sent to a new agent instead of opening a second chat', async () => {
    const blank = startStructuredAgentLaunch(WORKTREE_ID, 'codex')
    // The notes menu stays enabled: its pick fills the empty chat rather than repeating a start.
    expect(
      getStructuredAgentLaunchStatus(WORKTREE_ID, 'codex', structuredLaunchRequest(notesRequest))
    ).toBe('idle')

    const notes = startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesRequest)
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(notes.sessionId).toBe(blank.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    await expect(notes.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([[first.sessionId, 'review notes']])
  })

  it('opens a new chat for any other request once its notes claimed it', async () => {
    startStructuredAgentLaunch(WORKTREE_ID, 'codex')
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesRequest)

    const fix = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      prompt: 'Fix check B',
      promptDelivery: 'submit-after-ready'
    })
    const pick = startStructuredAgentLaunch(WORKTREE_ID, 'codex')

    expect(fix.sessionId).toBe(second.sessionId)
    expect(pick.sessionId).toBe(third.sessionId)
    await expect(fix.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([[second.sessionId, 'Fix check B']])
  })

  it('delivers the claiming text the way its own request asked', async () => {
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { promptDelivery: 'draft' })
    const notes = startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesRequest)
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })

    await expect(notes.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(sends()).toEqual([[first.sessionId, 'review notes']])
    expect(mocks.seedDraft).not.toHaveBeenCalled()
  })

  it('sends the same notes once when they are sent again', async () => {
    const blank = startStructuredAgentLaunch(WORKTREE_ID, 'codex')
    const notes = startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesRequest)
    const again = startStructuredAgentLaunch(WORKTREE_ID, 'codex', notesRequest)
    resolveFirstLaunch({ sessionId: first.sessionId, fence: 1 })

    expect(again.sessionId).toBe(blank.sessionId)
    expect(mocks.createIntent).toHaveBeenCalledOnce()
    for (const caller of [notes, again]) {
      await expect(caller.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
    }
    expect(sends()).toEqual([[first.sessionId, 'review notes']])
  })
})
