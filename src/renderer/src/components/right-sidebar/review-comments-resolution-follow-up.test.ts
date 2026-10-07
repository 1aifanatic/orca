import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checksPanelReviewStableKey, type PendingPRCommentAiAck } from './pr-comments-ai-launch-ack'

const store = vi.hoisted(() => ({
  fetchPRComments: vi.fn(async () => []),
  resolveReviewThread: vi.fn(async () => true),
  addPRReviewCommentReply: vi.fn(),
  addPRConversationComment: vi.fn(),
  settings: null
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

const { runReviewCommentsResolutionFollowUp } =
  await import('./review-comments-resolution-follow-up')
const { registerOpenChecksPanelView } = await import('./checks-panel/open-checks-panel-views')

function resolution(provider: 'github' | 'gitlab'): PendingPRCommentAiAck {
  return {
    reviewContextKey: 'repo-1::pr::42::sha-1',
    provider,
    selectedGroups: [],
    githubResolveTarget: { repoPath: '/repo', repoId: 'repo-1', prNumber: 42 }
  }
}

function panelOn(reviewContextKey: string) {
  const panel = {
    stableKey: () => checksPanelReviewStableKey(reviewContextKey),
    existingComments: () => [],
    setComments: vi.fn(),
    refresh: vi.fn(async (_provider: string) => {})
  }
  return { panel, unregister: registerOpenChecksPanelView(panel) }
}

beforeEach(() => vi.clearAllMocks())

describe('a reload’s comment resolution, with a Checks panel already open', () => {
  it.each(['github', 'gitlab'] as const)(
    're-reads that panel on that review (%s), as its own click does',
    async (provider) => {
      const { panel, unregister } = panelOn('repo-1::pr::42::sha-2')
      await runReviewCommentsResolutionFollowUp(resolution(provider))
      expect(panel.refresh).toHaveBeenCalledExactlyOnceWith(provider)
      expect(store.fetchPRComments).not.toHaveBeenCalled()
      unregister()
    }
  )

  it('leaves a panel on another review alone and refreshes the cached comments instead', async () => {
    const { panel, unregister } = panelOn('repo-1::pr::7::sha-1')
    await runReviewCommentsResolutionFollowUp(resolution('github'))
    expect(panel.refresh).not.toHaveBeenCalled()
    expect(store.fetchPRComments).toHaveBeenCalledOnce()
    unregister()
  })
})
