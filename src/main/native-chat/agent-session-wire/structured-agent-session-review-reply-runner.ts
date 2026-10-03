// The review writes a message's review reply asks for, through the runtime's repo-scoped GitHub and
// GitLab methods: the ones the review RPCs call. Resolves are idempotent; a reply is not, so a run
// that may repeat one already posted (`reread`) first reads the PR and skips what is there.

import type { AgentSessionReviewReply } from '../../../shared/agent-session-review-reply'
import type { PRComment } from '../../../shared/github/comment-types'
import type { RuntimeReviewCommandSurface } from '../../runtime/runtime-review-command-surface'

export type StructuredAgentSessionReviewRuntime = Pick<
  RuntimeReviewCommandSurface,
  | 'resolveRepoReviewThread'
  | 'resolveGitLabRepoMRDiscussion'
  | 'addRepoPRReviewCommentReply'
  | 'addRepoIssueComment'
  | 'getRepoPRComments'
>

/** The checks panel's ceiling: the shared GitHub client keeps four calls in flight. */
const REVIEW_REPLY_CONCURRENCY = 4

type ReviewWrite = () => Promise<string | null>

/** Runs every write; answers the first failure's words, or null when all went through. */
export async function runStructuredAgentSessionReviewReply(
  runtime: StructuredAgentSessionReviewRuntime,
  spec: AgentSessionReviewReply,
  options: {
    /** When the agent took the message: a reply posted since is this message's. */
    acceptedAt: number
    /** A run that may follow an earlier one cut off before its receipt. */
    reread: boolean
    log: (message: string, error?: unknown) => void
  }
): Promise<string | null> {
  const repo = `id:${spec.repoId}`
  const writes: ReviewWrite[] =
    spec.provider === 'gitlab'
      ? spec.resolve.map((discussionId) => async () => {
          const resolved = await runtime.resolveGitLabRepoMRDiscussion(
            repo,
            spec.iid,
            discussionId,
            true
          )
          return resolved.ok ? null : resolved.error
        })
      : await gitHubWrites(runtime, repo, spec, options)
  const failures = await runBounded(writes, options.log)
  return failures[0] ?? null
}

async function gitHubWrites(
  runtime: StructuredAgentSessionReviewRuntime,
  repo: string,
  spec: Extract<AgentSessionReviewReply, { provider: 'github' }>,
  options: { acceptedAt: number; reread: boolean; log: (message: string, error?: unknown) => void }
): Promise<ReviewWrite[]> {
  const posted = options.reread ? await postedSince(runtime, repo, spec, options) : []
  const alreadyPosted = (body: string, at: { threadId?: string; path?: string } | null) =>
    posted.some(
      (comment) =>
        comment.body.trim() === body.trim() &&
        (at === null
          ? !comment.threadId && !comment.path
          : at.threadId
            ? comment.threadId === at.threadId
            : comment.path === at.path)
    )
  const prRepo = spec.prRepo ?? null
  const conversationReply = spec.conversationReply
  return [
    ...spec.resolve.map(
      (threadId) => async () =>
        (await runtime.resolveRepoReviewThread(repo, threadId, true, prRepo))
          ? null
          : 'Could not resolve the review thread.'
    ),
    ...spec.replies
      .filter((reply) => !alreadyPosted(spec.replyBody, reply))
      .map((reply) => async () => {
        const result = await runtime.addRepoPRReviewCommentReply(repo, {
          prNumber: spec.prNumber,
          commentId: reply.commentId,
          body: spec.replyBody,
          ...(reply.threadId ? { threadId: reply.threadId } : {}),
          ...(reply.path ? { path: reply.path } : {}),
          ...(reply.line !== undefined ? { line: reply.line } : {}),
          prRepo
        })
        return result.ok ? null : result.error
      }),
    ...(conversationReply && !alreadyPosted(conversationReply, null)
      ? [
          async () => {
            const result = await runtime.addRepoIssueComment(
              repo,
              spec.prNumber,
              conversationReply,
              prRepo
            )
            return result.ok ? null : result.error
          }
        ]
      : [])
  ]
}

/** The PR's comments written since the agent took the message. A failed read answers none, which
 *  can post one reply twice: reported, never blocking the rest. */
async function postedSince(
  runtime: StructuredAgentSessionReviewRuntime,
  repo: string,
  spec: Extract<AgentSessionReviewReply, { provider: 'github' }>,
  options: { acceptedAt: number; log: (message: string, error?: unknown) => void }
): Promise<PRComment[]> {
  if (spec.replies.length === 0 && !spec.conversationReply) {
    return []
  }
  try {
    const comments = await runtime.getRepoPRComments(repo, spec.prNumber, spec.prRepo ?? null, {
      noCache: true
    })
    // GitHub stamps whole seconds.
    const since = Math.floor(options.acceptedAt / 1000) * 1000
    return comments.filter((comment) => Date.parse(comment.createdAt) >= since)
  } catch (error) {
    options.log('review reply: could not read the PR before replying; a reply may repeat', error)
    return []
  }
}

async function runBounded(
  writes: readonly ReviewWrite[],
  log: (message: string, error?: unknown) => void
): Promise<string[]> {
  const failures: string[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < writes.length) {
      const write = writes[next++]!
      try {
        const failure = await write()
        if (failure !== null) {
          failures.push(failure)
        }
      } catch (error) {
        log('review reply: a review write failed', error)
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(REVIEW_REPLY_CONCURRENCY, writes.length) }, worker)
  )
  return failures
}
