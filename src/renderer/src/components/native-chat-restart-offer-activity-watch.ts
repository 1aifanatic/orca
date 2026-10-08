import {
  getStructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusFeedOwner
} from '@/runtime/structured-agent-session-status-feed'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import { restartMachineTarget, type RestartMachineKey } from './native-chat-restart-machines'

/**
 * Re-reads a machine's offer once an offered or failed chat there shows new activity, so a message
 * the user sent there, or its agent starting, retires its entry here too. The host stays the judge;
 * this only asks again.
 *
 * One watch per machine, on that machine's own status feed, held only while it has something
 * offered or failed. Keyed on status and prompt rather than every summary, so an agent streaming in
 * such a chat costs one re-read, not one per tool call.
 */
const OFFERED_CHAT_REFRESH_DELAY_MS = 500

type WatchedOffer = {
  candidates: readonly ResumeCandidate[]
  failed: readonly ResumeCandidate[]
  listedAt: number
}

type Watch = {
  feed: StructuredAgentSessionStatusFeedOwner
  seen: Map<string, string>
  offer: WatchedOffer
  refresh: ReturnType<typeof setTimeout> | null
  release: () => void
}

const watches = new Map<RestartMachineKey, Watch>()

function offeredChatIds(offer: WatchedOffer): Set<string> {
  return new Set([...offer.candidates, ...offer.failed].map((entry) => entry.sessionId))
}

function activityKey(summary: AgentSessionStatusSummary): string {
  return `${summary.status ?? ''}\u0000${summary.latestPrompt}`
}

export function syncOfferedChatWatch(
  machine: RestartMachineKey,
  offer: WatchedOffer | undefined,
  onActivity: (machine: RestartMachineKey) => void
): void {
  const offeredIds = offer ? offeredChatIds(offer) : new Set<string>()
  if (!offer || offeredIds.size === 0) {
    releaseWatch(machine)
    return
  }
  let watch = watches.get(machine)
  if (!watch) {
    const feed = getStructuredAgentSessionStatusFeed(restartMachineTarget(machine))
    const created: Watch = {
      feed,
      seen: new Map(),
      offer,
      refresh: null,
      release: () => undefined
    }
    const unsubscribe = feed.subscribe(() => noticeActivity(machine, onActivity))
    const deactivate = feed.activate()
    created.release = () => {
      unsubscribe()
      deactivate()
    }
    watches.set(machine, created)
    watch = created
  }
  watch.offer = offer
  for (const sessionId of watch.seen.keys()) {
    if (!offeredIds.has(sessionId)) {
      watch.seen.delete(sessionId)
    }
  }
  // What the feed already holds is what this listing answered.
  for (const sessionId of offeredIds) {
    const summary = watch.feed.getSnapshot().get(sessionId)
    if (summary && !watch.seen.has(sessionId)) {
      watch.seen.set(sessionId, activityKey(summary))
    }
  }
}

function noticeActivity(
  machine: RestartMachineKey,
  onActivity: (machine: RestartMachineKey) => void
): void {
  const watch = watches.get(machine)
  if (!watch) {
    return
  }
  const snapshot = watch.feed.getSnapshot()
  let changed = false
  for (const sessionId of offeredChatIds(watch.offer)) {
    const summary = snapshot.get(sessionId)
    if (!summary) {
      continue
    }
    const key = activityKey(summary)
    const previous = watch.seen.get(sessionId)
    if (previous !== key) {
      watch.seen.set(sessionId, key)
      // A first sighting is news only if newer than the list; a change to a known chat always is,
      // since the host may have answered the list just before the change was delivered here.
      changed ||= previous !== undefined || summary.updatedAt > watch.offer.listedAt
    }
  }
  if (changed && watch.refresh === null) {
    watch.refresh = setTimeout(() => {
      watch.refresh = null
      onActivity(machine)
    }, OFFERED_CHAT_REFRESH_DELAY_MS)
  }
}

function releaseWatch(machine: RestartMachineKey): void {
  const watch = watches.get(machine)
  if (!watch) {
    return
  }
  if (watch.refresh !== null) {
    clearTimeout(watch.refresh)
  }
  watch.release()
  watches.delete(machine)
}

export function releaseOfferedChatWatches(): void {
  for (const machine of watches.keys()) {
    releaseWatch(machine)
  }
}
