// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'
import { openChecksPanelViewFor } from './open-checks-panel-views'

function model(reviewKey: string) {
  return {
    addPRConversationComment: vi.fn(),
    addPRReviewCommentReply: vi.fn(),
    asyncResultKeyRef: { current: reviewKey },
    claimedCommentResolutionRef: { current: null },
    commentsRef: { current: [] },
    commentsSelectionClearTokenRef: { current: 0 },
    pendingCommentResolutionRef: { current: null },
    resolveReviewThread: vi.fn(),
    setCommentResolutionAckBusyNow: vi.fn(),
    setComments: vi.fn(),
    setCommentsSelectionClearRequest: vi.fn(),
    settings: null,
    commentResolutionLaunchAcceptedRef: { current: false },
    fetchComments: vi.fn(async () => {}),
    fetchGitLabDetails: vi.fn(async () => {})
  } satisfies Parameters<typeof useChecksPanelAiAcknowledgement>[0]
}

const resolution = (provider: 'github' | 'gitlab') => ({
  reviewContextKey: 'repo-1::pr::42::sha-1',
  provider,
  selectedGroups: []
})

describe('a mounted Checks panel, for a resolution that runs without its click', () => {
  it('is found while it shows that review, and re-reads it from the review’s provider', async () => {
    const panel = model('repo-1::pr::42::sha-2')
    const { unmount } = renderHook(() => useChecksPanelAiAcknowledgement(panel))

    await openChecksPanelViewFor(resolution('github'))?.refresh()
    expect(panel.fetchComments).toHaveBeenCalledExactlyOnceWith({ force: true })
    await openChecksPanelViewFor(resolution('gitlab'))?.refresh()
    expect(panel.fetchGitLabDetails).toHaveBeenCalledExactlyOnceWith({ commitAsCurrent: true })

    panel.asyncResultKeyRef.current = 'repo-1::pr::7::sha-1'
    expect(openChecksPanelViewFor(resolution('github'))).toBeUndefined()
    panel.asyncResultKeyRef.current = 'repo-1::pr::42::sha-2'
    unmount()
    expect(openChecksPanelViewFor(resolution('github'))).toBeUndefined()
  })
})
