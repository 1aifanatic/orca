import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import type { PRCommentGroup } from '../../../shared/pr-comment-groups'
import { buildPRCommentBatchConversationReplyBody } from '@/components/right-sidebar/pr-comment-fixing-reply-body'

const state = vi.hoisted(() => {
  const capabilities: string[] = []
  const answers: unknown[] = []
  const calls: unknown[] = []
  const held: { keys: readonly unknown[]; settled: Promise<unknown> }[] = []
  const heldThreads: { keys: readonly unknown[]; settled: Promise<unknown> }[] = []
  return {
    capabilities,
    answers,
    calls,
    held,
    heldThreads,
    clearDeliveredDiffComments: vi.fn(async () => true),
    runResolution: vi.fn(async () => {})
  }
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ clearDeliveredDiffComments: state.clearDeliveredDiffComments })
  }
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => state.capabilities,
  readLocalRuntimeCapabilitiesOrUnknown: () => state.capabilities
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async (_target: unknown, method: string, params: unknown) => {
    state.calls.push([method, params])
    const answer = state.answers.shift()
    if (answer instanceof Error) {
      throw answer
    }
    return answer ?? { taken: [], pending: [] }
  })
}))
vi.mock('@/lib/notes-send-in-flight', () => ({
  diffCommentSendKey: (note: { id: string }) => note.id,
  holdNotesForSend: (keys: readonly unknown[], settled: Promise<unknown>) =>
    state.held.push({ keys, settled })
}))
vi.mock('@/components/right-sidebar/review-comments-resolution-follow-up', () => ({
  runReviewCommentsResolutionFollowUp: state.runResolution
}))
vi.mock('@/components/right-sidebar/pr-comment-groups-in-flight', () => ({
  holdPRCommentGroupsForSend: (keys: readonly unknown[], settled: Promise<unknown>) =>
    state.heldThreads.push({ keys, settled })
}))

const { recordableLaunchFollowUp, reviewCommentsResolutionFollowUp, reviewNotesDeliveredFollowUp } =
  await import('./agent-launch-follow-ups')

const NOTE = { id: 'n1', body: 'fix this', filePath: 'a.ts', lineNumber: 3 }
const NOTES = reviewNotesDeliveredFollowUp('wt-1', [NOTE])
const COMMENT = {
  id: 7,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'please rename this\n\nThe private details of why, which no reply quotes.',
  createdAt: '2026-01-01T00:00:00Z',
  url: 'https://example.test/c/7',
  threadId: 'thread-1',
  path: 'a.ts',
  line: 3
}
const RESOLUTION = reviewCommentsResolutionFollowUp({
  reviewContextKey: 'pr-1',
  provider: 'github',
  selectedGroups: [{ kind: 'thread', threadId: 'thread-1', root: COMMENT, replies: [COMMENT] }]
})

beforeEach(() => {
  state.capabilities = [AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY]
  state.answers = []
  state.calls = []
  state.held = []
  state.heldThreads = []
  state.clearDeliveredDiffComments.mockClear()
  state.runResolution.mockClear()
})
afterEach(() => vi.restoreAllMocks())

function isRecordedResolution(value: unknown): value is { selectedGroups: PRCommentGroup[] } {
  return typeof value === 'object' && value !== null && 'selectedGroups' in value
}

describe('which follow-ups a launch records', () => {
  it('records of each comment only the snippet its "Fixing:" reply quotes', () => {
    expect(JSON.stringify(RESOLUTION.payload)).not.toContain('private details')
    expect(JSON.stringify(RESOLUTION.payload)).toContain('thread-1')
    // A reply built after a reload reads as the click's would, long first lines included.
    const long = { ...COMMENT, id: 8, body: `${'word '.repeat(40)}\nmore` }
    const recorded = reviewCommentsResolutionFollowUp({
      reviewContextKey: 'pr-1',
      provider: 'github',
      selectedGroups: [
        { kind: 'standalone', comment: COMMENT },
        { kind: 'standalone', comment: long }
      ]
    }).payload
    if (!isRecordedResolution(recorded)) {
      throw new Error('unexpected payload')
    }
    const comments = recorded.selectedGroups.flatMap((group) =>
      group.kind === 'standalone' ? [group.comment] : []
    )
    expect(buildPRCommentBatchConversationReplyBody(comments)).toBe(
      buildPRCommentBatchConversationReplyBody([COMMENT, long])
    )
  })

  it('only on a host that keeps them, and only under the size cap', () => {
    expect(recordableLaunchFollowUp(NOTES)).toBe(NOTES)
    expect(recordableLaunchFollowUp(undefined)).toBeUndefined()
    const huge = reviewNotesDeliveredFollowUp('wt-1', [{ ...NOTE, body: 'x'.repeat(300 * 1024) }])
    expect(recordableLaunchFollowUp(huge)).toBeUndefined()
    state.capabilities = []
    expect(recordableLaunchFollowUp(NOTES)).toBeUndefined()
  })
})
