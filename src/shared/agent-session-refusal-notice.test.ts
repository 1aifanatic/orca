import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'
import {
  agentSessionReadHistoryRefusalParts,
  agentSessionRefusalNotice,
  agentSessionRefusalReasonWords,
  agentSessionWriteFailureNotice,
  agentSessionWriteNoticeEnglish,
  agentSessionWriteNoticeParts
} from './agent-session-refusal-notice'
import {
  AGENT_SESSION_WRITE_NOTICE_COPY,
  type AgentSessionWriteNoticeSentence
} from './agent-session-write-notice-copy'
import { AGENT_SESSION_REFUSAL_REASONS } from './agent-session-refusal-details'
import { agentSessionFailureSentence } from './agent-session-failure-words'
import {
  agentSessionRefusalFailure,
  agentSessionRpcErrorFailure,
  agentSessionWriteKindForMethod,
  type AgentSessionWriteFailure,
  type AgentSessionWriteKind,
  type AgentSessionWriteRefusal
} from './agent-session-write-failure'
import {
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'
import { structuredAgentSessionRejectionParts } from './structured-agent-session-send-disposition'

const WRITES: AgentSessionWriteKind[] = [
  'read-history',
  'send',
  'composer-send',
  'stop',
  'stop-task',
  'stop-tasks',
  'answer',
  'option',
  'command',
  'goal'
]
const HOST_TEXT = 'Expected runtime fence 1; the session is at 3.'

// A cause is named only where every host emitter of the code means it; any other code says only
// what did not happen, because one code covers owner states or reasons the client cannot tell apart.
const CAUSES: Partial<Record<AgentSessionWireRefusalCode, AgentSessionWriteNoticeSentence>> = {
  // Only send preparation, when the owner it restarted for this send failed to start.
  agent_session_owner_restart_failed: 'restartFailed',
  // Only the ledger, when a day's retained operation ids fill a client's or the host's quota.
  agent_session_operation_capacity: 'capacity',
  // A replayed operation with no recorded outcome, or a send behind a rewind whose outcome is
  // unrecorded: either way Orca cannot say what happened.
  agent_session_operation_unknown: 'outcomeUnknown',
  // Only the pending-prompt check.
  agent_session_item_revision_stale: 'questionChanged',
  agent_session_already_resolved: 'questionChanged',
  // No emitter on this host; the code names nothing else.
  agent_session_journal_unreadable: 'historyUnreadable',
  // On these writes, only an older host, or the phone reading an unknown method.
  structured_agent_session_unsupported: 'unsupported'
}

function isCause(part: unknown): boolean {
  return typeof part === 'string' && !part.startsWith('notDone') && part !== 'tryAgainComposerSend'
}

// A newer host can send a code this client has never heard of.
const FUTURE_CODE: AgentSessionWriteFailure = JSON.parse(
  '{"kind":"refused","code":"agent_session_from_the_future"}'
)
const FAILURES: AgentSessionWriteFailure[] = [
  ...AGENT_SESSION_WIRE_REFUSAL_CODES.map((code) => ({ kind: 'refused' as const, code })),
  { kind: 'failed' },
  { kind: 'unconfirmed' },
  FUTURE_CODE
]
const NOT_DONE: Record<AgentSessionWriteKind, AgentSessionWriteNoticeSentence> = {
  'read-history': 'notDoneReadHistory',
  send: 'notDoneSend',
  'composer-send': 'notDoneSend',
  stop: 'notDoneStop',
  'stop-task': 'notDoneStopTask',
  'stop-tasks': 'notDoneStopTasks',
  answer: 'notDoneAnswer',
  option: 'notDoneOption',
  command: 'notDoneCommand',
  goal: 'notDoneGoal'
}

function codeOf(failure: AgentSessionWriteFailure): string {
  return failure.kind === 'refused' ? failure.code : failure.kind
}

// The host may have run it: a thrown request, or a replayed id with no recorded outcome.
function mayHaveRun(failure: AgentSessionWriteFailure): boolean {
  return codeOf(failure) === 'unconfirmed' || codeOf(failure) === 'agent_session_operation_unknown'
}

// Where the cause sentence alone already says the write cannot take effect.
function causeSaysNotDone(
  failure: AgentSessionWriteFailure,
  write: AgentSessionWriteKind
): boolean {
  const code = codeOf(failure)
  return (
    code === 'structured_agent_session_unsupported' ||
    (write === 'read-history' && code === 'agent_session_journal_unreadable') ||
    (write === 'answer' &&
      (code === 'agent_session_item_revision_stale' || code === 'agent_session_already_resolved'))
  )
}

// The phone resends under the same id. These record nothing under it (the lease refusals drop the
// row they admitted), so a resend can go through; every other code can be refused again.
const RESEND_CAN_WORK = new Set([
  'failed',
  'agent_session_checkpoint_stale',
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])

// Every (failure x write) cell of the table, checked against the rules a notice must keep.
describe('the notice for every failure and write', () => {
  const cells = FAILURES.flatMap((failure) =>
    WRITES.map((write) => {
      const parts = agentSessionWriteNoticeParts(failure, write)
      return {
        failure,
        write,
        parts,
        english: agentSessionWriteNoticeEnglish(parts),
        cell: `${codeOf(failure)} x ${write}`
      }
    })
  )

  it('says the write did not happen, once and for that write, whenever that is certain', () => {
    for (const { failure, write, parts, cell } of cells.filter((c) => !mayHaveRun(c.failure))) {
      const notDone = parts.filter((part) => typeof part === 'string' && part.startsWith('notDone'))
      expect(notDone, cell).toEqual(causeSaysNotDone(failure, write) ? [] : [NOT_DONE[write]])
    }
  })

  it('never says a write did not happen when the host may have run it', () => {
    for (const { parts, cell } of cells.filter((c) => mayHaveRun(c.failure))) {
      expect(parts, cell).toEqual(['outcomeUnknown'])
    }
  })

  // The control that sent the write is how to try again; only the phone's composer has none.
  it('says how to try again only to update Orca, or on the phone where a resend can work', () => {
    for (const { failure, write, parts, english, cell } of cells) {
      const phoneResend = write === 'composer-send' && RESEND_CAN_WORK.has(codeOf(failure))
      expect(parts.includes('tryAgainComposerSend'), cell).toBe(phoneResend)
      expect(/again/i.test(english), cell).toBe(
        phoneResend || codeOf(failure) === 'structured_agent_session_unsupported'
      )
    }
    for (const reason of [null, DISPATCH_REJECTED_WRITE_FAILED, DISPATCH_REJECTED_QUEUE_FULL]) {
      expect(
        agentSessionWriteNoticeEnglish(structuredAgentSessionRejectionParts(reason, 'send'))
      ).not.toMatch(/again/i)
    }
  })

  it('names a cause only for a code on the allowlist', () => {
    for (const { failure, write, parts, cell } of cells) {
      if (write === 'read-history' && codeOf(failure) === 'agent_session_journal_unreadable') {
        expect(parts, cell).toEqual(['historyUnusable', 'startNewChat'])
        continue
      }
      const cause =
        failure.kind === 'unconfirmed'
          ? 'outcomeUnknown'
          : failure.kind === 'refused'
            ? CAUSES[failure.code]
            : undefined
      expect(parts.filter(isCause), cell).toEqual(cause ? [cause] : [])
    }
  })

  // Census of host emitters, one per code, that write for a log or carry a marker. One is enough
  // to rule out showing the host's message for that code:
  // - every code a planned write settles: "Operation <id> was already refused: <code>."
  //   (structured-agent-session-replay-outcome.ts; the settlement stores no message)
  // - operation_conflict / _expired / _invalid / _capacity: "Operation <id> was refused: <code>."
  //   (agent-session-mutation-envelope.ts, the ledger)
  // - operation_invalid, operation_unknown: `agent_session_rewind:<reason>` (structured-rewind-refusal.ts)
  // - operation_unknown: "The outcome of operation <id> is unknown; it was not run again."
  // - checkpoint_stale, conflict, identity_required, execution_owner_reconciling, unsupported: the
  //   bare code thrown as the message (lease-release, reservation-admission, tab-table,
  //   claim-identity, lease-transitions, reveal)
  // - ownership_unknown: "The session attached without a provider child to write to." (holds)
  // - item_revision_stale / already_resolved: "Item <id> has moved on." (prompt-state)
  // - owner_restart_failed: "<agent> couldn't restart: <cause>.", where the cause is the resume's
  //   own refusal message, including the ledger's (send-preparation, hold-resume)
  // - journal_unreadable: no emitter on this host; an older or newer one may send it.
  it('is never empty and never shows the host message', () => {
    for (const { failure, write, parts, cell } of cells) {
      expect(parts.length, cell).toBeGreaterThan(0)
      expect(
        parts.every((part) => typeof part === 'string'),
        cell
      ).toBe(true)
      if (failure.kind === 'refused') {
        expect(
          agentSessionRefusalNotice({ code: failure.code, message: HOST_TEXT }, write),
          cell
        ).not.toContain('fence')
      }
    }
  })
})

describe('agentSessionRefusalNotice', () => {
  // The phone resends under the same operation id. Owner refusals and failed requests record
  // nothing under it, so a resend can go through; a conflicting or expired id is refused again.
  it.each([
    ['agent_session_checkpoint_stale', 'Your message was not sent. Send it again.'],
    ['execution_owner_reconciling', 'Your message was not sent. Send it again.'],
    ['agent_session_operation_expired', 'Your message was not sent.'],
    ['agent_session_operation_conflict', 'Your message was not sent.'],
    ['agent_session_operation_invalid', 'Your message was not sent.'],
    ['agent_session_owner_restart_failed', "The agent couldn't restart. Your message was not sent."]
  ] as const)('tells the phone to send it again only where that can work: %s', (code, expected) => {
    expect(agentSessionRefusalNotice({ code, message: HOST_TEXT }, 'composer-send')).toBe(expected)
  })

  it('says what did not happen for a failed request', () => {
    expect(agentSessionWriteFailureNotice('composer-send')).toBe(
      'Your message was not sent. Send it again.'
    )
    expect(agentSessionWriteFailureNotice('stop')).toBe("The agent wasn't stopped.")
  })

  // A request that may have run must not say it did not happen.
  it.each(['runtime_timeout', 'runtime_error', undefined])(
    'claims nothing about a request that threw with %s',
    (code) => {
      for (const write of WRITES) {
        expect(
          agentSessionWriteNoticeEnglish(
            agentSessionWriteNoticeParts(agentSessionRpcErrorFailure(code), write)
          )
        ).toBe("Orca couldn't confirm what happened. Check the chat.")
      }
    }
  )

  it('says what did not happen when the host turned the request away before running it', () => {
    expect(agentSessionRpcErrorFailure('invalid_argument')).toEqual({
      kind: 'refused',
      code: 'agent_session_operation_invalid'
    })
    expect(agentSessionRpcErrorFailure('method_not_found')).toEqual({
      kind: 'refused',
      code: 'structured_agent_session_unsupported'
    })
  })

  it('says an agent could not restart without promising a retry will work', () => {
    // The host words the cause into the chat's status row; some causes need a new chat.
    expect(
      agentSessionRefusalNotice(
        {
          code: 'agent_session_owner_restart_failed',
          message:
            "Claude couldn't restart: Operation 1-a was refused: agent_session_operation_expired."
        },
        'send'
      )
    ).toBe("The agent couldn't restart. Your message was not sent.")
  })

  it('names a background-task stop as that, not as stopping the agent', () => {
    const stop = (fields: Record<string, unknown>): string =>
      agentSessionRefusalNotice(
        { code: 'agent_session_checkpoint_stale', message: HOST_TEXT },
        agentSessionWriteKindForMethod('agentSession.cancel', fields)
      )
    expect(stop({ turnId: 't1' })).toBe("The agent wasn't stopped.")
    expect(stop({ turnId: 'background-tasks', scope: 'background-tasks', taskId: 'b1' })).toBe(
      "The background task wasn't stopped."
    )
    expect(stop({ turnId: 'background-tasks', scope: 'background-tasks' })).toBe(
      "The background tasks weren't stopped."
    )
  })

  it('says a Stop refused over a moved-on prompt did not stop the agent', () => {
    const refusal = {
      code: 'agent_session_already_resolved' as const,
      message: 'Item q1 moved on.'
    }
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe(
      "This question was already answered or has changed. The agent wasn't stopped."
    )
    expect(agentSessionRefusalNotice(refusal, 'answer')).toBe(
      'This question was already answered or has changed.'
    )
  })

  it('says only what did not happen for a code from a newer host', () => {
    const refusal = JSON.parse('{"code":"agent_session_from_the_future","message":"internal"}')
    expect(agentSessionRefusalNotice(refusal, 'stop')).toBe("The agent wasn't stopped.")
  })
})

// Every (code x reason) a host can name, as a write keeps it.
const REASONED: AgentSessionWriteRefusal[] = AGENT_SESSION_WIRE_REFUSAL_CODES.flatMap((code) =>
  AGENT_SESSION_REFUSAL_REASONS[code].map((reason) =>
    agentSessionRefusalFailure({ code, details: { reason } })
  )
)

function reasonOf(failure: AgentSessionWriteRefusal): string {
  return `${failure.code}/${failure.details?.reason}`
}

describe('the notice for every reason a host names', () => {
  const cells = REASONED.flatMap((failure) =>
    WRITES.map((write) => ({
      failure,
      write,
      parts: agentSessionWriteNoticeParts(failure, write),
      words: agentSessionRefusalReasonWords(failure, write),
      cell: `${reasonOf(failure)} x ${write}`
    }))
  )

  it('has words for every reason', () => {
    for (const { words, cell } of cells) {
      expect(words, cell).toBeDefined()
    }
  })

  it('keeps the code words where the table says the reason means nothing more', () => {
    for (const { failure, write, parts, words, cell } of cells) {
      if (words && 'words' in words) {
        expect(parts, cell).toEqual(
          agentSessionWriteNoticeParts({ ...failure, details: undefined }, write)
        )
      }
    }
  })

  it('names a step exactly where the person has one to take', () => {
    for (const { words, cell } of cells) {
      if (words && 'cause' in words) {
        expect(words.step !== undefined, cell).toBe(
          words.action === 'wait' || words.action === 'actFirst' || words.action === 'goElsewhere'
        )
      }
    }
  })

  it('says the write did not happen, once, and never shows the host message', () => {
    for (const { failure, write, parts, cell } of cells) {
      const english = agentSessionWriteNoticeEnglish(parts)
      expect(english.length, cell).toBeGreaterThan(0)
      expect(agentSessionRefusalNotice({ ...failure, message: HOST_TEXT }, write), cell).toBe(
        english
      )
      if (failure.code === 'agent_session_operation_unknown') {
        expect(parts, cell).toEqual(['outcomeUnknown'])
        continue
      }
      const notDone = parts.filter((part) => typeof part === 'string' && part.startsWith('notDone'))
      const answeredAway = write === 'answer' && parts.includes('questionChanged')
      const unsupported = failure.code === 'structured_agent_session_unsupported'
      const saysNotDone = parts.includes('historyUnusable')
      expect(notDone, cell).toEqual(
        answeredAway || unsupported || saysNotDone ? [] : [NOT_DONE[write]]
      )
    }
  })

  it("uses the failure's own sentence for a start that failed, and only for a message", () => {
    const failure = agentSessionRefusalFailure({
      code: 'agent_session_operation_invalid',
      details: { reason: 'notSignedIn' }
    })
    expect(agentSessionWriteNoticeParts(failure, 'send')).toEqual([
      'notDoneSend',
      { text: agentSessionFailureSentence({ kind: 'notSignedIn' }, 'rejection') }
    ])
    // Its next step is to send the message again, which a Stop cannot do.
    expect(agentSessionWriteNoticeParts(failure, 'stop')).toEqual(['notDoneStop'])
  })

  it.each([
    [
      'agent_session_operation_invalid',
      'conversationCleared',
      'send',
      'This conversation has been cleared. Your message was not sent. Open the current conversation to continue.'
    ],
    [
      'agent_session_operation_invalid',
      'clearUnconfirmed',
      'send',
      "The last /clear didn't finish. Your message was not sent. Start a new chat to continue."
    ],
    [
      'agent_session_operation_invalid',
      'turnActive',
      'command',
      "The agent is still responding. The command didn't run. Wait for the agent to finish responding, or stop it."
    ],
    [
      'agent_session_conflict',
      'claimConflicted',
      'composer-send',
      'This chat is still open in a terminal agent. Your message was not sent. Quit that agent to continue the chat here.'
    ],
    [
      'agent_session_conflict',
      'chatStarting',
      'stop',
      "The agent is still starting. The agent wasn't stopped. Wait for the agent to finish starting."
    ],
    [
      'agent_session_operation_invalid',
      'promptGone',
      'answer',
      'This question was already answered or has changed.'
    ],
    [
      'agent_session_checkpoint_stale',
      'fenceStale',
      'composer-send',
      'Your message was not sent. Send it again.'
    ]
  ] as const)('%s / %s on %s', (code, reason, write, expected) => {
    expect(
      agentSessionRefusalNotice({ code, message: HOST_TEXT, details: { reason } }, write)
    ).toBe(expected)
  })
})

describe('a refusal from a host that names no reason this build knows', () => {
  it.each([
    ['an older host', undefined],
    ['a reason a newer host added', { reason: 'fromTheFuture' }],
    ['facts with no reason', { ownerVerdict: 'unverifiable' }]
  ])("reads as the code's row: %s", (_label, details) => {
    const refusal = JSON.parse(
      JSON.stringify({ code: 'agent_session_operation_invalid', message: HOST_TEXT, details })
    )
    expect(agentSessionRefusalNotice(refusal, 'command')).toBe("The command didn't run.")
  })
})

it('keeps a sentence the failure rows share word for word', () => {
  expect(agentSessionFailureSentence({ kind: 'historyTooLarge' }, 'row')).toContain(
    AGENT_SESSION_WRITE_NOTICE_COPY.startNewChat
  )
})

// A read of a chat's history is refused this way only for a journal file no retry can read.
describe('a read of a chat history whose journal cannot be read', () => {
  const FINAL =
    "This chat's history couldn't be read, so it can't continue here. Start a new chat to continue."

  it.each([
    ['a host that names the reason', { reason: 'journalUnreadable' }],
    ['a read that raises the bare code', undefined]
  ] as const)(
    'says the chat cannot continue here and to start a new one: %s',
    (_label, details) => {
      const parts = agentSessionReadHistoryRefusalParts('agent_session_journal_unreadable', details)
      expect(parts).toEqual(['historyUnusable', 'startNewChat'])
      expect(agentSessionWriteNoticeEnglish(parts)).toBe(FINAL)
      expect(
        agentSessionRefusalNotice(
          { code: 'agent_session_journal_unreadable', message: HOST_TEXT, details },
          'read-history'
        )
      ).toBe(FINAL)
    }
  )

  it('keeps the words a write refused the same way has, whose cause can clear', () => {
    expect(
      agentSessionRefusalNotice(
        {
          code: 'agent_session_journal_unreadable',
          message: HOST_TEXT,
          details: { reason: 'journalUnreadable' }
        },
        'send'
      )
    ).toBe("Orca couldn't read this chat's saved history. Your message was not sent.")
  })

  it('says only that the history did not load for any other read refusal', () => {
    expect(agentSessionReadHistoryRefusalParts('agent_session_ownership_unknown')).toEqual([
      'notDoneReadHistory'
    ])
    expect(agentSessionReadHistoryRefusalParts('agent_session_from_the_future')).toEqual([
      'notDoneReadHistory'
    ])
  })
})
