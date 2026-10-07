import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import type { PendingPRCommentAiAck, PRCommentAiLaunchAckDeps } from './pr-comments-ai-launch-ack'

const mocks = vi.hoisted(() => ({
  ack: vi.fn(),
  toast: { error: vi.fn(), success: vi.fn() }
}))
vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('./pr-comments-ai-launch-ack', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acknowledgePRCommentsAfterAiLaunch: mocks.ack
}))

const { acknowledgeCommentResolutionAfterDelivery } =
  await import('./pr-comment-resolution-after-delivery')

const RESOLUTION: PendingPRCommentAiAck = {
  reviewContextKey: 'pr-1',
  provider: 'github',
  selectedGroups: [],
  githubTarget: { repoPath: '/repo', repoId: 'r1', prNumber: 1, prRepo: { owner: 'o', repo: 'r' } }
}
const POSTED: PRComment = {
  id: 9,
  author: 'me',
  authorAvatarUrl: '',
  body: 'Fixing.',
  createdAt: '2026-01-01T00:00:00Z',
  url: 'https://example.test/c/9'
}

function actions() {
  return {
    resolveReviewThread: vi.fn(async () => true),
    addPRReviewCommentReply: vi.fn(),
    addPRConversationComment: vi.fn(async () => ({ ok: true as const, comment: POSTED })),
    settings: null
  }
}

function view(onReview: boolean) {
  return {
    isStillOnLaunchReview: () => onReview,
    existingComments: () => [],
    setComments: vi.fn(),
    refresh: vi.fn(async () => {})
  }
}

/** Acknowledges by posting one conversation reply, as a selection of plain comments would. */
function ackPostsOneReply(counts = { resolved: 0, replied: 1, skipped: 0, failed: 0 }) {
  mocks.ack.mockImplementationOnce(async ({ deps }: { deps: PRCommentAiLaunchAckDeps }) => {
    await deps.replyAsConversation('Fixing.')
    return counts
  })
}

beforeEach(() => vi.clearAllMocks())

describe('resolving a Checks launch’s comments once its prompt reached the agent', () => {
  it('shows the replies in the panel still on that review, then refreshes it', async () => {
    ackPostsOneReply()
    const panel = view(true)
    const refreshCache = vi.fn(async () => {})
    await acknowledgeCommentResolutionAfterDelivery(RESOLUTION, {
      actions: actions(),
      view: panel,
      refreshCache
    })
    expect(panel.setComments).toHaveBeenCalledOnce()
    expect(panel.refresh).toHaveBeenCalledOnce()
    expect(refreshCache).not.toHaveBeenCalled()
    expect(mocks.toast.success).toHaveBeenCalledOnce()
  })

  it('leaves a panel that moved to another review alone', async () => {
    ackPostsOneReply()
    const panel = view(false)
    await acknowledgeCommentResolutionAfterDelivery(RESOLUTION, {
      actions: actions(),
      view: panel,
      refreshCache: vi.fn(async () => {})
    })
    expect(panel.setComments).not.toHaveBeenCalled()
    expect(panel.refresh).not.toHaveBeenCalled()
  })

  it('with no panel, as after a reload, posts the same replies and refreshes the cached comments', async () => {
    ackPostsOneReply()
    const host = actions()
    const refreshCache = vi.fn(async () => {})
    await acknowledgeCommentResolutionAfterDelivery(RESOLUTION, { actions: host, refreshCache })
    expect(host.addPRConversationComment).toHaveBeenCalledOnce()
    expect(refreshCache).toHaveBeenCalledOnce()
    expect(mocks.toast.success).toHaveBeenCalledOnce()
  })

  it('reports what failed with the counts', async () => {
    ackPostsOneReply({ resolved: 1, replied: 0, skipped: 0, failed: 1 })
    await acknowledgeCommentResolutionAfterDelivery(RESOLUTION, {
      actions: actions(),
      refreshCache: vi.fn(async () => {})
    })
    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('failed 1'))
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })

  it('says so once when acknowledging throws, never rejecting its caller', async () => {
    mocks.ack.mockRejectedValueOnce(new Error('offline'))
    await expect(
      acknowledgeCommentResolutionAfterDelivery(RESOLUTION, {
        actions: actions(),
        refreshCache: vi.fn(async () => {})
      })
    ).resolves.toBeUndefined()
    expect(mocks.toast.error).toHaveBeenCalledExactlyOnceWith(
      'Started the agent, but could not resolve or reply on the selected comments.'
    )
  })
})
