// @vitest-environment happy-dom

// "Resolve comments with AI" writes to GitHub (fixing replies, resolved threads) only once the
// launch prompt reaches the agent. The chat's first message starts that agent, so a start that
// fails must post nothing and hand the comments back for a retry.

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

import type { AgentJournalSubmission } from '../../../../../shared/agent-session-journal-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { enqueueStructuredAgentSessionLaunchPrompt } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { settleStructuredAgentLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import {
  clearPendingPRCommentAiAck,
  type PendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import { runSourceControlAgentActionStart } from '../runSourceControlAgentActionStart'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'

const REVIEW_KEY = 'repo-1::42::sha-1'
const PENDING = {
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'pending' as const,
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null,
  handoverRecorded: true
}

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
    githubTarget: { ...target, prRepo: { owner: 'acme', name: 'widgets' } },
    githubResolveTarget: target
  }
}

function acknowledgement() {
  const model = {
    addPRConversationComment: vi.fn(async () => ({
      ok: true as const,
      comment: comment({ id: 30 })
    })),
    addPRReviewCommentReply: vi.fn(async () => ({
      ok: true as const,
      comment: comment({ id: 31, threadId: 'T1' })
    })),
    resolveReviewThread: vi.fn(async () => true),
    asyncResultKeyRef: { current: REVIEW_KEY },
    claimedCommentResolutionRef: { current: null as PendingPRCommentAiAck | null },
    commentsRef: { current: [] as PRComment[] },
    commentsSelectionClearTokenRef: { current: 0 },
    pendingCommentResolutionRef: { current: resolution() as PendingPRCommentAiAck | null },
    commentResolutionLaunchAcceptedRef: { current: false },
    setCommentResolutionAckBusyNow: vi.fn(),
    setComments: vi.fn(),
    setCommentsSelectionClearRequest: vi.fn(),
    settings: null,
    fetchComments: vi.fn(async () => {}),
    fetchGitLabDetails: vi.fn(async () => {})
  }
  const hook = renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model carries every member the hook reads; its state setters are no-op spies.
    useChecksPanelAiAcknowledgement(
      model as unknown as Parameters<typeof useChecksPanelAiAcknowledgement>[0]
    )
  )
  return { model, hook }
}

/** The new chat's first message, as the host answers it (accepted) and then publishes it. */
function hostAnswers(clientMessageId: string, final: Partial<AgentJournalSubmission>): void {
  const submission = { clientMessageId, ...PENDING }
  mocks.call.mockResolvedValue({
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: { clientMessageId, submission }
  })
  mocks.subscribe.mockImplementation(async (_target, _params, onEvent) => {
    queueMicrotask(() =>
      onEvent({
        type: 'batch',
        sessionId: 'session-1',
        batch: {
          cursor: { epoch: 'epoch-1', sequence: 3 },
          items: [],
          removedItemIds: [],
          submissions: [{ ...submission, ...final }]
        }
      })
    )
    return { unsubscribe: vi.fn() }
  })
}

async function resolveCommentsWithAi(
  hook: ReturnType<typeof acknowledgement>['hook'],
  firstMessageEndsAs: Partial<AgentJournalSubmission>
) {
  const stagedEntry = enqueueStructuredAgentSessionLaunchPrompt('session-1', 'Fix the comments')
  hostAnswers(stagedEntry!.clientMessageId, firstMessageEndsAs)
  mocks.launchAgentInNewTab.mockImplementation(() => ({
    surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'session-1' },
    promptDeliveryResult: settleStructuredAgentLaunchPrompt({
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      options: { prompt: 'Fix the comments', promptDelivery: 'submit-after-ready' },
      stagedEntry
    })
  }))
  return act(() =>
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

  it.each(['notSignedIn', 'providerMissing', 'providerExited'])(
    'posts no reply and resolves no thread when the start fails (%s), and hands the comments back',
    async (kind) => {
      const { model, hook } = acknowledgement()
      await expect(
        resolveCommentsWithAi(hook, { dispatchState: 'rejected', rejection: { kind } })
      ).resolves.toBe(false)

      expect(model.addPRReviewCommentReply).not.toHaveBeenCalled()
      expect(model.addPRConversationComment).not.toHaveBeenCalled()
      expect(model.resolveReviewThread).not.toHaveBeenCalled()
      expect(mocks.toastSuccess).not.toHaveBeenCalled()
      // Handed back for a retry, not consumed.
      expect(model.pendingCommentResolutionRef.current).toMatchObject({
        reviewContextKey: REVIEW_KEY
      })
    }
  )

  it('posts its reply and resolves its thread exactly once when the agent takes the prompt', async () => {
    const { model, hook } = acknowledgement()
    await expect(resolveCommentsWithAi(hook, { handedOverAt: 5 })).resolves.toBe(true)

    await vi.waitFor(() => expect(model.resolveReviewThread).toHaveBeenCalledTimes(1))
    expect(model.addPRConversationComment).toHaveBeenCalledTimes(1)
    expect(model.pendingCommentResolutionRef.current).toBeNull()
  })
})
