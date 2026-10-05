// The one row that says a turn was cut short when the agent stopped without anyone asking (a crash,
// a quit, an eviction, a teardown). Derived on read from the journal, never stored: the turn record
// is the durable fact, so a journal written before this rule, a quit that died mid-settle and any
// future stop cause all read the same. A row the host already wrote about the stop stays the
// explanation, so nothing is said twice. Shared by desktop and mobile, whose transcripts must agree.
// The journal names no cause a reader can see, so the words fit every cause and blame no one.

import { readAgentSessionFailureFact } from './agent-session-failure'
import { agentSessionResponseInterruptedBody } from './agent-session-host-status-rows'
import { agentJournalItemKey, parseAgentJournalItemKey } from './agent-session-journal-item-key'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { readAgentJournalTurn, readAgentJournalTurnOutcome } from './agent-session-turn-record'
import { agentTurnVerdict } from './agent-turn-outcome'
import {
  PROVIDER_EXIT_ROW_PREFIX,
  RESTART_CONTINUATION_ROW_PREFIX,
  STALE_SESSION_ROW_PREFIX
} from './agent-session-stop-row-identity'
import { isStructuredAgentSessionStartFailureRow } from './structured-agent-session-start-failure-row-key'
import { hostStatesTurnScopes } from './native-chat-turn-membership'

const CUT_TURN_NOTICE_ROW = 'cut-turn-notice:'

function rootTurnVerdict(
  item: AgentJournalRenderItem
): ReturnType<typeof agentTurnVerdict> | 'none' {
  const turn = readAgentJournalTurn(item.body)
  return turn && isRootAgentJournalItem(item)
    ? agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) })
    : 'none'
}

/** Root turns that ended interrupted with no verdict, so nobody asked for the stop. */
function isCutRootTurn(item: AgentJournalRenderItem): boolean {
  return rootTurnVerdict(item) === 'interruption'
}

/** What a row says about a stop, matched by what it states or who wrote it, never its tone alone:
 *  an agent's own error row in the turn (a denied permission, a refusal) says nothing about the stop.
 *  `exit`: the agent stopped. `owner-death`: a reopen proved the old agent dead, which is about the
 *  cut whatever was sent since. `not-continued`: a resume after a restart did not carry the chat on,
 *  which the restart note marks with a tone ('error' refused or not connected, 'warning' unconfirmed);
 *  a continuation that went on writes its note with none. A failed start's row is about a start. */
function stopExplanation(
  item: AgentJournalRenderItem
): 'exit' | 'owner-death' | 'not-continued' | null {
  if (
    item.body.kind !== 'status' ||
    readAgentJournalTurn(item.body) ||
    isStructuredAgentSessionStartFailureRow(item.itemId)
  ) {
    return null
  }
  const identity = parseAgentJournalItemKey(item.itemId)
  const clientMessageId = identity?.provider === 'orca' ? identity.clientMessageId : ''
  if (clientMessageId.startsWith(STALE_SESSION_ROW_PREFIX)) {
    return 'owner-death'
  }
  if (
    readAgentSessionFailureFact(item.body.failure)?.kind === 'providerExited' ||
    clientMessageId.startsWith(PROVIDER_EXIT_ROW_PREFIX)
  ) {
    return 'exit'
  }
  const { tone } = item.body
  return clientMessageId.startsWith(RESTART_CONTINUATION_ROW_PREFIX) &&
    (tone === 'error' || tone === 'warning')
    ? 'not-continued'
    : null
}

/**
 * The cut turns some row already explains: one scoped to the turn, or one about the conversation
 * (or from a host that states no scope) that follows the cut turn closely enough to be about it.
 * An exit row is about the cut only with no message sent since, which a later start would be
 * answering. An owner's proven death, and a restart note that follows the continuation's own
 * message, are about the cut until another turn begins.
 */
function explainedCutTurns(items: readonly AgentJournalRenderItem[]): Set<string> {
  const explained = new Set<string>()
  let cutNoSendSince: string | null = null
  let cutNoTurnSince: string | null = null
  for (const item of items) {
    const verdict = rootTurnVerdict(item)
    if (verdict !== 'none') {
      cutNoSendSince = cutNoTurnSince = verdict === 'interruption' ? item.itemId : null
      continue
    }
    if (item.body.kind === 'message' && item.body.role === 'user' && isRootAgentJournalItem(item)) {
      cutNoSendSince = null
      continue
    }
    const explanation = stopExplanation(item)
    if (explanation === null) {
      continue
    }
    const scope = item.turnScope
    const preceding = explanation === 'exit' ? cutNoSendSince : cutNoTurnSince
    if (scope?.kind === 'turn') {
      explained.add(scope.turnItemId)
    } else if (preceding !== null) {
      explained.add(preceding)
    }
  }
  return explained
}

/** The turn's last row, which the notice follows: one scoped to it, or by journal order on a host
 *  that states no scope. A new root turn ends the order-read run. */
function lastRowOfTurn(
  items: readonly AgentJournalRenderItem[],
  turnIndex: number,
  statesScopes: boolean
): number {
  const turnItemId = items[turnIndex]!.itemId
  let last = turnIndex
  for (let index = turnIndex + 1; index < items.length; index += 1) {
    const item = items[index]!
    if (statesScopes) {
      if (item.turnScope?.kind === 'turn' && item.turnScope.turnItemId === turnItemId) {
        last = index
      }
      continue
    }
    if (readAgentJournalTurn(item.body) && isRootAgentJournalItem(item)) {
      break
    }
    if (!(item.body.kind === 'message' && item.body.role === 'user')) {
      last = index
    }
  }
  return last
}

const noticeCache = new WeakMap<
  AgentJournalRenderItem,
  { after: AgentJournalRenderItem; statesScopes: boolean; notice: AgentJournalRenderItem }
>()

function cutTurnNotice(
  turnItem: AgentJournalRenderItem,
  after: AgentJournalRenderItem,
  statesScopes: boolean
): AgentJournalRenderItem {
  const cached = noticeCache.get(turnItem)
  if (cached?.after === after && cached.statesScopes === statesScopes) {
    return cached.notice
  }
  const notice: AgentJournalRenderItem = {
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId: `${CUT_TURN_NOTICE_ROW}${turnItem.itemId}`
    }),
    revision: 0,
    body: agentSessionResponseInterruptedBody(),
    // Just after the turn's last row and before anything the journal wrote next.
    sequence: after.sequence,
    sequenceIndex: (after.sequenceIndex ?? 0) + 0.5,
    observedAt: readAgentJournalTurn(turnItem.body)?.completedAt ?? after.observedAt,
    // A scope on a journal that states none would change how every other row is placed.
    ...(statesScopes ? { turnScope: { kind: 'turn' as const, turnItemId: turnItem.itemId } } : {})
  }
  noticeCache.set(turnItem, { after, statesScopes, notice })
  return notice
}

const ownerDeathRowCache = new WeakMap<AgentJournalRenderItem, AgentJournalRenderItem>()

/** A reopen's row about an owner found dead, in the notice's words: that owner was Orca, so an older
 *  host's "the agent stopped" blamed the agent, and in error red. */
function ownerDeathRowAsInterruption(item: AgentJournalRenderItem): AgentJournalRenderItem {
  if (stopExplanation(item) !== 'owner-death') {
    return item
  }
  const cached = ownerDeathRowCache.get(item)
  if (cached) {
    return cached
  }
  const reworded = { ...item, body: agentSessionResponseInterruptedBody() }
  ownerDeathRowCache.set(item, reworded)
  return reworded
}

/**
 * The journal as the transcript reads it: each root turn cut short with nobody asking, and no row
 * saying so, gets one muted notice right after the turn's last row, and a reopen's row about an
 * owner found dead says the same. Returns `items` itself when neither applies.
 */
export function withNativeChatCutTurnNotices(
  items: readonly AgentJournalRenderItem[]
): readonly AgentJournalRenderItem[] {
  const explained = explainedCutTurns(items)
  const statesScopes = hostStatesTurnScopes(items)
  const noticesAfter = new Map<number, AgentJournalRenderItem[]>()
  let rewords = false
  items.forEach((item, index) => {
    if (isCutRootTurn(item) && !explained.has(item.itemId)) {
      const last = lastRowOfTurn(items, index, statesScopes)
      const notice = cutTurnNotice(item, items[last]!, statesScopes)
      noticesAfter.set(last, [...(noticesAfter.get(last) ?? []), notice])
    }
    rewords ||= ownerDeathRowAsInterruption(item) !== item
  })
  if (noticesAfter.size === 0 && !rewords) {
    return items
  }
  return items.flatMap((item, index) => [
    ownerDeathRowAsInterruption(item),
    ...(noticesAfter.get(index) ?? [])
  ])
}
