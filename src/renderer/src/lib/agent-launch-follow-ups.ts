/**
 * The follow-ups a desktop click records on its launch (`agent-launch-follow-up`), and the window's
 * side of taking them: the live click takes its own before it runs it, and a window that reloaded
 * mid-launch takes the rest at startup. Whoever takes one runs it; a kind or version this build does
 * not know is discarded, never misread.
 *
 * Only the follow-ups a reload would otherwise turn into a second send are recorded: notes deleted
 * once sent, and review threads resolved with replies. A toast is not worth a record.
 */

import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from '@/runtime/local-runtime-capabilities'
import { diffCommentSendKey, holdNotesForSend } from '@/lib/notes-send-in-flight'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'
import type { PendingPRCommentAiAck } from '@/components/right-sidebar/pr-comments-ai-launch-ack'
import { runReviewCommentsResolutionFollowUp } from '@/components/right-sidebar/review-comments-resolution-follow-up'
import { holdPRCommentGroupsForSend } from '@/components/right-sidebar/pr-comment-groups-in-flight'
import { getPRCommentGroupId, type PRCommentGroup } from '../../../shared/pr-comment-groups'
import type { PRComment } from '../../../shared/github/comment-types'
import {
  agentLaunchFollowUpFits,
  type AgentLaunchFollowUp,
  type AgentLaunchFollowUpTake
} from '../../../shared/agent-launch-follow-up'
import { AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'

const REVIEW_NOTES_DELIVERED = 'review-notes-delivered'
const REVIEW_COMMENTS_RESOLUTION = 'review-comments-resolution'

export function reviewNotesDeliveredFollowUp(
  worktreeId: string,
  notes: readonly DiffCommentDeliverySnapshot[]
): AgentLaunchFollowUp {
  // Only what the removal matches on, so a note carries no more than it must.
  const snapshots = notes.map(
    ({ id, body, filePath, lineNumber, startLine, selectedText, source }) => ({
      id,
      body,
      filePath,
      lineNumber,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(selectedText !== undefined ? { selectedText } : {}),
      ...(source !== undefined ? { source } : {})
    })
  )
  return { kind: REVIEW_NOTES_DELIVERED, version: 1, payload: { worktreeId, notes: snapshots } }
}

export function reviewCommentsResolutionFollowUp(
  resolution: PendingPRCommentAiAck
): AgentLaunchFollowUp {
  // Without comment bodies: resolving and replying never read them, and they are other people's
  // words that would otherwise sit in the launch record.
  const withoutBody = (comment: PRComment): PRComment => ({ ...comment, body: '' })
  const selectedGroups = resolution.selectedGroups.map((group): PRCommentGroup =>
    group.kind === 'thread'
      ? { ...group, root: withoutBody(group.root), replies: group.replies.map(withoutBody) }
      : { ...group, comment: withoutBody(group.comment) }
  )
  return {
    kind: REVIEW_COMMENTS_RESOLUTION,
    version: 1,
    payload: { ...resolution, selectedGroups }
  }
}

function isNotesPayload(
  value: unknown
): value is { worktreeId: string; notes: DiffCommentDeliverySnapshot[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'notes' in value &&
    Array.isArray(value.notes) &&
    value.notes.every(
      (note: unknown) =>
        typeof note === 'object' &&
        note !== null &&
        'id' in note &&
        typeof note.id === 'string' &&
        'body' in note &&
        typeof note.body === 'string'
    )
  )
}

function isResolutionPayload(value: unknown): value is PendingPRCommentAiAck {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reviewContextKey' in value &&
    typeof value.reviewContextKey === 'string' &&
    'provider' in value &&
    typeof value.provider === 'string' &&
    'selectedGroups' in value &&
    Array.isArray(value.selectedGroups)
  )
}

/** How to run a recorded follow-up, and keep what it acts on unsendable until it runs. */
function readFollowUp(followUp: AgentLaunchFollowUp): {
  run: () => Promise<void>
  holdUntil?: (settled: Promise<unknown>) => void
} | null {
  if (followUp.kind === REVIEW_NOTES_DELIVERED && followUp.version === 1) {
    const payload = followUp.payload
    if (!isNotesPayload(payload)) {
      return null
    }
    return {
      run: async () => {
        await useAppStore.getState().clearDeliveredDiffComments(payload.worktreeId, payload.notes)
      },
      holdUntil: (settled) => holdNotesForSend(payload.notes.map(diffCommentSendKey), settled)
    }
  }
  if (followUp.kind === REVIEW_COMMENTS_RESOLUTION && followUp.version === 1) {
    const payload = followUp.payload
    return isResolutionPayload(payload)
      ? {
          run: () => runReviewCommentsResolutionFollowUp(payload),
          holdUntil: (settled) =>
            holdPRCommentGroupsForSend(payload.selectedGroups.map(getPRCommentGroupId), settled)
        }
      : null
  }
  return null
}

/** Whether this window's host records follow-ups; an older one runs them live, as before. */
export function hostRecordsLaunchFollowUps(): boolean {
  return (
    readLocalRuntimeCapabilitiesOrUnknown()?.includes(AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY) ??
    false
  )
}

/** The follow-up a launch request may carry: recorded only where the host keeps it and it fits. */
export function recordableLaunchFollowUp(
  followUp: AgentLaunchFollowUp | undefined
): AgentLaunchFollowUp | undefined {
  return followUp && hostRecordsLaunchFollowUps() && agentLaunchFollowUpFits(followUp)
    ? followUp
    : undefined
}

/** Null when the host could not answer: the caller treats that as nothing recorded. */
export async function takeLaunchFollowUps(
  operationId?: string
): Promise<AgentLaunchFollowUpTake | null> {
  try {
    return await callRuntimeRpc<AgentLaunchFollowUpTake>(
      { kind: 'local' },
      'agent.takeLaunchFollowUps',
      operationId ? { operationId } : {}
    )
  } catch (error) {
    console.warn('[agent-launch] could not take launch follow-ups', error)
    return null
  }
}

async function runTaken(take: AgentLaunchFollowUpTake['taken']): Promise<void> {
  for (const entry of take) {
    const followUp = entry.promptHandedOver ? readFollowUp(entry.followUp) : null
    await followUp?.run().catch((error: unknown) => {
      console.warn(`[agent-launch] the ${entry.followUp.kind} follow-up failed`, error)
    })
  }
}

/** How long past the host's own deadline a waiting window takes once more, then lets go. */
const PAST_DEADLINE_GRACE_MS = 15_000
/** For a pending entry whose deadline the host could not say: its owed-prompt deadline. */
const FALLBACK_WAIT_MS = 5 * 60_000

export type RecordedLaunchFollowUpClock = {
  now: () => number
  /** Runs `run` after `ms`; returns its cancel. */
  schedule: (ms: number, run: () => void) => () => void
  /** The host's word that a launch settled its prompt; returns its unsubscribe. */
  onSettled: (listener: (operationId: string) => void) => () => void
}

const WINDOW_CLOCK: RecordedLaunchFollowUpClock = {
  now: () => Date.now(),
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
  onSettled: (listener) =>
    window.api.ui.onAgentLaunchPromptSettled?.((event) => listener(event.operationId)) ?? (() => {})
}

/**
 * Startup: holds what launches still on their way act on, before anything else, then runs the
 * follow-ups launches finished while this window was gone. Each one still pending is taken when
 * the host says its prompt settled, or once more just past the host's own deadline; one still
 * pending then stays on its row for the next start, and nothing is held any more.
 */
export async function runRecordedLaunchFollowUps(
  clock: RecordedLaunchFollowUpClock = WINDOW_CLOCK
): Promise<void> {
  const capabilities = await ensureLocalRuntimeCapabilities()
  if (!capabilities?.includes(AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY)) {
    return
  }
  const first = await takeLaunchFollowUps()
  if (!first) {
    return
  }
  const waiting = new Map<string, () => void>()
  for (const { operationId, followUp } of first.pending) {
    let release: () => void = () => {}
    readFollowUp(followUp)?.holdUntil?.(new Promise<void>((resolve) => (release = resolve)))
    waiting.set(operationId, release)
  }
  await runTaken(first.taken)
  if (waiting.size === 0) {
    return
  }
  await new Promise<void>((done) => {
    const cancels: (() => void)[] = []
    const finish = (operationId: string): void => {
      waiting.get(operationId)?.()
      waiting.delete(operationId)
      if (waiting.size === 0) {
        cancels.forEach((cancel) => cancel())
        done()
      }
    }
    const takeOne = async (operationId: string, last: boolean): Promise<void> => {
      if (!waiting.has(operationId)) {
        return
      }
      const take = await takeLaunchFollowUps(operationId)
      if (take && take.pending.length === 0) {
        await runTaken(take.taken)
        finish(operationId)
      } else if (last) {
        finish(operationId)
      }
    }
    cancels.push(clock.onSettled((operationId) => void takeOne(operationId, false)))
    for (const { operationId, deadline } of first.pending) {
      const waitMs = (deadline ?? clock.now() + FALLBACK_WAIT_MS) - clock.now()
      cancels.push(
        clock.schedule(Math.max(0, waitMs) + PAST_DEADLINE_GRACE_MS, () => {
          void takeOne(operationId, true)
        })
      )
    }
  })
}
