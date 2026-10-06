// A /clear replaces a chat with a new conversation and moves its tab there; the host publishes
// which conversation the tab's replaced (`replacesSessionId`). Whatever this window still held for
// the old one — the composer's draft, and messages it sent there — belongs where the user now is.
// Derived from that link whenever the new chat renders, so it holds for a pane that was never
// mounted, after a reload, or for a tab that was not active when the clear ran. The link is passed
// only while no tab shows the old chat: one reopened from history keeps what is typed or sent there.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import { handedOffQueuedMessageIds } from '../../../../shared/structured-agent-session-draft-hand-off'
import { isLoneStructuredAgentSessionConversationCommand } from '../../../../shared/structured-agent-session-composer'
import {
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  classifyReplacedLeftover,
  replacedLeftoverNotice,
  resolveReplacedLeftover,
  type ReplacedLeftoverCause
} from '../../../../shared/structured-agent-session-replaced-leftovers'
import { AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import {
  appendToNativeChatComposerDraft,
  deleteNativeChatComposerDraft,
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { readMountedStructuredAgentSessionOutbox } from './structured-agent-session-outbox-dispatch'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  loadStructuredAgentSessionOutbox,
  readOutbox,
  subscribeToStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { returnMessageToComposer } from './structured-agent-session-withdrawn-message-restore'

const NO_ENTRIES: readonly StructuredAgentSessionOutboxEntry[] = []

type AskingState = {
  ids: Set<string>
  timers: Set<ReturnType<typeof setTimeout>>
  live: boolean
}
const newAskingState = (): AskingState => ({ ids: new Set(), timers: new Set(), live: true })
const NO_SUBSCRIPTION = (): void => {}
/** Asked again after 1, 2, 4, 8 and 16 s; with still no answer, the text comes back saying so. */
const ASK_AGAIN_MS = [1_000, 2_000, 4_000, 8_000, 16_000]

/** The old conversation's draft goes after anything already here. A lone /clear or /compact is
 *  dropped: the /clear is what replaced it, and a /compact does nothing in a fresh chat. */
function carryDraft(fromSessionId: string, composerScopeKey: string): void {
  const from = structuredAgentSessionDraftScopeKey(fromSessionId)
  const draft = readNativeChatComposerDraft(from)
  if (draft.text === '' && draft.images.length === 0) {
    return
  }
  const command = isLoneStructuredAgentSessionConversationCommand(draft.text.trim())
  if (
    (command && draft.images.length === 0) ||
    appendToNativeChatComposerDraft(composerScopeKey, { text: draft.text, images: draft.images })
  ) {
    deleteNativeChatComposerDraft(from)
  }
}

/** Gives back what never reached the replaced chat, after whatever the composer holds. What its
 *  outbox no longer holds was already given back by whichever view dropped it first. */
function handBack(
  fromSessionId: string,
  composerScopeKey: string | undefined,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): void {
  if (!composerScopeKey || entries.length === 0) {
    return
  }
  const held = new Set(
    getStructuredAgentSessionOutbox(fromSessionId).map((entry) => entry.clientMessageId)
  )
  for (const entry of entries) {
    if (held.has(entry.clientMessageId)) {
      returnMessageToComposer(
        composerScopeKey,
        `withdrawn-${entry.clientMessageId}`,
        entry.body.blocks
      )
    }
  }
}

/** Returns the old chat's messages still being asked about, to show as sending rows here. */
export function useStructuredAgentSessionReplacementCarry(args: {
  replacesSessionId: string | undefined
  composerScopeKey: string | undefined
  target: RuntimeClientTarget
  /** The new chat's fence; null until its state has loaded. */
  fence: number | null
  /** The new chat's submissions and cards: a message the host carried here is already here. */
  submissions: readonly AgentJournalSubmission[]
  queuedMessageIds: readonly string[] | undefined
  /** Says once, on this composer's line, why text came back. */
  say: (notice: string) => void
}): readonly StructuredAgentSessionOutboxEntry[] {
  const { composerScopeKey, fence, queuedMessageIds, replacesSessionId, say, submissions, target } =
    args
  const fromSessionId = replacesSessionId ?? ''
  // A send still marked on its way had its pane unmounted under it: read as in doubt, as a pane
  // mounting on its own chat reads it.
  const load = useCallback(
    () =>
      fromSessionId ? readMountedStructuredAgentSessionOutbox(fromSessionId, null, readOutbox) : [],
    [fromSessionId]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      fromSessionId
        ? subscribeToStructuredAgentSessionOutbox(fromSessionId, load, listener)
        : NO_SUBSCRIPTION,
    [fromSessionId, load]
  )
  const leftovers = useSyncExternalStore(subscribe, () =>
    fromSessionId ? loadStructuredAgentSessionOutbox(fromSessionId, load) : NO_ENTRIES
  )
  const fromDraftScope = fromSessionId ? structuredAgentSessionDraftScopeKey(fromSessionId) : ''
  const subscribeDraft = useCallback(
    (listener: () => void) =>
      fromDraftScope
        ? subscribeToNativeChatComposerDraft(fromDraftScope, listener)
        : NO_SUBSCRIPTION,
    [fromDraftScope]
  )
  // Re-read when the old draft changes; until the saved drafts have loaded it may not be in memory.
  const fromDraft = useSyncExternalStore(subscribeDraft, () =>
    readNativeChatComposerDraft(fromDraftScope)
  )

  const [loads, setLoads] = useState(0)
  useEffect(() => {
    if (!fromSessionId || !composerScopeKey) {
      return undefined
    }
    if (!isNativeChatComposerDraftLoadPending()) {
      carryDraft(fromSessionId, composerScopeKey)
      return undefined
    }
    // Carried once the load lands; a load that fails waits for its own retry and the next change.
    let live = true
    void hydrateNativeChatComposerDrafts().then(() => {
      if (live && !isNativeChatComposerDraftLoadPending()) {
        setLoads((count) => count + 1)
      }
    })
    return () => {
      live = false
    }
  }, [composerScopeKey, fromDraft, fromSessionId, loads])

  const ownedByHost = useMemo(
    () =>
      new Set([
        ...submissions.map((submission) => submission.clientMessageId),
        ...handedOffQueuedMessageIds(submissions),
        ...(queuedMessageIds ?? [])
      ]),
    [queuedMessageIds, submissions]
  )
  const verdicts = useMemo(
    () =>
      leftovers.map((entry) => ({ entry, verdict: classifyReplacedLeftover(entry, ownedByHost) })),
    [leftovers, ownedByHost]
  )

  /** Takes these from the old chat's outbox, giving back the text of those with a cause. */
  const settle = useCallback(
    (
      settled: readonly {
        entry: StructuredAgentSessionOutboxEntry
        cause?: ReplacedLeftoverCause
      }[]
    ) => {
      if (!fromSessionId || settled.length === 0) {
        return
      }
      const handedBack = settled.filter((item) => item.cause !== undefined)
      handBack(
        fromSessionId,
        composerScopeKey,
        handedBack.map((item) => item.entry)
      )
      const ids = new Set(settled.map((item) => item.entry.clientMessageId))
      commitStructuredAgentSessionOutbox(
        fromSessionId,
        getStructuredAgentSessionOutbox(fromSessionId).filter(
          (entry) => !ids.has(entry.clientMessageId)
        )
      )
      const notice = replacedLeftoverNotice(
        handedBack.flatMap((item) => (item.cause ? [item.cause] : []))
      )
      if (notice) {
        say(agentSessionWriteNoticeText(notice))
      }
    },
    [composerScopeKey, fromSessionId, say]
  )

  useEffect(() => {
    if (!composerScopeKey || fence === null) {
      return
    }
    settle(
      verdicts.flatMap(({ entry, verdict }) =>
        verdict.kind === 'owned'
          ? [{ entry }]
          : verdict.kind === 'handBack'
            ? [{ entry, cause: verdict.cause }]
            : []
      )
    )
  }, [composerScopeKey, fence, settle, verdicts])

  // In doubt: asked again under its own id, in the chat it was sent to, until the host's answer
  // proves it recorded (it stays the host's) or not (its text comes back). Each is asked once per
  // link however often the chat re-renders; leaving the chat, or the link going (the old chat shown
  // again), stops asking, and an answer still on its way is dropped.
  const asking = useRef<AskingState>(newAskingState())
  const settleRef = useRef(settle)
  // Read when each answer lands: a remote host's capabilities may still be on their way.
  const hostAnswersProve = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SEND_ANSWERS_PROOF_RUNTIME_CAPABILITY
  )
  const answersProve = useRef(hostAnswersProve)
  useEffect(() => {
    settleRef.current = settle
    answersProve.current = hostAnswersProve
  }, [hostAnswersProve, settle])
  useEffect(() => {
    const state = newAskingState()
    asking.current = state
    return () => {
      state.live = false
      state.timers.forEach(clearTimeout)
    }
  }, [fromSessionId])
  const ask = useCallback(
    (entry: StructuredAgentSessionOutboxEntry, attempt: number, toFence: number): void => {
      const state = asking.current
      void callStructuredAgentSession<AgentSessionMutationResult<AgentSessionSendResult>>(
        target,
        'agentSession.send',
        structuredAgentSessionSendRequest(entry, toFence)
      )
        .then(
          (answer) => answer,
          () => 'thrown' as const
        )
        .then((answer) => {
          if (!state.live) {
            return
          }
          const resolved = resolveReplacedLeftover(answer, answersProve.current)
          if (resolved === 'askAgain' && attempt < ASK_AGAIN_MS.length) {
            // Owned by the cleanup above, which clears every one still pending.
            const timer = setTimeout(() => {
              state.timers.delete(timer)
              ask(entry, attempt + 1, toFence)
            }, ASK_AGAIN_MS[attempt])
            state.timers.add(timer)
            return
          }
          state.ids.delete(entry.clientMessageId)
          settleRef.current([
            resolved === 'recorded'
              ? { entry }
              : { entry, cause: resolved === 'askAgain' ? 'unconfirmed' : resolved.handBack }
          ])
        })
    },
    [target]
  )
  useEffect(() => {
    if (!composerScopeKey || fence === null) {
      return
    }
    const state = asking.current
    for (const { entry, verdict } of verdicts) {
      if (verdict.kind === 'inDoubt' && !state.ids.has(entry.clientMessageId)) {
        state.ids.add(entry.clientMessageId)
        ask(entry, 0, fence)
      }
    }
  }, [ask, composerScopeKey, fence, verdicts])

  return useMemo(
    () =>
      verdicts.flatMap(({ entry, verdict }) =>
        verdict.kind === 'inDoubt' ? [{ ...entry, state: 'dispatching' as const }] : []
      ),
    [verdicts]
  )
}
