// What item, request and frame events do, decided on the forecast and again on the ledger.

import { requiresTerminalSettlement } from '../agent-session-journal/journal-terminal-settlement'
import { cancelledJournalPromptBody } from '../agent-session-journal/journal-prompt-body-bounds'
import { unhandledProviderFrameJournalItem } from '../agent-session-wire/unhandled-provider-frame'
import { providerTimelineEntryBytes, providerTimelinePlacement } from './provider-timeline-context'
import {
  pendingPrompt,
  providerKey,
  runningTool,
  settledTool,
  turnOf,
  type ProviderTimelineDecidedEvent,
  type ProviderTimelineDecision,
  type ProviderTimelineDecisionInput
} from './provider-timeline-decision'
import { providerTimelineItemClass, type ProviderTimelineKey } from './provider-timeline-identity'
import type { ProviderTimelineItemJoin } from './provider-timeline-joins'

export function decideItem(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'item.open' | 'item.update' | 'item.close' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const change =
    event.type === 'item.open' ? 'open' : event.type === 'item.update' ? 'update' : 'close'
  const join: ProviderTimelineItemJoin = {
    family: 'item',
    key: providerKey(event.item),
    thread: event.join?.thread ?? null
  }
  const ref = context.joins.reference(join, state.namespace)
  const found = context.joins.find(join, journal, state.namespace)
  const held = found ? (journal?.itemBody(found.itemId) ?? null) : null
  // This run closed it: an open reopens the same row, a second close is a repeat.
  const closed = state.closed.has(ref)
  if (change === 'open' && !closed && held) {
    return { dropped: 'item-replayed' }
  }
  if (change === 'update' && runningTool(event.body) && (closed || settledTool(held))) {
    return { dropped: 'item-settled' }
  }
  if (change === 'close' && (closed || settledTool(held))) {
    return { dropped: 'item-settled' }
  }
  const known = state.obligations.get(ref)
  const outlivesTurn =
    (event.type === 'item.open' && event.outlivesTurn === true) || known?.outlivesTurn === true
  const obligation = change !== 'close' && (requiresTerminalSettlement(event.body) || outlivesTurn)
  const row =
    found ??
    (input.execute && journal
      ? context.joins.place(
          join,
          providerTimelineItemClass(event.body),
          providerTimelinePlacement(context, state, event.join),
          journal
        )
      : null)
  const scope = row?.scope ?? providerTimelinePlacement(context, state, event.join).scope
  const turnItemId = turnOf(scope)
  const bytes = providerTimelineEntryBytes(event.item, event.body, event.producer)
  return {
    ...(obligation ? { hold: { key: ref, bytes } } : {}),
    write: row && {
      identity: row.identity,
      body: event.body,
      options: {
        ...event.producer,
        turnScope: row.scope,
        ...(row.ref === undefined ? {} : { providerItemRef: row.ref })
      }
    },
    ...(change === 'close' ? { closes: ref } : {}),
    commit: (next) => {
      if (obligation) {
        next.obligations.set(ref, { itemId: row?.itemId ?? null, turnItemId, outlivesTurn, bytes })
      } else {
        next.obligations.delete(ref)
      }
      if (change === 'close') {
        next.closed.set(ref, turnItemId)
      } else if (change === 'open') {
        next.closed.delete(ref)
      }
    }
  }
}

export function requestRef(input: ProviderTimelineDecisionInput, key: ProviderTimelineKey): string {
  return input.context.joins.reference(
    { family: 'request', key, thread: null },
    input.state.namespace
  )
}

export function decideRequest(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'request.open' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const key = providerKey(event.request)
  const ref = requestRef(input, key)
  const current = context.joins.request(key, journal, state.namespace)
  const held = current ? (journal?.itemBody(current.itemId) ?? null) : null
  // Pending in the journal, or opened here and not landed yet: the same request again.
  if (pendingPrompt(held) || (state.obligations.has(ref) && held === null)) {
    return { dropped: 'request-duplicate' }
  }
  const settledTurn = current ? turnOf(current.scope) : null
  if (
    held &&
    settledTurn !== null &&
    state.status({ itemId: settledTurn }, journal) === 'settled'
  ) {
    return { dropped: 'request-replayed' }
  }
  const placement = providerTimelinePlacement(context, state, event.join)
  const row =
    input.execute && journal
      ? context.joins.nextRequest(key, event.body.kind, placement, journal)
      : null
  const bytes = providerTimelineEntryBytes(event.request, event.body, event.producer)
  return {
    hold: { key: ref, bytes },
    // A row already there is a client's answer or a replay; neither is overwritten.
    write:
      row && journal?.itemBody(row.itemId) === null
        ? {
            identity: row.identity,
            body: event.body,
            options: { ...event.producer, turnScope: row.scope, lifecycle: true }
          }
        : null,
    commit: (next) =>
      next.obligations.set(ref, {
        itemId: row?.itemId ?? null,
        turnItemId: turnOf(row?.scope ?? placement.scope),
        outlivesTurn: false,
        bytes
      })
  }
}

export function decideWithdrawal(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'request.withdrawn' }>
): ProviderTimelineDecision {
  const { state, journal } = input
  const key = providerKey(event.request)
  const ref = requestRef(input, key)
  // The latest incarnation the journal holds, however long ago this run (or another) opened it.
  const current = input.context.joins.request(key, journal, state.namespace)
  const held = current ? (journal?.itemBody(current.itemId) ?? null) : null
  if (!pendingPrompt(held) && !(state.obligations.has(ref) && held === null)) {
    return { dropped: 'request-unknown' }
  }
  // Only while the journal holds it pending: a client's answer that landed first stands.
  const cancelled = current && held && pendingPrompt(held) ? cancelledJournalPromptBody(held) : null
  return {
    ...(input.execute
      ? {
          settle:
            current && cancelled
              ? [
                  {
                    kind: 'item' as const,
                    identity: current.identity,
                    body: cancelled,
                    turnScope: current.scope
                  }
                ]
              : []
        }
      : {}),
    commit: (next) => next.obligations.delete(ref)
  }
}

export function decideFrame(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'provider.frame' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const frame = unhandledProviderFrameJournalItem(context.agent, event.frameKind, event.payload)
  if (!frame || !event.minted || !input.execute || !journal) {
    return {}
  }
  const row = context.joins.place(
    { family: 'frame', key: event.minted, thread: event.join?.thread ?? null },
    'frame',
    providerTimelinePlacement(context, state, event.join),
    journal
  )
  return { write: { identity: row.identity, body: frame.body, options: { turnScope: row.scope } } }
}
