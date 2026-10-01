// @vitest-environment happy-dom

// "Resolve comments with AI" writes to GitHub (fixing replies, resolved threads) only once the
// launch prompt reaches the agent. The chat's first message starts that agent, so a start that
// fails must post nothing and hand the comments back for a retry; one a retry clears posts once.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

import type { PRComment } from '../../../../../shared/github/comment-types'
import { enqueueStructuredAgentSessionLaunchPrompt } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import {
  FIRST_START_FAILS,
  firstMessageStream,
  play,
  type FirstMessageChange
} from '@/lib/structured-agent-session-launch-prompt-test-support'
import {
  clearPendingPRCommentAiAck,
  type PendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import { runSourceControlAgentActionStart } from '../runSourceControlAgentActionStart'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'

const REVIEW_KEY = 'repo-1::42::sha-1'

function comment(overrides: Partial<PRComment>): PRComment {
  return {
    id: 1,
    author: 'alice',
    authorAvatarUrl: '',
    body: 'Please update this.',
    createdAt: '2026-05-14T00:00:00Z',
    url: 'https://github.com/acme/widgets/pull/42#discussion_r1',
    ...overrides
  }
}

/** An open review thread and a conversation comment: once the prompt is delivered, the thread is
 *  resolved and the conversation comment gets one fixing reply. */
function resolution(): PendingPRCommentAiAck {
  const target = { repoPath: '/repos/widgets', repoId: 'repo-1', prNumber: 42 }
  return {
    reviewContextKey: REVIEW_KEY,
    provider: 'github',
    selectedGroups: [
      {
        kind: 'thread',
        threadId: 'T1',
        root: comment({ id: 10, threadId: 'T1', path: 'src/a.ts', isResolved: false }),
        replies: []
      },
      {
        kind: 'standalone',
        comment: comment({ id: 20, url: 'https://github.com/acme/widgets/pull/42#issuecomment-9' })
      }
    ],
    githubTarget: { ...target, prRepo: { owner: 'acme', repo: 'widgets' } },
    githubResolveTarget: target
  }
}

type AcknowledgementInput = Parameters<typeof useChecksPanelAiAcknowledgement>[0]

function acknowledgement() {
  const pendingCommentResolutionRef: AcknowledgementInput['pendingCommentResolutionRef'] = {
    current: resolution()
  }
  const model = {
    addPRConversationComment: vi.fn<AcknowledgementInput['addPRConversationComment']>(async () => ({
      ok: true,
      comment: comment({ id: 30 })
    })),
    addPRReviewCommentReply: vi.fn<AcknowledgementInput['addPRReviewCommentReply']>(async () => ({
      ok: true,
      comment: comment({ id: 31, threadId: 'T1' })
    })),
    resolveReviewThread: vi.fn<AcknowledgementInput['resolveReviewThread']>(async () => true),
    asyncResultKeyRef: { current: REVIEW_KEY },
    claimedCommentResolutionRef: { current: null },
    commentsRef: { current: [] },
    commentsSelectionClearTokenRef: { current: 0 },
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef: { current: false },
    setCommentResolutionAckBusyNow: vi.fn(),
    setComments: vi.fn(),
    setCommentsSelectionClearRequest: vi.fn(),
    settings: null,
    fetchComments: vi.fn(async () => {}),
    fetchGitLabDetails: vi.fn(async () => {})
  } satisfies AcknowledgementInput
  const hook = renderHook(() => useChecksPanelAiAcknowledgement(model))
  return { model, hook }
}

/** Starts the launch; the first message's stream is the host's to play. */
function resolveCommentsWithAi(hook: ReturnType<typeof acknowledgement>['hook']) {
  const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'Fix the comments')
  const host = firstMessageStream(mocks, stagedEntry!.clientMessageId)
  mocks.launchAgentInNewTab.mockImplementation(() => ({
    surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
    promptDeliveryResult: settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      options: { prompt: 'Fix the comments', promptDelivery: 'submit-after-ready' },
      stagedEntry
    })
  }))
  const launched = act(() =>
    runSourceControlAgentActionStart({
      selectedAgent: 'claude',
      trimmedCommandInput: 'Fix the comments',
      agentArgs: '',
      agentArgsApply: false,
      commandTemplate: '{basePrompt}',
      saveTargetValue: 'none',
      actionId: 'resolveComments',
      repoId: null,
      settings: null,
      repo: null,
      worktreeId: 'wt-1',
      groupId: 'wt-1',
      promptDelivery: 'submit-after-ready',
      launchPlatform: 'linux',
      launchSource: 'task_page',
      onStart: undefined,
      onLaunchAccepted: hook.result.current.handleLaunchAccepted,
      onLaunchAborted: hook.result.current.handleLaunchAborted,
      onLaunched: () =>
        hook.result.current.consumeClaimedCommentResolutionAfterDeliveryRef.current(),
      onClose: vi.fn()
    })
  )
  return { host, launched }
}

describe('Resolve comments with AI, when the chat starts on its first message', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearPendingPRCommentAiAck()
  })
  afterEach(() => {
    cleanup()
  })

  function expectNothingPosted(model: ReturnType<typeof acknowledgement>['model']) {
    expect(model.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(model.addPRConversationComment).not.toHaveBeenCalled()
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  }

  it('posts its reply and resolves its thread exactly once, after a retried start takes the prompt', async () => {
    const { model, hook } = acknowledgement()
    const { host, launched } = resolveCommentsWithAi(hook)
    const stream = await host
    const [retry, handedOver, accepted] = FIRST_START_FAILS.retriedThenTaken

    await act(async () => {
      stream.next(retry!)
      stream.next(handedOver!)
    })
    // The agent is still starting: nothing is posted, and the comments stay claimed.
    expectNothingPosted(model)
    expect(model.claimedCommentResolutionRef.current).toMatchObject({
      reviewContextKey: REVIEW_KEY
    })

    stream.next(accepted!)
    await expect(launched).resolves.toBe(true)
    await vi.waitFor(() => expect(model.resolveReviewThread).toHaveBeenCalledTimes(1))
    expect(model.addPRConversationComment).toHaveBeenCalledTimes(1)
    expect(model.pendingCommentResolutionRef.current).toBeNull()
  })

  const endings: [string, readonly FirstMessageChange[]][] = [
    ['rejected after its tries', FIRST_START_FAILS.rejectedAfterTries],
    ['withdrawn when its chat closes mid-wait', FIRST_START_FAILS.chatClosed],
    ...['notSignedIn', 'providerMissing', 'providerExited'].map(
      (kind): [string, readonly FirstMessageChange[]] => [
        `refused at once (${kind})`,
        [{ dispatchState: 'rejected', rejection: { kind } }]
      ]
    )
  ]
  it.each(endings)(
    'posts nothing when the first message is %s, and hands the comments back',
    async (_c, end) => {
      const { model, hook } = acknowledgement()
      const { host, launched } = resolveCommentsWithAi(hook)
      play(await host, end)

      await expect(launched).resolves.toBe(false)
      expectNothingPosted(model)
      expect(model.pendingCommentResolutionRef.current).toMatchObject({
        reviewContextKey: REVIEW_KEY
      })
    }
  )

  // The source owns the retry of a launch prompt the host rejected for good: the chat offers none,
  // and sending again from the checks panel is what posts, once.
  it('posts once when sent again from the checks panel after a start that failed for good', async () => {
    const { model, hook } = acknowledgement()
    const first = resolveCommentsWithAi(hook)
    play(await first.host, FIRST_START_FAILS.rejectedAfterTries)
    await expect(first.launched).resolves.toBe(false)
    expectNothingPosted(model)

    const again = resolveCommentsWithAi(hook)
    play(await again.host, FIRST_START_FAILS.retriedThenTaken)
    await expect(again.launched).resolves.toBe(true)

    await vi.waitFor(() => expect(model.resolveReviewThread).toHaveBeenCalledTimes(1))
    expect(model.addPRConversationComment).toHaveBeenCalledTimes(1)
  })
})
