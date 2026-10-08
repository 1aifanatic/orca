import { BoundedMap } from '../../shared/bounded-map'
import {
  canReplaceSubagentState,
  isTerminalSubagentState
} from '../../shared/native-chat-subagent-summary'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { subagentGroupJournalBody } from '../native-chat/agent-session-journal/journal-subagent-group-body'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'

/** The shared roster's bounds: the most groups a session keeps, and children per group. */
const MAX_GROUPS = 32
const MAX_SUBAGENTS_PER_GROUP = 64
const UNLABELLED = 'subagent'

type RosterGroup = {
  groupId: string
  turn?: string
  entries: Map<string, NativeChatSubagentEntry>
  labelCounts: Map<string, number>
  lastSerialized: string | null
}

/** One roster row per spawning turn, revised in place, plus each completed subagent's reply as its
 *  own row, filed under its id so it opens beneath its roster entry. Lives as long as the provider
 *  child: a subagent an earlier run spawned is not known here, and its row is that run's. */
export class AcpSubagentTimeline {
  private readonly groups = new BoundedMap<string, RosterGroup>({ maxEntries: MAX_GROUPS })
  private readonly groupOf = new BoundedMap<string, string>({
    maxEntries: MAX_GROUPS * MAX_SUBAGENTS_PER_GROUP
  })
  private readonly results = new BoundedMap<string, string>({
    maxEntries: MAX_GROUPS * MAX_SUBAGENTS_PER_GROUP
  })

  /** Whether `id` is a subagent this run saw spawn. */
  has(id: string): boolean {
    return this.groupOf.has(id) && this.groups.has(this.groupOf.peek(id) ?? '')
  }

  translate(
    updates: AcpSubagentUpdate[],
    join: ProviderTimelineJoin,
    at: number
  ): ProviderTimelineEvent[] {
    const changed = new Set<RosterGroup>()
    const replies: { id: string; group: RosterGroup; text: string }[] = []
    for (const update of updates) {
      const group = this.apply(update, join, at)
      if (!group) {
        continue
      }
      changed.add(group)
      const entry = group.entries.get(update.id)
      if (update.result && entry?.state === 'completed') {
        replies.push({ id: update.id, group, text: update.result })
      }
    }
    const events = [...changed].flatMap((group) => this.groupEvent(group, join))
    for (const { id, group, text } of replies) {
      const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      if (this.results.get(id) === bounded) {
        continue
      }
      this.results.set(id, bounded)
      events.push({
        type: 'item.update',
        item: `subagent-result:${id}`,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: bounded }] },
        producer: { agentId: id, producerKind: 'agent' },
        join: groupJoin(group, join)
      })
    }
    return events
  }

  private apply(
    update: AcpSubagentUpdate,
    join: ProviderTimelineJoin,
    at: number
  ): RosterGroup | undefined {
    const known = this.groups.get(this.groupOf.get(update.id) ?? '')
    const current = known?.entries.get(update.id)
    if (known && current) {
      const state =
        update.state && canReplaceSubagentState(current.state, update.state)
          ? update.state
          : current.state
      known.entries.set(update.id, {
        ...current,
        state,
        ...(state !== current.state && isTerminalSubagentState(state) ? { settledAt: at } : {}),
        ...(update.tokens ? { tokens: update.tokens } : {})
      })
      return known
    }
    if (update.knownOnly) {
      return undefined
    }
    const group = this.groupFor(update.turn ?? join.turn)
    if (group.entries.size >= MAX_SUBAGENTS_PER_GROUP) {
      return undefined
    }
    const state = update.state ?? 'working'
    group.entries.set(update.id, {
      id: update.id,
      label: this.claimLabel(group, update.label ?? UNLABELLED),
      state,
      startedAt: at,
      ...(isTerminalSubagentState(state) ? { settledAt: at } : {}),
      ...(update.tokens ? { tokens: update.tokens } : {})
    })
    this.groupOf.set(update.id, group.groupId)
    return group
  }

  private groupFor(turn: string | undefined): RosterGroup {
    const groupId = turn ?? 'thread'
    const existing = this.groups.get(groupId)
    if (existing) {
      return existing
    }
    const group: RosterGroup = {
      groupId,
      ...(turn === undefined ? {} : { turn }),
      entries: new Map(),
      labelCounts: new Map(),
      lastSerialized: null
    }
    this.groups.set(groupId, group)
    return group
  }

  /** Two subagents with one description stay apart by ordinal, not by an invented name. */
  private claimLabel(group: RosterGroup, label: string): string {
    const seen = group.labelCounts.get(label) ?? 0
    group.labelCounts.set(label, seen + 1)
    return seen === 0 ? label : `${label} ${seen + 1}`
  }

  private groupEvent(group: RosterGroup, join: ProviderTimelineJoin): ProviderTimelineEvent[] {
    const body = subagentGroupJournalBody(group.groupId, [...group.entries.values()])
    const serialized = JSON.stringify(body)
    if (serialized === group.lastSerialized) {
      return []
    }
    // A repeated report must not burn a revision; the host retries a refused event itself.
    group.lastSerialized = serialized
    return [
      {
        type: 'item.update',
        item: `subagents:${group.groupId}`,
        body,
        join: groupJoin(group, join)
      }
    ]
  }
}

function groupJoin(group: RosterGroup, join: ProviderTimelineJoin): ProviderTimelineJoin {
  return {
    ...(join.thread === undefined ? {} : { thread: join.thread }),
    ...(group.turn ? { turn: group.turn } : {})
  }
}
