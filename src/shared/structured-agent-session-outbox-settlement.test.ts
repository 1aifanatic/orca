import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type { AgentJournalSubmission } from './agent-session-journal-types'
import type { AgentSessionWireRefusalCode } from './agent-session-wire'
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'
import { parseStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-saved-entry'
import {
  applyStructuredAgentSessionOutboxSettlement,
  settleStructuredAgentSessionEntryFromJournal,
  settleStructuredAgentSessionSendAnswer,
  structuredAgentSessionEntryOutlivedHostWindow,
  type StructuredAgentSessionSendAnswer,
  type StructuredAgentSessionOutboxSettlementContext
} from './structured-agent-session-outbox-settlement'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from './agent-session-host-authority'
import { DISPATCH_REJECTED_CANCELLED } from './structured-agent-session-dispatch-rejection'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  readAgentSessionRefusalReference
} from './agent-session-wire-refusals'
import { AGENT_SESSION_REFUSAL_REASONS } from './agent-session-refusal-details'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { admitStructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox-admission'
import {
  agentSessionRefusalReasonWords,
  agentSessionWriteNoticeEnglish
} from './agent-session-refusal-notice'
import {
  agentSessionRefusalFailure,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'

const ID = '1759600000000-0123456789abcdef0123456789abcdef'
const MADE_AT = 1_759_600_000_000
const NOW = MADE_AT + 1_000
const NO_ROWS: AgentJournalSubmission[] = []

function entry(
  patch: Partial<StructuredAgentSessionOutboxEntry> = {}
): StructuredAgentSessionOutboxEntry {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId: ID,
      sessionId: 'session-1',
      text: 'hello',
      attachments: [],
      queuedAt: 1
    }),
    ...patch
  }
}

/** The message's own row is loaded. */
const LOADED: ReadonlySet<string> = new Set([agentJournalSubmissionKey(ID)])

function row(patch: Partial<AgentJournalSubmission> = {}): AgentJournalSubmission {
  return {
    clientMessageId: ID,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1,
    ...patch
  }
}

function sent(submission: AgentJournalSubmission): StructuredAgentSessionSendAnswer {
  return {
    kind: 'result',
    result: {
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'e', sequence: 1 },
      value: { clientMessageId: ID, submission }
    }
  }
}

function refused(
  code: AgentSessionWireRefusalCode,
  details?: Record<string, unknown>
): StructuredAgentSessionSendAnswer {
  return {
    kind: 'result',
    result: { ok: false, refusal: { code, message: code, ...(details ? { details } : {}) } }
  }
}

const FIRST: StructuredAgentSessionOutboxSettlementContext = {
  firstAttempt: true,
  answersProve: true,
  journalHasRow: false,
  rowLoaded: true,
  outlivedHostWindow: false
}
const RESEND_PROVING: StructuredAgentSessionOutboxSettlementContext = {
  ...FIRST,
  firstAttempt: false
}
const RESEND_OLD_HOST: StructuredAgentSessionOutboxSettlementContext = {
  ...RESEND_PROVING,
  answersProve: false
}

describe('a send answer settles one of three ways', () => {
  it("case 1: any row the host returns, in any settled state, is the host's from then on", () => {
    for (const state of ['accepted', 'rejected', 'unknown'] as const) {
      expect(
        settleStructuredAgentSessionSendAnswer(sent(row({ dispatchState: state })), ID, FIRST)
      ).toEqual({
        kind: 'recorded'
      })
    }
    // A recovered unknown (a restart lost its outcome) is a record too, so it never parks the queue.
    expect(
      settleStructuredAgentSessionSendAnswer(
        sent(row({ dispatchState: 'unknown', recovered: true })),
        ID,
        RESEND_OLD_HOST
      )
    ).toEqual({ kind: 'recorded' })
  })

  it("case 1: a rejected row this client hasn't loaded keeps the entry with the host's fact, to draw it until then", () => {
    const unloaded = { ...FIRST, rowLoaded: false }
    expect(
      settleStructuredAgentSessionSendAnswer(
        sent(
          row({
            dispatchState: 'rejected',
            reason: 'Not now.',
            rejection: { kind: 'hostRestarted' }
          })
        ),
        ID,
        unloaded
      )
    ).toEqual({
      kind: 'rejectedUnseen',
      recorded: { reason: 'Not now.', rejection: { kind: 'hostRestarted' } }
    })
    // Only a rejection waits for its row: any other state, or a Stop's withdrawal, settles as before.
    for (const state of ['accepted', 'unknown'] as const) {
      expect(
        settleStructuredAgentSessionSendAnswer(sent(row({ dispatchState: state })), ID, unloaded)
      ).toEqual({ kind: 'recorded' })
    }
    expect(
      settleStructuredAgentSessionSendAnswer(
        sent(row({ dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED })),
        ID,
        unloaded
      )
    ).toEqual({ kind: 'withdrawn' })
  })

  it('case 1: a queued receipt or its hand-off belongs to the host', () => {
    expect(
      settleStructuredAgentSessionSendAnswer(
        {
          kind: 'result',
          result: {
            ok: true,
            replayed: true,
            fence: 1,
            cursor: { epoch: 'e', sequence: 1 },
            value: { clientMessageId: ID, queued: { messageId: ID, position: 0, state: 'waiting' } }
          }
        },
        ID,
        FIRST
      )
    ).toEqual({ kind: 'recorded' })
    expect(
      settleStructuredAgentSessionSendAnswer(
        sent(row({ clientMessageId: 'other', queuedMessageId: ID, dispatchState: 'rejected' })),
        ID,
        FIRST
      )
    ).toEqual({ kind: 'recorded' })
  })

  it('a pending row keeps the entry until the row settles; a Stop withdrawal hands it back silently', () => {
    expect(
      settleStructuredAgentSessionSendAnswer(sent(row({ dispatchState: 'pending' })), ID, FIRST)
    ).toEqual({ kind: 'pending' })
    expect(
      settleStructuredAgentSessionSendAnswer(
        sent(row({ dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED })),
        ID,
        FIRST
      )
    ).toEqual({ kind: 'withdrawn' })
  })

  it("case 2: a first attempt's refusal proves no record, on any host", () => {
    const settled = settleStructuredAgentSessionSendAnswer(
      refused('agent_session_operation_capacity'),
      ID,
      { ...FIRST, answersProve: false }
    )
    expect(settled.kind).toBe('returned')
  })

  it("case 2: on a host whose answers prove, a resend's refusal proves no record", () => {
    expect(
      settleStructuredAgentSessionSendAnswer(
        refused('agent_session_journal_unreadable'),
        ID,
        RESEND_PROVING
      ).kind
    ).toBe('returned')
  })

  it('case 3: an older host may refuse a resent id before looking it up, so it goes again', () => {
    // Said once: why, and that Orca keeps sending it, never that it was not sent.
    expect(
      settleStructuredAgentSessionSendAnswer(
        refused('agent_session_journal_unreadable'),
        ID,
        RESEND_OLD_HOST
      )
    ).toEqual({ kind: 'unanswered', words: ['historyUnreadable', 'stillSending'] })
  })

  it('case 3: "outcome unknown" is never proof, even on a first attempt', () => {
    expect(
      settleStructuredAgentSessionSendAnswer(
        refused('agent_session_operation_unknown', { reason: 'outcomeUnknown' }),
        ID,
        FIRST
      )
    ).toEqual({ kind: 'unanswered' })
  })

  it('an expired id is settled by the journal: a row keeps it, none hands it back to check', () => {
    expect(
      settleStructuredAgentSessionSendAnswer(refused('agent_session_operation_expired'), ID, {
        ...RESEND_OLD_HOST,
        journalHasRow: true
      })
    ).toEqual({ kind: 'recorded' })
    expect(
      settleStructuredAgentSessionSendAnswer(
        refused('agent_session_operation_expired'),
        ID,
        RESEND_OLD_HOST
      )
    ).toEqual({ kind: 'returned', words: ['sendOutcomeLost'] })
  })

  it('a closed chat or a reused id can never settle by resending, so it comes back to check', () => {
    for (const answer of [
      refused('agent_session_ownership_unknown', { reason: 'sessionNotAttached' }),
      refused('agent_session_operation_conflict', { reason: 'fingerprintMismatch' })
    ]) {
      expect(settleStructuredAgentSessionSendAnswer(answer, ID, RESEND_PROVING)).toEqual({
        kind: 'returned',
        words: ['sendOutcomeLost']
      })
      expect(settleStructuredAgentSessionSendAnswer(answer, ID, RESEND_OLD_HOST)).toEqual({
        kind: 'returned',
        words: ['sendOutcomeLost']
      })
    }
  })

  it('a thrown error is no answer, by code: a timeout, a closed socket or a thrown refusal goes again', () => {
    for (const rpcCode of [
      'runtime_timeout',
      'remote_runtime_unavailable',
      'runtime_unavailable',
      undefined
    ]) {
      expect(
        settleStructuredAgentSessionSendAnswer(
          { kind: 'thrown', refusal: undefined, rpcCode },
          ID,
          FIRST
        )
      ).toEqual({ kind: 'unanswered' })
    }
    // A thrown refusal may come after the row was written, so it is held, saying why once.
    expect(
      settleStructuredAgentSessionSendAnswer(
        {
          kind: 'thrown',
          refusal: { kind: 'refused', code: 'agent_session_journal_unreadable' },
          rpcCode: 'agent_session_refused'
        },
        ID,
        FIRST
      )
    ).toEqual({ kind: 'unanswered', words: ['historyUnreadable', 'stillSending'] })
  })

  it('a call the host turned away before running it proves no record, on a first attempt only', () => {
    for (const rpcCode of ['method_not_found', 'invalid_argument', 'unauthorized']) {
      const thrown: StructuredAgentSessionSendAnswer = {
        kind: 'thrown',
        refusal: undefined,
        rpcCode
      }
      expect(settleStructuredAgentSessionSendAnswer(thrown, ID, FIRST).kind).toBe('returned')
      // An earlier attempt may have landed before the host turned this one away.
      for (const resend of [
        RESEND_OLD_HOST,
        RESEND_PROVING,
        { ...RESEND_PROVING, journalHasRow: true }
      ]) {
        const settled = settleStructuredAgentSessionSendAnswer(thrown, ID, resend)
        expect(settled.kind, rpcCode).toBe('unanswered')
        expect(settled).toMatchObject({ words: expect.arrayContaining(['stillSending']) })
      }
    }
  })

  it('a reused message id on a resend is settled by the journal, as a conflict is', () => {
    const reused = refused('agent_session_operation_invalid', { reason: 'messageIdReused' })
    for (const resend of [RESEND_PROVING, RESEND_OLD_HOST]) {
      expect(
        settleStructuredAgentSessionSendAnswer(reused, ID, { ...resend, journalHasRow: true })
      ).toEqual({ kind: 'recorded' })
      expect(settleStructuredAgentSessionSendAnswer(reused, ID, resend)).toEqual({
        kind: 'returned',
        words: ['sendOutcomeLost']
      })
    }
  })

  it("an older host's made-up record for a lost row is the chat's only with a loaded row", () => {
    const madeUp = sent(
      row({ dispatchState: 'unknown', reason: 'durable_send_submission_missing', recovered: true })
    )
    expect(settleStructuredAgentSessionSendAnswer(madeUp, ID, RESEND_OLD_HOST)).toEqual({
      kind: 'returned',
      words: ['sendOutcomeLost']
    })
    expect(
      settleStructuredAgentSessionSendAnswer(madeUp, ID, {
        ...RESEND_OLD_HOST,
        journalHasRow: true
      })
    ).toEqual({ kind: 'recorded' })
    // A real recovered row is the host's.
    expect(
      settleStructuredAgentSessionSendAnswer(
        sent(
          row({
            dispatchState: 'unknown',
            reason: 'host_restarted_before_acknowledgement',
            recovered: true
          })
        ),
        ID,
        RESEND_OLD_HOST
      )
    ).toEqual({ kind: 'recorded' })
  })
})

// While Orca keeps sending, a step for the person (send again, retry, start over) would invite a
// second copy, so the line says only what stopped it, and that Orca keeps trying.
describe('a send Orca keeps sending says why, and only why', () => {
  const STEP =
    /\b(send|try again|retry|start a new chat|reopen|quit|sign in|update orca|answer the|open the current|wait for)\b/i
  const cells = AGENT_SESSION_WIRE_REFUSAL_CODES.flatMap((code) =>
    [undefined, ...AGENT_SESSION_REFUSAL_REASONS[code]].flatMap((reason) => {
      // Read through the checked reader, so each code meets only its own reasons.
      const reference = readAgentSessionRefusalReference({
        code,
        ...(reason ? { details: { reason } } : {})
      })
      return reference ? [agentSessionRefusalFailure(reference)] : []
    })
  )

  it('names no step beside "Orca will keep trying to send it", for any code or reason', () => {
    let held = 0
    for (const refusal of cells) {
      const cell = `${refusal.code}/${refusal.details?.reason ?? '-'}`
      for (const answer of [
        {
          kind: 'result',
          result: { ok: false, refusal: { ...refusal, message: 'x' } }
        } satisfies StructuredAgentSessionSendAnswer,
        { kind: 'thrown', refusal, rpcCode: undefined } satisfies StructuredAgentSessionSendAnswer
      ]) {
        const settled = settleStructuredAgentSessionSendAnswer(answer, ID, RESEND_OLD_HOST)
        if (settled.kind !== 'unanswered' || !settled.words) {
          continue
        }
        held += 1
        expect(settled.words.at(-1), cell).toBe('stillSending')
        const said = agentSessionWriteNoticeEnglish(settled.words.slice(0, -1))
        expect(said, cell).not.toMatch(STEP)
      }
    }
    expect(held).toBeGreaterThan(50)
  })

  // A cause that lasts (signed out, a history too large, an older host) can hold a message for
  // hours, so the line keeps saying what it is, without the step.
  it('keeps the cause a refusal names, before "Orca will keep trying to send it"', () => {
    const lasting = (refusal: AgentSessionWriteRefusal): boolean => {
      const words = agentSessionRefusalReasonWords(refusal)
      return words
        ? 'cause' in words || 'fact' in words
        : refusal.code === 'structured_agent_session_unsupported' ||
            refusal.code === 'agent_session_journal_unreadable'
    }
    let named = 0
    for (const refusal of cells.filter(lasting)) {
      const cell = `${refusal.code}/${refusal.details?.reason ?? '-'}`
      const settled = settleStructuredAgentSessionSendAnswer(
        { kind: 'thrown', refusal, rpcCode: undefined },
        ID,
        RESEND_OLD_HOST
      )
      if (settled.kind !== 'unanswered' || !settled.words) {
        continue
      }
      named += 1
      expect(settled.words.length, cell).toBeGreaterThanOrEqual(2)
      expect(agentSessionWriteNoticeEnglish(settled.words.slice(0, -1)), cell).not.toMatch(STEP)
    }
    expect(named).toBeGreaterThan(20)
    const notSignedIn = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: { reason: 'notSignedIn' }
    })
    expect(
      settleStructuredAgentSessionSendAnswer(
        { kind: 'thrown', refusal: notSignedIn, rpcCode: undefined },
        ID,
        RESEND_OLD_HOST
      )
    ).toEqual({ kind: 'unanswered', words: ['agentNotSignedIn', 'stillSending'] })
  })

  it('a thrown request with no cause of its own says only that Orca keeps trying', () => {
    const thrown = (rpcCode: string): StructuredAgentSessionSendAnswer => ({
      kind: 'thrown',
      refusal: undefined,
      rpcCode
    })
    for (const rpcCode of ['unauthorized', 'invalid_argument']) {
      expect(settleStructuredAgentSessionSendAnswer(thrown(rpcCode), ID, RESEND_OLD_HOST)).toEqual({
        kind: 'unanswered',
        words: ['stillSending']
      })
    }
    // A host without the method is an older one: that is the cause.
    expect(
      settleStructuredAgentSessionSendAnswer(thrown('method_not_found'), ID, RESEND_OLD_HOST)
    ).toEqual({ kind: 'unanswered', words: ['newerOrcaNeeded', 'stillSending'] })
  })

  it('a thrown "outcome unknown" says nothing, as the returned one does', () => {
    expect(
      settleStructuredAgentSessionSendAnswer(
        {
          kind: 'thrown',
          refusal: { kind: 'refused', code: 'agent_session_operation_unknown' },
          rpcCode: undefined
        },
        ID,
        FIRST
      )
    ).toEqual({ kind: 'unanswered' })
  })
})

describe('the journal settles what an answer did not', () => {
  const reading = {
    submissions: NO_ROWS,
    cursor: { epoch: 'e', sequence: 10 },
    inFlightClientMessageId: null,
    queuedMessageIds: null,
    loadedItemIds: LOADED,
    now: NOW
  }

  it('a recovered-unknown row is a record: the parked head leaves, so nothing waits behind it', () => {
    const settled = settleStructuredAgentSessionEntryFromJournal(entry({ state: 'unconfirmed' }), {
      ...reading,
      submissions: [row({ dispatchState: 'unknown', recovered: true })]
    })
    expect(settled).toEqual({ kind: 'recorded' })
  })

  it("keeps the host's fact on a rejected message until its row loads, writing nothing meanwhile", () => {
    const rejected = {
      ...reading,
      submissions: [row({ dispatchState: 'rejected', reason: 'Not now.' })]
    }
    const unloaded = { ...rejected, loadedItemIds: new Set<string>() }
    expect(
      settleStructuredAgentSessionEntryFromJournal(entry({ state: 'unconfirmed' }), unloaded)
    ).toEqual({ kind: 'rejectedUnseen', recorded: { reason: 'Not now.' } })
    // Once kept, an unchanged batch, or one with no submission for it (a reopened page), settles
    // nothing.
    const kept = entry({ state: 'unconfirmed', recordedRejection: { reason: 'Not now.' } })
    expect(settleStructuredAgentSessionEntryFromJournal(kept, unloaded)).toBeNull()
    expect(
      settleStructuredAgentSessionEntryFromJournal(kept, { ...unloaded, submissions: NO_ROWS })
    ).toBeNull()
    // Its row loaded: the host's row is the message.
    expect(settleStructuredAgentSessionEntryFromJournal(kept, rejected)).toEqual({
      kind: 'recorded'
    })
    expect(
      settleStructuredAgentSessionEntryFromJournal(entry({ state: 'dispatching' }), rejected)
    ).toEqual({ kind: 'recorded' })
    // An older build's entry is never drawn, so it leaves at once.
    expect(
      settleStructuredAgentSessionEntryFromJournal(
        entry({ state: 'queued', legacyUnsettled: true }),
        unloaded
      )
    ).toEqual({ kind: 'recorded' })
    // Past the host's window the copy goes too: the row still shows it once its page loads.
    const pastWindow = MADE_AT + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1
    expect(
      settleStructuredAgentSessionEntryFromJournal(entry({ state: 'dispatching' }), {
        ...unloaded,
        now: pastWindow
      })
    ).toEqual({ kind: 'recorded' })
    expect(
      settleStructuredAgentSessionEntryFromJournal(kept, {
        ...unloaded,
        submissions: NO_ROWS,
        now: pastWindow
      })
    ).toEqual({ kind: 'recorded' })
  })

  // A Stop that took the send back before its turn opened leaves nothing to wait on behind it.
  it('a send the host withdrew at a Stop goes back silently, and the next send goes out', () => {
    const outbox = [
      entry({ state: 'dispatching', lastAttemptAt: 1 }),
      entry({ clientMessageId: 'next' })
    ]
    const withdrawn = row({
      dispatchState: 'rejected',
      recovered: true,
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })
    const settled = settleStructuredAgentSessionEntryFromJournal(outbox[0]!, {
      ...reading,
      submissions: [withdrawn]
    })
    expect(settled).toEqual({ kind: 'withdrawn' })
    const applied = applyStructuredAgentSessionOutboxSettlement(outbox, ID, settled!)
    expect(applied.returned).toMatchObject({ words: null })
    expect(admitStructuredAgentSessionOutboxEntry(applied.entries)).toMatchObject({
      state: 'dispatch',
      entry: { clientMessageId: 'next' }
    })
  })

  it('a send the host left in doubt at a Stop is its record, so the next send goes out', () => {
    const outbox = [
      entry({ state: 'dispatching', lastAttemptAt: 1 }),
      entry({ clientMessageId: 'next' })
    ]
    const settled = settleStructuredAgentSessionEntryFromJournal(outbox[0]!, {
      ...reading,
      submissions: [
        row({
          dispatchState: 'unknown',
          recovered: true,
          reason: 'provider_closed_before_acknowledgement'
        })
      ]
    })
    expect(settled).toEqual({ kind: 'recorded' })
    const applied = applyStructuredAgentSessionOutboxSettlement(outbox, ID, settled!)
    expect(admitStructuredAgentSessionOutboxEntry(applied.entries)).toMatchObject({
      state: 'dispatch',
      entry: { clientMessageId: 'next' }
    })
  })

  it('a row while the send is in flight as pending changes nothing', () => {
    expect(
      settleStructuredAgentSessionEntryFromJournal(entry({ state: 'dispatching' }), {
        ...reading,
        submissions: [row({ dispatchState: 'pending' })]
      })
    ).toBeNull()
  })

  it('no row: an ordinary entry waits for its own answer', () => {
    expect(
      settleStructuredAgentSessionEntryFromJournal(entry({ state: 'unconfirmed' }), reading)
    ).toBeNull()
  })

  it("a host-published queued card under the id is the host's", () => {
    expect(
      settleStructuredAgentSessionEntryFromJournal(entry(), { ...reading, queuedMessageIds: [ID] })
    ).toEqual({ kind: 'recorded' })
  })

  it("a Stop's stamp: no row once the journal is read through the Stop's answer hands it back silently", () => {
    const stopped = entry({
      state: 'unconfirmed',
      lastAttemptAt: 2,
      stoppedBy: { operationId: 'stop-1', cursor: { epoch: 'e', sequence: 12 } }
    })
    expect(settleStructuredAgentSessionEntryFromJournal(stopped, reading)).toBeNull()
    expect(
      settleStructuredAgentSessionEntryFromJournal(stopped, {
        ...reading,
        cursor: { epoch: 'e', sequence: 12 }
      })
    ).toEqual({ kind: 'withdrawn' })
    // Its own request still out: its answer settles it.
    expect(
      settleStructuredAgentSessionEntryFromJournal(stopped, {
        ...reading,
        cursor: { epoch: 'e', sequence: 12 },
        inFlightClientMessageId: ID
      })
    ).toBeNull()
    // Another epoch can't say; the person checks.
    expect(
      settleStructuredAgentSessionEntryFromJournal(stopped, {
        ...reading,
        cursor: { epoch: 'f', sequence: 99 }
      })
    ).toEqual({ kind: 'returned', words: ['sendOutcomeLost'] })
  })

  it("a stamped send whose row the journal shows is the host's, whatever the Stop said", () => {
    const stopped = entry({ state: 'unconfirmed', stoppedBy: { operationId: 'stop-1' } })
    expect(
      settleStructuredAgentSessionEntryFromJournal(stopped, {
        ...reading,
        submissions: [row({ dispatchState: 'accepted' })]
      })
    ).toEqual({ kind: 'recorded' })
  })

  it('a Stop that will never be answered hands a stamped send back to check, once the journal loads', () => {
    const stopped = entry({
      state: 'unconfirmed',
      stoppedBy: { operationId: 'stop-1', unanswerable: true }
    })
    expect(
      settleStructuredAgentSessionEntryFromJournal(stopped, { ...reading, cursor: null })
    ).toBeNull()
    expect(settleStructuredAgentSessionEntryFromJournal(stopped, reading)).toEqual({
      kind: 'returned',
      words: ['sendOutcomeLost']
    })
  })

  it("a queue send stamped by a Stop waits for the host's draft list before coming back", () => {
    const stopped = entry({
      state: 'unconfirmed',
      sentDelivery: 'queue-if-active',
      stoppedBy: { operationId: 'stop-1', cursor: { epoch: 'e', sequence: 1 } }
    })
    expect(settleStructuredAgentSessionEntryFromJournal(stopped, reading)).toBeNull()
    expect(
      settleStructuredAgentSessionEntryFromJournal(stopped, { ...reading, queuedMessageIds: [] })
    ).toEqual({ kind: 'withdrawn' })
  })
})

describe('entries an older build saved are migrated, never sent again', () => {
  const saved = (value: Record<string, unknown>) =>
    parseStructuredAgentSessionOutboxEntry({ ...entry(), ...value }, 'session-1')

  it('rejected, held for Retry and outlived-Stop entries read as awaiting settlement', () => {
    expect(saved({ state: 'rejected' })).toMatchObject({ state: 'queued', legacyUnsettled: true })
    expect(saved({ state: 'queued', lastFailure: { kind: 'failed' } })).toMatchObject({
      legacyUnsettled: true
    })
    expect(saved({ state: 'unconfirmed', outlivedStop: true })).toMatchObject({
      legacyUnsettled: true
    })
    // An unconfirmed one is unchanged: it is still resent.
    expect(saved({ state: 'unconfirmed', retryAfterUnknownSubmittedAt: 5 })).not.toHaveProperty(
      'legacyUnsettled'
    )
  })

  it('once the journal loads: a row drops it, none hands it back with words to check the chat', () => {
    const legacy = saved({ state: 'rejected' })!
    const reading = {
      submissions: NO_ROWS,
      cursor: null,
      inFlightClientMessageId: null,
      queuedMessageIds: null,
      loadedItemIds: LOADED,
      now: NOW
    }
    expect(settleStructuredAgentSessionEntryFromJournal(legacy, reading)).toBeNull()
    expect(
      settleStructuredAgentSessionEntryFromJournal(legacy, {
        ...reading,
        cursor: { epoch: 'e', sequence: 1 }
      })
    ).toEqual({ kind: 'returned', words: ['sendOutcomeLost'] })
    expect(
      settleStructuredAgentSessionEntryFromJournal(legacy, {
        ...reading,
        submissions: [row({ dispatchState: 'rejected' })]
      })
    ).toEqual({ kind: 'recorded' })
  })
})

describe('applying a settlement', () => {
  // A return keeps the entry, marked, in its place until its draft is saved (R2: never lost).
  it('a record leaves the outbox; a return stays marked returning and hands back, with its words', () => {
    const outbox = [entry(), entry({ clientMessageId: 'next' })]
    expect(applyStructuredAgentSessionOutboxSettlement(outbox, ID, { kind: 'recorded' })).toEqual({
      entries: [outbox[1]],
      returned: null
    })
    const returning = { ...outbox[0], returning: { ending: 'returned' } }
    expect(
      applyStructuredAgentSessionOutboxSettlement(outbox, ID, {
        kind: 'returned',
        words: ['tryAgain']
      })
    ).toEqual({
      entries: [returning, outbox[1]],
      returned: { entry: returning, words: ['tryAgain'] }
    })
    expect(
      applyStructuredAgentSessionOutboxSettlement(outbox, ID, { kind: 'withdrawn' }).returned
    ).toEqual({ entry: returning, words: null })
  })

  it('never settles a returning entry again from the journal', () => {
    expect(
      settleStructuredAgentSessionEntryFromJournal(
        entry({ state: 'unconfirmed', returning: { ending: 'returned' } }),
        {
          submissions: [row({ dispatchState: 'accepted' })],
          cursor: { epoch: 'e', sequence: 10 },
          inFlightClientMessageId: null,
          queuedMessageIds: null,
          loadedItemIds: LOADED,
          now: NOW
        }
      )
    ).toBeNull()
  })

  it('no answer keeps it under the same id, in doubt; pending keeps it dispatching', () => {
    const outbox = [entry({ state: 'dispatching' })]
    expect(
      applyStructuredAgentSessionOutboxSettlement(outbox, ID, { kind: 'unanswered' }).entries[0]
    ).toMatchObject({ clientMessageId: ID, state: 'unconfirmed' })
    expect(
      applyStructuredAgentSessionOutboxSettlement(outbox, ID, { kind: 'pending' }).entries[0]
    ).toMatchObject({ clientMessageId: ID, state: 'dispatching' })
  })
})

describe("past the host's window, a host answer that settles nothing", () => {
  const PAST = { ...RESEND_OLD_HOST, outlivedHostWindow: true }
  const hostAnswers: [string, StructuredAgentSessionSendAnswer][] = [
    ['a refusal it returned', refused('agent_session_journal_unreadable')],
    [
      'a refusal it threw',
      {
        kind: 'thrown',
        refusal: { kind: 'refused', code: 'structured_agent_session_unsupported' },
        rpcCode: undefined
      }
    ],
    ['a call it turned away', { kind: 'thrown', refusal: undefined, rpcCode: 'method_not_found' }]
  ]

  it.each(hostAnswers)(
    '%s: comes back to check the chat, or is the row it shows',
    (_label, answer) => {
      expect(settleStructuredAgentSessionSendAnswer(answer, ID, RESEND_OLD_HOST).kind).toBe(
        'unanswered'
      )
      expect(settleStructuredAgentSessionSendAnswer(answer, ID, PAST)).toEqual({
        kind: 'returned',
        words: ['sendOutcomeLost']
      })
      expect(
        settleStructuredAgentSessionSendAnswer(answer, ID, { ...PAST, journalHasRow: true })
      ).toEqual({ kind: 'recorded' })
    }
  )

  it('but a lost connection is no answer from the host, so it still goes again', () => {
    expect(
      settleStructuredAgentSessionSendAnswer(
        { kind: 'thrown', refusal: undefined, rpcCode: 'runtime_timeout' },
        ID,
        PAST
      )
    ).toEqual({ kind: 'unanswered' })
  })
})

describe('the host window bounds every entry', () => {
  const pastWindow = MADE_AT + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1
  const reading = {
    submissions: NO_ROWS,
    cursor: { epoch: 'e', sequence: 10 },
    inFlightClientMessageId: null,
    queuedMessageIds: null,
    loadedItemIds: LOADED,
    now: pastWindow
  }

  it('a send a Stop outran whose answer never settles it comes back to check, past the window', () => {
    // A queue send with no published draft list, and a Stop never answered: nothing else ends them.
    for (const stopped of [
      entry({
        state: 'unconfirmed',
        sentDelivery: 'queue-if-active',
        stoppedBy: { operationId: 'stop-1', cursor: { epoch: 'e', sequence: 4 } }
      }),
      entry({ state: 'unconfirmed', stoppedBy: { operationId: 'stop-1' } })
    ]) {
      expect(
        settleStructuredAgentSessionEntryFromJournal(stopped, { ...reading, now: NOW })
      ).toBeNull()
      expect(settleStructuredAgentSessionEntryFromJournal(stopped, reading)).toEqual({
        kind: 'returned',
        words: ['sendOutcomeLost']
      })
      // A row still settles it as the host's.
      expect(
        settleStructuredAgentSessionEntryFromJournal(stopped, { ...reading, submissions: [row()] })
      ).toEqual({ kind: 'recorded' })
    }
  })

  it('an ordinary entry is left to its own sender, whatever the time', () => {
    expect(
      settleStructuredAgentSessionEntryFromJournal(entry({ state: 'unconfirmed' }), reading)
    ).toBeNull()
  })

  it('an id older than the host replays can no longer be settled by a resend', () => {
    const madeAt = MADE_AT
    expect(structuredAgentSessionEntryOutlivedHostWindow(entry(), madeAt + 1000)).toBe(false)
    expect(
      structuredAgentSessionEntryOutlivedHostWindow(
        entry(),
        madeAt + AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS + 1
      )
    ).toBe(true)
  })
})
